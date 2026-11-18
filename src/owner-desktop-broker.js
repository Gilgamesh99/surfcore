import { createHash, randomUUID } from 'node:crypto';
import { normalizeOwnerDesktopTimeout, OWNER_DESKTOP_PENDING_TTL_MS } from './owner-desktop-conversation-options.js';

const MESSAGE_TTL = 5 * 60_000;
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
  if (/^(?:请)?(?:继续|接着)(?:上次|刚才|之前|当前)?的?(?:电脑|桌面)(?:操作|任务)(?:[，,:：\s].*)?[。！!]?$/su.test(text)) return { kind: 'continue', text };
  const explicit = /^(?:电脑|桌面)(?:操作|任务)?\s*[:：]\s*(.+)$/su.exec(text)
    ?? /^computer use\s*[:：]\s*(.+)$/isu.exec(text);
  const natural = /^(?:请|麻烦)?\s*(?:你)?\s*(?:帮我)?\s*(?:在|用|使用|操作|控制)?\s*(?:我的|这台)?(?:电脑|桌面)(?:上)?\s*(?:帮我)?\s*[,，:：]?\s*(.+)$/su.exec(text);
  const namedTool = /^(?:请|麻烦)?\s*(?:你)?\s*(?:帮我)?\s*(?:用|使用|通过)\s*(?:Windows[\s-]*MCP|Computer\s+Use)(?:\s*工具)?\s*(?:来|帮我)?\s*(?:(?:控制|操作|在)\s*(?:我的|这台)?(?:电脑|桌面)(?:上)?\s*[,，:：]?\s*)?(?:来\s*)?(.+)$/isu.exec(text);
  const body = (explicit ?? natural ?? namedTool)?.[1].trim();
  if (!body) return null;
  // A tool name is not enough: require a direct action, never a quoted/conditional/question example.
  const prose = body.replace(/https?:\/\/[^\s<>"'“”‘’，。！？；]+/giu, '[URL]');
  if (/^(?:(?:请|麻烦)\s*)?(?:你\s*)?(?:先\s*)?(?:不要|不用|别|勿|禁止|取消|停止|终止|如果|假如|假设|要是|若|等我|有人说|例如|比如|示例|[“‘「『"'])/u.test(prose)
      || /[?？]|(?:吗|么|呢)[。！!]*$|的话(?:[，,\s]|请|需要|要|先|再|才|就|$)/u.test(prose)
      || /(?:需要什么(?:权限|条件)|要多久)[。！!]*$/u.test(prose)
      || /(?:^|[，,。；;])\s*(?:这(?:只)?是(?:举例|示例)|(?:请)?(?:不要|别|勿)执行)/u.test(prose)) return null;
  if (!explicit && !/^(?:打开|关闭|点击|双击|输入|搜索|查找|截图|查看|切换|滚动|播放|暂停|保存|下载|上传|运行|启动|操作|选中|复制|粘贴|移动|拖动|浏览|整理).+/su.test(body)) return null;
  return { kind: 'command', text };
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
  readLedger = () => [], writeLedger = () => {}, prepareSession, startedAt = now() } = {}) {
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
    try {
      const settings = getSettings() || {};
      env.settings = { ...settings, timeoutMs: normalizeOwnerDesktopTimeout(settings.timeoutMs) };
    } catch (error) {
      env.error = error?.code === 'owner-desktop.timeout-invalid'
        ? failure('OWNER_DESKTOP_TIMEOUT_INVALID', error.message, error.hint)
        : failure('OWNER_DESKTOP_POLICY_UNAVAILABLE', '无法读取当前桌面授权策略。', retryHint);
    }
    return env;
  }
  function policy(env, task) {
    if (env.error) return env.error;
    const { settings: s, runtime: r } = env;
    if (s?.enabled !== true || !s.authorizationEpoch) return failure('OWNER_DESKTOP_DISABLED', '主人电脑操作尚未启用。', '在 SurfCore 设置中启用主人电脑操作，并确认 Windows Computer Use 人类开关已开启。');
    if (r?.mode !== 'reserved2' || r.enabled === false) return failure('OWNER_DESKTOP_MODE', '电脑操作只在二代仿真模式启用时可用。', '恢复二代仿真模式后重新发出指令。');
    if (!positiveId(r.ownerQQ) || (task && positiveId(r.ownerQQ) !== task.ownerQQ)) return failure('OWNER_DESKTOP_OWNER_CHANGED', '主人身份已变化，原任务授权已撤销。', retryHint);
    if (r.allowed !== true || r.blocked === true) return failure('OWNER_DESKTOP_TARGET_BLOCKED', '来源会话或主人已被访问规则禁止。', retryHint);
    if (r.paused || r.silent) return failure('OWNER_DESKTOP_PAUSED', '当前 AI 已暂停或静默，电脑任务已停止。', '恢复 AI 后，由主人重新发送指令。');
    if (r.connected !== true || r.ready !== true) return failure('OWNER_DESKTOP_OFFLINE', 'QQ 或 DSH 连接不可用，电脑任务已停止。', '恢复连接后重新发送指令；旧任务不会自动恢复。');
    if (task && (task.binding !== binding(env) || task.selfUserId !== positiveId(r.selfUserId))) return failure('OWNER_DESKTOP_AUTH_CHANGED', '任务所属授权或会话代际已变化。', retryHint);
    if (task?.sourceSessionId && task.sourceSessionId !== r.sessionId) return failure('OWNER_DESKTOP_SESSION_CHANGED', '原 QQ 会话已变化，电脑任务已停止。', retryHint);
    return null;
  }
  function binding({ settings: s, runtime: r }) {
    return JSON.stringify([s?.enabled, s?.timeoutMs, s?.authorizationEpoch ?? null,
      positiveId(r?.ownerQQ), positiveId(r?.selfUserId), r?.mode, r?.epoch ?? null, r?.liveSince ?? null]);
  }
  function view(task, command = false) {
    const fields = ['id', 'ownerQQ', 'selfUserId', 'conversationKey', 'sourceMessageId', 'sourceReceivedAt', 'sourceTime',
      'timeoutMs', 'claimExpiresAt', 'claimedAt', 'expiresAt', 'status', 'phase', 'sourceSessionId', 'sessionId', 'preparedId', 'messageId', 'turnId',
      'previousTaskId', 'continuationRequested', 'completedAt', 'settledAt', 'closureStatus', 'executionStopped', 'code', 'error', 'hint', 'ackNotification', 'startNotification', 'progressNotification', 'lastProgressAt', 'terminalNotification'];
    const result = Object.fromEntries(fields.filter(key => task[key] !== undefined).map(key => [key, task[key]]));
    // Backward-compatible display alias; the two receipt phases remain independently visible.
    result.notification = task.terminalNotification ?? task.ackNotification;
    if (command) result.text = task.text;
    return result;
  }
  const leaseDigest = lease => createHash('sha256').update(lease).digest('hex');
  const awaitingStop = task => !task.settledAt && (Boolean(task.messageId) || task.executionStopped === false);
  const stoppingIssue = () => failure('OWNER_DESKTOP_PREVIOUS_STOPPING', '先前电脑任务尚未确认停止。', '等待宿主确认旧回合已停止后，再处理新任务；不要并行启动。');
  function end(task, status, issue = null, output = '') {
    if (TERMINAL.has(task.status)) return task.terminalPromise;
    task.status = status;
    task.phase = awaitingStop(task) ? 'stopping' : 'finished';
    task.completedAt = now();
    if (issue) Object.assign(task, { code: issue.code, error: issue.error, hint: issue.hint });
    task.closureLeaseDigest = task.leaseId ? leaseDigest(task.leaseId) : '';
    task.text = ''; task.preparedPrompt = ''; task.leaseId = '';
    if (activeId === task.id) activeId = '';
    const label = status === 'done' ? '电脑任务已完成。' : status === 'cancelled' ? '电脑任务已取消。' : '电脑任务失败。';
    task.terminalPromise = report(task, label + (output ? '\n' + output : '') + (issue ? '\n' + issue.error + '\n' + issue.hint : ''), 'terminalNotification');
    while (tasks.size > 30) {
      const removable = [...tasks.values()].find(row => row.id !== activeId && TERMINAL.has(row.status) && !awaitingStop(row));
      if (!removable) break;
      tasks.delete(removable.id);
    }
    return task.terminalPromise;
  }
  function check(task) {
    const deadline = task.status === 'pending' ? task.claimExpiresAt : task.expiresAt;
    const unlimited = task.status === 'running' && task.timeoutMs === 0 && deadline === null;
    const issue = !unlimited && !Number.isSafeInteger(deadline)
      ? failure('OWNER_DESKTOP_DEADLINE_INVALID', '电脑任务期限无效，原授权已撤销。', retryHint)
      : !unlimited && now() >= deadline
        ? failure('OWNER_DESKTOP_EXPIRED', task.status === 'pending' ? '电脑指令未及时领取，原授权已过期。' : '电脑任务已超时，原授权已撤销。', retryHint)
        : policy(environment(task.conversationKey), task);
    if (issue) { lastError = issue; end(task, 'cancelled', issue); }
    return issue;
  }
  function refresh() {
    if (activeId) { const task = tasks.get(activeId); if (task) check(task); }
  }
  async function report(task, text, field = 'ackNotification') {
    const env = environment(task.conversationKey);
    const r = env.runtime;
    const save = result => { task[field] = { ...result, at: now() }; };
    save({ ok: null, status: 'sending' });
    if (env.error || positiveId(r?.ownerQQ) !== task.ownerQQ || positiveId(r?.selfUserId) !== task.selfUserId
        || r?.allowed !== true || r.blocked || r.paused || r.silent || r.connected !== true || r.mode !== 'reserved2') {
      save(failure('OWNER_DESKTOP_NOTICE_BLOCKED', '任务回执被当前 QQ 权限阻止。', '在设置页查看任务结果；恢复权限不会自动补发。'));
      return;
    }
    try {
      const sent = await notify(task.conversationKey, text, { ownerQQ: task.ownerQQ, selfUserId: task.selfUserId, epoch: r.epoch, authorizationEpoch: env.settings?.authorizationEpoch,
        ...(['startNotification', 'progressNotification'].includes(field) ? { isCurrent: () => !TERMINAL.has(task.status) && !check(task) } : {}) });
      if (sent?.ok === false) throw new Error('notice rejected');
      save({ ok: true, status: 'sent' });
    } catch {
      save(failure('OWNER_DESKTOP_NOTICE_FAILED', '电脑任务回执发送失败。', '请在设置页查看任务状态；不要重复执行原任务。'));
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
    const previous = [...tasks.values()].reverse().find(task => task.conversationKey === key
      && task.ownerQQ === message.ownerQQ && task.selfUserId === message.selfUserId);
    if (message.kind === 'cancel') {
      const task = activeId ? tasks.get(activeId) : null;
      if (task && task.ownerQQ === message.ownerQQ) {
        await end(task, 'cancelled', failure('OWNER_DESKTOP_CANCELLED', '主人已取消电脑任务；在途动作无法撤回，后续动作已禁止。', '需要继续时发送“继续电脑任务”或新的电脑指令。'));
        if (key !== task.conversationKey) await report(message, '已取消电脑任务；结果保留在任务原会话。');
        return { ok: true, handled: true, task: view(task) };
      }
      const summary = previous ? '最近的电脑任务状态：' + ({ done: '已完成', failed: '失败', cancelled: '已取消' }[previous.status] || previous.status)
        + (previous.error ? '\n' + previous.error : '') + (previous.hint ? '\n' + previous.hint : '') : '当前没有进行中的电脑任务，也没有本会话的近期任务记录。';
      await report(message, summary);
      return { ok: true, handled: true, ...(previous ? { task: view(previous) } : {}) };
    }
    const denied = policy(env);
    if (denied) { lastError = denied; await report(message, denied.error + '\n' + denied.hint); return { ...denied, handled: true }; }
    // The host resolves continuation from its persistent exact-source catalog.
    // In-memory task history is only a correlation hint and vanishes on restart.
    if (activeId) {
      const active = tasks.get(activeId);
      if (active.conversationKey !== key || active.ownerQQ !== message.ownerQQ) {
        const busy = failure('OWNER_DESKTOP_BUSY', '另一会话已有电脑任务进行中，没有排队执行本条指令。', '回到原会话继续，或发送“取消电脑任务”后再发新指令。');
        lastError = busy; await report(message, busy.error + '\n' + busy.hint); return { ...busy, handled: true };
      }
      // Revoke synchronously before admitting the new live instruction. Never await between them.
      end(active, 'cancelled', failure('OWNER_DESKTOP_REPLACED', '主人发来新指令，旧任务授权已撤销。', '将按主人新指令继续独立桌面会话。'));
    }
    // Even unlimited execution must be claimed while its original live message is fresh.
    const claimExpiresAt = Math.min(message.sourceReceivedAt + OWNER_DESKTOP_PENDING_TTL_MS, message.sourceTime + MESSAGE_TTL);
    const task = { ...message, id: randomUUID(), status: 'pending', phase: 'pending', leaseId: '', binding: binding(env),
      timeoutMs: env.settings.timeoutMs, claimExpiresAt, claimedAt: null, expiresAt: claimExpiresAt,
      continuationRequested: message.kind === 'continue' };
    if (previous) task.previousTaskId = previous.id;
    tasks.set(task.id, task); activeId = task.id; lastError = null;
    await report(task, '已收到电脑操作任务，将在独立桌面会话中执行，进度和结果会回到这里。发送“继续电脑任务”可续接，发送“取消电脑任务”可停止后续动作。');
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
    const blocked = [...tasks.values()].some(awaitingStop);
    return { ok: true, tasks: blocked ? [] : [...tasks.values()].filter(task => task.status === 'pending').map(task => view(task)), ...(blocked ? { blocked: stoppingIssue() } : {}) };
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
    if ([...tasks.values()].some(other => other.id !== task.id && awaitingStop(other))) return stoppingIssue();
    task.status = 'running'; task.phase = 'claimed'; task.leaseId = body.leaseId;
    task.claimedAt = now();
    task.expiresAt = task.timeoutMs === 0 ? null : task.claimedAt + task.timeoutMs;
    return { ok: true, task: view(task, true) };
  }
  async function prepare(body) {
    const found = lookup(body);
    if (found.error) return found.error;
    const task = found.task;
    if (task.preparedId) return { ok: true, task: view(task), sourceSessionId: task.sourceSessionId, preparedId: task.preparedId, prompt: task.preparedPrompt };
    if (task.preparing) return task.preparing;
    task.phase = 'preparing';
    task.preparing = (async () => {
      try {
        if (typeof prepareSession !== 'function') throw new Error('prepare unavailable');
        const result = await prepareSession(Object.freeze(view(task, true)));
        const current = lookup(body);
        if (current.error) return current.error;
        if (!result || typeof result.sourceSessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,150}$/.test(result.sourceSessionId)
            || typeof result.prompt !== 'string' || !result.prompt.trim()) throw new Error('invalid prepared session');
        task.sourceSessionId = result.sourceSessionId;
        const issue = check(task);
        if (issue) return issue;
        task.preparedId = randomUUID(); task.preparedPrompt = result.prompt; task.phase = 'prepared';
        return { ok: true, task: view(task), sourceSessionId: task.sourceSessionId, preparedId: task.preparedId, prompt: task.preparedPrompt };
      } catch (error) {
        if (TERMINAL.has(task.status)) return failure('OWNER_DESKTOP_FINISHED', '准备期间任务已结束。', retryHint);
        const issue = failure('OWNER_DESKTOP_PREPARE_FAILED', '原 QQ 会话准备失败，尚未发送电脑任务。', '检查 QQ 会话预设、人格和 DSH 连接后，重新发送指令。');
        lastError = issue; await end(task, 'failed', issue); return issue;
      }
    })();
    return task.preparing;
  }
  function bind(body) {
    const found = lookup(body);
    if (found.error) return found.error;
    const task = found.task;
    if (!task.preparedId || body.preparedId !== task.preparedId) return failure('OWNER_DESKTOP_PREPARE_MISMATCH', '原会话准备记录不匹配。', '停止发送，重新读取当前任务状态。');
    if (typeof body.messageId !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(body.messageId)) return failure('OWNER_DESKTOP_BAD_REQUEST', '宿主消息编号格式无效。', '由运行时预留唯一宿主消息编号后绑定。');
    if (typeof body.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,150}$/.test(body.sessionId) || body.sessionId === task.sourceSessionId) return failure('OWNER_DESKTOP_BAD_REQUEST', '桌面目标必须是宿主核验的独立会话。', '使用官方桌面子会话编号，不能在来源 QQ 会话中执行。');
    if (task.messageId) return task.messageId === body.messageId && task.sessionId === body.sessionId
      ? { ok: true, task: view(task) } : failure('OWNER_DESKTOP_ALREADY_BOUND', '任务已绑定其他会话或消息，禁止再次投递。', '使用原绑定核对执行状态，不要重发。');
    if ([...tasks.values()].some(other => other.id !== task.id && awaitingStop(other))) return stoppingIssue();
    task.sessionId = body.sessionId; task.messageId = body.messageId; task.phase = 'bound';
    return { ok: true, task: view(task) };
  }
  async function started(body) {
    const found = lookup(body);
    if (found.error) return found.error;
    const task = found.task;
    if (!task.messageId || body.messageId !== task.messageId) return failure('OWNER_DESKTOP_MESSAGE_MISMATCH', '执行回合的消息与原任务不匹配。', '停止当前回合，不要使用其他消息激活任务。');
    const validTurn = typeof body.turnId === 'string' ? body.turnId.length > 0 && body.turnId.length <= 150
      : Number.isSafeInteger(body.turnId) && body.turnId >= 0;
    if (!validTurn) return failure('OWNER_DESKTOP_BAD_REQUEST', '宿主回合编号格式无效。', '使用实际领取任务消息的宿主回合编号。');
    if (task.turnId !== undefined && task.turnId !== body.turnId) return failure('OWNER_DESKTOP_TURN_MISMATCH', '任务已登记其他执行回合。', '停止新回合，重新发送明确的电脑指令。');
    task.turnId = body.turnId; task.phase = 'executing';
    task.startPromise ??= report(task, '电脑任务已开始，执行过程保留在独立桌面会话。\n桌面会话：' + task.sessionId + '\n可在 DSH 打开该会话查看；这里可以继续聊天或发送“取消电脑任务”。', 'startNotification');
    await task.startPromise;
    return { ok: true, task: view(task) };
  }
  function ownsTurn(sessionId, turnId) {
    return turnId !== undefined && [...tasks.values()].some(task => task.sessionId === sessionId && task.turnId === turnId);
  }
  async function progress(body) {
    const found = lookup(body);
    if (found.error) return found.error;
    const task = found.task;
    if (!task.messageId || task.turnId === undefined) return failure('OWNER_DESKTOP_NOT_STARTED', '任务尚未进入已绑定的桌面回合。', '先核对宿主消息与回合绑定，再报告进度。');
    if (typeof body.summary !== 'string' || !body.summary.trim() || body.summary.length > 500) return failure('OWNER_DESKTOP_BAD_REQUEST', '桌面进度必须是 1 至 500 字的简短摘要。', '只回传当前进度；截图和详细记录保留在桌面会话。');
    const summary = body.summary.trim();
    const digest = createHash('sha256').update(summary).digest('hex');
    if (task.progressDigest === digest || (task.lastProgressAt !== undefined && now() - task.lastProgressAt < 5000)) return { ok: true, skipped: true, task: view(task) };
    task.progressDigest = digest; task.lastProgressAt = now();
    await report(task, '电脑任务进度：' + summary, 'progressNotification');
    return task.progressNotification.ok === false ? { ...task.progressNotification, task: view(task) } : { ok: true, task: view(task) };
  }
  function validate(body) {
    const found = lookup(body);
    return found.error || { ok: true, task: view(found.task) };
  }
  async function complete(body) {
    if (!['done', 'failed', 'cancelled'].includes(body?.status)) return failure('OWNER_DESKTOP_BAD_REQUEST', '任务结束状态无效。', '请使用 done、failed 或 cancelled。');
    let found = lookup(body);
    // An ended lease can only acknowledge shutdown. It cannot amend the terminal outcome,
    // send another receipt, restore authority, or provide a different session binding.
    const closed = tasks.get(body.taskId);
    if (found.error && closed && TERMINAL.has(closed.status) && typeof body.leaseId === 'string'
        && closed.closureLeaseDigest && closed.closureLeaseDigest === leaseDigest(body.leaseId)) {
      if (body.sessionId !== undefined && body.sessionId !== closed.sessionId) return failure('OWNER_DESKTOP_SESSION_CHANGED', '停止证明的会话与原任务不匹配。', '使用原任务绑定的桌面会话，不要提供其他会话。');
      if (!closed.settledAt && body.executionStopped === false) {
        closed.executionStopped = false; closed.phase = 'stopping';
      } else if (!closed.settledAt && (body.executionStopped === true || (!closed.messageId && closed.executionStopped !== false))) {
        closed.executionStopped = true; closed.settledAt = now(); closed.closureStatus = body.status; closed.phase = 'finished';
      }
      await closed.terminalPromise;
      return { ok: true, late: true, task: view(closed) };
    }
    if (found.error) return found.error;
    const task = found.task;
    if (body.sessionId !== undefined && body.sessionId !== task.sessionId) return failure('OWNER_DESKTOP_SESSION_CHANGED', '结束回执的会话与原任务不匹配。', '使用绑定阶段记录的桌面会话编号。');
    if (body.status === 'done' && !task.messageId) return failure('OWNER_DESKTOP_NOT_BOUND', '任务尚未绑定宿主消息，不能报告成功。', '先完成来源会话准备与桌面消息绑定。');
    const issue = body.status === 'done' ? null : failure(bounded(body.code, 100) || 'OWNER_DESKTOP_EXECUTION_FAILED',
      bounded(body.error, 500) || '电脑任务未完成。', bounded(body.hint, 500) || retryHint);
    task.executionStopped = body.executionStopped === true || (body.executionStopped !== false && !task.messageId);
    if (task.executionStopped) task.settledAt = now();
    task.closureStatus = body.status;
    const summary = bounded(body.output, 500).trim();
    const more = typeof body.output === 'string' && body.output.length > 500 && task.sessionId
      ? '\n完整结果保留在桌面会话：' + task.sessionId : '';
    await end(task, body.status, issue, summary + more);
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
  return { ingest, status, pending, claim, prepare, bind, started, progress, validate, complete, cancel, revoke, ownsTurn };
}

/** Call only after the console authentication / loopback / CSRF gates. No API can mint a task. */
export async function handleOwnerDesktopRoute(broker, req, url, { readBody, sendJson }) {
  if (req.headers?.['x-agent-token'] !== undefined || req.headers?.['x-agent-call'] !== undefined) {
    sendJson(failure('OWNER_DESKTOP_CONSOLE_ONLY', '电脑任务接口仅管理端可用。', 'QQ 模型不能创建、领取或授权电脑任务。'), 403); return;
  }
  const action = url.pathname.slice('/api/owner-desktop/'.length);
  if (req.method === 'GET' && ['status', 'pending'].includes(action)) { sendJson(broker[action]()); return; }
  if (req.method !== 'POST' || !['claim', 'prepare', 'bind', 'started', 'progress', 'validate', 'complete', 'cancel'].includes(action)) {
    sendJson(failure('OWNER_DESKTOP_NOT_FOUND', '未知电脑任务接口或请求方法。', '仅可查询、领取、校验、完成或取消已存在的主人任务。'), 404); return;
  }
  try {
    const body = await readBody();
    const allowed = action === 'complete' ? ['taskId', 'leaseId', 'status', 'output', 'code', 'error', 'hint', 'sessionId', 'executionStopped']
      : action === 'bind' ? ['taskId', 'leaseId', 'preparedId', 'sessionId', 'messageId']
      : action === 'started' ? ['taskId', 'leaseId', 'messageId', 'turnId']
      : action === 'progress' ? ['taskId', 'leaseId', 'summary'] : ['taskId', 'leaseId'];
    if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some(key => !allowed.includes(key))) {
      sendJson(failure('OWNER_DESKTOP_BAD_REQUEST', '电脑任务请求包含不允许的字段。', '任务正文、主人和发送目标只能来自实时 QQ 消息，不能由接口提供。'), 400); return;
    }
    const result = await broker[action](body);
    sendJson(result, result.ok ? 200 : result.code === 'OWNER_DESKTOP_BAD_REQUEST' ? 400 : 409);
  } catch {
    sendJson(failure('OWNER_DESKTOP_REQUEST_FAILED', '电脑任务请求无法处理。', '检查请求 JSON 和桥接状态后刷新；不要重新创建旧任务。'), 400);
  }
}
