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
async function harness({ config = {}, savedState, files = {} } = {}) {
  const liveSource = Symbol('fixture-live-source');
  const settings = { enabled: true, parentSessionId: 'fixture-parent', authorizationEpoch: 'fixture-epoch', timeoutMs: 600000 };
  let handler;
  const server = new EventEmitter();
  server.address = () => ({ port: 41234 });
  server.listen = (_port, _host, cb) => { server.listening = true; cb?.(); return server; };
  server.close = cb => { server.emit('close'); cb?.(); };
  function FixtureSymbol(description) { return description === 'owner-desktop-live' ? liveSource : Symbol(description); }
  Object.setPrototypeOf(FixtureSymbol, Symbol);
  const h = await bridgeHarness({ config: { sendDelayMs: 0, ...config }, savedState, files, globals: {
    Symbol: FixtureSymbol, createOwnerDesktopBroker, handleOwnerDesktopRoute,
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
async function test(name, run) {
  const h = await harness();
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
function failed(response, status) {
  if (status) assert.equal(response.status, status);
  assert.equal(response.data.ok, false); assert.ok(response.data.code); assert.ok(response.data.error); assert.ok(response.data.hint);
}

await test('real private/group transport callbacks alone mint isolated tasks before QQ batching', async h => {
  for (const kind of ['private', 'group']) {
    const id = await claim(h, kind);
    assert.equal(h.calls.prompts.length, 0, 'desktop command must not reach shared QQ model');
    assert.equal(h.getSocialV2State(kind === 'private' ? 'private:123' : 'group:456').unread.length, 0);
    const complete = await h.request('complete', { method: 'POST', body: { taskId: id, leaseId, status: 'done', output: '任务完成' } });
    assert.equal(complete.status, 200); assert.equal(h.calls.sent.at(-1).kind, kind);
    assert.equal(h.calls.sent.at(-1).id, kind === 'private' ? 123 : 456);
  }
  const serialized = JSON.stringify((await h.request('status')).data);
  assert.ok(!serialized.includes('打开浏览器')); assert.ok(!serialized.includes(leaseId));
  const ledger = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/owner-desktop-consumed.json'), 'utf8'));
  assert.equal(ledger.length, 2); assert.deepEqual(Object.keys(ledger[0]).sort(), ['digest', 'until']);
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
  failed(await h.request('complete', { method: 'POST', body: { taskId, leaseId, status: 'done' } }), 409);
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
await test('owner reset command revokes an isolated task without a shared QQ mapping', async h => {
  const taskId = await claim(h); assert.equal(h.state.sessions['private:123'], undefined);
  await h.live.private(h.event('private', { message: [{ type: 'text', data: { text: '/reset' } }] }));
  failed(await h.request('validate', { method: 'POST', body: { taskId, leaseId } }), 409);
  assert.match(h.calls.sent.at(-1).text, /已取消电脑任务/);
});
await test('queued completion reply rechecks owner before actual transport and never becomes outbox replay', async h => {
  const taskId = await claim(h);
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
  const taskId = await claim(h);
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
console.log('Owner desktop wiring: ' + passed + ' tests passed (fake HTTP/QQ/DSH, no sockets).');
