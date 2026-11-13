// Private inbox only: no sends, configuration imports, or default state path.
// Poll saves a stable batch; only ack commits its cursors. Network runs outside the file lock.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'

const SESSIONS = 'https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions'
const HISTORY = 'https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs'
const VIEW = 'https://api.bilibili.com/x/web-interface/view'
const STATE_LIMIT = 2 * 1024 * 1024
const BODY_LIMIT = 1024 * 1024
const noHit = (extra = {}) => ({ ok: true, hit: false, items: [], ...extra })
const object = v => !!v && typeof v === 'object' && !Array.isArray(v)
const limit = (v, fallback, max) => Number.isSafeInteger(v) && v > 0 ? Math.min(v, max) : fallback
const cmp = (a, b) => a.length - b.length || a.localeCompare(b)
const maxId = (a, b) => cmp(a, b) > 0 ? a : b
const seconds = v => ((typeof v === 'number' || (typeof v === 'string' && /^[0-9]+$/.test(v))) && Number.isSafeInteger(Number(v)) && Number(v) >= 0) ? Number(v) : null
const more = value => {
  if (![true, false, 1, 0, '1', '0'].includes(value)) throw problem('invalid-data', '私信分页缺少有效结束标记，不能确认完整覆盖。')
  return value === true || value === 1 || value === '1'
}

export function exactDmId(value, zero = false) {
  const s = typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : ''
  return (zero ? /^(0|[1-9][0-9]{0,19})$/ : /^[1-9][0-9]{0,19}$/).test(s) ? s : ''
}
export function dmTextPrefix(value, length) {
  let text = typeof value === 'string' ? value : ''
  if (text.length <= length) return text
  text = text.slice(0, Math.max(0, length))
  return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text
}
const clipped = (v, n) => dmTextPrefix(typeof v === 'string' ? v : '', n)
class InboxError extends Error {
  constructor(code, error, hint) { super(error); this.code = code; this.hint = hint }
}
const problem = (code, error, hint = '稍后重试；不要确认尚未完整读取的批次。') => new InboxError('dm.' + code, error, hint)
const detail = e => ({ code: e.code, error: e.message, hint: e.hint })
const failed = e => ({ ok: false, hit: false, items: [], ...detail(e instanceof InboxError ? e : problem('internal', '私信读取未完成。')) })
const idRequired = (value, zero = false) => {
  const id = exactDmId(value, zero)
  if (!id) throw problem('unsafe-id', '私信接口含缺失或不精确的标识符。', '保留水位；检查接口的字符串 ID 字段，勿把不安全数字转成字符串。')
  return id
}
function messageSequence(raw, zero = false) {
  const values = [raw?.msg_seqno, raw?.msg_seq].filter(value => value !== undefined)
  if (!values.length) return idRequired(undefined, zero)
  const ids = values.map(value => idRequired(value, zero))
  if (ids.some(id => id !== ids[0])) throw problem('unsafe-id', '私信消息序号字段相互冲突，未推进水位。')
  return ids[0]
}
function parseContent(raw) {
  if (object(raw)) return raw
  if (typeof raw !== 'string') return {}
  try { const v = JSON.parse(raw); return object(v) ? v : { content: raw } } catch { return { content: raw } }
}
function cardIdentity(card) {
  const bvids = new Set(), aids = new Set()
  const bad = () => { throw problem('unsupported-card', '此视频卡片缺少明确标识或包含冲突标识。', '请对方补发唯一的 B站视频链接（BV号）；不要猜测要分享的视频。') }
  if (card.source !== undefined && String(card.source) !== '5') bad()
  if (card.bvid !== undefined) {
    if (typeof card.bvid !== 'string' || !/^BV[0-9A-Za-z]{10}$/.test(card.bvid)) bad()
    bvids.add(card.bvid)
  }
  for (const key of ['aid', ...(String(card.source) === '5' ? ['id'] : [])]) {
    if (card[key] === undefined) continue
    const aid = exactDmId(card[key]); if (!aid) bad(); aids.add(aid)
  }
  for (const key of ['url', 'link', 'uri', 'jump_url']) {
    if (card[key] === undefined || card[key] === '') continue
    if (typeof card[key] !== 'string' || card[key].length > 2048 || /[\\\s]/.test(card[key])) bad()
    let u; try { u = new URL(card[key]) } catch { bad() }
    if (!['https:', 'http:'].includes(u.protocol) || u.hostname !== 'www.bilibili.com' || u.username || u.password || u.port) bad()
    const match = /^\/video\/(BV[0-9A-Za-z]{10}|av[1-9][0-9]{0,19})\/?$/.exec(u.pathname)
    if (!match) bad()
    if (match[1].startsWith('BV')) bvids.add(match[1]); else aids.add(match[1].slice(2))
  }
  if (bvids.size > 1 || aids.size > 1 || (!bvids.size && !aids.size)) bad()
  return { bvid: [...bvids][0] || '', aid: [...aids][0] || '', title: clipped(card.title, 300) }
}

