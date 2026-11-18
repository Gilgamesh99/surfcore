import assert from 'node:assert/strict';
import { installOwnerDesktopRuntime, isOwnerDesktopTool } from '../lib/owner-desktop-runtime.js';
import { installOwnerDesktopConversationGate } from '../lib/owner-desktop-conversation-gate.js';
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const PRESET = 'owner-desktop-conversation';

// Installed host contract: official startActivation receipt; sendMessage returns
// only a message id and cold-restores a new live Agent over the same Session.
// Session snapshots the inserted object, claim fires before schema resolution,
// pre-step can run before dispatch resolves, and host settlement disposes handles.
function fixture(options = {}) {
  let clock = 100_000, timerId = 0, sequence = 0, sessionSequence = 0, running;
  const hooks = new Map(), timers = new Map(), agents = new Map(), masks = new Map(), guards = [], calls = [], records = (options.records ?? []).map(row => ({ ...row })), histories = new Map(options.histories ?? []), activations = [];
  const catalogue = new Set(['windows_desktop', 'windows_mcp_doctor', 'mcp__windows__Screenshot', 'mcp__windows__Click',
    'bash', 'ops_bash', 'read', 'subagent', 'mcp__snowluma__qq_send_message', 'mcp__web-search-safe__web_search', 'todo_write']);
  const native = { describe: definitions => ({ schemas: definitions.map(({ name }) => ({ name })) }) };
  const ptc = { describe: () => ({ schemas: [{ name: 'run_code' }] }) };
  const on = (name, fn) => { const rows = hooks.get(name) ?? []; rows.push(fn); hooks.set(name, rows); return () => { rows.splice(rows.indexOf(fn), 1); }; };
  const emit = (name, ...args) => { for (const fn of [...(hooks.get(name) ?? [])]) fn(...args); };
  const waterfall = (name, value, fallback = () => ({ kind: 'allow' })) => { const rows = [...(hooks.get(name) ?? [])]; const run = index => index === rows.length ? Promise.resolve(fallback()) : rows[index](value, () => run(index + 1)); return run(0); };
  const definitions = agent => [...catalogue].filter(name => {
    if (!agent) return true;
    if (agent.grant === false && (name === 'windows_desktop' || name.startsWith('mcp__windows__'))) return false;
    return (masks.get(agent) ?? []).every(mask => !mask.allow || mask.allow.includes(name));
  }).map(name => ({ name }));
  const rootTools = { definitions, view: () => ({ restrictableNames: new Set(catalogue) }), selectExecutor: agent => agent.executor, guard: fn => { guards.push(fn); return () => {}; } };
  function scopedTools(agent) {
    return { ...rootTools, restrict(mask) {
      for (const name of mask.allow ?? []) assert.ok(name !== 'run_code' && catalogue.has(name), 'host rejects unknown/reserved names');
      const rows = masks.get(agent) ?? []; rows.push(mask); masks.set(agent, rows); emit('tools/change');
      return () => { const index = rows.indexOf(mask); if (index >= 0) rows.splice(index, 1); emit('tools/change'); };
    } };
  }
  const config = { enabled: true, authorizationEpoch: 'epoch-1', timeoutMs: options.timeoutMs ?? 600_000 };
  const owner = { value: '10001' };
  const task = { id: 'task-a', ownerQQ: owner.value, selfUserId: '90001', conversationKey: 'private:10001', sourceMessageId: 'qq-message-123',
    sourceReceivedAt: clock, sourceTime: clock - 1, continuationRequested: false, status: 'running', timeoutMs: config.timeoutMs, claimedAt: clock,
    claimExpiresAt: clock + 300_000, expiresAt: config.timeoutMs === 0 ? null : clock + config.timeoutMs };
  const control = { validate: null, validateHook: null, bindHook: null, prepare: null, sendHook: null, postMessages: null,
    cancelHangs: false, claim: null, receiptId: null, sourceKind: null, dispatchHold: null, receiptHook: null, throwDispatch: false, storageError: false, complete: null, completeHook: null };
  const store = {
    find: identity => records.findLast(row => row.phase === 'ready' && Object.entries(identity).every(([key, value]) => row[key] === value)) ?? null,
    reserve(record) { if (control.storageError) throw Object.assign(new Error('store'), { code: 'owner-desktop.storage-failed', hint: '修复映射存储' }); records.push({ ...record, phase: 'reserved' }); return true; },
    confirm(id) { records.find(row => row.sessionId === id).phase = 'ready'; return true; },
    isSession: id => records.some(row => row.sessionId === id), list: () => records.map(row => ({ ...row })), status: () => ({ ok: true }),
  };
  let source, child;
  function makeAgent(id, parent = null) {
    const inbox = { nextTurn: [], nextStep: [], remove(messageId) {
      for (const list of [this.nextTurn, this.nextStep]) { const index = list.findIndex(message => message.id === messageId); if (index >= 0) { list.splice(index, 1); return true; } } return false;
    } };
    let selection = parent ? { provider: 'old-provider', model: 'old-model' } : { provider: 'original-provider', model: 'original-model', reasoningEffort: 'original-effort' };
    const session = histories.get(id) ?? { id, header: parent ? { agentPreset: PRESET, parentSession: parent.id, origin: 'subagent' } : { agentPreset: 'qq-chat-v2' }, history: [], snapshotEvents: () => [] };
    histories.set(id, session);
    const agent = { id, session, executor: options.ptc && parent ? ptc : native, grant: parent ? parent.grant : options.grant !== false, status: 'idle', inbox,
      model: { current: () => ({ ...selection }), select: route => { selection = { ...route }; } },
      persona: parent ? 'trusted QQ persona in dedicated message' : 'original QQ persona', cancelCalls: [], turn: session.lastTurn ?? 0, idle: deferred(),
      async whenIdle() {
        if (!parent) throw new Error('QQ idle must never be awaited');
        assert.ok(this.submitted || this.cancelCalls.length, 'never observe dispatch-before-send idle as stop proof');
        if (masks.has(this)) assert.equal(definitions(this).length, 0, 'schema permission must close before observing idle');
        assert.ok(guard({ agent: this, name: 'windows_desktop' }), 'execution permission must close before observing idle');
        while (this.status === 'running') await this.idle.promise;
      },
      cancel(cause) { this.cancelCalls.push(cause); if (!parent) throw new Error('QQ must never be cancelled'); this.abort?.abort(cause); if (!control.cancelHangs) finish(this, 'aborted'); },
      send(message) {
        this.submitted = message;
        const snapshot = Object.freeze(structuredClone(message)); this.inbox.nextTurn.push(snapshot);
        emit('agent/inbox/inserted', { agent: this, message: snapshot }); control.sendHook?.(this, snapshot);
        if (this.cancelCalls.length) return;
        this.status = 'running'; this.abort = new AbortController(); this.turn++;
        const claimed = [...this.inbox.nextStep.splice(0), ...this.inbox.nextTurn.splice(0, 1)];
        for (const message of claimed) emit('agent/inbox/claimed', { agent: this, message, turn: this.turn });
        this.initial = claimed.at(-1); this.firstSchemas = definitions(this).map(tool => tool.name);
        this.preStep = waterfall('agent/pre-step', { agent: this, messages: claimed, turn: this.turn, step: 1, signal: this.abort.signal },
          () => ({ kind: 'enter', messages: control.postMessages ?? [...claimed, { id: 'host-context', source: { kind: 'runtime-context' }, content: [] }] }));
        this.preStep.then(result => { if (result.kind !== 'enter') finish(this, 'blocked'); else this.session.history.push(...result.messages); });
      },
    };
    agent.ctx = { preset: session.header.agentPreset, get: name => name === 'tools' ? scopedTools(agent) : undefined };
    agents.set(id, agent); emit('agent/created', { agent }); return agent;
  }
  function finish(agent, kind = 'completed') {
    if (agent.disposed || (control.cancelHangs && kind === 'aborted')) return;
    if (agent.abort) emit('session/event', agent.session, { type: 'turn/end', data: { turn: agent.turn, reason: { kind } } });
    agent.status = 'idle'; agent.idle.resolve(); agent.session.lastTurn = agent.turn; agent.disposed = true;
    emit('agent/disposed', { agent }); agents.delete(agent.id);
    const activation = activations.findLast(row => row.agent === agent);
    if (activation?.continuation) {
      const message = { id: 'settlement-' + ++sequence, role: 'user', source: { kind: 'subagent-settled', form: 'notice', senderSessionId: agent.id }, content: [{ type: 'text', text: 'large result must stay outside QQ' }] };
      source.inbox.nextTurn.push(message); emit('agent/inbox/inserted', { agent: source, message });
    }
    emit('subagent/end', { id: agent.id, parentSessionId: source.id, stopReason: kind }); activation?.result.resolve({ stopReason: kind, output: [] });
  }
  const services = { agents: { get: id => agents.get(id) }, tools: rootTools, agentPresets: { composedPreset: ctx => ctx?.preset, serviceFor: () => services.subagents } };
  const ctx = { on, get: name => services[name] };
  async function dispatch(spec, continuation) {
    if (control.throwDispatch) throw new Error('private transport details');
    assert.equal(spec.parent, source); assert.notEqual(spec.childId, source.id); assert.equal(spec.signal.aborted, false);
    if (!continuation) { assert.equal(spec.provider, 'spawn'); assert.equal(spec.agentPreset, PRESET); assert.equal(spec.delivery, 'caller'); assert.deepEqual(spec.agentOptions, source.model.current()); }
    assert.equal(store.isSession(spec.childId), true, 'persistent deny-only reservation precedes host create');
    child = makeAgent(spec.childId, source);
    const activation = { agent: child, continuation, result: deferred(), spec }; activations.push(activation);
    const message = { id: 'host-message-' + ++sequence, role: 'user', content: spec.prompt,
      source: control.sourceKind ?? (continuation ? { kind: 'agent-message', form: 'relay', senderSessionId: source.id } : { kind: 'user' }) };
    child.send(message); control.receiptHook?.(child, message);
    await control.dispatchHold?.promise;
    return { childId: spec.childId, messageId: control.receiptId ?? message.id, result: activation.result.promise };
  }
  services.subagents = { startActivation: spec => dispatch(spec, false), sendMessage: async (sender, target, content, opts) => (await dispatch({ parent: sender, childId: target, prompt: content, signal: opts.signal }, true)).messageId };
  async function bridge(path, opts = {}) {
    const action = path.split('/').at(-1); calls.push({ action, body: opts.body }); let value = { ok: true };
    if (action === 'pending') value = control.pending ?? { ok: true, tasks: [{ id: task.id }] };
    if (action === 'claim') value = control.claim ?? { ok: true, task: { ...task } };
    if (action === 'prepare') {
      Object.assign(task, { sourceSessionId: source.id, preparedId: 'prepare-' + task.id });
      value = control.prepare ?? { ok: true, task: { ...task }, sourceSessionId: task.sourceSessionId, preparedId: task.preparedId, prompt: 'FULL QQ PERSONA + OWNER COMMAND; NO QQ TOKEN' };
    }
    if (action === 'bind') { await control.bindHook?.(); Object.assign(task, { sessionId: opts.body.sessionId, messageId: opts.body.messageId }); }
    if (action === 'started') task.turnId = opts.body.turnId;
    if (action === 'validate') { await control.validateHook?.(); value = control.validate ?? { ok: true, task: { ...task } }; }
    if (action === 'complete') {
      await control.completeHook?.(opts.body);
      value = control.complete ?? { ok: true, task: { ...task, id: opts.body.taskId, status: opts.body.status, executionStopped: opts.body.executionStopped } };
    }
    return { ok: true, data: value };
  }
  const runtime = installOwnerDesktopRuntime(ctx, { getSettings: () => config, getOwnerQQ: () => owner.value,
    getPresetStatus: () => options.presetMissing ? { ok: false, code: 'owner-desktop.preset-unavailable', error: '预设未就绪', hint: '重载插件' } : { ok: true, agentPreset: PRESET }, conversationStore: store, bridge,
    isManagedAgent: agent => agent?.ctx?.preset?.startsWith('qq-chat') || agent?.id?.startsWith('bili'), isWorkerSession: id => id === 'retired-worker',
    autoStart: false, now: () => clock, newLeaseId: () => 'lease-' + task.id, newSessionId: () => 'desktop-' + ++sessionSequence,
    setTimer(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimer: id => timers.delete(id) });
  if (!options.missingGate) installOwnerDesktopConversationGate({
    tools: { ...rootTools, guard: fn => rootTools.guard(exec => exec.agent?.ctx?.preset === PRESET ? fn(exec) : undefined) },
    on(name, fn) { return on(name, (...args) => { if (!name.startsWith('agent/') || args[0]?.agent?.ctx?.preset === PRESET) return fn(...args); }); },
  });
  source = makeAgent('original-qq'); const sibling = makeAgent('sibling-qq');
  async function begin() { runtime.start(); running = runtime.tick(); await flush(); if (child?.preStep && !control.dispatchHold) return child.preStep; if (!child) await running; return { kind: 'pending' }; }
  const exec = (name = 'mcp__windows__Screenshot', actual = child ?? source) => ({ agent: actual, name, arguments: {}, callId: 'call-1', rootCallId: 'root-1', token: Symbol('host-execution'), signal: actual.abort?.signal ?? new AbortController().signal });
  const prepare = value => waterfall('tools/pre-execute', value);
  const guard = value => { for (const check of guards) { const reason = check(value); if (reason) return reason; } };
  async function execute(value) { const result = await prepare(value); return result.kind === 'allow' ? guard(value) : result.reason; }
  async function fire(ms) { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); await timer.fn(); } await flush(); }
  async function end(kind = 'completed') { finish(child, kind); await running; return runtime.status(); }
  function nextTask() { Object.assign(task, { id: 'task-' + ++sequence, sourceMessageId: 'owner-message-' + sequence, claimedAt: clock, sourceReceivedAt: clock, claimExpiresAt: clock + 300_000, expiresAt: config.timeoutMs === 0 ? null : clock + config.timeoutMs }); for (const key of ['sourceSessionId', 'sessionId', 'messageId', 'preparedId', 'turnId']) delete task[key]; }
  return { runtime, services, source, sibling, agents, task, config, owner, control, calls, timers, catalogue, native, ptc, masks, store, records, histories, activations,
    begin, end, emit, waterfall, exec, prepare, guard, execute, fire, definitions, finish, nextTask, running: () => running, child: () => child, advance: ms => { clock += ms; } };
}

