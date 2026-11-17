import { createHash, randomUUID } from 'node:crypto';

const MESSAGE_TTL = 5 * 60_000;
const MAX_TASK_MS = 10 * 60_000;
const MAX_LEDGER = 2048;
const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const failure = (code, error, hint) => ({ ok: false, code, error, hint });
const retryHint = '检查桌面授权与 QQ 设置后，由主人重新发送一条新的电脑操作指令。';
const positiveId = value => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return '';
  const id = String(value ?? '');
  return /^[1-9][0-9]{0,19}$/.test(id) ? id : '';
};
const messageId = value => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return '';
  const id = String(value ?? '');
  return /^-?[1-9][0-9]{0,19}$/.test(id) ? id : '';
};
const bounded = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';

// This is an intent recognizer, never an identity or authority source.
export function ownerDesktopIntent(value) {
  const text = String(value ?? '').trim();
  if (/^(?:取消|停止|终止)(?:当前|这次|本次|我的)?(?:电脑|桌面)(?:操作|任务)?[。！!]?$/u.test(text)) return { kind: 'cancel' };
  if (!text || text.length > 8_000 || /[?？]$/u.test(text)) return null;
  const explicit = /^(?:电脑|桌面)(?:操作|任务)?\s*[:：]\s*(.+)$/su.exec(text)
    ?? /^computer use\s*[:：]\s*(.+)$/isu.exec(text);
  const natural = /^(?:请|麻烦)?(?:你)?(?:帮我)?(?:在|用|操作)?(?:我的|这台)?(?:电脑|桌面)(?:上)?(?:帮我)?(?:打开|关闭|点击|双击|输入|搜索|查找|截图|查看|切换|滚动|播放|暂停|保存|下载|上传|运行|启动|操作|选中|复制|粘贴|移动|拖动|浏览|整理).+/u.test(text);
  return explicit || natural ? { kind: 'command', text } : null;
}