// resolveVideo receives only canonical IDs, never a caller-provided URL.
export async function normalizeDmMessage(raw, { resolveVideo, maxText = 4000 } = {}) {
  const seq = messageSequence(raw), ts = seconds(raw?.timestamp), type = seconds(raw?.msg_type)
  if (ts === null || type === null || type > 65535) throw problem('invalid-message', '私信消息时间或类型无效。')
  const content = parseContent(raw.content)
  const source = typeof content.content === 'string' ? content.content : typeof content.text === 'string' ? content.text : typeof raw.content === 'string' ? raw.content : JSON.stringify(content)
  const cap = limit(maxText, 4000, 8000)
  const message = { seq, ts, type, text: clipped(source, cap) }
  if (source.length > cap) { message.truncated = true; message.error = detail(problem('text-truncated', '此条私信内容超过读取上限，已截断。', '在 B站私信查看完整内容；不要根据截断的指令执行分享。')) }
  if (type === 7) {
    let video
    try { video = cardIdentity(content) } catch (e) { message.error = detail(e); return message }
    if ((!video.bvid || !video.title || (video.aid && video.bvid)) && resolveVideo) video = await resolveVideo(video)
    if (!video.bvid) { message.error = detail(problem('unsupported-card', '视频卡片仅有 av 号，尚未解析为 BV 号。', '读取公开视频信息或请对方补发 BV 链接。')); return message }
    message.video = { ...video, url: 'https://www.bilibili.com/video/' + video.bvid }
    message.text = '[视频卡片] ' + (video.title || video.bvid) + '\n' + message.video.url
  }
  return message
}