let passed = 0;
async function check(name, run) { await run(); passed++; console.log('PASS ' + name); }
await check('separate child follows QQ model/persona; original busy inbox and tools unchanged', async () => {
  const f = fixture(); f.source.status = 'running'; const normal = { id: 'normal-message' }; f.source.inbox.nextStep.push(normal); const before = f.definitions(f.source);
  assert.equal((await f.begin()).kind, 'enter'); const child = f.child();
  assert.notEqual(child, f.source); assert.deepEqual(child.model.current(), f.source.model.current()); assert.equal(f.source.cancelCalls.length, 0);
  assert.deepEqual(f.source.inbox.nextStep, [normal]); assert.equal(f.source.persona, 'original QQ persona'); assert.deepEqual(f.source.session.history, []); assert.deepEqual(f.definitions(f.source), before);
  assert.notEqual(child.submitted, child.initial); assert.equal(f.task.messageId, child.initial.id); assert.equal(f.task.sessionId, child.id);
  assert.ok(child.firstSchemas.includes('windows_desktop')); assert.ok(child.firstSchemas.every(isOwnerDesktopTool));
  assert.equal(await f.execute(f.exec()), undefined);
  for (const name of ['run_code', 'ops_bash', 'read', 'subagent', 'mcp__snowluma__qq_send_message', 'todo_write']) assert.match(await f.execute(f.exec(name)), /tool-not-allowed/);
  assert.match(await f.execute(f.exec('windows_desktop', f.source)), /授权|权限/);
  f.emit('session/event', child.session, { type: 'assistant/message', data: { turn: child.turn, message: { role: 'assistant', content: [{ type: 'text', text: '电脑完成短报' }] } } });
  const result = await f.end(); assert.equal(result.lastResult.status, 'done'); assert.equal(f.calls.at(-1).body.output, '电脑完成短报'); assert.equal(f.calls.at(-1).body.executionStopped, true);
  assert.equal(f.agents.get(f.source.id), f.source); assert.equal(f.agents.has(child.id), false); assert.equal(f.records[0].phase, 'ready');
});
await check('cold continuation retains only computer history and current QQ model selection', async () => {
  const f = fixture(); await f.begin(); const first = f.child(); first.session.history.push({ screen: 'prior computer context' }); await f.end();
  f.source.model.select({ provider: 'new-provider', model: 'new-model', reasoningEffort: 'high' }); f.nextTask(); await f.begin();
  const second = f.child(); assert.equal(second.id, first.id); assert.notEqual(second, first); assert.equal(second.session, first.session); assert.ok(second.session.history.some(row => row.screen));
  assert.deepEqual(second.model.current(), f.source.model.current()); assert.equal(second.initial.source.kind, 'agent-message'); assert.equal(f.activations[1].continuation, true);
  await f.end(); assert.deepEqual(f.source.inbox.nextTurn, []); assert.deepEqual(f.source.session.history, []); assert.equal(f.source.cancelCalls.length, 0);
});
await check('claim before dispatch receipt cannot enter model or execute tool', async () => {
  const f = fixture(); f.control.dispatchHold = deferred(); await f.begin(); const child = f.child();
  assert.ok(child.firstSchemas.every(isOwnerDesktopTool)); assert.match(await f.execute(f.exec()), /turn-mismatch/); assert.equal(f.calls.some(row => row.action === 'bind'), false);
  f.control.dispatchHold.resolve(); f.control.dispatchHold = null; await flush(); assert.equal((await child.preStep).kind, 'enter'); await f.end();
});
await check('receipt ID mismatch, wrong source and forged claimed clone fail closed', async () => {
  for (const mutate of [f => { f.control.receiptId = 'wrong-receipt'; }, f => { f.control.sourceKind = { kind: 'runtime-context' }; }, f => { f.control.sendHook = (agent, message) => f.emit('agent/inbox/claimed', { agent, message: structuredClone(message), turn: 1 }); }]) {
    const f = fixture(); mutate(f); await f.begin(); await f.running(); assert.notEqual(f.runtime.status().lastResult.status, 'done'); assert.ok(f.runtime.status().lastError.hint); assert.equal(f.calls.some(row => row.action === 'started'), false);
  }
});
for (const [label, option, code] of [['PTC transport', { ptc: true }, 'native-presentation'], ['missing gate', { missingGate: true }, 'native-presentation'], ['human Computer Use off', { grant: false }, 'computer-use-off']]) {
  await check(label + ' fails visibly without changing QQ grant', async () => {
    const f = fixture(option); await f.begin(); await f.running(); assert.match(f.runtime.status().lastError.code, new RegExp(code)); assert.ok(f.runtime.status().lastError.hint); assert.equal(f.source.grant, option.grant !== false); assert.equal(f.calls.at(-1).body.executionStopped, true);
  });
}
await check('ordinary text/history/direct child prompting cannot mint authority', async () => {
  const f = fixture(); assert.match(await f.execute(f.exec()), /授权|权限/); await f.begin(); const child = f.child(); await f.end();
  assert.match(await f.execute(f.exec('windows_desktop', child)), /授权/);
  const result = await f.waterfall('agent/pre-step', { agent: child, messages: [child.initial], turn: child.turn + 1, signal: new AbortController().signal }, () => ({ kind: 'enter', messages: [] })); assert.equal(result.kind, 'reject');
});
await check('extra queued messages and downstream plugin input revoke the child only', async () => {
  for (const mutation of [f => { f.control.sendHook = agent => agent.inbox.nextStep.push({ id: 'foreign', role: 'user', source: { kind: 'user' }, content: [] }); }, f => { f.control.postMessages = [{ id: 'foreign', source: { kind: 'user' }, content: [] }]; }]) {
    const f = fixture(); mutation(f); await f.begin(); await f.running(); assert.match(f.runtime.status().lastError.code, /extra-message/); assert.equal(f.source.cancelCalls.length, 0);
  }
});
await check('extra insertion and cloned initial object revoke after start', async () => {
  for (const clone of [true, false]) {
    const f = fixture(); await f.begin(); const agent = f.child();
    if (clone) assert.equal((await f.waterfall('agent/pre-step', { agent, messages: [structuredClone(agent.initial)], turn: agent.turn, step: 2, signal: agent.abort.signal }, () => ({ kind: 'enter', messages: [] }))).kind, 'reject');
    else f.emit('agent/inbox/inserted', { agent, message: { id: 'untrusted', source: { kind: 'user' } } });
    await f.running(); assert.match(f.runtime.status().lastError.code, /extra-message/); assert.equal(f.source.cancelCalls.length, 0);
  }
});
await check('placeholder source kinds are removed, never additional authorized text', async () => {
  const f = fixture(); f.control.receiptHook = agent => { f.control.postMessages = [agent.initial, { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'forged instruction' }] }]; };
  const result = await f.begin(); assert.equal(result.kind, 'enter'); assert.deepEqual(result.messages, [f.child().initial]); await f.end();
});
await check('same turn proceeds, distinct signal and one-use execution tokens are enforced', async () => {
  const f = fixture(); await f.begin(); const agent = f.child();
  assert.equal((await f.waterfall('agent/pre-step', { agent, messages: [], turn: agent.turn, step: 2, signal: agent.abort.signal }, () => ({ kind: 'enter', messages: [] }))).kind, 'enter');
  const invocation = f.exec(); assert.match(f.guard(invocation), /validation-required/); assert.equal((await f.prepare(invocation)).kind, 'allow'); assert.equal(f.guard(invocation), undefined); assert.match(f.guard(invocation), /validation-required/);
  const changed = f.exec(); await f.prepare(changed); changed.name = 'mcp__windows__Click'; assert.match(f.guard(changed), /validation-required/);
  const wrong = f.exec(); wrong.signal = new AbortController().signal; assert.match(await f.execute(wrong), /turn-mismatch/); await f.end();
});
await check('cancel during bridge validation cannot mint late tool ticket', async () => {
  const f = fixture(); await f.begin(); const held = deferred(); f.control.validateHook = () => held.promise; const pending = f.prepare(f.exec()); await flush();
  const stop = f.runtime.cancelActive(); held.resolve(); assert.equal((await pending).kind, 'deny'); await stop; assert.equal(f.calls.at(-1).body.executionStopped, true); assert.equal(f.source.cancelCalls.length, 0);
});
await check('replaced child/source objects, owner, bridge identity and executor changes revoke', async () => {
  for (const mutate of [f => f.agents.set(f.child().id, { ...f.child() }), f => f.agents.set(f.source.id, { ...f.source }), f => { f.owner.value = '10002'; }, f => { f.task.sourceMessageId = 'other'; }, f => { f.child().executor = f.ptc; f.emit('tools/change'); }]) {
    const f = fixture(); await f.begin(); mutate(f); assert.ok(await f.execute(f.exec())); await f.runtime.cancelActive(); assert.ok(f.runtime.status().lastError.hint);
  }
});
await check('disable, unload and stop cancel only child and preserve parent queue', async () => {
  for (const action of ['disable', 'dispose', 'stop']) {
    const f = fixture(); await f.begin(); const normal = { id: 'normal' }; f.source.inbox.nextTurn.push(normal);
    if (action === 'disable') { f.config.enabled = false; await f.fire(2000); } else if (action === 'dispose') f.emit('dispose'); else await f.runtime.stop();
    await f.running(); assert.equal(f.agents.get(f.source.id), f.source); assert.equal(f.source.cancelCalls.length, 0); assert.deepEqual(f.source.inbox.nextTurn, [normal]); assert.equal(f.calls.at(-1).body.executionStopped, true);
  }
});
await check('failed cancellation reports real stop uncertainty and pauses admission', async () => {
  const f = fixture(); await f.begin(); f.control.cancelHangs = true; const stop = f.runtime.stop(); await flush(); await f.fire(10_000); await stop;
  assert.equal(f.calls.at(-1).body.executionStopped, false); assert.match(f.runtime.status().lastError.code, /stop-unconfirmed/); assert.equal(f.runtime.status().phase, 'stopping');
  f.control.pending = { ok: true, tasks: [] }; const before = f.runtime.status().lastResult; f.runtime.start(); await f.runtime.tick();
  assert.equal(f.runtime.status().ok, false); assert.equal(f.runtime.status().phase, 'stopping'); assert.deepEqual(f.runtime.status().lastResult, before);
  assert.equal(f.calls.filter(row => row.action === 'claim').length, 1);
});
await check('unlimited timeout and finite timeout actively preserve or cancel execution', async () => {
  const unlimited = fixture({ timeoutMs: 0 }); await unlimited.begin(); unlimited.advance(10_000_000); await unlimited.fire(2000); assert.equal(await unlimited.execute(unlimited.exec()), undefined); await unlimited.end();
  const limited = fixture({ timeoutMs: 30_000 }); await limited.begin(); limited.advance(30_000); await limited.fire(30_000); await limited.running(); assert.match(limited.runtime.status().lastError.code, /timeout/);
});
await check('late non-Windows registrations stay hidden; late Windows obey lease', async () => {
  const f = fixture(); await f.begin(); f.catalogue.add('future_unsafe_tool'); f.catalogue.add('mcp__windows__LateTool'); f.emit('tools/change');
  assert.ok(!f.definitions(f.child()).some(tool => tool.name === 'future_unsafe_tool')); assert.ok(f.definitions(f.child()).some(tool => tool.name === 'mcp__windows__LateTool')); await f.end();
});
await check('progress is a bounded host report to the same task; no child QQ tool', async () => {
  const f = fixture(); await f.begin(); const child = f.child();
  const progress = { type: 'assistant/message', data: { turn: child.turn, message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(900) }, { type: 'tool-call' }] } } };
  f.emit('session/event', child.session, progress); f.emit('session/event', child.session, progress); await flush();
  const reports = f.calls.filter(row => row.action === 'progress'); assert.equal(reports.length, 1); assert.equal(reports[0].body.summary.length, 500); assert.equal(reports[0].body.taskId, f.task.id); await f.end();
});
await check('settlement suppression requires exact typed source child-parent pair', async () => {
  const f = fixture(); await f.begin(); const child = f.child();
  for (const message of [{ id: 'normal', source: { kind: 'user' } }, { id: 'fake', source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'unregistered' } }]) { f.source.inbox.nextTurn.push(message); f.emit('agent/inbox/inserted', { agent: f.source, message }); }
  const other = { id: 'other-parent', source: { kind: 'subagent-settled', form: 'notice', senderSessionId: child.id } }; f.sibling.inbox.nextTurn.push(other); f.emit('agent/inbox/inserted', { agent: f.sibling, message: other });
  assert.equal(f.source.inbox.nextTurn.length, 2); assert.deepEqual(f.sibling.inbox.nextTurn, [other]); await f.end();
});
await check('store/preset/start failures are visible; retired workers deny every tool', async () => {
  for (const options of [{ presetMissing: true }, {}]) { const f = fixture(options); if (!options.presetMissing) f.control.storageError = true; await f.begin(); await f.running(); assert.ok(f.runtime.status().lastError.hint); assert.equal(f.source.cancelCalls.length, 0); }
  const f = fixture(); f.control.throwDispatch = true; await f.begin(); await f.running(); assert.ok(!f.runtime.status().lastError.error.includes('private transport')); assert.equal(f.records[0].phase, 'reserved');
  const old = { id: 'retired-worker', session: { id: 'retired-worker', header: {} } }; assert.match(await f.execute(f.exec('todo_write', old)), /retired-worker/);
});
await check('changed bot identity never reuses a different conversation history', async () => {
  const f = fixture(); await f.begin(); const first = f.child().id; await f.end(); f.nextTask(); f.task.selfUserId = '90002'; await f.begin(); assert.notEqual(f.child().id, first); assert.equal(f.activations[1].continuation, false); await f.end();
});
await check('subagent/end and receipt resolution do not prove an active loop stopped', async () => {
  const f = fixture(); await f.begin(); f.control.cancelHangs = true; const child = f.child();
  f.emit('subagent/end', { id: child.id, parentSessionId: f.source.id, stopReason: 'error' });
  f.activations[0].result.resolve({ stopReason: 'error' }); await flush(); await f.fire(10_000); await f.running();
  assert.equal(child.status, 'running'); assert.equal(f.calls.at(-1).body.executionStopped, false); assert.match(f.runtime.status().lastError.code, /stop-unconfirmed/);
});
await check('status returns independent rows and explicit store corruption even while disabled', async () => {
  const f = fixture(); await f.begin(); const status = f.runtime.status(); status.conversations[0].sessionId = 'mutated'; assert.notEqual(f.records[0].sessionId, 'mutated'); await f.end();
  f.config.enabled = false; f.store.list = () => { throw { code: 'owner-desktop.conversation-store-unreadable', error: '目录损坏', hint: '保留记录并恢复备份' }; };
  const failed = f.runtime.status(); assert.equal(failed.ok, false); assert.equal(failed.lastError.code, 'owner-desktop.conversation-store-unreadable'); assert.equal(failed.lastError.error, '目录损坏'); assert.equal(failed.lastError.hint, '保留记录并恢复备份');
});
await check('broken desktop index keeps ordinary QQ safe tools but denies desktop operations', async () => {
  const f = fixture(); await f.begin();
  f.store.isSession = () => { throw new Error('unreadable'); };
  f.store.status = () => ({ ok: false, code: 'owner-desktop.conversation-store-unreadable', error: '目录损坏', hint: '保留并修复目录' });
  assert.equal(await f.execute(f.exec('mcp__snowluma__qq_send_message', f.source)), undefined);
  assert.match(await f.execute(f.exec('windows_desktop', f.source)), /普通 QQ/);
  assert.match(await f.execute(f.exec()), /conversation-store-unreadable/);
  await f.runtime.cancelActive(); assert.equal(f.source.cancelCalls.length, 0);
});
await check('cancel during unfinished dispatch is bounded and cannot observe early idle as proof', async () => {
  const f = fixture(); const held = deferred(); f.control.dispatchHold = held; await f.begin();
  const stop = f.runtime.cancelActive(); await flush(); await f.fire(10_000); await stop;
  assert.equal(f.calls.at(-1).body.executionStopped, false); assert.match(f.runtime.status().lastError.code, /stop-unconfirmed/); assert.equal(f.source.cancelCalls.length, 0);
  assert.equal(f.child().status, 'idle');
  assert.deepEqual(f.calls.filter(row => row.action === 'complete').map(row => row.body.executionStopped), [false], 'early idle is not dispatch completion');
  held.resolve(); await flush(); assert.ok(await f.execute(f.exec())); assert.equal(f.calls.some(row => row.action === 'bind'), false);
  assert.deepEqual(f.calls.filter(row => row.action === 'complete').map(row => row.body.executionStopped), [false, true]);
});
await check('healthy polling clears transient availability only and preserves failed task outcome', async () => {
  const options = { presetMissing: true }; const f = fixture(options); f.control.pending = { ok: true, tasks: [] };
  await f.begin(); assert.equal(f.runtime.status().lastError.code, 'owner-desktop.preset-unavailable');
  options.presetMissing = false; await f.runtime.tick(); assert.equal(f.runtime.status().lastError, null);
  f.control.pending = { ok: false, code: 'owner-desktop.bridge-unavailable', error: '离线', hint: '恢复连接' };
  await f.runtime.tick(); assert.equal(f.runtime.status().lastError.code, 'owner-desktop.bridge-unavailable');
  f.control.pending = { ok: true, tasks: [] }; await f.runtime.tick(); assert.equal(f.runtime.status().lastError, null);
  f.control.pending = null; await f.begin(); const failed = await f.end('error'); const terminal = failed.lastResult;
  assert.equal(terminal.status, 'failed');
  f.control.pending = { ok: false, code: 'owner-desktop.bridge-unavailable', error: '离线', hint: '恢复连接' }; await f.runtime.tick();
  f.control.pending = { ok: true, tasks: [] }; await f.runtime.tick();
  assert.deepEqual(f.runtime.status().lastResult, terminal); assert.equal(f.runtime.status().lastError.code, failed.lastError.code);
});
await check('fresh continue after restart uses durable child history and current QQ route', async () => {
  const first = fixture(); await first.begin(); const oldChild = first.child(), id = oldChild.id; await first.end();
  const previousHistory = [...oldChild.session.history]; const resumed = fixture({ records: first.records, histories: [[id, first.histories.get(id)]] });
  resumed.task.continuationRequested = true; resumed.source.model.select({ provider: 'changed-provider', model: 'changed-model' });
  assert.equal((await resumed.begin()).kind, 'enter'); assert.equal(resumed.child().id, id); assert.notEqual(resumed.child(), oldChild);
  assert.equal(resumed.activations[0].continuation, true); assert.deepEqual(resumed.child().session.history.slice(0, previousHistory.length), previousHistory);
  assert.deepEqual(resumed.child().model.current(), resumed.source.model.current()); await resumed.end();
});
await check('continue without ready matching history fails visibly without creating a child', async () => {
  for (const records of [[], [{ phase: 'reserved', conversationKey: 'private:10001', ownerQQ: '10001', selfUserId: '90001', sourceSessionId: 'original-qq', sessionId: 'reserved-desktop' }], [{ phase: 'ready', conversationKey: 'private:10001', ownerQQ: '10001', selfUserId: 'different-bot', sourceSessionId: 'original-qq', sessionId: 'foreign-desktop' }]]) {
    const f = fixture({ records }); f.task.continuationRequested = true; await f.begin();
    assert.equal(f.runtime.status().lastError.code, 'owner-desktop.no-previous'); assert.ok(f.runtime.status().lastError.hint); assert.equal(f.child(), undefined);
    assert.equal(f.records.length, records.length); assert.equal(f.calls.at(-1).body.executionStopped, true);
  }
});
await check('continuation intent is boolean and bound through every validation', async () => {
  for (const intent of [undefined, 'true', 0]) { const f = fixture(); f.task.continuationRequested = intent; await f.begin(); assert.equal(f.runtime.status().lastError.code, 'owner-desktop.invalid-task'); assert.equal(f.child(), undefined); }
  const f = fixture(); await f.begin(); f.control.validate = { ok: true, task: { ...f.task, continuationRequested: true } };
  assert.match(await f.execute(f.exec()), /task-changed/); await f.runtime.cancelActive();
});
await check('real late idle closes the original lease once without reviving tools or terminal outcome', async () => {
  const f = fixture(); await f.begin(); const child = f.child(); const normal = { id: 'normal-QQ-message' }; f.source.inbox.nextTurn.push(normal);
  f.control.cancelHangs = true; const stop = f.runtime.stop(); await flush(); await f.fire(10_000); await stop;
  const terminal = f.runtime.status().lastResult; f.config.authorizationEpoch = 'epoch-changed'; f.owner.value = 'other-owner';
  f.control.cancelHangs = false; f.finish(child, 'aborted'); await flush();
  const completed = f.calls.filter(row => row.action === 'complete').map(row => row.body);
  assert.equal(completed.length, 2); assert.deepEqual(completed[1], { ...completed[0], executionStopped: true });
  assert.deepEqual(f.runtime.status().lastResult, { ...terminal, executionStopped: true }); assert.equal(f.runtime.status().lastError, null);
  assert.equal(f.runtime.status().phase, 'paused'); assert.equal(f.activations.length, 1); assert.equal(f.calls.filter(row => row.action === 'bind').length, 1);
  assert.equal(f.definitions(child).length, 0); assert.ok(await f.execute(f.exec('windows_desktop', child)));
  assert.deepEqual(f.source.inbox.nextTurn, [normal]); assert.equal(f.source.cancelCalls.length, 0);
  f.emit('subagent/end', { id: child.id, parentSessionId: f.source.id, stopReason: 'aborted' }); f.emit('agent/disposed', { agent: child }); await flush();
  assert.equal(f.calls.filter(row => row.action === 'complete').length, 2);
});
await check('late proof waits for the initial terminal request and coalesces concurrent retries', async () => {
  const f = fixture(); await f.begin(); const initial = deferred(), late = deferred();
  f.control.completeHook = body => body.executionStopped ? late.promise : initial.promise;
  f.control.cancelHangs = true; const stop = f.runtime.stop(); await flush(); await f.fire(10_000);
  f.control.cancelHangs = false; f.finish(f.child(), 'aborted'); await flush();
  assert.deepEqual(f.calls.filter(row => row.action === 'complete').map(row => row.body.executionStopped), [false]);
  initial.resolve(); await stop; await flush();
  f.control.pending = { ok: true, tasks: [] }; f.runtime.start(); const retry = f.runtime.tick(); await flush(); await f.runtime.tick();
  assert.deepEqual(f.calls.filter(row => row.action === 'complete').map(row => row.body.executionStopped), [false, true]);
  late.resolve(); await retry; assert.equal(f.runtime.status().lastResult.executionStopped, true); assert.equal(f.activations.length, 1);
});
await check('failed or mismatched late proof stays blocked and retry submits only the same proof', async () => {
  for (const reply of [{ ok: false, code: 'OWNER_DESKTOP_DISCONNECTED', error: '离线', hint: '恢复桥接连接' }, { ok: true, task: { id: 'another-task', executionStopped: true } }]) {
    const f = fixture(); await f.begin(); f.control.cancelHangs = true; const stop = f.runtime.stop(); await flush(); await f.fire(10_000); await stop;
    f.control.complete = reply; f.control.cancelHangs = false; f.finish(f.child(), 'aborted'); await flush();
    assert.equal(f.runtime.status().phase, 'stopping'); assert.equal(f.runtime.status().lastError.code, 'owner-desktop.stop-proof-pending'); assert.ok(f.runtime.status().lastError.hint);
    assert.equal(f.runtime.status().lastResult.executionStopped, false);
    assert.ok(f.runtime.status().lastError.error.includes(reply.ok ? '停止回执与原任务' : reply.error));
    f.control.pending = { ok: true, tasks: [] }; f.control.complete = null; f.runtime.start(); await f.runtime.tick();
    const completed = f.calls.filter(row => row.action === 'complete').map(row => row.body);
    assert.deepEqual(completed.map(body => body.executionStopped), [false, true, true]); assert.deepEqual(completed[1], completed[2]);
    assert.equal(f.runtime.status().lastResult.executionStopped, true); assert.equal(f.runtime.status().lastError, null);
    assert.equal(f.calls.filter(row => row.action === 'claim').length, 1); assert.equal(f.calls.filter(row => row.action === 'bind').length, 1); assert.equal(f.activations.length, 1);
  }
});
await check('reload with remote stopping blocker cannot fabricate proof or appear idle', async () => {
  const f = fixture(); const blocked = { ok: false, code: 'OWNER_DESKTOP_PREVIOUS_STOPPING', error: '旧执行未确认停止', hint: '等待真实停止证明' };
  f.control.pending = { ok: true, tasks: [{ id: f.task.id }], blocked }; await f.begin();
  for (const enabled of [true, false, true]) {
    f.config.enabled = enabled; f.runtime.start(); assert.equal(f.runtime.status().ok, false); await f.runtime.tick();
    const status = f.runtime.status(); assert.equal(status.phase, 'stopping'); assert.equal(status.lastError.code, blocked.code); assert.equal(status.lastError.error, blocked.error);
    assert.ok(status.lastError.hint.includes(blocked.hint)); assert.match(status.lastError.hint, /完全退出 DSH/); assert.match(status.lastError.hint, /重启 QQ 桥接/);
    assert.equal(f.calls.some(row => ['claim', 'bind', 'complete'].includes(row.action)), false); assert.equal(f.child(), undefined);
  }
  f.control.pending = { ok: true, tasks: [] }; await f.runtime.tick(); assert.equal(f.runtime.status().lastError, null);
});
await check('replacement instance and disposal notices never acknowledge an original running loop', async () => {
  const f = fixture(); await f.begin(); const child = f.child(); f.control.cancelHangs = true;
  const stop = f.runtime.stop(); await flush(); await f.fire(10_000); await stop;
  let replacementObserved = false; f.agents.set(child.id, { ...child, status: 'idle', whenIdle: async () => { replacementObserved = true; } });
  f.emit('agent/disposed', { agent: child }); f.emit('subagent/end', { id: child.id, parentSessionId: f.source.id, stopReason: 'completed' }); f.activations[0].result.resolve({ stopReason: 'completed' }); await flush();
  assert.equal(replacementObserved, false); assert.deepEqual(f.calls.filter(row => row.action === 'complete').map(row => row.body.executionStopped), [false]);
  f.control.cancelHangs = false; f.finish(child, 'aborted'); await flush(); assert.deepEqual(f.calls.filter(row => row.action === 'complete').map(row => row.body.executionStopped), [false, true]);
});
await check('rejected idle proof remains blocked while unload never waits indefinitely', async () => {
  const f = fixture(); await f.begin(); f.child().whenIdle = async () => { throw new Error('loop observation failed'); };
  f.control.cancelHangs = true; await f.runtime.stop(); f.control.cancelHangs = false; f.finish(f.child(), 'aborted'); await flush();
  f.control.pending = { ok: true, tasks: [] }; f.runtime.start(); await f.runtime.tick();
  assert.equal(f.runtime.status().phase, 'stopping'); assert.match(f.runtime.status().lastError.hint, /完全退出 DSH/);
  assert.deepEqual(f.calls.filter(row => row.action === 'complete').map(row => row.body.executionStopped), [false]);
  f.emit('dispose'); await flush(); assert.equal(f.runtime.status().phase, 'stopped'); assert.equal(f.runtime.status().ok, false);
  const late = fixture(); await late.begin(); late.control.cancelHangs = true; const stop = late.runtime.stop(); await flush(); await late.fire(10_000); await stop;
  late.emit('dispose'); await flush(); assert.equal(late.runtime.status().phase, 'stopped');
  late.control.cancelHangs = false; late.finish(late.child(), 'aborted'); await flush();
  assert.deepEqual(late.calls.filter(row => row.action === 'complete').map(row => row.body.executionStopped), [false, true]); assert.equal(late.timers.size, 0);
});
console.log('owner desktop independent conversation runtime: ' + passed + ' groups passed');