/** Only the real transport caller supplies source; event fields never supply it. */
export function trustedOwnerDesktopMessage({ source, kind, id, event, runtime, now, startedAt = 0 }) {
  if (source !== 'onebot-live' || !event || event.post_type !== 'message' || event.message_type !== kind
      || !['private', 'group'].includes(kind) || event.history || event.replayed || event.isSelf) return null;
  const owner = positiveId(runtime.ownerQQ);
  const self = positiveId(runtime.selfUserId);
  const sender = positiveId(event.user_id);
  const peer = positiveId(id);
  if (!owner || !self || !sender || sender !== owner || sender === self || !peer) return null;
  if (positiveId(event.self_id) !== self) return null;
  if (event.sender?.user_id !== undefined && positiveId(event.sender.user_id) !== sender) return null;
  if (kind === 'private' && (peer !== owner || event.group_id != null)) return null;
  if (kind === 'group' && positiveId(event.group_id) !== peer) return null;
  if (!Array.isArray(event.message) || event.message.length > 100) return null;
  // Reply/forward/card/markdown payloads can contain somebody else's instructions.
  if (event.message.some(seg => !seg || !['text', 'at'].includes(seg.type))) return null;
  const ats = event.message.filter(seg => seg.type === 'at').map(seg => positiveId(seg.data?.qq));
  if (ats.some(target => target !== self) || (kind === 'group' && !ats.includes(self))) return null;
  if (event.message.some(seg => seg.type === 'text' && typeof seg.data?.text !== 'string')) return null;
  const text = event.message.filter(seg => seg.type === 'text').map(seg => seg.data.text).join('').trim();
  if (/\[CQ:|<forward|<reply/i.test(text)) return null;
  const intent = ownerDesktopIntent(text);
  if (!intent) return null;
  const outerId = messageId(event.message_id ?? event.msg_id);
  const sourceTime = Number(event.time) * 1000;
  if (!outerId || !Number.isFinite(sourceTime) || sourceTime <= 0 || sourceTime > now + 5_000
      || now - sourceTime > MESSAGE_TTL || sourceTime < Math.ceil(startedAt / 1000) * 1000) return null;
  return Object.freeze({ ownerQQ: owner, selfUserId: self, conversationKey: kind + ':' + peer,
    sourceMessageId: outerId, sourceReceivedAt: now, sourceTime, ...intent });
}

/** All I/O is injected. Commands and leases are never serialized to the replay ledger. */
export function createOwnerDesktopBroker({ getSettings, getRuntime, now = Date.now, notify = async () => {},
  readLedger = () => [], writeLedger = () => {}, startedAt = now() } = {}) {
  let ledger;
  let storageError = null;
  const tasks = new Map();
  let activeId = '';
  let lastError = null;
  try {
    ledger = readLedger();
    if (!Array.isArray(ledger) || ledger.length > MAX_LEDGER || ledger.some(row => !row
        || !/^[a-f0-9]{64}$/.test(row.digest) || !Number.isFinite(row.until))) throw new Error('invalid ledger');
    ledger = ledger.filter(row => row.until > now()).map(row => ({ digest: row.digest, until: row.until }));
  } catch {
    ledger = [];
    storageError = failure('OWNER_DESKTOP_LEDGER_UNAVAILABLE', '桌面消息去重记录无法读取，已停止接收操作。', '先修复桌面消息去重记录；不要删除记录后重放旧消息。');
  }
  function environment(key) {
    const env = { settings: {}, runtime: {} };
    try { env.runtime = getRuntime(key) || {}; } catch { env.error = failure('OWNER_DESKTOP_POLICY_UNAVAILABLE', '无法读取当前 QQ 授权策略。', retryHint); }
    try { env.settings = getSettings() || {}; } catch { env.error = failure('OWNER_DESKTOP_POLICY_UNAVAILABLE', '无法读取当前桌面授权策略。', retryHint); }
    return env;
  }
  function policy(env, task) {
    if (env.error) return env.error;
    const { settings: s, runtime: r } = env;
    if (s?.enabled !== true || !s.parentSessionId) return failure('OWNER_DESKTOP_DISABLED', '主人电脑操作尚未启用或未选择授权会话。', '在 SurfCore 设置中选择已开启 Computer Use 的管理会话，并启用主人电脑操作。');
    if (r?.mode !== 'reserved2' || r.enabled === false) return failure('OWNER_DESKTOP_MODE', '电脑操作只在二代仿真模式启用时可用。', '恢复二代仿真模式后重新发出指令。');
    if (!positiveId(r.ownerQQ) || (task && positiveId(r.ownerQQ) !== task.ownerQQ)) return failure('OWNER_DESKTOP_OWNER_CHANGED', '主人身份已变化，原任务授权已撤销。', retryHint);
    if (r.allowed !== true || r.blocked === true) return failure('OWNER_DESKTOP_TARGET_BLOCKED', '来源会话或主人已被访问规则禁止。', retryHint);
    if (r.paused || r.silent) return failure('OWNER_DESKTOP_PAUSED', '当前 AI 已暂停或静默，电脑任务已停止。', '恢复 AI 后，由主人重新发送指令。');
    if (r.connected !== true || r.ready !== true) return failure('OWNER_DESKTOP_OFFLINE', 'QQ 或 DSH 连接不可用，电脑任务已停止。', '恢复连接后重新发送指令；旧任务不会自动恢复。');
    if (task && (task.binding !== binding(env) || task.selfUserId !== positiveId(r.selfUserId))) return failure('OWNER_DESKTOP_AUTH_CHANGED', '任务所属授权或会话代际已变化。', retryHint);
    return null;
  }
  function binding({ settings: s, runtime: r }) {
    return JSON.stringify([s?.enabled, s?.parentSessionId, s?.timeoutMs, s?.authorizationEpoch ?? null,
      positiveId(r?.ownerQQ), positiveId(r?.selfUserId), r?.mode, r?.epoch ?? null, r?.liveSince ?? null]);
  }
  function view(task, command = false) {
    const { id, ownerQQ, conversationKey, sourceMessageId, sourceReceivedAt, expiresAt, status,
      sessionId, completedAt, code, error, hint, notification } = task;
    return { id, ownerQQ, conversationKey, sourceMessageId, sourceReceivedAt, expiresAt, status,
      ...(sessionId ? { sessionId } : {}), ...(completedAt ? { completedAt } : {}),
      ...(code ? { code, error, hint } : {}), ...(notification ? { notification } : {}),
      ...(command ? { text: task.text } : {}) };
  }
  function end(task, status, issue = null) {
    task.status = status;
    task.completedAt = now();
    if (issue) Object.assign(task, { code: issue.code, error: issue.error, hint: issue.hint });
    task.text = '';
    task.leaseId = '';
    if (activeId === task.id) activeId = '';
    while (tasks.size > 30) tasks.delete(tasks.keys().next().value);
  }
  function check(task) {
    const issue = now() >= task.expiresAt
      ? failure('OWNER_DESKTOP_EXPIRED', '电脑任务已超时，原授权已撤销。', retryHint)
      : policy(environment(task.conversationKey), task);
    if (issue) { lastError = issue; end(task, 'cancelled', issue); }
    return issue;
  }
  function refresh() {
    if (activeId) { const task = tasks.get(activeId); if (task) check(task); }
  }
  async function report(task, text) {
    // The fixed original destination is never taken from a completion request.
    const env = environment(task.conversationKey);
    const r = env.runtime;
    if (env.error || positiveId(r?.ownerQQ) !== task.ownerQQ || positiveId(r?.selfUserId) !== task.selfUserId
        || r?.allowed !== true || r.blocked || r.paused || r.silent || r.connected !== true || r.mode !== 'reserved2') {
      task.notification = failure('OWNER_DESKTOP_NOTICE_BLOCKED', '任务回执被当前 QQ 权限阻止。', '在设置页查看任务结果；恢复权限不会自动补发。');
      return;
    }
    try {
      const sent = await notify(task.conversationKey, text, { ownerQQ: task.ownerQQ, selfUserId: task.selfUserId, epoch: env.runtime.epoch, authorizationEpoch: env.settings?.authorizationEpoch });
      if (sent?.ok === false) throw new Error('notice rejected');
      task.notification = { ok: true };
    } catch {
      task.notification = failure('OWNER_DESKTOP_NOTICE_FAILED', '电脑任务回执发送失败。', '请在设置页查看任务状态；不要重复执行原任务。');
    }
  }
  function consume(message) {
    if (storageError) return storageError;
    const digest = createHash('sha256').update(JSON.stringify([message.selfUserId, message.conversationKey, message.sourceMessageId])).digest('hex');
    const retained = ledger.filter(row => row.until > now());
    if (retained.some(row => row.digest === digest)) return failure('OWNER_DESKTOP_REPLAY', '这条电脑指令已经处理过。', '如需再次操作，请发送一条新消息。');
    if (retained.length >= MAX_LEDGER) return failure('OWNER_DESKTOP_LEDGER_FULL', '短时间电脑指令过多，已停止接收。', '五分钟后再发送新的指令。');
    const next = [...retained, { digest, until: Math.max(now(), message.sourceTime) + MESSAGE_TTL + 5_000 }];
    try { writeLedger(next.map(row => ({ ...row }))); }
    catch {
      storageError = failure('OWNER_DESKTOP_LEDGER_UNAVAILABLE', '电脑消息去重记录写入失败，未启动任务。', '修复状态目录写入权限后重启桥接，再发送新指令。');
      return storageError;
    }
    ledger = next;
    return null;
  }
  async function ingest(input) {
    const key = input.kind + ':' + String(input.id ?? '');
    const env = environment(key);
    const liveSince = Math.max(startedAt, Number(env.runtime.liveSince) || 0);
    const verified = trustedOwnerDesktopMessage({ ...input, runtime: env.runtime, now: now(), startedAt: liveSince });
    if (!verified) return { ok: true, handled: false };
    const message = { ...verified };
    const consumed = consume(message);
    if (consumed) {
      lastError = consumed;
      if (consumed.code !== 'OWNER_DESKTOP_REPLAY') await report(message, consumed.error + '\n' + consumed.hint);
      return { ...consumed, handled: true };
    }
    refresh();
    if (message.kind === 'cancel') {
      const task = activeId ? tasks.get(activeId) : null;
      if (task && task.ownerQQ === message.ownerQQ) {
        end(task, 'cancelled', failure('OWNER_DESKTOP_CANCELLED', '主人已取消电脑任务。', '需要继续时请重新发送指令。'));
        await report(message, '已取消电脑任务；在途桌面动作无法撤回，后续动作已禁止。');
        return { ok: true, handled: true, task: view(task) };
      }
      await report(message, '当前没有进行中的电脑任务。');
      return { ok: true, handled: true };
    }
    const denied = policy(env);
    if (denied) { lastError = denied; await report(message, denied.error + '\n' + denied.hint); return { ...denied, handled: true }; }
    if (activeId) {
      const busy = failure('OWNER_DESKTOP_BUSY', '已有电脑任务进行中，没有排队执行本条指令。', '等待当前任务结束，或发送“取消电脑任务”，再发一条新指令。');
      lastError = busy; await report(message, busy.error + '\n' + busy.hint); return { ...busy, handled: true };
    }
    const timeout = Number(env.settings.timeoutMs);
    const task = { ...message, id: randomUUID(), status: 'pending', leaseId: '', binding: binding(env),
      expiresAt: now() + Math.min(MAX_TASK_MS, Number.isFinite(timeout) && timeout > 0 ? timeout : MAX_TASK_MS) };
    tasks.set(task.id, task); activeId = task.id; lastError = null;
    await report(task, '已收到电脑操作任务，将在独立会话执行。发送“取消电脑任务”可停止后续动作。');
    return { ok: true, handled: true, task: view(task) };
  }
  function status() {
    refresh();
    const env = environment('');
    return { ok: true, enabled: env.settings?.enabled === true, activeTaskId: activeId || null,
      tasks: [...tasks.values()].map(task => view(task)), lastError: storageError || env.error || lastError };
  }
  function pending() {
    refresh();
    return { ok: true, tasks: [...tasks.values()].filter(task => task.status === 'pending').map(task => view(task)) };
  }
  function lookup(body, claimed = true) {
    if (!body || typeof body.taskId !== 'string' || typeof body.leaseId !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(body.leaseId)) return { error: failure('OWNER_DESKTOP_BAD_REQUEST', '任务编号或租约格式无效。', '请由桌面运行时提交任务编号和一次性租约。') };
    const task = tasks.get(body.taskId);
    if (!task) return { error: failure('OWNER_DESKTOP_NOT_FOUND', '任务不存在或桥接已重启。', retryHint) };
    if (TERMINAL.has(task.status)) return { error: failure('OWNER_DESKTOP_FINISHED', '任务已经结束，原授权不能再使用。', retryHint) };
    if (claimed && (task.status !== 'running' || task.leaseId !== body.leaseId)) return { error: failure('OWNER_DESKTOP_LEASE_MISMATCH', '任务租约不匹配。', '停止当前执行器，不要复用其他任务的租约。') };
    const issue = check(task);
    return issue ? { error: issue } : { task };
  }
  function claim(body) {
    const found = lookup(body, false);
    if (found.error) return found.error;
    const task = found.task;
    if (task.status !== 'pending') return failure('OWNER_DESKTOP_ALREADY_CLAIMED', '任务已经被执行器领取。', '禁止再次启动同一个任务。');
    task.status = 'running'; task.leaseId = body.leaseId;
    return { ok: true, task: view(task, true) };
  }
  function validate(body) {
    const found = lookup(body);
    return found.error || { ok: true, task: view(found.task) };
  }
  async function complete(body) {
    if (!['done', 'failed', 'cancelled'].includes(body?.status)) return failure('OWNER_DESKTOP_BAD_REQUEST', '任务结束状态无效。', '请使用 done、failed 或 cancelled。');
    const found = lookup(body);
    if (found.error) return found.error;
    const task = found.task;
    const issue = body.status === 'done' ? null : failure(bounded(body.code, 100) || 'OWNER_DESKTOP_EXECUTION_FAILED',
      bounded(body.error, 500) || '电脑任务未完成。', bounded(body.hint, 500) || retryHint);
    if (typeof body.sessionId === 'string') task.sessionId = body.sessionId.slice(0, 150);
    const output = bounded(body.output, 3000).trim();
    end(task, body.status, issue);
    const label = body.status === 'done' ? '电脑任务已完成。' : body.status === 'cancelled' ? '电脑任务已取消。' : '电脑任务失败。';
    await report(task, label + (output ? '\n' + output : '') + (issue ? '\n' + issue.error + '\n' + issue.hint : ''));
    return { ok: true, task: view(task) };
  }
  function revoke(reason = '授权已撤销', conversationKey = '') {
    const task = activeId ? tasks.get(activeId) : null;
    if (!task || (conversationKey && task.conversationKey !== conversationKey)) return { ok: true, cancelled: 0 };
    const issue = failure('OWNER_DESKTOP_REVOKED', bounded(reason, 300), retryHint);
    end(task, 'cancelled', issue); lastError = issue;
    return { ok: true, cancelled: 1, task: view(task) };
  }
  function cancel(body = {}) {
    if (body.taskId && activeId !== body.taskId) return failure('OWNER_DESKTOP_NOT_ACTIVE', '指定任务已不再运行。', '刷新任务状态后再操作。');
    if (body.leaseId && tasks.get(activeId)?.leaseId !== body.leaseId) return failure('OWNER_DESKTOP_LEASE_MISMATCH', '任务租约不匹配。', '停止当前执行器。');
    return revoke('管理端已取消电脑任务。');
  }
  return { ingest, status, pending, claim, validate, complete, cancel, revoke };
}

/** Call only after the console authentication / loopback / CSRF gates. No API can mint a task. */
export async function handleOwnerDesktopRoute(broker, req, url, { readBody, sendJson }) {
  if (req.headers?.['x-agent-token'] !== undefined || req.headers?.['x-agent-call'] !== undefined) {
    sendJson(failure('OWNER_DESKTOP_CONSOLE_ONLY', '电脑任务接口仅管理端可用。', 'QQ 模型不能创建、领取或授权电脑任务。'), 403); return;
  }
  const action = url.pathname.slice('/api/owner-desktop/'.length);
  if (req.method === 'GET' && ['status', 'pending'].includes(action)) { sendJson(broker[action]()); return; }
  if (req.method !== 'POST' || !['claim', 'validate', 'complete', 'cancel'].includes(action)) {
    sendJson(failure('OWNER_DESKTOP_NOT_FOUND', '未知电脑任务接口或请求方法。', '仅可查询、领取、校验、完成或取消已存在的主人任务。'), 404); return;
  }
  try {
    const body = await readBody();
    const allowed = action === 'complete' ? ['taskId', 'leaseId', 'status', 'output', 'code', 'error', 'hint', 'sessionId'] : ['taskId', 'leaseId'];
    if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some(key => !allowed.includes(key))) {
      sendJson(failure('OWNER_DESKTOP_BAD_REQUEST', '电脑任务请求包含不允许的字段。', '任务正文、主人和发送目标只能来自实时 QQ 消息，不能由接口提供。'), 400); return;
    }
    const result = await broker[action](body);
    sendJson(result, result.ok ? 200 : result.code === 'OWNER_DESKTOP_BAD_REQUEST' ? 400 : 409);
  } catch {
    sendJson(failure('OWNER_DESKTOP_REQUEST_FAILED', '电脑任务请求无法处理。', '检查请求 JSON 和桥接状态后刷新；不要重新创建旧任务。'), 400);
  }
}