export function createDmInbox({ stateFile, ownerMid, ownerName = '', selfMid, headers = {}, fetchImpl = globalThis.fetch,
  timeoutMs = 12000, maxPages = 5, maxMessages = 100, maxSessions = 50, maxRequests = 20, pageSize = 20,
  maxText = 4000, contextMessages = 8, contextMaxAgeSec = 1800, now = Date.now } = {}) {
  const owner = exactDmId(ownerMid), self = exactDmId(selfMid)
  const bounds = { timeout: limit(timeoutMs, 12000, 60000), pages: limit(maxPages, 5, 10),
    messages: limit(maxMessages, 100, 200), sessions: limit(maxSessions, 50, 200), requests: limit(maxRequests, 20, 40),
    page: limit(pageSize, 20, 100), text: limit(maxText, 4000, 8000), context: limit(contextMessages, 8, 12), age: limit(contextMaxAgeSec, 1800, 7200) }
  const guard = () => {
    if (typeof stateFile !== 'string' || !path.isAbsolute(stateFile) || !owner || !self || owner === self)
      throw problem('configuration', '私信读取缺少有效的状态路径、主人或本人账号。', '检查 B站配置中的 owner.mid、self.mid 和角色状态路径。')
  }
  const stamp = () => new Date(now()).toISOString()
  const clock = () => Math.floor(now() / 1000)
  const hash = text => createHash('sha256').update(text).digest('hex')
  function load() {
    let raw
    try {
      if (fs.statSync(stateFile).size > STATE_LIMIT) throw problem('state-limit', '私信状态文件超过安全读取上限。', '保留文件，检查积压批次和状态格式。')
      raw = fs.readFileSync(stateFile, 'utf8')
    } catch (e) { if (e.code === 'ENOENT') return { state: null, revision: '' }; throw e instanceof InboxError ? e : problem('state-read', '无法读取私信状态。', '检查角色状态目录权限；不要删除待处理批次。') }
    let state
    try { state = JSON.parse(raw) } catch { throw problem('state-invalid', '私信状态不是有效 JSON。', '保留原文件并恢复已知有效备份；不要自动重置水位。') }
    if (!object(state) || (state.version !== undefined && state.version !== 2)) throw problem('state-invalid', '私信状态版本不支持。')
    if (state.version === 2) {
      if (state.ownerMid !== owner || state.selfMid !== self) throw problem('account-mismatch', '私信状态所属账号与当前配置不一致。', '切回对应账号或使用独立角色状态，避免串用确认水位。')
      if (!object(state.cursors) || !object(state.recent) || !object(state.started) || !Array.isArray(state.acked) || !Number.isSafeInteger(state.revision)) throw problem('state-invalid', '私信状态结构不完整。')
      const validCursors = cursors => object(cursors) && Object.entries(cursors).every(([mid, cursor]) => exactDmId(mid) && object(cursor) && typeof cursor.seq === 'string' && exactDmId(cursor.seq, true) && seconds(cursor.ts) !== null)
      const validMessages = messages => Array.isArray(messages) && messages.length <= 200 && messages.every(msg => object(msg) && typeof msg.seq === 'string' && exactDmId(msg.seq) && seconds(msg.ts) !== null && Number.isSafeInteger(msg.type) && msg.type >= 0 && msg.type <= 65535 && typeof msg.text === 'string' && msg.text.length <= 8000)
      if (!validCursors(state.cursors) || Object.entries(state.recent).some(([mid, messages]) => !exactDmId(mid) || !validMessages(messages))) throw problem('state-invalid', '私信状态包含无效消息水位或上下文。')
      if (state.pending) {
        const p = state.pending
        if (!object(p) || !/^[a-f0-9-]{36}$/.test(p.batchId || '') || !Array.isArray(p.items) || !p.items.length || !validCursors(p.cursors) || p.items.some(item => !object(item) || !exactDmId(item.mid) || item.mid === self || item.isOwner !== (item.mid === owner) || !validMessages(item.messages) || !item.messages.length || (item.context !== undefined && !validMessages(item.context)))) throw problem('state-invalid', '待确认私信批次结构无效。')
        if (Object.entries(p.cursors).some(([mid, cursor]) => state.cursors[mid] && cmp(cursor.seq, state.cursors[mid].seq) < 0) || p.items.some(item => !p.cursors[item.mid] || item.messages.some(msg => cmp(msg.seq, p.cursors[item.mid].seq) > 0))) throw problem('state-invalid', '待确认私信批次的消息与水位不一致。')
      }
    } else if (state.lastSeen === undefined && state.seen === undefined) {
      if (Object.keys(state).length) throw problem('state-invalid', '旧私信状态缺少可迁移水位。')
    }
    return { state, revision: hash(raw) }
  }
  function fresh(old) {
    if (old?.version === 2) return structuredClone(old)
    const state = { version: 2, revision: 0, ownerMid: owner, selfMid: self, cursors: {}, recent: {}, started: {}, acked: [], pending: null }
    if (old?.lastSeen !== undefined) {
      const ts = seconds(old.lastSeen); if (ts === null) throw problem('state-invalid', '旧主人时间水位无效。')
      state.lastSeen = ts
    }
    if (old?.seen !== undefined) {
      if (!object(old.seen)) throw problem('state-invalid', '旧会话时间水位无效。')
      state.seen = {}
      for (const [mid, value] of Object.entries(old.seen)) {
        if (!exactDmId(mid) || seconds(value) === null) throw problem('state-invalid', '旧会话标识或时间水位无效。')
        state.seen[mid] = seconds(value)
      }
    }
    if (old?.at) state.legacyAt = clipped(old.at, 40)
    return state
  }
  async function lock(action) {
    const lockPath = stateFile + '.lock', until = Date.now() + 500
    try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }) } catch { throw problem('state-write', '无法创建私信状态目录。') }
    let fd
    while (fd === undefined) {
      try { fd = fs.openSync(lockPath, 'wx', 0o600) } catch (e) {
        if (e.code !== 'EEXIST') throw problem('state-write', '无法锁定私信状态文件。')
        // Never unlink somebody else's lock: two stale-lock recoverers could remove a new live lock.
        if (Date.now() >= until) throw problem('state-busy', '私信状态锁仍被占用。', '稍后重试同一批次；若持续占用，先确认锁内进程已退出再人工清理锁文件，勿推进水位。')
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    }
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); return action() }
    finally { try { fs.closeSync(fd) } finally { fs.unlinkSync(lockPath) } }
  }
  function save(state) {
    state.revision += 1; state.at = stamp()
    const text = JSON.stringify(state) + '\n'
    if (Buffer.byteLength(text) > STATE_LIMIT) throw problem('state-limit', '私信批次超过状态容量，未推进水位。', '缩小单批读取上限并重试；保留原状态。')
    const temp = stateFile + '.' + randomUUID() + '.tmp'
    let fd
    try {
      fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, text); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined
      fs.renameSync(temp, stateFile)
    } catch { throw problem('state-write', '私信批次保存失败，未确认交付。', '检查磁盘和角色目录权限后重试。') }
    finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp) } catch {} }
  }
  const pendingResult = (state, any = true) => {
    if (!any && state.pending.items.some(item => item.mid !== owner)) throw problem('pending-scope', '尚有全会话范围的待确认批次。', '用 --any 交付并确认原批次后再切换监听范围。')
    const { batchId, items, warnings } = state.pending
    return { ok: true, hit: true, batchId, items, ...(warnings?.length ? { warnings } : {}) }
  }
  async function getJson(endpoint, params, run) {
    if (++run.requests > bounds.requests) throw problem('request-limit', '单次私信读取请求数已达上限，尚未完整衔接水位。')
    const remaining = run.deadline - Date.now()
    if (remaining <= 0) throw problem('timeout', '私信读取超时，未确认批次。')
    const url = new URL(endpoint); for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
    const controller = new AbortController(); let timer
    const expiry = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(problem('timeout', '私信读取超时，未确认批次。')) }, remaining) })
    const work = (async () => {
      if (typeof fetchImpl !== 'function') throw problem('network', '私信读取环境缺少网络接口。')
      const r = await fetchImpl(url.href, { method: 'GET', headers, redirect: 'manual', signal: controller.signal })
      if (r.redirected || (r.status >= 300 && r.status < 400) || (r.url && (new URL(r.url).origin !== url.origin || new URL(r.url).pathname !== url.pathname))) throw problem('redirect', '私信接口返回了非预期跳转。', '保留水位并检查 B站登录状态；不会跟随跳转发送 Cookie。')
      if (!r.ok) throw problem('http', '私信接口 HTTP 请求失败。')
      let json
      try {
        let text = ''
        if (r.body?.getReader) {
          const reader = r.body.getReader(), decoder = new TextDecoder(); let bytes = 0
          try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > BODY_LIMIT) throw problem('response-limit', '私信接口响应过大。'); text += decoder.decode(part.value, { stream: true }) } text += decoder.decode() }
          finally { reader.releaseLock() }
        } else text = await r.text()
        if (Buffer.byteLength(text) > BODY_LIMIT) throw problem('response-limit', '私信接口响应过大。')
        json = JSON.parse(text)
      } catch (e) { if (e instanceof InboxError) throw e; throw problem('invalid-json', '私信接口未返回有效 JSON。', '检查登录或风控状态，稍后重试；错误响应不会作为消息投递。') }
      if (json?.code !== 0) {
        const code = Number.isSafeInteger(json?.code) ? json.code : null
        if ([-352, -412, -509].includes(code)) throw problem('risk-control', 'B站暂时限制了私信读取。', '暂停轮询，等待风控解除后再重试同一批次。')
        if ([-101, -111, 61000].includes(code)) throw problem('login-required', 'B站登录状态失效，私信未读。', '重新登录 B站后重试；不要重置水位。')
        if ([-404, 62002, 62012].includes(code)) throw problem('unavailable', 'B站消息或视频已删除或不可用。', '在 B站确认内容可见性；不要猜测视频或确认未读批次。')
        throw problem('api', 'B站读取接口返回错误' + (code === null ? '。' : '（' + code + '）。'))
      }
      if (!object(json.data)) throw problem('invalid-data', '私信接口缺少有效数据。')
      return json.data
    })()
    try { return await Promise.race([work, expiry]) }
    catch (e) { throw e instanceof InboxError ? e : problem('network', '私信网络读取失败。') }
    finally { clearTimeout(timer); controller.abort() }
  }
  async function sessions(any, run) {
    const rows = new Map(); let end = ''
    for (let page = 0; page < bounds.pages; page++) {
      const data = await getJson(SESSIONS, { session_type: 1, group_id: 0, count: 50, mobi_app: 'web', ...(end ? { end_ts: end } : {}) }, run)
      if (!Array.isArray(data.session_list) || data.session_list.length > 100) throw problem('invalid-data', '私信会话列表格式无效。')
      for (const s of data.session_list) {
        if (!object(s)) throw problem('invalid-data', '私信会话结构无效。')
        if (s.session_type !== undefined && Number(s.session_type) !== 1) continue
        const mid = idRequired(s.talker_id)
        if (mid === self || (!any && mid !== owner) || (any && BigInt(mid) < 1000n && mid !== owner)) continue
        if (rows.has(mid)) continue
        const last = s.last_msg || {}, hasLastSequence = last.msg_seqno !== undefined || last.msg_seq !== undefined
        const fromLast = hasLastSequence ? messageSequence(last, true) : '', fromMax = exactDmId(s.max_seqno, true)
        if ((s.max_seqno !== undefined && !fromMax) || (!fromLast && !fromMax)) throw problem('unsafe-id', '私信会话缺少精确消息序号。')
        const seq = fromLast && fromMax ? maxId(fromLast, fromMax) : fromLast || fromMax
        const ts = seconds(last.timestamp ?? 0); if (ts === null) throw problem('invalid-message', '私信会话时间无效。')
        rows.set(mid, { mid, seq, ts, name: mid === owner ? clipped(ownerName, 160) : clipped(s.account_info?.name ?? s.talker_name, 160) })
        if (rows.size > bounds.sessions) throw problem('session-limit', '私信会话数超过单次读取上限，未推进水位。')
      }
      if ((!any && rows.has(owner)) || !more(data.has_more)) return [...rows.values()]
      const times = data.session_list.map(s => idRequired(s.session_ts)).sort(cmp)
      const next = times[0]
      if (!next || (end && cmp(next, end) >= 0)) throw problem('history-gap', '私信会话分页无法继续，尚未完整衔接水位。')
      end = next
    }
    throw problem('history-gap', '私信会话分页达到上限，未确认任何尾部消息。', '在 B站检查积压；调整有界分页预算后重试，不要用 baseline 跳过未读消息。')
  }
  async function history(session, cursor, run) {
    const rows = new Map(); let begin = '', reached = false
    for (let page = 0; page < bounds.pages; page++) {
      const data = await getJson(HISTORY, { talker_id: session.mid, session_type: 1, size: bounds.page, sender_device_id: 1, ...(begin ? { begin_seqno: begin } : {}) }, run)
      if (!Array.isArray(data.messages) || data.messages.length > bounds.page) throw problem('invalid-data', '私信历史列表格式或数量无效。')
      const pageRows = []
      for (const raw of data.messages) {
        const seq = messageSequence(raw), ts = seconds(raw?.timestamp)
        const sender = idRequired(raw?.sender_uid)
        if (ts === null || (sender !== session.mid && sender !== self)) throw problem('invalid-message', '私信历史的发送者或时间无效。')
        if (raw.receiver_id !== undefined && idRequired(raw.receiver_id) !== (sender === self ? session.mid : self)) throw problem('invalid-message', '私信历史接收者与会话不一致。')
        const previous = rows.get(seq)
        if (previous && JSON.stringify(previous) !== JSON.stringify(raw)) throw problem('history-gap', '同一私信序号对应冲突内容。')
        if (!previous && ++run.messages > bounds.messages) throw problem('message-limit', '私信历史超过单次消息上限，未确认尾部消息。')
        rows.set(seq, raw); pageRows.push(seq)
        if (cursor.seq ? cmp(seq, cursor.seq) <= 0 : ts <= cursor.ts) reached = true
      }
      if (reached || !more(data.has_more)) {
        if (!reached && cursor.seq && cursor.seq !== '0') throw problem('history-gap', '私信历史未能衔接上次已确认的消息序号。', '保留水位，在 B站检查历史缺口；不要直接确认最新几条。')
        break
      }
      const next = pageRows.sort(cmp)[0]
      if (!next || (begin && cmp(next, begin) >= 0)) throw problem('history-gap', '私信历史分页没有进展。')
      begin = next
      if (page === bounds.pages - 1) throw problem('history-gap', '私信历史分页已达上限，尚未衔接旧水位。')
    }
    if (!rows.size || !rows.has(session.seq)) throw problem('history-gap', '私信历史未覆盖会话列表所指的最新消息。')
    return [...rows.values()].filter(raw => cursor.seq ? cmp(messageSequence(raw), cursor.seq) > 0 : raw.timestamp > cursor.ts).sort((a, b) => cmp(messageSequence(a), messageSequence(b)))
  }
  async function videoResolver(video, run) {
    const key = video.aid ? 'aid:' + video.aid : 'bvid:' + video.bvid
    if (!run.videos.has(key)) run.videos.set(key, getJson(VIEW, video.aid ? { aid: video.aid } : { bvid: video.bvid }, run))
    const data = await run.videos.get(key), aid = idRequired(data.aid), bvid = typeof data.bvid === 'string' && /^BV[0-9A-Za-z]{10}$/.test(data.bvid) ? data.bvid : ''
    if (!bvid || (video.aid && video.aid !== aid) || (video.bvid && video.bvid !== bvid)) throw problem('unsupported-card', '视频卡片标识与公开信息不一致。', '请对方补发准确的 BV 链接，不要猜测分享目标。')
    if (typeof data.title !== 'string' || !data.title.trim()) throw problem('invalid-data', '视频公开信息缺少标题。')
    return { aid, bvid, title: clipped(data.title, 300) }
  }
  async function poll({ any = false, baseline = false } = {}) {
    try {
      guard(); const snapshot = load()
      if (snapshot.state?.pending) {
        if (baseline) throw problem('pending-batch', '仍有待确认私信，不能重置基线。', '先交付并 --ack 原批次，避免丢失尚未处理的消息。')
        return pendingResult(snapshot.state, any)
      }
      const state = fresh(snapshot.state), scope = any ? 'any' : 'owner'
      const run = { deadline: Date.now() + bounds.timeout, requests: 0, messages: 0, videos: new Map() }
      const list = await sessions(any, run), warnings = [], items = [], cursors = {}
      const legacy = snapshot.state && snapshot.state.version !== 2 && (state.lastSeen !== undefined || state.seen !== undefined)
      const first = !snapshot.state || (!legacy && !state.started[scope] && !(scope === 'owner' && state.started.any))
      const newAnyLegacy = legacy && any && state.seen === undefined
      const establish = baseline || first || newAnyLegacy
      if (legacy) warnings.push(detail(problem('legacy-timestamp', '旧状态仅有秒级时间水位；同一秒内的先后无法恢复。', '迁移只交付严格晚于旧水位的消息；如该秒有漏读，请在 B站人工核对。')))
      const started = state.started[scope] || state.started.any || (Number.isFinite(Date.parse(state.legacyAt)) ? Math.floor(Date.parse(state.legacyAt) / 1000) : clock())
      for (const session of list) {
        if (baseline || (establish && !state.cursors[session.mid] && !(legacy && (state.seen?.[session.mid] !== undefined || (session.mid === owner && state.lastSeen !== undefined))))) { state.cursors[session.mid] = { seq: session.seq, ts: session.ts }; continue }
        const stored = state.cursors[session.mid]
        const oldTs = state.seen?.[session.mid] ?? (session.mid === owner ? state.lastSeen : undefined)
        const cursor = stored || { seq: '', ts: oldTs === undefined ? started : oldTs }
        if (stored && cmp(session.seq, stored.seq) <= 0) continue
        const messages = await history(session, cursor, run)
        let next = stored || { seq: session.seq, ts: cursor.ts }
        const incoming = []
        for (const raw of messages) {
          next = { seq: maxId(next.seq, messageSequence(raw)), ts: Math.max(next.ts, seconds(raw.timestamp)) }
          if (exactDmId(raw.sender_uid) === self) continue
          const message = await normalizeDmMessage(raw, { maxText: bounds.text, resolveVideo: video => videoResolver(video, run) })
          incoming.push(message)
        }
        cursors[session.mid] = next
        if (incoming.length) {
          const context = (state.recent[session.mid] || []).filter(msg => msg.ts >= clock() - bounds.age).slice(-bounds.context)
          items.push({ mid: session.mid, name: session.name, isOwner: session.mid === owner, messages: incoming, ...(context.length ? { context } : {}) })
        }
      }
      if (Object.keys({ ...state.cursors, ...cursors }).length > 200) throw problem('state-limit', '私信会话水位数量超过上限。', '保留状态并检查账号会话数量，不要静默删掉未读水位。')
      state.started[scope] ||= clock()
      if (establish) warnings.push(detail(problem('baseline', '已建立当前私信基线，现有历史不会自动重放。', '此后新消息会以待确认批次交付。')))
      if (items.length) {
        items.sort((a, b) => a.messages[0].ts - b.messages[0].ts || a.mid.localeCompare(b.mid))
        state.pending = { batchId: randomUUID(), items, cursors, warnings, createdAt: stamp() }
      } else Object.assign(state.cursors, cursors) // Outgoing-only scans may advance after complete history coverage.
      return await lock(() => {
        const current = load()
        if (current.revision !== snapshot.revision) {
          if (current.state?.pending && !baseline) return pendingResult(current.state, any)
          throw problem('state-conflict', '私信状态在读取期间已变化。', '重新轮询最新状态；旧快照不会覆盖已确认水位。')
        }
        save(state)
        return state.pending ? pendingResult(state, any) : noHit({ ...(establish ? { baseline: true } : {}), ...(warnings.length ? { warnings } : {}) })
      })
    } catch (e) { return failed(e) }
  }
  async function ack(batchId) {
    try {
      guard()
      if (typeof batchId !== 'string' || !/^[a-f0-9-]{36}$/.test(batchId)) throw problem('invalid-batch', '待确认批次编号无效。', '使用最近一次 poll 返回的完整 batchId。')
      return await lock(() => {
        const state = load().state
        if (state?.acked?.includes(batchId)) return noHit({ acked: true, alreadyAcked: true, batchId })
        if (!state?.pending || state.pending.batchId !== batchId) throw problem('batch-mismatch', '此批次不是当前待确认私信。', '重新读取当前批次，勿确认未交付内容。')
        const batch = state.pending
        Object.assign(state.cursors, batch.cursors)
        for (const item of batch.items) {
          const merged = new Map((state.recent[item.mid] || []).concat(item.messages).map(msg => [msg.seq, msg]))
          const recent = [...merged.values()].filter(msg => msg.ts >= clock() - bounds.age).sort((a, b) => cmp(a.seq, b.seq)).slice(-bounds.context)
          let chars = 0; state.recent[item.mid] = recent.reverse().filter(msg => { chars += JSON.stringify(msg).length; return chars <= 16000 }).reverse()
          const ts = Math.max(...item.messages.map(message => message.ts))
          state.seen ||= {}; state.seen[item.mid] = Math.max(state.seen[item.mid] || 0, ts)
          if (item.mid === owner) state.lastSeen = Math.max(state.lastSeen || 0, ts)
        }
        for (const mid of Object.keys(state.recent)) { state.recent[mid] = state.recent[mid].filter(msg => msg.ts >= clock() - bounds.age); if (!state.recent[mid].length) delete state.recent[mid] }
        state.pending = null; state.acked = [...state.acked, batchId].slice(-32); save(state)
        return noHit({ acked: true, batchId })
      })
    } catch (e) { return failed(e) }
  }
  return { poll, ack }
}
