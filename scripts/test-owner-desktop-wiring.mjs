import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createOwnerDesktopBroker, handleOwnerDesktopRoute } from '../src/owner-desktop-broker.js';
import { readQqSessionSources } from '../src/owner-desktop-config.js';
import { createOwnerDesktopPolicy } from '../plugins/surfcore/lib/owner-desktop-policy.js';

const source = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
const callbacks = source.slice(source.indexOf('  bot.onPrivateMessage(async (event) => {'), source.indexOf("  bot.onNotice('notify'"));
const leaseId = 'bridge-fixture-lease-12345';
let passed = 0;
let nextMessage = 1;
async function harness({ config = {}, savedState, files = {}, globals = {} } = {}) {
  const liveSource = Symbol('fixture-live-source');
  const settings = { enabled: true, authorizationEpoch: 'fixture-epoch', timeoutMs: 600000 };
  let handler;
  const server = new EventEmitter();
  server.address = () => ({ port: 41234 });
  server.listen = (_port, _host, cb) => { server.listening = true; cb?.(); return server; };
  server.close = cb => { server.emit('close'); cb?.(); };
  function FixtureSymbol(description) { return description === 'owner-desktop-live' ? liveSource : Symbol(description); }
  Object.setPrototypeOf(FixtureSymbol, Symbol);
  const h = await bridgeHarness({ config: { sendDelayMs: 0, ...config }, savedState, files, globals: {
    ...globals, Symbol: FixtureSymbol, createOwnerDesktopBroker, handleOwnerDesktopRoute,
    readOwnerDesktopSettings: () => ({ ...settings }), http: { createServer: callback => { handler = callback; return server; } },
  } });
  h.cfg.sendDelayMs = 0; h.setMode('reserved2'); h.setSelfIdentity('fixture bot', '999');
  h.startConsoleServer();
  const live = {};
  vm.runInNewContext(callbacks, { bot: { onPrivateMessage: fn => { live.private = fn; }, onGroupMessage: fn => { live.group = fn; } },
    handleIncoming: h.handleIncoming, cfg: h.cfg, ownerDesktopLiveSource: liveSource, log() {} });
  function event(kind = 'private', patch = {}) {
    return { post_type: 'message', message_type: kind, user_id: 123, sender: { user_id: 123, nickname: 'owner fixture' }, self_id: 999,
      ...(kind === 'group' ? { group_id: 456 } : {}), message_id: nextMessage++, time: Math.ceil(Date.now() / 1000),
      message: [...(kind === 'group' ? [{ type: 'at', data: { qq: 999 } }] : []), { type: 'text', data: { text: '电脑：打开浏览器查看天气' } }], ...patch };
  }
  async function request(action, { method = 'GET', body = {}, headers = {}, raw, prefix = '/api/owner-desktop/' } = {}) {
    const req = new EventEmitter();
    req.url = prefix + action; req.method = method;
    req.headers = { host: '127.0.0.1:41234', 'x-console-token': 'fixture-console-token', 'content-type': 'application/json', ...headers };
    req.pause = () => {};
    let response;
    const res = { writeHead(status) { this.status = status; }, end(text) { response = { status: this.status, data: JSON.parse(text) }; } };
    const running = handler(req, res);
    if (method !== 'GET') { req.emit('data', Buffer.from(raw ?? JSON.stringify(body))); req.emit('end'); }
    await running;
    assert.ok(response, 'handler must respond');
    return response;
  }
  return { ...h, settings, live, event, request, close: async () => { server.close(); await h.close(); } };
}
async function test(name, run, options = {}) {
  const h = await harness(options);
  try { await run(h); passed++; console.log('PASS', name); }
  finally { await h.close(); }
}
async function claim(h, kind = 'private') {
  await h.live[kind](h.event(kind));
  const pending = await h.request('pending');
  assert.equal(pending.status, 200); assert.equal(pending.data.tasks.length, 1);
  const taskId = pending.data.tasks[0].id;
  const claimed = await h.request('claim', { method: 'POST', body: { taskId, leaseId } });
  assert.equal(claimed.status, 200); assert.equal(claimed.data.task.text, '电脑：打开浏览器查看天气');
  return taskId;
}
async function bind(h, taskId, turnId = 'desktop-fixture-turn') {
  const prepared = await h.request('prepare', { method: 'POST', body: { taskId, leaseId } });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.data));
  const messageId = 'fixture-host-message-' + taskId;
  const desktopSessionId = 'desktop-child-' + prepared.data.sourceSessionId;
  const bound = await h.request('bind', { method: 'POST', body: { taskId, leaseId, preparedId: prepared.data.preparedId, sessionId: desktopSessionId, messageId } });
  assert.equal(bound.status, 200, JSON.stringify(bound.data));
  const started = await h.request('started', { method: 'POST', body: { taskId, leaseId, messageId, turnId } });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  return { ...prepared.data, desktopSessionId, task: started.data.task };
}
function failed(response, status) {
  if (status) assert.equal(response.status, status);
  assert.equal(response.data.ok, false); assert.ok(response.data.code); assert.ok(response.data.error); assert.ok(response.data.hint);
}

