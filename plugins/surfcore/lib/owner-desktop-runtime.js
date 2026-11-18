import { randomUUID } from 'node:crypto';
import { normalizeOwnerDesktopTimeout, OWNER_DESKTOP_DEFAULT_TIMEOUT_MS, OWNER_DESKTOP_PENDING_TTL_MS } from '../../../src/owner-desktop-conversation-options.js';
import { armOwnerDesktopConversation, isOwnerDesktopTool } from './owner-desktop-conversation-gate.js';
export { isOwnerDesktopTool };
const PRESET = 'owner-desktop-conversation';
const POLL_MS = 2_000, STOP_WAIT_MS = 10_000;
const original = value => value?.[Symbol.for('cordis.original')] ?? value;
const failure = (code, error, hint) => ({ ok: false, code, error, hint });
const denial = issue => issue.code + ': ' + issue.error + ' ' + issue.hint;
const idOf = agent => agent?.session?.id ?? agent?.id;
function service(ctx, name) { try { return ctx?.get?.(name); } catch { return undefined; } }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const endedIssue = () => failure('owner-desktop.lease-revoked', '当前电脑指令授权已结束。', '由主人从原 QQ 对话发送新指令。');
const boundaryIssue = () => failure('owner-desktop.native-presentation-unavailable', '独立电脑会话的原生工具边界不可用。', '重载 SurfCore 专用预设后重试，不要开放 run_code 或本地执行工具。');

/** Official continuing subagent history; exact host receipt + committed object + one turn.
 * The QQ parent is never cancelled, recomposed, granted tools, or used for screen context.
 * Persisted mappings only deny authority: every continuation requires fresh bridge validation.
 */
