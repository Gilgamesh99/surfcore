import { randomUUID } from 'node:crypto';
import { normalizeOwnerDesktopTimeout, OWNER_DESKTOP_DEFAULT_TIMEOUT_MS, OWNER_DESKTOP_PENDING_TTL_MS } from '../../../src/owner-desktop-config.js';
import { armOwnerDesktopBoundary, isOwnerDesktopTool } from '../../../dsh/agent-presets/owner-desktop/owner-desktop-boundary.mjs';
export { isOwnerDesktopTool };

const POLL_MS = 2_000;
const WORKER_LABEL = 'SurfCore owner desktop task';
const WORKER_PRESET = 'owner-desktop';
// Cordis exports this symbol; each ctx.get/serviceFor read may return a new tracing proxy.
const SERVICE_ORIGINAL = Symbol.for('cordis.original');
function serviceIdentity(value) { return value?.[SERVICE_ORIGINAL] ?? value; }
function safeService(ctx, name) {
  try { return typeof ctx?.get === 'function' ? ctx.get(name) : undefined; } catch { return undefined; }
}

function failure(code, error, hint) { return { ok: false, code, error, hint }; }
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function sessionId(agent) { return agent?.session?.id ?? agent?.id; }
function sessionEvents(session) {
  try { return typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : null; } catch { return null; }
}
function textOf(message) {
  if (!Array.isArray(message?.content)) return null;
  if (message.content.length !== 1 || message.content[0]?.type !== 'text') return null;
  return message.content[0].text;
}
function outputText(result) {
  return (Array.isArray(result?.output) ? result.output : [])
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n').slice(0, 4000);
}

/** Host-only owner-task consumer. Never installs or changes Windows grants.
 * bridge is callBridge(path, options); all dependencies are injectable for offline tests.
 * stop() pauses polling and drains cancellation; start() resumes after settings are saved.
 */