await test('real private/group callbacks derive the source then bind a distinct desktop child', async h => {
  for (const kind of ['private', 'group']) {
    const id = await claim(h, kind);
    const prepared = await bind(h, id);
    assert.equal(prepared.sourceSessionId, h.state.sessions[kind === 'private' ? 'private:123' : 'group:456']);
    assert.notEqual(prepared.desktopSessionId, prepared.sourceSessionId);
    assert.equal(prepared.task.sessionId, prepared.desktopSessionId); assert.equal(prepared.task.continuationRequested, false);
    assert.equal(h.calls.prompts.length, 0, 'host sends into the separate child through its official API');
    assert.ok(h.getSocialV2State(kind === 'private' ? 'private:123' : 'group:456').recentMessages.some(m => m.ownerDesktop && m.text.includes('打开浏览器')));
    assert.equal(h.getSocialV2State(kind === 'private' ? 'private:123' : 'group:456').unread.length, 0);
    const complete = await h.request('complete', { method: 'POST', body: { taskId: id, leaseId, status: 'done', output: '任务完成', executionStopped: true } });
    assert.equal(complete.status, 200); assert.equal(h.calls.sent.at(-1).kind, kind);
    assert.equal(h.calls.sent.at(-1).id, kind === 'private' ? 123 : 456);
  }
  const serialized = JSON.stringify((await h.request('status')).data);
  assert.ok(!serialized.includes('打开浏览器')); assert.ok(!serialized.includes(leaseId));
  const ledger = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/owner-desktop-consumed.json'), 'utf8'));
  assert.equal(ledger.length, 2); assert.deepEqual(Object.keys(ledger[0]).sort(), ['digest', 'until']);
});
await test('natural Windows-MCP owner request prepares exact source text for a separate desktop session', async h => {
  const text = '你使用Windows-MCP控制我的电脑，打开b站刷一会';
  h.settings.timeoutMs = 0;
  for (const kind of ['private', 'group']) {
    const event = h.event(kind);
    event.message.at(-1).data.text = text;
    await h.live[kind](event);
    const pending = await h.request('pending');
    assert.equal(pending.data.tasks.length, 1, kind + ': natural owner command must reach desktop intake');
    assert.equal(h.calls.prompts.length, 0, 'desktop command is reserved for exact host insertion');
    assert.equal(h.getSocialV2State(kind === 'private' ? 'private:123' : 'group:456').unread.length, 0);
    const taskId = pending.data.tasks[0].id;
    const claimed = await h.request('claim', { method: 'POST', body: { taskId, leaseId } });
    assert.equal(claimed.status, 200);
    assert.equal(claimed.data.task.text, text);
    assert.equal(claimed.data.task.timeoutMs, 0);
    assert.equal(claimed.data.task.expiresAt, null);
    assert.equal(claimed.data.task.conversationKey, kind === 'private' ? 'private:123' : 'group:456');
    const prepared = await bind(h, taskId);
    assert.ok(prepared.prompt.endsWith(text));
    assert.equal(prepared.sourceSessionId, h.state.sessions[claimed.data.task.conversationKey]);
    assert.equal((await h.request('complete', { method: 'POST', body: { taskId, leaseId, status: 'done', output: 'fixture complete', executionStopped: true } })).status, 200);
  }
});
await test('direct/history-shaped handleIncoming cannot create a task; ordinary owner chat still queues QQ unread', async h => {
  await h.handleIncoming('private', 123, h.event(), h.cfg);
  assert.equal((await h.request('pending')).data.tasks.length, 0);
  assert.ok(h.getSocialV2State('private:123').unread.length > 0);
  const before = h.getSocialV2State('private:123').unread.length;
  await h.live.private(h.event('private', { message: [{ type: 'text', data: { text: '晚饭吃什么' } }] }));
  assert.equal((await h.request('pending')).data.tasks.length, 0);
  assert.equal(h.getSocialV2State('private:123').unread.length, before + 1);
});
await test('bridge admin authentication, model markers, CSRF, malformed body and mint attempts fail closed', async h => {
  failed(await h.request('status', { headers: { 'x-console-token': 'wrong' } }), 401);
  for (const headers of [{ 'x-agent-token': '' }, { 'x-agent-token': 'not-a-token' }, { 'x-agent-call': '' }, { 'x-agent-call': '1' }]) {
    failed(await h.request('pending', { headers }), 403);
  }
  failed(await h.request('status', { headers: { host: 'evil.invalid:41234' } }), 403);
  failed(await h.request('cancel', { method: 'POST', headers: { origin: 'https://evil.invalid' } }), 403);
  failed(await h.request('cancel', { method: 'POST', headers: { 'content-type': 'text/plain' } }), 415);
  failed(await h.request('claim', { method: 'POST', raw: '{invalid' }), 400);
  failed(await h.request('claim', { method: 'POST', raw: '[]' }), 400);
  failed(await h.request('create', { method: 'POST', body: { text: '电脑：打开浏览器' } }), 404);
  assert.equal((await h.request('pending')).data.tasks.length, 0);
});
await test('actual pause and mode routes revoke before off/on can restore authority', async h => {
  let taskId = await claim(h);
  await h.request('activity', { prefix: '/api/socialV2/', method: 'POST', body: { paused: true } });
  await h.request('activity', { prefix: '/api/socialV2/', method: 'POST', body: { paused: false } });
  failed(await h.request('validate', { method: 'POST', body: { taskId, leaseId } }), 409);
  taskId = await claim(h);
  await h.request('mode', { prefix: '/api/', method: 'POST', body: { mode: 'chat' } });
  await h.request('mode', { prefix: '/api/', method: 'POST', body: { mode: 'reserved2' } });
  failed(await h.request('validate', { method: 'POST', body: { taskId, leaseId } }), 409);
});
await test('actual v2 total switch cannot restore a task after off/on', async h => {
  const taskId = await claim(h);
  assert.equal((await h.request('config', { prefix: '/api/socialV2/', method: 'POST', body: { enabled: false } })).status, 200);
  assert.equal((await h.request('config', { prefix: '/api/socialV2/', method: 'POST', body: { enabled: true } })).status, 200);
  failed(await h.request('validate', { method: 'POST', body: { taskId, leaseId } }), 409);
});
await test('owner and settings epochs are rechecked at validate and completion', async h => {
  const taskId = await claim(h);
  h.settings.authorizationEpoch = 'fixture-epoch-next';
  failed(await h.request('validate', { method: 'POST', body: { taskId, leaseId } }), 409);
  h.settings.authorizationEpoch = 'fixture-epoch';
  const late = await h.request('complete', { method: 'POST', body: { taskId, leaseId, status: 'done', executionStopped: true } });
  assert.equal(late.status, 200); assert.equal(late.data.late, true); assert.equal(late.data.task.status, 'cancelled');
  const second = await claim(h);
  h.cfg.ownerQQ = 321;
  failed(await h.request('validate', { method: 'POST', body: { taskId: second, leaseId } }), 409);
  assert.ok(!(await h.request('status')).data.tasks.some(t => t.status === 'running'));
});
await test('reset and retireSession cancel leases even without an existing QQ session mapping', async h => {
  let taskId = await claim(h);
  h.retireSession('private:123');
  failed(await h.request('validate', { method: 'POST', body: { taskId, leaseId } }), 409);
  taskId = await claim(h);
  h.resetEpoch();
  failed(await h.request('validate', { method: 'POST', body: { taskId, leaseId } }), 409);
});
await test('owner reset command revokes a pending desktop task before source preparation', async h => {
  const taskId = await claim(h); assert.equal(h.state.sessions['private:123'], undefined);
  await h.live.private(h.event('private', { message: [{ type: 'text', data: { text: '/reset' } }] }));
  failed(await h.request('validate', { method: 'POST', body: { taskId, leaseId } }), 409);
  assert.match(h.calls.sent.at(-1).text, /已取消电脑任务/);
});
await test('queued completion reply rechecks owner before actual transport and never becomes outbox replay', async h => {
  const taskId = await claim(h); await bind(h, taskId);
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const original = h.bot.sendPrivateMessage.bind(h.bot);
  h.bot.sendPrivateMessage = async (id, text) => {
    if (text === 'queue barrier') { entered(); await new Promise(resolve => { release = resolve; }); }
    return original(id, text);
  };
  const queued = h.sendToQQ('private:123', 'queue barrier');
  await started;
  const completing = h.request('complete', { method: 'POST', body: { taskId, leaseId, status: 'done', output: 'private desktop result' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await h.request('status')).data.tasks.find(task => task.id === taskId).status, 'done');
  h.cfg.ownerQQ = 321;
  release(); await queued;
  const complete = await completing;
  assert.equal(complete.status, 200);
  assert.equal(complete.data.task.notification.ok, false);
  assert.ok(!h.calls.sent.some(item => item.text.includes('private desktop result')));
});
await test('known tokens and local secret-looking output are blocked by existing outbound audit', async h => {
  const taskId = await claim(h); await bind(h, taskId);
  const token = h.getSocialV2State('private:123').agentToken;
  const result = await h.request('complete', { method: 'POST', body: { taskId, leaseId, status: 'done', output: 'raw ' + token } });
  assert.equal(result.status, 200);
  assert.ok(!h.calls.sent.some(item => item.text.includes(token)));
  assert.match(h.calls.sent.at(-1).text, /敏感信息/);
});
await test('bridge persists new QQ identity before prompts and retains it across retire and reset', async h => {
  const file = path.join(h.temp, 'state/qq-session-sources.json');
  const first = await h.ensureSession('private:123');
  assert.ok(readQqSessionSources(file).sessions.includes(first));
  h.retireSession('private:123');
  assert.equal(h.state.sessions['private:123'], undefined);
  assert.ok(readQqSessionSources(file).sessions.includes(first));
  const next = await h.ensureSession('private:123');
  assert.equal((await h.request('reset', { prefix: '/api/session/', method: 'POST', body: { key: 'private:123' } })).status, 200);
  assert.ok(readQqSessionSources(file).sessions.includes(next));
  const policy = createOwnerDesktopPolicy({ ledgerFile: path.join(h.temp, 'worker-fixture.json'), qqStateDir: path.join(h.temp, 'state'), biliWorkspace: path.join(h.temp, 'bili') });
  assert.equal(policy.isManagedAgent({ session: { id: first, header: { agentPreset: 'standard', cwd: path.join(h.temp, 'renamed') } } }), true);
  assert.equal(policy.isWorkerSession(first), false);
});
await test('QQ learner sessions retain source identity while normal tools stay outside worker denial', async h => {
  const learner = await h.ensureSlangLearnerSession();
  const sources = readQqSessionSources(path.join(h.temp, 'state/qq-session-sources.json'));
  assert.ok(sources.sessions.includes(learner));
  assert.ok(sources.directories.includes(path.join(h.temp, 'state/slang-agent')));
  const policy = createOwnerDesktopPolicy({ ledgerFile: path.join(h.temp, 'worker-fixture.json'), qqStateDir: path.join(h.temp, 'state'), biliWorkspace: path.join(h.temp, 'bili') });
  assert.equal(policy.isManagedAgent({ session: { id: learner, header: { agentPreset: 'standard' } } }), true);
  assert.equal(policy.isWorkerSession(learner), false);
});
await test('source-record failures cannot erase QQ identity or send another prompt', async h => {
  const id = await h.ensureSession('private:123'); const file = path.join(h.temp, 'state/qq-session-sources.json');
  fs.writeFileSync(file + '.lock', 'fixture-held');
  const visible = error => error.code.startsWith('owner-desktop.qq-source-') && Boolean(error.hint);
  assert.throws(() => h.retireSession('private:123'), visible);
  assert.equal(h.state.sessions['private:123'], id);
  await assert.rejects(h.ensureSession('private:123'), visible);
  assert.equal(h.calls.prompts.length, 0);
  fs.unlinkSync(file + '.lock'); fs.writeFileSync(file, '{}');
  await assert.rejects(h.ensureSession('group:456'), visible);
  assert.equal(h.state.sessions['group:456'], undefined);
  assert.equal(h.calls.prompts.length, 0);
});
{
  const h = await harness({ config: { sessionCwd: path.resolve('fixture-custom-qq-cwd') }, savedState: { sessions: { 'private:123': 'retired-bootstrap-qq' } } });
  try {
    const source = readQqSessionSources(path.join(h.temp, 'state/qq-session-sources.json'));
    assert.ok(source.sessions.includes('retired-bootstrap-qq'), 'startup seeds mappings before policy retirement');
    assert.ok(source.directories.includes(path.resolve('fixture-custom-qq-cwd')));
    passed++; console.log('PASS startup seeds custom QQ cwd and existing identity before retirement');
  } finally { await h.close(); }
}
await test('prepare keeps source model and persona while excluding source tokens and shared unread', async h => {
  h.cfg.dsh = { ...h.cfg.dsh, followDefaultModel: false, provider: 'fixture-owner-provider', model: 'fixture-owner-model' };
  const selections = [];
  h.api.sessions.selectModel = async params => {
    selections.push(params);
    return { result: { ok: true, value: { selected: { provider: params.provider, model: params.model } } } };
  };
  const original = await h.ensureSession('private:123');
  const created = h.calls.created.length;
  h.appendSocialV2Message('private:123', 'untrusted fixture', 'UNRELATED_UNREAD_DO_NOT_EXECUTE', 'UNRELATED_UNREAD_DO_NOT_EXECUTE', false, false, 987654, [], '321');
  const st = h.getSocialV2State('private:123');
  const taskId = await claim(h);
  const prepared = await bind(h, taskId);
  assert.equal(prepared.sourceSessionId, original); assert.notEqual(prepared.desktopSessionId, original); assert.equal(prepared.sessionId, undefined); assert.equal(h.calls.created.length, created);
  assert.equal(selections.length, 1); assert.equal(selections[0].provider, 'fixture-owner-provider'); assert.equal(selections[0].model, 'fixture-owner-model');
  assert.match(prepared.prompt, /PERSONA_FIXTURE_CARD/);
  assert.ok(!prepared.prompt.includes(st.agentToken)); assert.ok(!prepared.prompt.includes('qq_get_prompt')); assert.ok(!prepared.prompt.includes('【会话令牌】'));
  assert.match(prepared.prompt, /本次主人原文/); assert.ok(prepared.prompt.endsWith('电脑：打开浏览器查看天气'));
  assert.ok(!prepared.prompt.includes('UNRELATED_UNREAD_DO_NOT_EXECUTE'));
  assert.ok(!prepared.prompt.includes('【首回复节奏】')); assert.ok(!prepared.prompt.includes('【沉睡前强制等待】'));
  assert.equal(st.unread.length, 1); assert.equal(h.calls.prompts.length, 0);
  failed(await h.request('prepare', { method: 'POST', body: { taskId, leaseId, sessionId: 'foreign' } }), 400);
  failed(await h.request('bind', { method: 'POST', body: { taskId, leaseId, preparedId: prepared.preparedId, sessionId: prepared.desktopSessionId, messageId: 'other-host-message-fixture' } }), 409);
}, { globals: { readPersonaLayerText: layer => layer === 'full' ? 'PERSONA_FIXTURE_CARD' : '' } });

await test('source QQ stays responsive during desktop execution and shutdown', async h => {
  const key = 'private:123'; const taskId = await claim(h); const prepared = await bind(h, taskId);
  h.appendSocialV2Message(key, 'owner', '普通聊天仍需保留', '普通聊天仍需保留', false, true, 765432, [], '123');
  const st = h.getSocialV2State(key);
  assert.equal(h.isConversationBusyV2(key, st), false);
  h.scheduleWakeV2(key, 'at'); assert.ok(st.pendingWakeTimer, 'desktop execution must not defer ordinary QQ wakes');
  clearTimeout(st.pendingWakeTimer); st.pendingWakeTimer = null;
  await h.deliverPrompt(key, 'ordinary owner chat');
  assert.equal(h.calls.prompts.length, 1); assert.equal(st.unread.length, 1);
  assert.equal(h.calls.prompts[0].sessionId, prepared.sourceSessionId);
  assert.ok(!JSON.stringify(h.calls.prompts).includes(prepared.desktopSessionId));
  const terminal = await h.request('complete', { method: 'POST', body: { taskId, leaseId, status: 'failed', executionStopped: false } });
  assert.equal(terminal.data.task.phase, 'stopping');
  await h.deliverPrompt(key, 'ordinary chat during desktop shutdown');
  assert.equal(h.calls.prompts.length, 2);
  const count = h.calls.sent.length;
  const closed = await h.request('complete', { method: 'POST', body: { taskId, leaseId, status: 'failed', executionStopped: true } });
  assert.equal(closed.data.task.phase, 'finished'); assert.equal(closed.data.late, true);
  assert.equal(st.unread.length, 1); assert.equal(h.calls.sent.length, count);
});

await test('DSH readiness revoke sends one terminal after progress and later cancel reports it', async h => {
  const taskId = await claim(h); await bind(h, taskId);
  assert.equal((await h.request('progress', { method: 'POST', body: { taskId, leaseId, summary: 'fixture progress' } })).status, 200);
  const before = h.calls.sent.length;
  h.setReady(false);
  failed(await h.request('validate', { method: 'POST', body: { taskId, leaseId } }), 409);
  const closed = await h.request('complete', { method: 'POST', body: { taskId, leaseId, status: 'done', output: 'late output must not appear', executionStopped: true } });
  const task = (await h.request('status')).data.tasks.find(t => t.id === taskId);
  assert.equal(task.status, 'cancelled'); assert.equal(task.code, 'OWNER_DESKTOP_OFFLINE');
  assert.equal(task.terminalNotification.ok, true); assert.equal(h.calls.sent.length, before + 1);
  h.setReady(true);
  assert.equal(closed.data.task.status, 'cancelled'); assert.equal(h.calls.sent.length, before + 1);
  await h.live.private(h.event('private', { message: [{ type: 'text', data: { text: '取消电脑任务' } }] }));
  assert.match(h.calls.sent.at(-1).text, /已取消/); assert.ok(!h.calls.sent.at(-1).text.includes('没有正在运行'));
  assert.ok(!h.calls.sent.some(item => item.text.includes('late output must not appear')));
});

await test('fresh continue preserves source and desktop identity with a fresh message after stop proof', async h => {
  const first = await claim(h); const prepared = await bind(h, first);
  await h.live.private(h.event('private', { message: [{ type: 'text', data: { text: '继续电脑任务' } }] }));
  failed(await h.request('validate', { method: 'POST', body: { taskId: first, leaseId } }), 409);
  assert.equal((await h.request('pending')).data.tasks.length, 0, 'do not dispatch while the old child is stopping');
  await h.request('complete', { method: 'POST', body: { taskId: first, leaseId, status: 'cancelled', executionStopped: true, sessionId: prepared.desktopSessionId } });
  const pending = (await h.request('pending')).data.tasks;
  assert.equal(pending.length, 1); assert.equal(pending[0].previousTaskId, first);
  assert.equal(pending[0].continuationRequested, true);
  const taskId = pending[0].id;
  assert.equal((await h.request('claim', { method: 'POST', body: { taskId, leaseId } })).status, 200);
  const next = await bind(h, taskId, 'desktop-second-turn');
  assert.equal(next.sourceSessionId, prepared.sourceSessionId); assert.equal(next.desktopSessionId, prepared.desktopSessionId); assert.notEqual(next.preparedId, prepared.preparedId);
  assert.ok(next.prompt.endsWith('继续电脑任务')); assert.equal(next.task.continuationRequested, true);
  assert.equal(h.calls.created.length, 1);
});
await test('cancel drops already-queued progress while preserving a single terminal receipt', async h => {
  const taskId = await claim(h); const prepared = await bind(h, taskId);
  let release; let entered;
  const barrier = new Promise(resolve => { entered = resolve; });
  const original = h.bot.sendPrivateMessage.bind(h.bot);
  h.bot.sendPrivateMessage = async (id, text) => {
    if (text === 'progress queue barrier') { entered(); await new Promise(resolve => { release = resolve; }); }
    return original(id, text);
  };
  const queued = h.sendToQQ('private:123', 'progress queue barrier'); await barrier;
  const reporting = h.request('progress', { method: 'POST', body: { taskId, leaseId, summary: 'obsolete desktop progress' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await h.request('status')).data.tasks.find(task => task.id === taskId).progressNotification.status, 'sending');
  const cancel = await h.request('cancel', { method: 'POST', body: { taskId, leaseId } });
  assert.equal(cancel.status, 200); release(); await queued;
  const progress = await reporting; failed(progress, 409); assert.equal(progress.data.code, 'OWNER_DESKTOP_NOTICE_FAILED');
  const closed = await h.request('complete', { method: 'POST', body: { taskId, leaseId, status: 'cancelled', executionStopped: true, sessionId: prepared.desktopSessionId } });
  assert.equal(closed.data.task.terminalNotification.ok, true);
  assert.ok(!h.calls.sent.some(item => item.text.includes('obsolete desktop progress')));
  assert.equal(h.calls.sent.filter(item => item.text.startsWith('电脑任务已取消。')).length, 1);
});
await test('source history receives short audited summaries and visible desktop identity only', async h => {
  const taskId = await claim(h); const prepared = await bind(h, taskId);
  const st = h.getSocialV2State('private:123');
  assert.ok(h.calls.sent.some(item => item.text.includes(prepared.desktopSessionId)));
  assert.ok(st.recentMessages.some(item => item.isSelf && item.text.includes(prepared.desktopSessionId)));
  assert.equal((await h.request('progress', { method: 'POST', body: { taskId, leaseId, summary: '已打开页面，正在查看标题' } })).status, 200);
  assert.ok(st.recentMessages.some(item => item.isSelf && item.text.includes('正在查看标题')));
  assert.equal(st.unread.length, 0);
  assert.ok(st.recentMessages.filter(item => item.isSelf).every(item => item.text.length <= 200));
  failed(await h.request('progress', { method: 'POST', body: { taskId, leaseId, summary: 'x'.repeat(501) } }), 400);
  failed(await h.request('progress', { method: 'POST', headers: { 'x-agent-token': st.agentToken }, body: { taskId, leaseId, summary: 'model-forged summary' } }), 403);
  assert.ok(!h.calls.sent.some(item => item.text.includes('model-forged summary')));
  assert.ok(!prepared.prompt.includes(st.agentToken)); assert.equal(h.calls.prompts.length, 0);
  const terminal = await h.request('complete', { method: 'POST', body: { taskId, leaseId, status: 'done', output: 'x'.repeat(1000), executionStopped: true, sessionId: prepared.desktopSessionId } });
  assert.equal(terminal.data.task.terminalNotification.ok, true);
  const summary = h.calls.sent.at(-1).text;
  assert.ok(summary.includes('x'.repeat(500))); assert.ok(!summary.includes('x'.repeat(501)));
  assert.ok(summary.includes('完整结果保留在桌面会话：' + prepared.desktopSessionId));
});

await test('fresh continuation with no broker history reaches host catalog lookup on the current source', async h => {
  const original = await h.ensureSession('private:123');
  await h.live.private(h.event('private', { message: [{ type: 'text', data: { text: '继续电脑任务：查看刚才的页面' } }] }));
  const pending = (await h.request('pending')).data.tasks;
  assert.equal(pending.length, 1); assert.equal(pending[0].continuationRequested, true); assert.equal(pending[0].previousTaskId, undefined);
  const taskId = pending[0].id;
  const claim = await h.request('claim', { method: 'POST', body: { taskId, leaseId } });
  assert.equal(claim.status, 200); assert.equal(claim.data.task.continuationRequested, true);
  const prepared = await h.request('prepare', { method: 'POST', body: { taskId, leaseId } });
  assert.equal(prepared.status, 200); assert.equal(prepared.data.sourceSessionId, original); assert.equal(prepared.data.task.continuationRequested, true);
  assert.ok(prepared.data.prompt.endsWith('继续电脑任务：查看刚才的页面'));
  assert.equal((await h.request('validate', { method: 'POST', body: { taskId, leaseId } })).data.task.continuationRequested, true);
  assert.equal(h.calls.created.length, 1); assert.equal(h.calls.prompts.length, 0);
});

console.log('Owner desktop wiring: ' + passed + ' tests passed (fake HTTP/QQ/DSH, no sockets).');
