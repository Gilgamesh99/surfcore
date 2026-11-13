// Execute the actual bridge route callback, with an in-memory HTTP server and gateway.
// No sockets, production configuration, credentials, QQ/DSH processes or real sends.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import * as dmShare from '../src/bili-dm-share.js';

const BV = 'BV1xx411c7mD';
const payload = (patch = {}) => ({ requestId: 'dm-123-900', ownerMid: '123', sourceSeq: '9007199254740993', groupId: '456',
  video: { bvid: BV, title: '示例视频', url: 'https://www.bilibili.com/video/' + BV }, commentary: '这段剪辑很有意思。', ...patch });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function blocked(result, code, status = 'failed') {
  assert.equal(result.body.ok, false, JSON.stringify(result.body));
  assert.equal(result.body.code, code, JSON.stringify(result.body));
  assert.equal(result.body.status, status); assert.ok(result.body.error); assert.ok(result.body.hint);
}
async function fixture(t, { config = {}, files = {}, gateway, names = { 456: '测试群', 789: 'Other Group' }, ...options } = {}) {
  let listener;
  const server = new EventEmitter();
  server.address = () => ({ port: 43100 });
  server.listen = (_port, _host, ready) => { ready(); return server; };
  const sent = [], metadata = [], queued = [], marked = [];
  const h = await bridgeHarness({ config, files: { 'dsh/surfcore/bili.config.json': { owner: { mid: '123' } }, ...files },
    globals: { ...dmShare, http: { createServer: (handler) => { listener = handler; return server; } },
      createOutbox: () => ({ flush: async () => ({}), stats: () => ({ count: queued.length }),
        push: (...args) => { queued.push(args); return true; }, markSent: (...args) => marked.push(args) }),
      fetch: async (url, init) => {
        assert.ok(String(url).endsWith('/send_group_msg'), 'unexpected mocked HTTP action');
        const body = JSON.parse(init.body); sent.push(body);
        if (gateway) return gateway({ url, init, body, sent });
        return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: -9001 } }) };
      }, ...options.globals } });
  h.bot.getGroupInfo = async (id) => { metadata.push(String(id)); return { group_name: names[id] || '', member_count: 12 }; };
  h.setMode('reserved2');
  h.startConsoleServer();
  t.after(async () => { server.emit('close'); await h.close(); });
  async function request(route, { method = 'POST', body, headers = {}, raw } = {}) {
    const req = new EventEmitter();
    Object.assign(req, { url: route, method, headers: { host: '127.0.0.1:43100', 'x-console-token': 'fixture-console-token', 'content-type': 'application/json', ...headers }, destroy() {} });
    let status, response;
    const res = { writeHead(code) { status = code; }, end(text) { response = { status, body: JSON.parse(text) }; } };
    const pending = listener(req, res);
    queueMicrotask(() => { req.emit('data', Buffer.from(raw ?? JSON.stringify(body ?? {}))); req.emit('end'); });
    await pending;
    assert.ok(response, 'route must return a response');
    return response;
  }
  return { h, sent, metadata, queued, marked, request,
    resolve: (target, options) => request('/api/bili/dm-share/resolve', { body: { target }, ...options }),
    send: (body = payload(), options) => request('/api/bili/dm-share/send', { body, ...options }),
    status: (id = 'dm-123-900', options) => request('/api/bili/dm-share/status?requestId=' + encodeURIComponent(id), { method: 'GET', ...options }) };
}