export function installOwnerDesktopRuntime(ctx, {
  getSettings, getOwnerQQ, getPresetStatus, conversationStore, bridge,
  isManagedAgent: isOtherManaged = () => false, isWorkerSession = () => false,
  now = Date.now, newLeaseId = randomUUID, newSessionId = randomUUID, autoStart = true,
  setTimer = setTimeout, clearTimer = clearTimeout, onStatus = () => {},
} = {}) {
  const agents = service(ctx, 'agents'), tools = service(ctx, 'tools'), presets = service(ctx, 'agentPresets');
  let active = null, pollTimer = null, inFlight = null, paused = !autoStart, disposed = false;
  let lastError = null, availabilityError = null, lastResult = null, hooksReady = false;
  let pendingStop = null, brokerBlocked = null;
  const recoveryHint = '若停止证明已丢失或持续无法确认，请先完全退出 DSH 并确认其桌面工具子进程结束，再重启 QQ 桥接和 DSH；单独重新启用不能解除阻塞。';
  function stopIssue() {
    if (!pendingStop) return brokerBlocked;
    if (pendingStop.proofState === 'stopped') return failure('owner-desktop.stop-proof-pending',
      '电脑执行已停止，但桥接尚未确认停止证明。' + (pendingStop.reportIssue ? ' ' + pendingStop.reportIssue.error : ''),
      '恢复 QQ 桥接连接后，在 QQ 设置中重新启用电脑任务以重试原停止证明；确认前不会启动新任务。' + recoveryHint);
    return failure('owner-desktop.stop-unconfirmed', '权限已撤销，但电脑执行未确认停止。', pendingStop.proofState === 'unavailable' ? recoveryHint
      : '在独立电脑会话点停止，并保持 DSH 运行；原工具结束后会自动补交停止证明。请等待状态确认停止，再重新启用并发送新指令。' + recoveryHint);
  }
  function settings() {
    try {
      const value = getSettings?.() ?? {};
      return { enabled: value.enabled === true, authorizationEpoch: String(value.authorizationEpoch ?? ''),
        timeoutMs: normalizeOwnerDesktopTimeout(value.timeoutMs), ownerQQ: String(getOwnerQQ?.() ?? '') };
    } catch (error) {
      lastError = failure(error?.code ?? 'owner-desktop.settings-invalid', '无法读取电脑任务设置。', error?.hint ?? '修复设置后重新保存授权。');
      return { enabled: false, authorizationEpoch: '', ownerQQ: '', timeoutMs: OWNER_DESKTOP_DEFAULT_TIMEOUT_MS };
    }
  }
  function servicesMatch() {
    return [['agents', agents], ['tools', tools], ['agentPresets', presets]].every(([name, value]) => value && original(service(ctx, name)) === original(value));
  }
  function subagentsFor(parent) { try { return presets?.serviceFor?.(parent, 'subagents') ?? service(ctx, 'subagents'); } catch { return undefined; } }
  function hostIssue(config) {
    if (!hooksReady || !servicesMatch() || typeof agents?.get !== 'function' || typeof tools?.definitions !== 'function'
      || typeof presets?.composedPreset !== 'function' || typeof bridge !== 'function'
      || !['find', 'reserve', 'confirm', 'isSession', 'list', 'status'].every(name => typeof conversationStore?.[name] === 'function'))
      return failure('owner-desktop.host-unavailable', '独立电脑会话所需的宿主接口不可用。', '更新并重载 SurfCore 与 DSH 后重试。');
    const preset = getPresetStatus?.();
    if (!preset?.ok || preset.agentPreset !== PRESET) return preset?.ok === false ? preset : boundaryIssue();
    const stored = conversationStore.status();
    if (stored?.ok === false) return stored;
    if (!config.ownerQQ || !config.authorizationEpoch)
      return failure('owner-desktop.settings-incomplete', '主人身份或电脑授权版本不完整。', '在 QQ 设置中保存主人账号和电脑授权。');
    if (!tools.definitions().some(row => row.name.startsWith('mcp__windows__')))
      return failure('owner-desktop.tools-unavailable', '宿主尚未注册 Windows 桌面工具。', '启用 Windows MCP 并等候工具注册后重新发送指令。');
    return null;
  }
  function status() {
    const config = settings(); let issue = stopIssue() ?? availabilityError ?? lastError, conversations = [];
    try {
      const rows = conversationStore?.list?.();
      if (!Array.isArray(rows)) throw failure('owner-desktop.conversation-store-unavailable', '电脑会话目录不可用。', '重载插件并检查持久化会话目录。');
      conversations = rows.map(row => ({ ...row }));
      if (config.enabled && !issue) issue = hostIssue(config);
    } catch (error) {
      issue = failure(typeof error?.code === 'string' && error.code.startsWith('owner-desktop.') ? error.code : 'owner-desktop.host-unavailable',
        typeof error?.error === 'string' ? error.error : '无法读取电脑会话状态。', typeof error?.hint === 'string' && error.hint ? error.hint : '重载插件并检查持久化会话目录后重试。');
    }
    const current = active ?? pendingStop?.lease;
    return { ok: !issue, enabled: config.enabled, phase: disposed ? 'stopped' : stopIssue() ? 'stopping' : paused ? 'paused' : active?.phase ?? (config.enabled ? 'idle' : 'disabled'),
      activeTaskId: current?.taskId ?? null, sessionId: current?.childId ?? null,
      sourceSessionId: current?.sourceSessionId ?? null, desktopSessionId: current?.childId ?? null,
      conversations, lastError: issue ? { ...issue } : null, lastResult: lastResult ? { ...lastResult } : null };
  }
  function publish() { try { onStatus(status()); } catch { /* observers never mint authority */ } }
  async function call(path, body) {
    let raw;
    try { raw = await bridge('/api/owner-desktop/' + path, body === undefined ? { timeoutMs: 4000 } : { method: 'POST', body, timeoutMs: 4000 }); } catch { raw = null; }
    const value = raw && Object.hasOwn(raw, 'data') ? raw.data : raw;
    if (raw?.ok !== true || value?.ok !== true) {
      const detail = value?.ok === false ? value : null;
      return failure(typeof detail?.code === 'string' ? detail.code : 'owner-desktop.bridge-unavailable',
        typeof detail?.error === 'string' ? detail.error.slice(0, 300) : '主人电脑任务桥接校验失败。',
        typeof detail?.hint === 'string' && detail.hint ? detail.hint.slice(0, 300) : '检查 QQ 桥接连接与电脑任务设置后重试。');
    }
    return value;
  }
  function retired(agent) {
    const seen = new Set();
    for (let current = agent; current && seen.size < 32; current = agents?.get?.(current.session?.header?.parentSession)) {
      if (seen.has(current)) return true; seen.add(current);
      try {
        if (isWorkerSession(idOf(current)) || current.session?.header?.agentPreset === 'owner-desktop') return true;
        if ((current.session?.snapshotEvents?.() ?? []).some(event => event?.type === 'subagent/descriptor' && event.data?.label === 'SurfCore owner desktop task')) return true;
      } catch { return true; }
      if (!current.session?.header?.parentSession) return false;
    }
    return false;
  }
  function desktop(agent) {
    if (agent?.session?.header?.agentPreset === PRESET) return true;
    try { if (presets?.composedPreset?.(agent?.ctx) === PRESET) return true; } catch { /* header still identifies dedicated sessions */ }
    try { return conversationStore?.isSession?.(idOf(agent)) === true; }
    catch { return false; } // Broken desktop storage must not disable ordinary QQ's safe tools.
  }
  function managed(agent) { try { return desktop(agent) || retired(agent) || isOtherManaged(agent); } catch { return true; } }
  function timingIssue(task, config) {
    if (!task || task.status !== 'running' || task.timeoutMs !== config.timeoutMs
      || !Number.isSafeInteger(task.sourceReceivedAt) || task.sourceReceivedAt <= 0
      || !Number.isSafeInteger(task.claimedAt) || task.claimedAt < task.sourceReceivedAt || task.claimedAt > now()
      || !Number.isSafeInteger(task.claimExpiresAt) || task.claimedAt >= task.claimExpiresAt
      || task.claimExpiresAt > task.sourceReceivedAt + OWNER_DESKTOP_PENDING_TTL_MS
      || (config.timeoutMs === 0 ? task.expiresAt !== null : !Number.isSafeInteger(task.expiresAt) || task.expiresAt !== task.claimedAt + config.timeoutMs))
      return failure('owner-desktop.deadline-invalid', '桥接任务缺少有效领取时间或执行期限。', '重载兼容桥接后，由主人重新发送实时指令。');
    return null;
  }
  function leaseIssue(lease, agent, signal) {
    if (!lease || active !== lease || lease.revoked || lease.ended || paused || disposed || signal?.aborted) return endedIssue();
    const config = settings();
    if (!config.enabled || ['ownerQQ', 'authorizationEpoch', 'timeoutMs'].some(key => config[key] !== lease.config[key]))
      return failure('owner-desktop.settings-changed', '电脑设置或主人身份已改变。', '确认设置后由主人重新发送指令。');
    if (!servicesMatch() || (lease.subagents && original(subagentsFor(lease.source)) !== original(lease.subagents)))
      return failure('owner-desktop.service-changed', '宿主服务已关闭或替换。', '重载 SurfCore 后重新发送指令。');
    if (lease.task?.expiresAt !== null && now() >= lease.task?.expiresAt)
      return failure('owner-desktop.expired', '电脑任务已达到执行时限。', '检查当前桌面状态后重新发送指令。');
    if (lease.source && agents.get(lease.sourceSessionId) !== lease.source)
      return failure('owner-desktop.source-session-changed', '来源 QQ 会话已关闭或替换。', '恢复原 QQ 会话后由主人重新发送指令。');
    if (lease.agent && (agents.get(lease.childId) !== lease.agent || (agent && agent !== lease.agent)))
      return failure('owner-desktop.agent-mismatch', '电脑会话实例已关闭或替换。', '从原 QQ 对话发送新指令恢复独立电脑会话。');
    try {
      const stored = conversationStore.status();
      if (stored?.ok !== true) return stored?.ok === false ? stored : failure('owner-desktop.conversation-store-unavailable', '电脑会话目录不可用。', '检查并恢复持久化目录后重试。');
    } catch { return failure('owner-desktop.conversation-store-unavailable', '无法校验电脑会话目录。', '检查并恢复持久化目录后重试。'); }
    if (lease.boundary && !lease.boundary.isActive()) return boundaryIssue();
    if (agent && (!lease.bound || !lease.initial || !lease.stepAccepted || !Number.isSafeInteger(lease.turn) || signal !== lease.turnSignal))
      return failure('owner-desktop.turn-mismatch', '此次调用不属于获准消息的执行轮次。', '由主人发送新的电脑指令。');
    return null;
  }
  function close(lease) { lease.tickets.clear(); lease.boundary?.close(); }
  function revoke(lease, issue, terminal = 'cancelled') {
    if (!lease || lease.revoked || lease.ended) return;
    lease.revoked = issue; lease.terminal = terminal; lease.phase = 'cancelling'; close(lease);
    lease.controller.abort({ kind: 'hook', reason: issue.code });
    // The child has its own inbox and history. Never touch the QQ parent's loop.
    if (lease.agent) { try { lease.agent.cancel({ kind: 'hook', reason: issue.code }); } catch { lease.cancelFailed = true; } }
    lease.revokedEvent.resolve(); lastError = issue; publish();
  }
  async function validate(lease) {
    const checked = await call('validate', { taskId: lease.taskId, leaseId: lease.leaseId });
    if (!checked.ok) return checked;
    const timing = timingIssue(checked.task, lease.config); if (timing) return timing;
    const keys = ['id', 'ownerQQ', 'selfUserId', 'conversationKey', 'sourceMessageId', 'sourceReceivedAt', 'sourceTime', 'continuationRequested', 'timeoutMs', 'claimExpiresAt', 'claimedAt', 'expiresAt'];
    if (lease.preparedId) keys.push('sourceSessionId', 'preparedId');
    if (lease.bound) keys.push('sessionId', 'messageId');
    if (keys.some(key => checked.task[key] !== lease.task[key]))
      return failure('owner-desktop.task-changed', '可信任务、来源会话或消息绑定已变化。', '停止当前任务，由主人重新发送指令。');
    return checked;
  }
  function ordinaryDenial(exec) {
    if (retired(exec.agent)) return 'owner-desktop.retired-worker: 旧桌面子代理不能恢复权限。请从原 QQ 对话发送新指令。';
    if (desktop(exec.agent)) return 'owner-desktop.owner-task-required: 电脑会话没有有效主人消息授权。';
    if (isOwnerDesktopTool(exec.name) && managed(exec.agent)) return 'owner-desktop.owner-task-required: 普通 QQ/B站消息没有桌面权限。';
  }
  async function preExecute(exec, next) {
    const lease = active;
    if (lease?.agent !== exec.agent) { const reason = ordinaryDenial(exec); return reason ? { kind: 'deny', reason } : next(); }
    if (!isOwnerDesktopTool(exec.name)) return { kind: 'deny', reason: 'owner-desktop.tool-not-allowed: 独立电脑会话只允许 Windows 工具。' };
    const issue = leaseIssue(lease, exec.agent, exec.signal);
    if (issue || typeof exec.token !== 'symbol' || typeof exec.callId !== 'string' || typeof exec.rootCallId !== 'string')
      return { kind: 'deny', reason: denial(issue ?? failure('owner-desktop.invocation-invalid', '工具调用缺少宿主执行身份。', '重载兼容宿主后重试。')) };
    const decision = await next(); if (decision?.kind !== 'allow') return decision;
    const checked = await validate(lease), changed = leaseIssue(lease, exec.agent, exec.signal);
    if (!checked.ok || changed) { const reason = changed ?? checked; revoke(lease, reason); return { kind: 'deny', reason: denial(reason) }; }
    lease.tickets.set(exec.token, { agent: exec.agent, name: exec.name, callId: exec.callId, rootCallId: exec.rootCallId, signal: exec.signal, turn: lease.turn });
    return decision;
  }
  function guard(exec) {
    const lease = active;
    if (lease?.agent !== exec.agent) return ordinaryDenial(exec);
    if (!isOwnerDesktopTool(exec.name)) return 'owner-desktop.tool-not-allowed: 独立电脑会话只允许 Windows 工具。';
    const issue = leaseIssue(lease, exec.agent, exec.signal); if (issue) { revoke(lease, issue); return denial(issue); }
    const ticket = lease.tickets.get(exec.token); lease.tickets.delete(exec.token);
    if (!ticket || ['agent', 'name', 'callId', 'rootCallId', 'signal'].some(key => ticket[key] !== exec[key]) || ticket.turn !== lease.turn)
      return 'owner-desktop.validation-required: 此次调用未通过桥接实时校验。';
  }
  function created({ agent }) {
    const lease = active;
    if (!lease || !lease.dispatching || idOf(agent) !== lease.childId || lease.agent) return;
    if (agents.get(lease.childId) !== agent || agent.session?.header?.parentSession !== lease.sourceSessionId
      || agent.session?.header?.origin !== 'subagent' || presets.composedPreset(agent.ctx) !== PRESET || retired(agent)
      || typeof agent.model?.select !== 'function' || typeof agent.cancel !== 'function' || typeof agent.whenIdle !== 'function' || typeof agent.inbox?.remove !== 'function') {
      revoke(lease, failure('owner-desktop.child-identity-invalid', '宿主创建的电脑会话身份不匹配。', '重载专用预设后由主人重试。'), 'failed'); return;
    }
    lease.agent = agent;
    // Official synchronous model/selection event. Cold resumes follow the QQ's current route.
    agent.model.select(lease.modelSelection);
  }
  function inserted({ agent, message }) {
    // Host continuation settlement is not an owner instruction or QQ context.
    if (message?.source?.kind === 'subagent-settled' && message.source.form === 'notice') {
      const childId = message.source.senderSessionId;
      try {
        if (conversationStore?.isSession?.(childId) && conversationStore.list().some(row => row.sessionId === childId && row.sourceSessionId === idOf(agent))) {
          agent.inbox.remove(message.id); return;
        }
      } catch { /* no broad deletion on unavailable storage */ }
    }
    const lease = active;
    if (lease?.agent !== agent || lease.ended || lease.revoked) return;
    const trustedSource = lease.continuation ? message?.source?.kind === 'agent-message' && message.source.senderSessionId === lease.sourceSessionId : message?.source?.kind === 'user';
    if (!lease.inserted && lease.dispatching && message?.role === 'user' && typeof message.id === 'string' && trustedSource) {
      lease.inserted = message;
      lease.boundary = armOwnerDesktopConversation(agent, exec => { const issue = leaseIssue(lease, exec.agent, exec.signal); return issue ? denial(issue) : undefined; }, () => revoke(lease, boundaryIssue()));
      if (!lease.boundary) revoke(lease, boundaryIssue(), 'failed');
    } else revoke(lease, failure('owner-desktop.extra-message', '电脑轮次收到未经绑定的额外输入，授权已撤销。', '由主人从原 QQ 对话重新发送指令。'));
  }
  function claimed({ agent, message, turn }) {
    const lease = active; if (lease?.agent !== agent || lease.ended || lease.revoked) return;
    if (lease.initial || message !== lease.inserted || !Number.isSafeInteger(turn)) {
      revoke(lease, failure('owner-desktop.extra-message', '宿主领取的消息与待绑定首条消息不一致。', '从原 QQ 对话重新发送指令。')); return;
    }
    lease.initial = message; lease.turn = turn;
    // Real host order: claim -> tools.resolve -> pre-step. The message receipt is checked before model entry.
    if (!lease.boundary?.activate()) revoke(lease, boundaryIssue(), 'failed');
    else if (!lease.boundary.desktopAvailable()) revoke(lease, failure('owner-desktop.computer-use-off', '来源 QQ 会话的 Computer Use 未开启或电脑能力不可用。', '在原 QQ 会话输入框手动打开 Computer Use，再由主人重新发送指令。'), 'failed');
  }
  async function preStep(payload, next) {
    const lease = active;
    if (lease?.agent !== payload.agent) return desktop(payload.agent) || retired(payload.agent) ? { kind: 'reject' } : next();
    if (lease.revoked || lease.ended) return { kind: 'reject' };
    const first = !lease.stepAccepted;
    if (!lease.initial || payload.turn !== lease.turn || !Array.isArray(payload.messages)
      || (first ? payload.messages.length !== 1 || payload.messages[0] !== lease.initial : payload.messages.length !== 0)
      || (lease.turnSignal && payload.signal !== lease.turnSignal)) {
      revoke(lease, failure('owner-desktop.extra-message', '电脑授权轮次混入了其他消息。', '从原 QQ 对话重新发送指令。')); return { kind: 'reject' };
    }
    if (!lease.turnSignal) {
      lease.turnSignal = payload.signal;
      lease.abortListener = () => revoke(lease, failure('owner-desktop.aborted', '电脑指令已被中止。', '确认桌面状态后由主人发送新指令。'));
      payload.signal.addEventListener('abort', lease.abortListener, { once: true });
    }
    await lease.binding.promise;
    if (lease.revoked || !lease.bound || lease.messageId !== lease.initial.id) return { kind: 'reject' };
    lease.stepAccepted = true;
    const issue = leaseIssue(lease, payload.agent, payload.signal); if (issue) { revoke(lease, issue); return { kind: 'reject' }; }
    const checked = await validate(lease), changed = leaseIssue(lease, payload.agent, payload.signal);
    if (!checked.ok || changed) { revoke(lease, changed ?? checked); return { kind: 'reject' }; }
    if (first) {
      const started = await call('started', { taskId: lease.taskId, leaseId: lease.leaseId, messageId: lease.messageId, turnId: lease.turn });
      if (!started.ok) { revoke(lease, started); return { kind: 'reject' }; }
    }
    const decision = await next();
    if (decision?.kind !== 'enter') return decision;
    const admitted = Array.isArray(decision.messages) ? decision.messages.filter(message => !['runtime-context', 'model-selection'].includes(message?.source?.kind)) : null;
    if (!admitted || (first ? admitted.length !== 1 || admitted[0] !== lease.initial : admitted.length !== 0)) {
      revoke(lease, failure('owner-desktop.extra-message', '宿主插件追加了未经授权的输入。', '检查消息注入插件后重试。')); return { kind: 'reject' };
    }
    if (leaseIssue(lease, payload.agent, payload.signal)) return { kind: 'reject' };
    // Drop placeholders instead of trusting their source.kind as permission-bearing text.
    return { ...decision, messages: admitted };
  }
  function sessionEvent(session, event) {
    const lease = active;
    if (!lease || session !== lease.agent?.session || event.data?.turn !== lease.turn) return;
    if (event.type === 'assistant/message') {
      const message = event.data.message;
      if (message?.role !== 'assistant' || !Array.isArray(message.content)) return;
      const text = message.content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
      if (!message.content.some(block => block.type === 'tool-call')) lease.output = text.slice(0, 4000);
      else if (lease.bound && lease.stepAccepted && !lease.revoked && !lease.ended && text.trim() && text !== lease.lastProgress && now() - lease.progressAt >= 15_000) {
        lease.lastProgress = text; lease.progressAt = now();
        void call('progress', { taskId: lease.taskId, leaseId: lease.leaseId, summary: text.slice(0, 500) }).then(result => {
          if (!result.ok && active === lease && !lease.ended && !lease.revoked) { lastError = result; publish(); }
        });
      }
      return;
    }
    if (event.type !== 'turn/end') return;
    lease.ended = true; lease.turnEnd = event.data; close(lease); lease.finished.resolve(event.data);
  }
  function agentDisposed(agent) {
    const lease = active;
    if (lease?.source === agent && !lease.ended) revoke(lease, failure('owner-desktop.source-session-changed', '来源 QQ 会话已关闭。', '恢复原 QQ 会话后重试。'));
    if (lease?.agent !== agent) return;
    if (!lease.ended && !lease.revoked) revoke(lease, failure('owner-desktop.agent-disposed', '电脑会话已关闭。', '从原 QQ 对话发送新指令恢复历史。'));
  }
  try {
    if (typeof ctx?.on === 'function' && typeof tools?.guard === 'function') {
      tools.guard(guard); ctx.on('tools/pre-execute', preExecute); ctx.on('agent/created', created); ctx.on('agent/inbox/inserted', inserted);
      ctx.on('agent/inbox/claimed', claimed); ctx.on('agent/pre-step', preStep); ctx.on('session/event', sessionEvent);
      ctx.on('agent/disposed', ({ agent }) => agentDisposed(agent));
      ctx.on('subagent/end', info => {
        const lease = active;
        if (lease && info?.id === lease.childId && info.parentSessionId === lease.sourceSessionId) {
          if (!lease.ended && !lease.revoked) revoke(lease, failure('owner-desktop.execution-failed', '电脑执行提前结束。', '检查独立电脑会话后重新发送指令。'), 'failed');
        }
      });
      ctx.on('dispose', async () => { disposed = true; await stop(); }); hooksReady = true;
    }
  } catch { lastError = failure('owner-desktop.host-unavailable', '无法安装独立电脑执行守卫。', '重载兼容的 DSH 与 SurfCore 后重试。'); }
  async function bounded(promise) {
    let timer;
    try { return await Promise.race([promise, new Promise(resolve => { timer = setTimer(() => resolve(false), STOP_WAIT_MS); })]); }
    finally { if (timer) clearTimer(timer); }
  }
  function observeStopped(lease) {
    // Capture the original instance and dispatch, never a later agents.get(id).
    // This promise survives the UI timeout, but never participates in admission.
    const agent = lease.agent, dispatch = lease.dispatchTask;
    if (!lease.dispatchAttempted) return Promise.resolve(true);
    return (async () => {
      try {
        if (dispatch) await dispatch.catch(() => {});
        if (!agent || !lease.dispatchSettled) return false;
        await agent.whenIdle();
        return true;
      } catch { return false; }
    })();
  }
  async function reportStopped(record) {
    if (pendingStop !== record || record.proofState !== 'stopped') return;
    if (record.reporting) return record.reporting;
    record.reporting = (async () => {
      const result = await call('complete', record.payload);
      if (!result.ok || result.task?.id !== record.lease.taskId || result.task.executionStopped !== true
        || (record.lease.bound && result.task.sessionId !== record.lease.childId)) {
        record.reportIssue = result.ok ? failure('owner-desktop.stop-proof-mismatch', '停止回执与原任务或会话不一致。', recoveryHint) : result;
        publish(); return;
      }
      if (pendingStop !== record) return;
      pendingStop = null;
      if (lastResult?.taskId === record.lease.taskId) lastResult = { ...lastResult, executionStopped: true };
      if (lastError === record.terminalError) lastError = null;
      publish();
    })();
    try { await record.reporting; } finally { record.reporting = null; }
  }
  async function execute(taskId, config) {
    const lease = { taskId, leaseId: newLeaseId(), config, phase: 'claiming', agent: null, task: null, tickets: new Map(), controller: new AbortController(),
      finished: deferred(), revokedEvent: deferred(), done: deferred(), binding: deferred(),
      revoked: null, ended: false, bound: false, stepAccepted: false, dispatching: false, progressAt: 0 };
    active = lease; publish();
    let completion, claimedTask = false, timeout, heartbeat;
    function watch() {
      if (active !== lease || lease.ended || lease.revoked) return;
      heartbeat = setTimer(async () => {
        const changed = leaseIssue(lease); if (changed) { revoke(lease, changed); return; }
        const checked = await validate(lease); if (!lease.ended && !checked.ok) revoke(lease, checked); watch();
      }, POLL_MS); heartbeat?.unref?.();
    }
    try {
      const claim = await call('claim', { taskId, leaseId: lease.leaseId });
      if (!claim.ok) { lastError = claim; return; }
      claimedTask = true; lease.task = claim.task ? { ...claim.task } : null;
      if (!lease.task || lease.task.id !== taskId || lease.task.ownerQQ !== config.ownerQQ || !lease.task.selfUserId || !lease.task.sourceMessageId || !lease.task.conversationKey || typeof lease.task.continuationRequested !== 'boolean') {
        completion = failure('owner-desktop.invalid-task', '电脑任务缺少可信主人消息身份。', '由主人重新发送实时电脑指令。'); return;
      }
      completion = timingIssue(lease.task, config) ?? hostIssue(config); if (completion) return;
      const prepared = await call('prepare', { taskId, leaseId: lease.leaseId });
      if (!prepared.ok) { completion = prepared; return; }
      if (typeof prepared.sourceSessionId !== 'string' || !prepared.sourceSessionId || typeof prepared.preparedId !== 'string' || !prepared.preparedId
        || typeof prepared.prompt !== 'string' || !prepared.prompt.trim()) {
        completion = failure('owner-desktop.prepare-invalid', '桥接没有返回来源 QQ 会话和可信人设提示。', '重载兼容桥接后重新发送指令。'); return;
      }
      lease.preparedId = prepared.preparedId; lease.sourceSessionId = prepared.sourceSessionId;
      Object.assign(lease.task, { sourceSessionId: prepared.sourceSessionId, preparedId: prepared.preparedId });
      lease.source = agents.get(lease.sourceSessionId);
      const source = lease.source;
      if (!source || idOf(source) !== lease.sourceSessionId || source.session?.header?.parentSession || retired(source) || desktop(source)
        || !['qq-chat', 'qq-chat-v2'].includes(presets.composedPreset(source.ctx))) {
        completion = failure('owner-desktop.qq-session-unavailable', '可信来源 QQ 会话当前不可用。', '恢复同一 QQ 会话后由主人重新发送指令。'); return;
      }
      const model = source.model?.current?.();
      if (!model?.provider || !model?.model) { completion = failure('owner-desktop.model-unavailable', '无法读取来源 QQ 当前模型。', '在原 QQ 会话选定模型后重新发送指令。'); return; }
      lease.modelSelection = { provider: model.provider, model: model.model, ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }) };
      lease.subagents = subagentsFor(source);
      if (typeof lease.subagents?.startActivation !== 'function' || typeof lease.subagents?.sendMessage !== 'function') {
        completion = failure('owner-desktop.subagents-unavailable', '宿主不支持独立电脑会话的正式创建与续接接口。', '更新 DSH 并重载 SurfCore 后重试。'); return;
      }
      const identity = { conversationKey: lease.task.conversationKey, ownerQQ: lease.task.ownerQQ, selfUserId: lease.task.selfUserId, sourceSessionId: lease.sourceSessionId };
      const previous = conversationStore.find(identity);
      if (lease.task.continuationRequested && !previous) {
        completion = failure('owner-desktop.no-previous', '当前 QQ 对话没有可继续的电脑会话历史。', '请先由主人发送新的电脑任务，建立独立会话后再发送继续指令。'); return;
      }
      lease.continuation = Boolean(previous); lease.childId = previous?.sessionId ?? newSessionId();
      if (typeof lease.childId !== 'string' || !lease.childId || lease.childId === lease.sourceSessionId || agents.get(lease.childId)) {
        completion = failure('owner-desktop.child-unavailable', '电脑会话仍在运行或会话身份无效。', '在独立电脑会话中确认停止后，从原 QQ 对话重试。'); return;
      }
      if (!previous) conversationStore.reserve({ ...identity, sessionId: lease.childId });
      const verified = await validate(lease), changed = leaseIssue(lease);
      if (!verified.ok || changed) { completion = changed ?? verified; return; }
      if (lease.task.expiresAt !== null) { timeout = setTimer(() => revoke(lease, failure('owner-desktop.timeout', '电脑任务达到执行时限。', '确认桌面状态后重新发送指令。')), Math.max(1, lease.task.expiresAt - now())); timeout?.unref?.(); }
      lease.phase = 'starting'; lease.dispatching = true; lease.dispatchAttempted = true; watch(); publish();
      const prompt = [{ type: 'text', text: prepared.prompt }];
      lease.dispatchTask = Promise.resolve().then(async () => {
        try {
          if (lease.continuation) return { childId: lease.childId, messageId: await lease.subagents.sendMessage(source, lease.childId, prompt, { signal: lease.controller.signal }) };
          return await lease.subagents.startActivation({ provider: 'spawn', parent: source, childId: lease.childId,
            agentPreset: PRESET, delivery: 'caller', name: 'surfcore-desktop-' + lease.childId.slice(0, 8),
            description: 'SurfCore independent desktop conversation', prompt, agentOptions: lease.modelSelection, signal: lease.controller.signal, maxDepth: 1 });
        } finally { lease.dispatchSettled = true; }
      });
      let receipt;
      try { receipt = await Promise.race([lease.dispatchTask, lease.revokedEvent.promise.then(() => null)]); }
      finally { lease.dispatching = false; }
      if (lease.revoked) { completion = lease.revoked; return; }
      if (receipt?.childId !== lease.childId || !receipt.messageId || !lease.agent || !lease.inserted || receipt.messageId !== lease.inserted.id) {
        completion = failure('owner-desktop.message-unverified', '宿主回执与实际电脑消息不一致。', '重载兼容宿主后由主人重试。'); revoke(lease, completion, 'failed'); return;
      }
      conversationStore.confirm(lease.childId);
      lease.messageId = receipt.messageId;
      const bound = await call('bind', { taskId, leaseId: lease.leaseId, preparedId: lease.preparedId, sessionId: lease.childId, messageId: lease.messageId });
      if (!bound.ok) { completion = bound; revoke(lease, bound, 'failed'); return; }
      lease.bound = true; Object.assign(lease.task, { sessionId: lease.childId, messageId: lease.messageId });
      const boundChecked = await validate(lease), boundChanged = leaseIssue(lease);
      if (!boundChecked.ok || boundChanged) { completion = boundChanged ?? boundChecked; revoke(lease, completion, 'failed'); return; }
      lease.phase = 'running'; lease.binding.resolve(); publish();
      await Promise.race([lease.finished.promise, lease.revokedEvent.promise]);
      if (lease.revoked) completion = { ...lease.revoked, status: lease.terminal };
      else if (lease.turnEnd?.reason?.kind !== 'completed' || !lease.stepAccepted) completion = failure('owner-desktop.execution-failed', '独立电脑轮次没有正常完成。', '查看电脑会话中的失败原因，确认桌面状态后重试。');
      else completion = { ok: true, status: 'done', output: lease.output ?? '' };
    } catch (error) {
      completion = lease.revoked ?? failure(typeof error?.code === 'string' && error.code.startsWith('owner-desktop.') ? error.code : 'owner-desktop.execution-failed', '独立电脑会话启动或执行失败。', typeof error?.hint === 'string' ? error.hint : '检查电脑会话、原 QQ 的 Computer Use 与桥接状态后重试。');
      revoke(lease, completion, 'failed');
    } finally {
      if (timeout) clearTimer(timeout); if (heartbeat) clearTimer(heartbeat);
      if (!lease.ended && !lease.revoked) revoke(lease, completion ?? endedIssue(), 'failed');
      close(lease); lease.binding.resolve();
      // subagent/end and result settle even when host disposal fails. Neither is
      // proof that tools stopped. Only the exact child loop's whenIdle completion
      // proves execution drained; a failure before dispatch has nothing to drain.
      let proofState = 'waiting';
      const proof = observeStopped(lease).then(stopped => { proofState = stopped ? 'stopped' : 'unavailable'; return stopped; });
      const executionStopped = await bounded(proof);
      if (!executionStopped) {
        paused = true; pendingStop = { lease, proofState, reporting: null }; completion = stopIssue();
      }
      if (lease.turnSignal && lease.abortListener) lease.turnSignal.removeEventListener('abort', lease.abortListener);
      lease.ended = true;
      if (claimedTask) {
        completion ??= lease.revoked ?? failure('owner-desktop.execution-failed', '电脑任务未完成。', '查看电脑会话后重试。');
        const terminal = completion.status ?? (completion.ok ? 'done' : 'failed');
        const payload = { taskId, leaseId: lease.leaseId, status: terminal, executionStopped,
          ...(lease.bound ? { sessionId: lease.childId } : {}),
          ...(completion.ok ? { output: completion.output ?? '' } : { code: completion.code, error: completion.error, hint: completion.hint }) };
        const finished = await call('complete', payload);
        lastResult = { taskId, status: terminal, executionStopped, sourceSessionId: lease.sourceSessionId ?? null, desktopSessionId: lease.childId ?? null, sessionId: lease.childId ?? null };
        lastError = !finished.ok ? finished : completion.ok ? null : completion;
        if (pendingStop?.lease === lease) {
          const record = pendingStop; record.payload = { ...payload, executionStopped: true }; record.terminalError = lastError;
          // Attach after the original terminal request: a late proof can only close
          // that same lease, and must never race the initial executionStopped:false.
          void proof.then(stopped => {
            record.proofState = stopped ? 'stopped' : 'unavailable'; publish();
            if (stopped) return reportStopped(record);
          });
        }
      }
      if (active === lease) active = null; lease.done.resolve(); publish();
    }
  }
  function schedule() {
    if (paused || disposed || pollTimer) return;
    pollTimer = setTimer(() => { pollTimer = null; void tick(); }, POLL_MS); pollTimer?.unref?.();
  }
  async function tick() {
    if (paused || disposed) return status();
    if (inFlight) { const issue = active && leaseIssue(active); if (issue) revoke(active, issue); return status(); }
    inFlight = (async () => {
      if (pendingStop?.proofState === 'stopped') await reportStopped(pendingStop);
      const config = settings(); if (!config.enabled && !pendingStop && !brokerBlocked) return;
      const pending = await call('pending'); if (!pending.ok) { availabilityError = pending; publish(); return; }
      if (!Array.isArray(pending.tasks)) { availabilityError = failure('owner-desktop.invalid-pending', '桥接任务列表无效。', '重载兼容桥接后重试。'); publish(); return; }
      if (pending.blocked !== undefined) {
        const blocked = pending.blocked;
        brokerBlocked = blocked?.ok === false && ['code', 'error', 'hint'].every(key => typeof blocked[key] === 'string' && blocked[key])
          ? failure(blocked.code, blocked.error, blocked.hint + ' ' + recoveryHint)
          : failure('owner-desktop.invalid-pending', '桥接停止阻塞状态无效，无法确认旧执行已停止。', recoveryHint);
        publish(); return;
      }
      brokerBlocked = null;
      if (pendingStop) { publish(); return; }
      if (!config.enabled) { publish(); return; }
      const issue = hostIssue(config); if (issue) { availabilityError = issue; publish(); return; }
      // A healthy poll repairs only availability, never an earlier task outcome.
      if (availabilityError) { availabilityError = null; publish(); }
      const task = pending.tasks.find(item => typeof item?.id === 'string' && item.id);
      if (!paused && !disposed && task) await execute(task.id, config);
    })();
    try { await inFlight; } catch { availabilityError = failure('owner-desktop.runtime-failed', '电脑任务轮询失败。', '重载插件并检查任务状态。'); publish(); }
    finally { inFlight = null; schedule(); }
    return status();
  }
  async function cancelActive() {
    if (active) { const lease = active; revoke(lease, failure('owner-desktop.cancelled', '主人电脑任务已取消。', '需要继续时请由主人发送新指令。')); await lease.done.promise; }
    return status();
  }
  async function stop() {
    paused = true; if (pollTimer) clearTimer(pollTimer); pollTimer = null;
    await cancelActive(); if (inFlight) await inFlight; publish(); return status();
  }
  function start() { if (!disposed) { paused = false; schedule(); publish(); } return status(); }
  schedule();
  return { status, tick, stop, start, cancelActive, isManagedAgent: managed };
}