export function installOwnerDesktopRuntime(ctx, {
  getSettings, getOwnerQQ, bridge, isManagedAgent: isOtherManaged = () => false,
  registerWorkerSession, isWorkerSession, getPresetStatus,
  now = Date.now, newLeaseId = randomUUID, newChildId = randomUUID, autoStart = true,
  setTimer = setTimeout, clearTimer = clearTimeout, onStatus = () => {},
} = {}) {
  let active = null;
  let pollTimer = null;
  let inFlight = null;
  let paused = !autoStart;
  let disposed = false;
  let lastError = null;
  let lastResult = null;
  const ownedAgents = new WeakSet();
  const ownedSessions = new Set();
  const listeners = [];
  let hooksReady = false;
  const agentRegistry = safeService(ctx, 'agents');
  const presetRegistry = safeService(ctx, 'agentPresets');
  const toolRegistry = safeService(ctx, 'tools');

  function rootServicesMatch() {
    return [['agents', agentRegistry], ['agentPresets', presetRegistry], ['tools', toolRegistry]]
      .every(([name, bound]) => bound && serviceIdentity(safeService(ctx, name)) === serviceIdentity(bound));
  }
  function validParent(parent, config) {
    try {
      return !!parent && agentRegistry.get(config.parentSessionId) === parent
        && sessionId(parent) === config.parentSessionId && !parent.session?.header?.parentSession
        && parent.session?.header?.origin !== 'subagent' && !isOtherManaged(parent);
    } catch { return false; }
  }
  function subagentService(parent) {
    // Only called after checking the exact live human management parent.
    try {
      const root = safeService(ctx, 'subagents');
      return root ? { service: root, source: 'root' }
        : { service: presetRegistry?.serviceFor?.(parent, 'subagents'), source: 'parent-preset' };
    } catch { return { service: undefined, source: 'parent-preset' }; }
  }
  function supportedProvider(provider) {
    return provider?.inheritsParentContext === false && typeof provider.prepareContinuable === 'function'
      && ['depthLimit', 'agentPreset'].every(key => provider.capabilities?.[key] === true);
  }
  function missingCapabilities(missing) {
    return failure('owner-desktop.host-unavailable', '宿主缺少受控桌面子代理接口：' + missing.join('、') + '。', '更新并重载 SurfCore 与 DSH 后重试。');
  }

  function settings() {
    try {
      const value = getSettings?.() ?? {};
      const timeoutMs = normalizeOwnerDesktopTimeout(value.timeoutMs);
      return { enabled: value.enabled === true, parentSessionId: String(value.parentSessionId ?? ''),
        authorizationEpoch: String(value.authorizationEpoch ?? ''),
        timeoutMs, ownerQQ: String(getOwnerQQ?.() ?? '') };
    } catch (error) {
      if (error?.code === 'owner-desktop.timeout-invalid') lastError = failure(error.code, error.message, error.hint);
      return { enabled: false, parentSessionId: '', authorizationEpoch: '', ownerQQ: '', timeoutMs: OWNER_DESKTOP_DEFAULT_TIMEOUT_MS };
    }
  }
  function toolNames() {
    const schemas = toolRegistry?.definitions?.();
    if (!Array.isArray(schemas)) return [];
    return [...new Set(schemas.map(schema => schema?.name).filter(isOwnerDesktopTool))];
  }
  function inspectHost(config) {
    const missing = Object.entries({ hooks: hooksReady, 'context.get': typeof ctx?.get === 'function',
      'agents.get': typeof agentRegistry?.get === 'function', bridge: typeof bridge === 'function',
      registerWorkerSession: typeof registerWorkerSession === 'function', isWorkerSession: typeof isWorkerSession === 'function',
      'tools.guard': typeof toolRegistry?.guard === 'function', 'tools.definitions': typeof toolRegistry?.definitions === 'function',
      getPresetStatus: typeof getPresetStatus === 'function',
      'agentPresets.composedPreset': typeof presetRegistry?.composedPreset === 'function',
    }).filter(([, available]) => !available).map(([name]) => name);
    if (missing.length) return { issue: missingCapabilities(missing) };
    if (!rootServicesMatch()) return { issue: failure('owner-desktop.service-changed', '宿主服务已经关闭或替换。', '重载 SurfCore 后重新启用桌面任务。') };
    const preset = getPresetStatus();
    if (preset?.ok !== true) return { issue: failure('owner-desktop.preset-unavailable', '隔离桌面预设尚未就绪。', preset?.hint || '重载 SurfCore 并确认主人桌面任务预设注册成功后重试。') };
    if (!config.parentSessionId || !config.authorizationEpoch || !config.ownerQQ) {
      return { issue: failure('owner-desktop.settings-incomplete', '主人桌面任务设置不完整。', '在设置页保存主人账号和已授权的管理会话。') };
    }
    const parent = agentRegistry.get(config.parentSessionId);
    if (!validParent(parent, config)) {
      return { issue: failure('owner-desktop.parent-unavailable', '已授权的管理会话当前不可用。', '打开独立管理会话，手动开启 Computer Use 后重新保存该会话。') };
    }
    const selected = subagentService(parent);
    const unavailable = Object.entries({
      'subagents.startActivation': typeof selected.service?.startActivation === 'function',
      'subagents.getProvider': typeof selected.service?.getProvider === 'function',
      ...(selected.source === 'parent-preset' ? { 'agentPresets.serviceFor': typeof presetRegistry?.serviceFor === 'function' } : {}),
    }).filter(([, available]) => !available).map(([name]) => name);
    if (unavailable.length) return { issue: missingCapabilities(unavailable) };
    const provider = selected.service.getProvider('spawn');
    if (!supportedProvider(provider)) {
      return { issue: failure('owner-desktop.provider-unavailable', '宿主不支持隔离的本地子代理。', '启用支持 startActivation 与独立 agentPreset 的 DSH spawn 提供方。') };
    }
    const names = toolNames();
    if (!names.includes('windows_desktop') || !names.some(name => name.startsWith('mcp__windows__'))) {
      return { issue: failure('owner-desktop.tools-unavailable', '宿主尚未注册可用的 Windows 桌面工具。', '启用 Windows MCP 并等候工具注册后重新发送指令。') };
    }
    return { parent, subagents: selected.service, serviceSource: selected.source, provider };
  }
  function hostIssue(config) { return inspectHost(config).issue ?? null; }
  function status() {
    const config = settings();
    let issue = lastError;
    try { if (config.enabled && !issue) issue = hostIssue(config); } catch {
      issue = failure('owner-desktop.host-unavailable', '无法读取宿主桌面接口。', '重载插件后查看桌面任务状态。');
    }
    return { ok: !issue, enabled: config.enabled, phase: disposed ? 'stopped' : paused ? 'paused'
      : active ? active.phase : config.enabled ? 'idle' : 'disabled',
      activeTaskId: active?.taskId ?? null, sessionId: active?.child ? sessionId(active.child) : null,
      lastError: issue ? { ...issue } : null, lastResult: lastResult ? { ...lastResult } : null };
  }
  function publish() { try { onStatus(status()); } catch { /* UI observers cannot change authority. */ } }
  function remember(agent) {
    if (!agent || typeof agent !== 'object') return;
    ownedAgents.add(agent);
    if (sessionId(agent)) ownedSessions.add(sessionId(agent));
  }
  function hasRetiredDescriptor(agent) {
    if (agent?.session?.header?.agentPreset === WORKER_PRESET) return true;
    const events = sessionEvents(agent?.session);
    if (!Array.isArray(events)) return false;
    const descriptor = events.find(event => event?.type === 'subagent/descriptor')?.data;
    // Denial only: neither a copied label nor a resumed preset can authorize tools.
    return descriptor?.label === WORKER_LABEL || agent.session?.header?.agentPreset === WORKER_PRESET;
  }
  function candidate(agent) {
    const lease = active;
    if (!lease || lease.published || !lease.parent || !agent || sessionId(agent) !== lease.childId) return null;
    if (agent.session?.header?.origin !== 'subagent'
      || agent.session?.header?.parentSession !== sessionId(lease.parent)
      || agentRegistry.get(sessionId(agent)) !== agent) return null;
    if (!lease.candidates.has(agent)) lease.candidates.set(agent, { initial: null, turn: null, invalid: false, inserted: null });
    return lease.candidates.get(agent);
  }
  function managed(agent) {
    const seen = new Set();
    for (let cursor = agent, depth = 0; cursor && depth < 16; depth++) {
      const id = sessionId(cursor);
      if (seen.has(cursor)) return false;
      seen.add(cursor);
      let registered = false;
      try { registered = isWorkerSession?.(id) === true; } catch { registered = cursor.session?.header?.origin === 'subagent'; }
      if (ownedAgents.has(cursor) || ownedSessions.has(id) || registered || hasRetiredDescriptor(cursor)) {
        for (const descendant of seen) remember(descendant);
        return true;
      }
      // Only the host-reserved fresh child is held behind the publication barrier.
      if (candidate(cursor)) return true;
      const header = cursor.session?.header;
      if (header?.origin !== 'subagent' || !header.parentSession) return false;
      let retiredParent = ownedSessions.has(header.parentSession);
      try { retiredParent ||= isWorkerSession?.(header.parentSession) === true; } catch { retiredParent = true; }
      if (retiredParent) {
        for (const descendant of seen) remember(descendant);
        return true;
      }
      cursor = agentRegistry?.get?.(header.parentSession);
    }
    return false;
  }
  function created({ agent }) {
    const record = candidate(agent);
    if (record) {
      const events = sessionEvents(agent.session);
      record.created = agent.session?.header?.isSeeded === false && agent.session.inheritedEventCount === 0
        && Array.isArray(events) && !events.some(event => ['user/message', 'turn/start'].includes(event?.type));
    }
    managed(agent);
  }
  function recordFor(agent) {
    if (active?.child === agent) return active.record;
    return candidate(agent);
  }
  function configMatches(lease) {
    const current = settings();
    return current.enabled && ['ownerQQ', 'parentSessionId', 'authorizationEpoch', 'timeoutMs']
      .every(key => current[key] === lease.config[key]);
  }
  function leaseIssue(lease, agent, signal) {
    if (!lease || active !== lease || lease.revoked || paused || disposed || lease.controller.signal.aborted || signal?.aborted)
      return failure('owner-desktop.lease-revoked', '桌面任务授权已结束。', '由主人发送一条新的桌面指令。');
    if (!configMatches(lease)) return failure('owner-desktop.settings-changed', '桌面任务设置或主人身份已经变化。', '确认设置后由主人重新发送指令。');
    if (lease.config.timeoutMs === 0 ? lease.deadline !== null : !Number.isSafeInteger(lease.deadline))
      return failure('owner-desktop.deadline-invalid', '桌面任务执行期限无效。', '重载兼容的 QQ 桥接后，由主人重新发送指令。');
    if (lease.deadline !== null && now() >= lease.deadline)
      return failure('owner-desktop.expired', '桌面任务已达到执行时限。', '检查当前桌面状态后重新发送指令。');
    if (!rootServicesMatch())
      return failure('owner-desktop.service-changed', '宿主服务已经关闭或替换。', '重载 SurfCore 后重新启用桌面任务。');
    if (!validParent(lease.parent, lease.config))
      return failure('owner-desktop.parent-unavailable', '管理会话已经关闭或替换。', '重新打开并授权管理会话后再发送指令。');
    try {
      const current = subagentService(lease.parent);
      if (current.source !== lease.serviceSource || serviceIdentity(current.service) !== lease.subagentIdentity)
        return failure('owner-desktop.service-changed', '管理会话的子代理服务已经关闭或替换。', '确认管理会话服务后重新发送指令。');
      const provider = current.service?.getProvider?.('spawn');
      if (serviceIdentity(provider) !== lease.providerIdentity || !supportedProvider(provider))
        return failure('owner-desktop.provider-changed', '桌面任务的 spawn 提供方已经关闭或替换。', '确认本地 spawn 提供方后重新发送指令。');
    } catch {
      return failure('owner-desktop.service-changed', '无法重新校验管理会话的子代理服务。', '重载 SurfCore 后重新发送指令。');
    }
    if (getPresetStatus?.()?.ok !== true)
      return failure('owner-desktop.preset-unavailable', '隔离桌面预设已卸载。', '重载 SurfCore 后重新发送指令。');
    if (agent && (agent !== lease.child || agentRegistry.get(sessionId(agent)) !== agent))
      return failure('owner-desktop.agent-mismatch', '工具调用不属于当前桌面任务。', '只允许当前受控任务子代理执行。');
    if (agent && (!lease.boundary?.isActive() || presetRegistry.composedPreset(agent.ctx) !== WORKER_PRESET))
      return failure('owner-desktop.boundary-unavailable', '隔离桌面执行边界已失效。', '重载桌面任务预设后重试。');
    if (agent && (!lease.record?.initial || !Number.isSafeInteger(lease.record.turn) || !lease.stepAccepted || lease.record.invalid || lease.ended))
      return failure('owner-desktop.turn-mismatch', '当前消息或轮次没有桌面授权。', '由主人重新发送单条桌面指令。');
    return null;
  }
  function revoke(lease, issue, terminal = 'cancelled') {
    if (!lease || lease.revoked) return;
    lease.revoked = issue;
    lease.terminal = terminal;
    lease.phase = 'cancelling';
    lease.tickets.clear();
    lease.ready.resolve();
    lease.controller.abort({ kind: 'hook', reason: issue.code });
    lease.boundary?.close();
    for (const child of new Set([lease.child, ...lease.candidates.keys()])) {
      try { child?.cancel?.({ kind: 'hook', reason: issue.code }); } catch { /* The exact activation is also disposed in finally. */ }
    }
    lastError = issue;
    publish();
  }
  async function call(path, body) {
    let raw;
    try { raw = await bridge(`/api/owner-desktop/${path}`, body === undefined
      ? { timeoutMs: 4000 } : { method: 'POST', body, timeoutMs: 4000 }); } catch { raw = null; }
    const value = raw && Object.hasOwn(raw, 'data') ? raw.data : raw;
    if (raw?.ok !== true || value?.ok !== true) {
      const detail = value?.ok === false ? value : null;
      return failure(typeof detail?.code === 'string' ? detail.code : 'owner-desktop.bridge-unavailable',
        typeof detail?.error === 'string' ? detail.error.slice(0, 300) : '主人桌面任务桥接校验失败。',
        typeof detail?.hint === 'string' && detail.hint ? detail.hint.slice(0, 300) : '检查 QQ 桥接连接与桌面任务设置后重试。');
    }
    return value;
  }
  function taskTimingIssue(task, config) {
    if (!task || task.status !== 'running' || task.timeoutMs !== config.timeoutMs
      || !Number.isSafeInteger(task.sourceReceivedAt) || task.sourceReceivedAt <= 0
      || !Number.isSafeInteger(task.claimedAt) || task.claimedAt < task.sourceReceivedAt || task.claimedAt > now()
      || !Number.isSafeInteger(task.claimExpiresAt) || task.claimedAt >= task.claimExpiresAt
      || task.claimExpiresAt > task.sourceReceivedAt + OWNER_DESKTOP_PENDING_TTL_MS
      || (config.timeoutMs === 0 ? task.expiresAt !== null
        : !Number.isSafeInteger(task.expiresAt) || task.expiresAt !== task.claimedAt + config.timeoutMs))
      return failure('owner-desktop.deadline-invalid', '桥接任务缺少有效的领取时间或执行期限。', '重载兼容的 QQ 桥接后，由主人重新发送实时指令。');
    return null;
  }
  async function validateLease(lease) {
    const checked = await call('validate', { taskId: lease.taskId, leaseId: lease.leaseId });
    if (!checked.ok) return checked;
    const timing = taskTimingIssue(checked.task, lease.config);
    if (timing) return timing;
    if (['id', 'ownerQQ', 'conversationKey', 'sourceMessageId', 'sourceReceivedAt', 'timeoutMs', 'claimExpiresAt', 'claimedAt', 'expiresAt']
      .some(key => checked.task[key] !== lease.task[key]))
      return failure('owner-desktop.task-changed', '桥接任务身份或执行期限已经变化。', '停止当前任务，由主人重新发送指令。');
    return checked;
  }
  function ticketIdentity(exec) {
    return typeof exec?.token === 'symbol' && typeof exec.callId === 'string' && typeof exec.rootCallId === 'string';
  }
  function denial(issue) { return `${issue.code}: ${issue.error} ${issue.hint}`; }
  function ordinaryDenial(exec) {
    if (!exec.agent || !isOwnerDesktopTool(exec.name)) return undefined;
    try { if (!isOtherManaged(exec.agent)) return undefined; } catch { /* Classification failure cannot enable Windows. */ }
    return 'owner-desktop.owner-task-required: 普通 QQ 与 B站会话不能操作电脑。请由主人私聊或在群里 @ SurfCore 发送独立桌面指令。';
  }
  async function preExecute(exec, next) {
    if (!managed(exec.agent)) {
      const reason = ordinaryDenial(exec);
      return reason ? { kind: 'deny', reason } : next();
    }
    const lease = active;
    const issue = leaseIssue(lease, exec.agent, exec.signal);
    if (issue || !isOwnerDesktopTool(exec.name) || !ticketIdentity(exec))
      return { kind: 'deny', reason: denial(issue ?? failure('owner-desktop.tool-denied', '桌面子代理不能调用这个工具。', '仅使用已授权的 Windows 桌面工具。')) };
    const decision = await next();
    if (decision?.kind !== 'allow') return decision;
    const checked = await validateLease(lease);
    const changed = leaseIssue(lease, exec.agent, exec.signal);
    if (!checked.ok || changed) {
      const reason = changed ?? checked;
      revoke(lease, reason);
      return { kind: 'deny', reason: denial(reason) };
    }
    lease.tickets.set(exec.token, { agent: exec.agent, callId: exec.callId, rootCallId: exec.rootCallId,
      name: exec.name, signal: exec.signal, turn: lease.record.turn });
    return decision;
  }
  function guard(exec) {
    if (!managed(exec.agent)) return ordinaryDenial(exec);
    const lease = active;
    const issue = leaseIssue(lease, exec.agent, exec.signal);
    if (issue) { if (lease?.child === exec.agent && !lease.ended) revoke(lease, issue); return denial(issue); }
    if (!isOwnerDesktopTool(exec.name)) return 'owner-desktop.tool-denied: 仅允许当前任务的 Windows 桌面工具。';
    const ticket = lease.tickets.get(exec.token);
    lease.tickets.delete(exec.token);
    if (!ticket || ticket.agent !== exec.agent || ticket.callId !== exec.callId || ticket.rootCallId !== exec.rootCallId
      || ticket.name !== exec.name || ticket.signal !== exec.signal || ticket.turn !== lease.record.turn)
      return 'owner-desktop.validation-required: 此次调用没有通过桥接的实时身份校验。';
    return undefined;
  }
  function inserted({ agent, message }) {
    const record = recordFor(agent);
    if (!record) return;
    if (record.inserted && record.inserted !== message) {
      record.invalid = true;
      if (active?.child === agent) revoke(active, failure('owner-desktop.extra-message', '桌面任务收到额外消息，授权已撤销。', '不要向执行子代理追加消息；由主人重新发送指令。'));
    } else record.inserted = message;
  }
  function claimed({ agent, message, turn }) {
    const record = recordFor(agent);
    if (!record) return;
    if (record.initial || !Number.isSafeInteger(turn) || textOf(message) !== active?.prompt
      || typeof message?.id !== 'string' || message.source?.kind !== 'user') record.invalid = true;
    else { record.initial = message; record.turn = turn; }
    if (record.invalid && active?.child === agent) revoke(active, failure('owner-desktop.extra-message', '桌面任务的消息或轮次发生变化。', '由主人重新发送单条桌面指令。'));
  }
  async function preStep(payload, next) {
    const { agent } = payload;
    const pending = candidate(agent);
    const lease = active;
    if (pending && !lease.published) await lease.ready.promise;
    if (!managed(agent)) return next();
    if (!lease || lease !== active || lease.child !== agent) return { kind: 'reject' };
    const record = lease.record;
    const firstStep = !lease.stepAccepted;
    const messages = payload.messages;
    if (!record?.initial || record.initial.id !== lease.messageId || record.invalid || payload.turn !== record.turn
      || !Array.isArray(messages) || messages.some(message => message !== record.initial)
      || (lease.stepAccepted ? messages.length !== 0 : (messages.length !== 1 || messages[0] !== record.initial))) {
      revoke(lease, failure('owner-desktop.extra-message', '桌面任务只能执行首条指令所在的一轮。', '由主人发送新指令启动新的隔离任务。'));
      return { kind: 'reject' };
    }
    // This listener is cancellable through the official turn signal.
    if (!lease.turnSignal) {
      lease.turnSignal = payload.signal;
      lease.abortListener = () => { if (!lease.ended) revoke(lease, failure('owner-desktop.aborted', '桌面任务已被中止。', '检查当前桌面状态后重新发送指令。')); };
      payload.signal.addEventListener('abort', lease.abortListener, { once: true });
    }
    lease.stepAccepted = true;
    const issue = leaseIssue(lease, agent, payload.signal);
    if (issue) { revoke(lease, issue); return { kind: 'reject' }; }
    const decision = await next();
    // The 0.2.2 loop adds runtime-context placeholders after claiming inbox messages.
    // Remove them here: the loop regenerates context from its authoritative assembly
    // during commit. No placeholder content or identity enters our task authorization.
    const admitted = Array.isArray(decision?.messages)
      ? decision.messages.filter(message => message?.source?.kind !== 'runtime-context') : null;
    if (decision?.kind === 'enter' && (!admitted
      || (firstStep ? admitted.length !== 1 || admitted[0] !== record.initial : admitted.length !== 0))) {
      revoke(lease, failure('owner-desktop.extra-message', '宿主追加了本任务之外的消息。', '检查消息注入插件后重新发送指令。'));
      return { kind: 'reject' };
    }
    if (leaseIssue(lease, agent, payload.signal)) return { kind: 'reject' };
    return decision?.kind === 'enter' ? { ...decision, messages: admitted } : decision;
  }
  function sessionEvent(session, event) {
    const lease = active;
    if (!lease?.child || session !== lease.child.session || event?.type !== 'turn/end') return;
    lease.ended = true;
    lease.turnEnded = lease.record?.turn === event.data?.turn;
    lease.tickets.clear();
    if (lease.record?.turn !== event.data?.turn) revoke(lease, failure('owner-desktop.turn-mismatch', '桌面任务轮次结束信号不匹配。', '重新发送指令。'));
  }
  function agentDisposed(agent) {
    const lease = active;
    if (lease && !lease.settled && (agent === lease.parent || (agent === lease.child && !lease.ended)))
      revoke(lease, failure('owner-desktop.agent-disposed', '桌面执行或管理会话已经关闭。', '重新打开并授权管理会话后再发送指令。'));
  }
  function listen(name, fn) { const off = ctx.on(name, fn); if (typeof off === 'function') listeners.push(off); }

  try {
    if (typeof ctx?.on === 'function' && typeof toolRegistry?.guard === 'function') {
      const off = toolRegistry.guard(guard);
      if (typeof off === 'function') listeners.push(off);
      listen('tools/pre-execute', preExecute);
      listen('agent/created', created);
      listen('agent/inbox/inserted', inserted);
      listen('agent/inbox/claimed', claimed);
      listen('agent/pre-step', preStep);
      listen('agent/disposed', ({ agent }) => agentDisposed(agent));
      listen('session/disposed', session => {
        if (active?.child?.session === session) agentDisposed(active.child);
        else if (active?.parent?.session === session) agentDisposed(active.parent);
      });
      listen('session/event', sessionEvent);
      listen('dispose', async () => { disposed = true; await stop(); });
      hooksReady = true;
    }
  } catch {
    lastError = failure('owner-desktop.host-unavailable', '无法安装桌面执行守卫。', '重载兼容的 DSH 与 SurfCore 后重试。');
  }

  async function execute(taskId, config) {
    const lease = { taskId, leaseId: newLeaseId(), childId: newChildId(), config, parent: null, child: null, task: null, record: null,
      phase: 'claiming', controller: new AbortController(), ready: deferred(), candidates: new Map(),
      tickets: new Map(), published: false, revoked: null, stepAccepted: false, ended: false, settled: false,
      deadline: undefined, done: deferred() };
    active = lease;
    publish();
    let run;
    let claimedTask = false;
    let completion = null;
    let timeout;
    let heartbeat;
    function watch() {
      if (active !== lease || lease.ended || lease.revoked) return;
      heartbeat = setTimer(async () => {
        const changed = leaseIssue(lease);
        if (changed) { revoke(lease, changed); return; }
        const checked = await validateLease(lease);
        if (active === lease && !lease.ended && !checked.ok) revoke(lease, checked);
        watch();
      }, POLL_MS);
      heartbeat?.unref?.();
    }
    try {
      const claim = await call('claim', { taskId, leaseId: lease.leaseId });
      if (!claim.ok) { lastError = claim; return; }
      claimedTask = true;
      lease.task = claim.task ? Object.freeze({ ...claim.task }) : null;
      if (!lease.task || lease.task.id !== taskId || String(lease.task.ownerQQ) !== config.ownerQQ
        || typeof lease.task.text !== 'string' || !lease.task.text.trim()
        || typeof lease.task.sourceMessageId !== 'string' || !lease.task.sourceMessageId
        || !Number.isFinite(lease.task.sourceReceivedAt) || !lease.task.conversationKey) {
        completion = failure('owner-desktop.invalid-task', '桥接任务缺少可信消息来源。', '由主人重新发送实时桌面指令。');
        return;
      }
      const timing = taskTimingIssue(lease.task, config);
      if (timing) { completion = timing; return; }
      lease.deadline = lease.task.expiresAt;
      const host = inspectHost(config);
      if (host.issue) { completion = host.issue; return; }
      lease.parent = host.parent;
      lease.subagents = host.subagents;
      lease.serviceSource = host.serviceSource;
      lease.subagentIdentity = serviceIdentity(host.subagents);
      lease.providerIdentity = serviceIdentity(host.provider);
      const invalid = leaseIssue(lease);
      if (invalid) { completion = invalid; return; }
      const validated = await validateLease(lease);
      if (!validated.ok) { completion = validated; return; }
      const stale = leaseIssue(lease);
      if (stale) { completion = stale; return; }
      if (lease.deadline !== null) {
        timeout = setTimer(() => revoke(lease, failure('owner-desktop.timeout', '桌面任务已达到时间上限。', '先确认当前桌面状态，再发送新的指令。')), Math.max(1, lease.deadline - now()));
        timeout?.unref?.();
      }
      watch();
      if (typeof lease.childId !== 'string' || !lease.childId || agentRegistry.get(lease.childId) || isWorkerSession(lease.childId)) {
        completion = failure('owner-desktop.child-id-unavailable', '无法预留全新的桌面任务身份。', '重新发送指令以生成新的独立任务。');
        return;
      }
      const registered = await registerWorkerSession(lease.childId);
      if (registered !== true && registered?.ok !== true) {
        completion = failure('owner-desktop.worker-registration-failed', '无法记录桌面子代理的永久拒绝标记。', '修复主人桌面任务状态存储后重试。');
        revoke(lease, completion, 'failed');
        return;
      }
      ownedSessions.add(lease.childId);
      const cancelled = leaseIssue(lease);
      if (cancelled) { completion = cancelled; return; }
      lease.phase = 'starting';
      lease.prompt = lease.task.text;
      run = await lease.subagents.startActivation({ provider: 'spawn', parent: lease.parent, childId: lease.childId,
        prompt: [{ type: 'text', text: lease.prompt }], label: WORKER_LABEL, delivery: 'caller',
        signal: lease.controller.signal, agentPreset: WORKER_PRESET, maxDepth: 1 });
      const child = agentRegistry.get(lease.childId);
      if (!child || !run?.result || typeof run.dispose !== 'function' || run.childId !== sessionId(child)
        || run.childId !== lease.childId || typeof run.messageId !== 'string' || !run.messageId
        || child.session?.header?.parentSession !== sessionId(lease.parent) || child.session?.header?.origin !== 'subagent'
        || child.session?.header?.isSeeded !== false || child.session?.inheritedEventCount !== 0
        || presetRegistry.composedPreset(child.ctx) !== WORKER_PRESET) {
        completion = failure('owner-desktop.nonlocal-provider', '提供方没有返回可验证的独立本地子代理。', '启用支持独立预设和本地 startActivation 的 spawn 后重试。');
        revoke(lease, completion, 'failed');
        return;
      }
      lease.child = child;
      lease.messageId = run.messageId;
      remember(child);
      lease.record = lease.candidates.get(child);
      lease.boundary = armOwnerDesktopBoundary(child, exec => {
        const issue = leaseIssue(lease, exec.agent, exec.signal);
        if (issue && !lease.ended) revoke(lease, issue);
        return issue ? denial(issue) : undefined;
      });
      if (!lease.record?.created || !lease.boundary) {
        completion = failure('owner-desktop.native-presentation-unavailable', '隔离桌面预设未在首步之前建立原生执行边界。', '重载 owner-desktop 预设；不要放开 run_code 作为替代。');
        revoke(lease, completion, 'failed');
        return;
      }
      const changed = leaseIssue(lease);
      if (changed) { completion = changed; revoke(lease, changed); return; }
      lease.phase = 'running';
      lease.published = true;
      lease.ready.resolve();
      publish();
      const result = await run.result;
      const finishedIssue = leaseIssue(lease);
      if (finishedIssue && !lease.revoked) revoke(lease, finishedIssue);
      lease.settled = true;
      lease.ended = true;
      lease.tickets.clear();
      if (lease.revoked) completion = { ...lease.revoked, status: lease.terminal };
      else if (!lease.turnEnded || !lease.stepAccepted || !lease.record?.initial || lease.record.initial.id !== lease.messageId || lease.record.invalid) completion = failure('owner-desktop.turn-unverified', '无法确认桌面任务的初始消息与执行轮次。', '更新兼容的 DSH 生命周期接口后重试。');
      else if (result?.stopReason !== 'completed') completion = { ...failure('owner-desktop.execution-failed', '桌面子代理没有正常完成任务。', '查看独立执行会话中的失败原因，确认桌面状态后重试。'), status: result?.stopReason === 'aborted' ? 'cancelled' : 'failed' };
      else completion = { ok: true, status: 'done', output: outputText(result) };
    } catch {
      completion = lease.revoked ? { ...lease.revoked, status: lease.terminal }
        : failure('owner-desktop.execution-failed', '桌面任务启动或执行失败。', '查看 DSH 子代理与 Computer Use 状态后重试。');
    } finally {
      if (timeout) clearTimer(timeout);
      if (heartbeat) clearTimer(heartbeat);
      lease.ready.resolve();
      lease.ended = true;
      lease.tickets.clear();
      if (lease.turnSignal && lease.abortListener) lease.turnSignal.removeEventListener('abort', lease.abortListener);
      try { if (run?.dispose) await run.dispose(); } catch {
        completion = failure('owner-desktop.dispose-failed', '桌面子代理未能确认停止。', '关闭执行会话并重载插件，确认停止后再开启桌面任务。');
        paused = true;
      }
      lease.boundary?.close();
      if (claimedTask) {
        completion ??= lease.revoked ?? failure('owner-desktop.execution-failed', '桌面任务未完成。', '检查执行会话后重试。');
        const terminal = completion.status ?? (completion.ok ? 'done' : 'failed');
        const payload = { taskId, leaseId: lease.leaseId, status: terminal,
          ...(lease.child ? { sessionId: sessionId(lease.child) } : {}),
          ...(completion.ok ? { output: completion.output ?? '' } : { code: completion.code, error: completion.error, hint: completion.hint }) };
        const finished = await call('complete', payload);
        lastResult = { taskId, status: terminal, ...(lease.child ? { sessionId: sessionId(lease.child) } : {}) };
        lastError = !finished.ok ? finished : completion.ok ? null : completion;
      }
      active = null;
      lease.done.resolve();
      publish();
    }
  }
  function schedule() {
    if (paused || disposed || pollTimer) return;
    pollTimer = setTimer(() => { pollTimer = null; void tick(); }, POLL_MS);
    pollTimer?.unref?.();
  }
  async function tick() {
    if (paused || disposed) return status();
    if (inFlight) {
      const issue = active && leaseIssue(active);
      if (issue) revoke(active, issue);
      return status();
    }
    inFlight = (async () => {
      const config = settings();
      if (!config.enabled) return;
      const pending = await call('pending');
      if (!pending.ok) { lastError = pending; publish(); return; }
      if (!Array.isArray(pending.tasks)) { lastError = failure('owner-desktop.invalid-pending', '桥接任务列表格式无效。', '重载兼容的 QQ 桥接后重试。'); publish(); return; }
      const task = pending.tasks.find(item => typeof item?.id === 'string' && item.id);
      if (!paused && !disposed && task) await execute(task.id, config);
    })();
    try { await inFlight; } catch {
      lastError = failure('owner-desktop.runtime-failed', '桌面任务轮询失败。', '重载插件并检查任务状态。'); publish();
    } finally { inFlight = null; schedule(); }
    return status();
  }
  async function cancelActive() {
    if (active) {
      const lease = active;
      revoke(lease, failure('owner-desktop.cancelled', '主人桌面任务已取消。', '需要继续时请发送一条新的指令。'));
      await lease.done.promise;
    }
    return status();
  }
  async function stop() {
    paused = true;
    if (pollTimer) clearTimer(pollTimer);
    pollTimer = null;
    await cancelActive();
    if (inFlight) await inFlight;
    publish();
    return status();
  }
  function start() {
    if (!disposed) { paused = false; lastError = null; schedule(); publish(); }
    return status();
  }
  schedule();
  return { status, tick, stop, start, cancelActive, isManagedAgent: managed };
}