test('real routes resolve allow-only group and send exactly one text with true receipt', async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.resolve('测试群')).body, { ok: true, group: { id: '456', name: '测试群' } });
  const result = await f.send();
  assert.equal(result.status, 200); assert.equal(result.body.status, 'sent');
  assert.equal(result.body.receipt.messageId, '-9001'); assert.equal(result.body.receipt.groupId, '456');
  assert.equal(result.body.receipt.groupName, '测试群'); assert.ok(Date.parse(result.body.receipt.sentAt));
  assert.deepEqual(f.sent, [{ group_id: 456, message: [{ type: 'text', data: { text: '示例视频\nhttps://www.bilibili.com/video/' + BV + '\n这段剪辑很有意思。' } }] }]);
  assert.deepEqual((await f.status()).body, result.body);
  assert.deepEqual((await f.send()).body, result.body); assert.equal(f.sent.length, 1); assert.equal(f.queued.length, 0);
  assert.equal(f.h.getSocialV2State('group:456').recentMessages.at(-1).messageId, '-9001');
});
test('console authentication is mandatory and generic scoped QQ agent tokens cannot call handoff', async (t) => {
  const f = await fixture(t);
  const unauthorized = await f.send(payload(), { headers: { 'x-console-token': '' } });
  assert.equal(unauthorized.status, 401); blocked(unauthorized, 'DM_SHARE_UNAUTHORIZED');
  const token = f.h.getSocialV2State('group:456').agentToken;
  for (const headers of [{ 'x-agent-token': token }, { 'x-agent-token': token, 'x-agent-call': '1' }, { 'x-agent-call': '1' }, { 'x-agent-call': '' }, { 'x-agent-token': '' }]) {
    for (const route of ['resolve', 'send', 'status']) {
      const result = await f.request('/api/bili/dm-share/' + route + '?requestId=dm-123-900', { method: route === 'status' ? 'GET' : 'POST', body: payload(), headers });
      assert.equal(result.status, 403); blocked(result, 'DM_SHARE_CONSOLE_ONLY');
    }
  }
  assert.equal(f.sent.length, 0); assert.equal(f.metadata.length, 0);
});
test('existing host/origin/JSON guards and route method restrictions stay enforced', async (t) => {
  const f = await fixture(t);
  for (const [headers, status] of [[{ host: 'evil.invalid' }, 403], [{ origin: 'https://evil.invalid' }, 403], [{ 'content-type': 'text/plain' }, 415]]) {
    const result = await f.send(payload(), { headers }); assert.equal(result.status, status); assert.ok(result.body.code && result.body.hint);
  }
  blocked(await f.request('/api/bili/dm-share/send', { method: 'GET' }), 'DM_SHARE_ROUTE_INVALID');
  blocked(await f.send(undefined, { raw: '{' }), 'DM_SHARE_REQUEST_INVALID');
  blocked(await f.send({}), 'DM_SHARE_REQUEST_INVALID');
  assert.equal(f.sent.length, 0);
});
test('general QQ send route still requires reserved2 session authority', async (t) => {
  const f = await fixture(t);
  const response = await f.request('/api/send/group', { body: { groupId: 456, message: 'fixture' } });
  assert.equal(response.body.ok, false); assert.equal(f.sent.length, 0);
});
test('new route requires current Bili owner and explicit plural allow.groups', async (t) => {
  const f = await fixture(t, { config: { allow: { group: ['456'], groups: [], private: ['123'] }, allowAllWhenEmpty: true } });
  blocked(await f.resolve('456'), 'DM_SHARE_GROUP_NOT_ALLOWED');
  blocked(await f.send(), 'DM_SHARE_GROUP_NOT_ALLOWED');
  f.h.cfg.allow.groups = ['456'];
  fs.writeFileSync(path.join(f.h.temp, 'dsh/surfcore/bili.config.json'), JSON.stringify({ owner: { mid: '999' } }));
  blocked(await f.send(), 'DM_SHARE_OWNER_MISMATCH'); assert.equal(f.sent.length, 0);
});
test('live paused/enabled/tool/mode/deny guards block and permit safe exact retry', async (t) => {
  const cases = [
    ['pause', 'DM_SHARE_PAUSED', (h) => { h.socialV2.paused = true; }, (h) => { h.socialV2.paused = false; }],
    ['disabled', 'DM_SHARE_PAUSED', (h) => { h.cfg.socialV2.enabled = false; }, (h) => { h.cfg.socialV2.enabled = true; }],
    ['sendGroup', 'DM_SHARE_TOOL_DISABLED', (h) => { h.cfg.socialV2.tools.sendGroup = false; }, (h) => { h.cfg.socialV2.tools.sendGroup = true; }],
    ['sendMessage', 'DM_SHARE_TOOL_DISABLED', (h) => { h.cfg.socialV2.tools.sendMessage = false; }, (h) => { h.cfg.socialV2.tools.sendMessage = true; }],
    ['mode', 'DM_SHARE_MODE_BLOCKED', (h) => h.setMode('closed-agent'), (h) => h.setMode('reserved2')],
    ['deny', 'DM_SHARE_MODE_BLOCKED', (h) => { h.cfg.deny.groups = ['456']; }, (h) => { h.cfg.deny.groups = []; }],
  ];
  for (const [name, code, deny, allow] of cases) await t.test(name, async (t) => {
    const f = await fixture(t); deny(f.h); const result = await f.send(); blocked(result, code);
    assert.equal(result.body.retryable, true); assert.equal(f.sent.length, 0);
    allow(f.h); assert.equal((await f.send()).body.status, 'sent'); assert.equal(f.sent.length, 1);
  });
});
test('silent role gate blocks the dedicated admin handoff', async (t) => {
  const f = await fixture(t, { files: { 'state/current-role.json': { role: null, mode: 'silent' } } });
  blocked(await f.send(), 'DM_SHARE_PAUSED'); assert.equal(f.sent.length, 0);
});
test('rate limit and token-per-turn limit are enforced without extra reservations', async (t) => {
  const f = await fixture(t); const st = f.h.getSocialV2State('group:456');
  f.h.cfg.socialV2.send.maxSendPerMinute = 1; st.sendTimes = [Date.now()];
  blocked(await f.send(), 'SEND_RATE_LIMIT'); assert.equal(f.sent.length, 0); assert.equal(st.sendTimes.length, 1);
  st.sendTimes = []; f.h.cfg.socialV2.tokenGuard.enabled = true; f.h.cfg.socialV2.tokenGuard.maxOutboundPerTurn = 1; st.tokenTurnSent = 1;
  blocked(await f.send(), 'TOKEN_GUARD_SEND_LIMIT'); assert.equal(f.sent.length, 0); assert.equal(st.sendTimes.length, 0);
  st.tokenTurnSent = 0; assert.equal((await f.send()).body.status, 'sent'); assert.equal(st.tokenTurnSent, 1); assert.equal(st.sendTimes.length, 1);
});
test('fish guard has no admin-owner bypass introduced by this route', async (t) => {
  const f = await fixture(t); const st = f.h.getSocialV2State('group:456');
  f.h.cfg.fishGuard.enabled = true; f.h.cfg.fishGuard.blockSends = true;
  st.fishGuard = { until: Date.now() + 600000, at: Date.now(), reason: 'cooldown' };
  blocked(await f.send(), 'FISH_GUARD_SEND_BLOCK'); assert.equal(f.sent.length, 0);
});
test('configured max length and existing sensitive text audit block before network', async (t) => {
  const f = await fixture(t); f.h.cfg.socialV2.send.maxMessageChars = 10;
  blocked(await f.send(), 'DM_SHARE_TEXT_LIMIT'); assert.equal(f.sent.length, 0);
  f.h.cfg.socialV2.send.maxMessageChars = 500;
  blocked(await f.send(payload({ requestId: 'sensitive-fixture', commentary: 'token=fixture_secret' })), 'DM_SHARE_SENSITIVE_TEXT');
  assert.equal(f.sent.length, 0);
});
test('global sendChain serializes unrelated regular sends before handoff', { timeout: 5000 }, async (t) => {
  const entered = deferred(), release = deferred(); const order = [];
  const f = await fixture(t, { config: { sendDelayMs: 0 }, gateway: async () => {
    order.push('handoff');
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 2 } }) };
  } });
  f.h.bot.sendGroupMessage = async () => { entered.resolve(); await release.promise; order.push('ordinary'); };
  const regular = f.h.sendToQQ('group:456', 'fixture ordinary'); await entered.promise;
  const handoff = f.send();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(f.sent.length, 0); release.resolve(); await regular;
  assert.equal((await handoff).body.status, 'sent'); assert.equal(f.sent.length, 1);
  assert.deepEqual(order, ['ordinary', 'handoff']);
});
test('queue-time session epoch and allowlist changes stop stale sends', async (t) => {
  for (const change of ['epoch', 'allowlist']) await t.test(change, async (t) => {
    const entered = deferred(), release = deferred();
    const f = await fixture(t, { gateway: async () => {
      entered.resolve(); await release.promise;
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) };
    } });
    const first = f.send(); await entered.promise;
    const second = f.send(payload({ requestId: 'second-request', sourceSeq: '901' }));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    if (change === 'epoch') f.h.resetEpoch(); else f.h.cfg.allow.groups = [];
    release.resolve(); assert.equal((await first).body.status, 'sent');
    blocked(await second, change === 'epoch' ? 'DM_SHARE_SESSION_CHANGED' : 'DM_SHARE_GROUP_NOT_ALLOWED');
    assert.equal(f.sent.length, 1);
  });
});
for (const mode of ['timeout', 'partial-json', 'http-failure', 'missing-receipt']) {
  test('true transport ' + mode + ' stays unknown and never enters competing outbox', async (t) => {
    const f = await fixture(t, { gateway: async () => {
      if (mode === 'timeout') throw new Error('fetch failed ECONNREFUSED fixture');
      return { ok: mode !== 'http-failure', status: mode === 'http-failure' ? 503 : 200, json: async () => {
        if (mode === 'partial-json') throw new Error('partial accepted response');
        return { status: 'ok', retcode: 0, data: mode === 'missing-receipt' ? {} : { message_id: 11 } };
      } };
    } });
    const result = await f.send(); blocked(result, 'DM_SHARE_UNKNOWN', 'unknown');
    assert.equal(result.body.retryable, false); assert.equal(result.status, 409);
    blocked(await f.status(), 'DM_SHARE_UNKNOWN', 'unknown');
    blocked(await f.send(), 'DM_SHARE_UNKNOWN', 'unknown');
    assert.equal(f.sent.length, 1); assert.equal(f.queued.length, 0);
  });
}
test('partial name metadata cannot pick an otherwise matching allowed group', async (t) => {
  const f = await fixture(t, { config: { allow: { groups: ['456', '789'], private: ['123'] } } });
  f.h.bot.getGroupInfo = async (id) => { if (id === 789) throw new Error('fixture unavailable'); return { group_name: '测试群' }; };
  blocked(await f.resolve('测试群'), 'DM_SHARE_GROUPS_UNAVAILABLE'); assert.equal(f.sent.length, 0);
});
