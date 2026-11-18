import assert from 'node:assert/strict';
import { createOwnerDesktopBroker, handleOwnerDesktopRoute, ownerDesktopIntent } from '../src/owner-desktop-broker.js';

let passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS', name); }
const leaseId = 'lease-fixture-0000000001';
function fixture(options = {}) {
  let time = 1_800_000_000_000;
  let seq = 1;
  let ledger = options.ledger ?? [];
  const settings = { enabled: true, parentSessionId: 'management-fixture', timeoutMs: 600_000, authorizationEpoch: 'auth-epoch-one' };
  const runtime = { ownerQQ: '123', selfUserId: '999', mode: 'reserved2', epoch: 1, enabled: true,
    allowed: true, blocked: false, paused: false, silent: false, connected: true, ready: true };
  const notices = [];
  const makeBroker = extra => createOwnerDesktopBroker({ getSettings: () => ({ ...settings }), getRuntime: () => ({ ...runtime }),
    now: () => time, startedAt: time, notify: async (key, text, authority) => { notices.push({ key, text, authority }); },
    readLedger: () => ledger, writeLedger: next => { ledger = structuredClone(next); }, ...options, ...extra });
  const broker = makeBroker();
  function input(kind = 'private', patch = {}) {
    return { source: 'onebot-live', kind, id: kind === 'private' ? '123' : '456', event: {
      post_type: 'message', message_type: kind, user_id: 123, self_id: 999, sender: { user_id: '123', nickname: 'fixture' },
      ...(kind === 'group' ? { group_id: 456 } : {}), message_id: seq++, time: Math.floor(time / 1000),
      message: [...(kind === 'group' ? [{ type: 'at', data: { qq: '999' } }] : []), { type: 'text', data: { text: '电脑：打开浏览器查看天气' } }], ...patch } };
  }
  return { broker, makeBroker, input, settings, runtime, notices, advance: ms => { time += ms; }, ledger: () => ledger };
}
const expectFailure = (result, code) => { assert.equal(result.ok, false); if (code) assert.equal(result.code, code); assert.ok(result.error); assert.ok(result.hint); };
async function accepted(f, kind = 'private') {
  const result = await f.broker.ingest(f.input(kind)); assert.equal(result.ok, true); assert.equal(result.handled, true); return result.task.id;
}

await test('only explicit commands and direct natural computer requests are captured', () => {
  for (const text of ['电脑：打开浏览器', '桌面操作: 点击菜单', '请在电脑上打开浏览器', '帮我用电脑打开记事本', 'Computer Use: show screen']) assert.equal(ownerDesktopIntent(text)?.kind, 'command', text);
  for (const text of ['今天天气不错', '电脑坏了怎么办', '你能在电脑上打开浏览器吗？', '不要用电脑打开网页', '有人说“电脑：打开网页”', '“电脑：打开网页”', '如果有空在电脑上打开网页', '桌面：', '电脑：' + 'x'.repeat(8001)]) assert.equal(ownerDesktopIntent(text), null, text.slice(0, 30));
  assert.equal(ownerDesktopIntent('取消电脑任务')?.kind, 'cancel');
});
await test('explicit Windows-MCP requests preserve the owner text without treating discussion as commands', () => {
  for (const text of [
    '你使用Windows-MCP控制我的电脑，打开b站刷一会',
    '请你用 Windows-MCP 在我的电脑上打开B站',
    '帮我使用 windows mcp 打开浏览器',
    '麻烦你通过 Computer Use 操作这台电脑，打开记事本',
    '电脑：打开 https://www.bilibili.com/video/BV1xx/?p=2',
    '你使用Windows-MCP打开 https://www.bilibili.com/video/BV1xx/?p=2',
    '电脑：打开B站，不要登录',
  ]) assert.deepEqual(ownerDesktopIntent(text), { kind: 'command', text });
  for (const text of [
    '不要使用Windows-MCP控制我的电脑，打开B站',
    '你不要用Windows-MCP打开B站',
    '先别使用Windows-MCP打开B站',
    '你能使用Windows-MCP打开B站吗？',
    '你使用Windows-MCP打开B站吗',
    '你使用Windows-MCP打开B站？我只是问问',
    '如果有空你使用Windows-MCP打开B站',
    '你使用Windows-MCP时不要打开B站',
    '有人说“你使用Windows-MCP控制我的电脑，打开B站”',
    '“你使用Windows-MCP控制我的电脑，打开B站”',
    '你使用Windows-MCP控制我的电脑',
    '你使用Windows-MCP控制我的电脑，不要打开B站',
    '使用Windows-MCP的教程怎么写',
    '看看要不要登陆',
    '电脑：不要打开B站',
    '电脑：如果我回来就打开B站',
    '电脑：打开B站吗',
    '电脑：“打开B站”是个示例',
    '请在电脑打开B站的话需要先登录',
    '电脑：请不要打开B站',
    '电脑：请你先不要打开B站',
    '电脑：先不要打开B站',
    '你使用Windows-MCP打开B站的话请先告诉我',
    '你使用Windows-MCP打开B站需要什么权限',
    '你使用Windows-MCP打开B站，这只是举例，不要执行',
  ]) assert.equal(ownerDesktopIntent(text), null, text);
});
await test('private and typed group @ create isolated tasks without exposing command outside claim', async () => {
  for (const kind of ['private', 'group']) {
    const f = fixture(); const id = await accepted(f, kind);
    for (const result of [f.broker.status(), f.broker.pending()]) {
      assert.ok(!JSON.stringify(result).includes('打开浏览器'));
      assert.ok(!JSON.stringify(result).includes(leaseId));
    }
    const claim = f.broker.claim({ taskId: id, leaseId });
    assert.equal(claim.task.text, '电脑：打开浏览器查看天气'); assert.equal(claim.task.ownerQQ, '123');
    assert.equal(claim.task.conversationKey, kind === 'private' ? 'private:123' : 'group:456');
    assert.equal(f.broker.validate({ taskId: id, leaseId }).ok, true);
    assert.ok(!JSON.stringify(f.broker.validate({ taskId: id, leaseId })).includes('打开浏览器'));
  }
});
await test('forged sender source bot message ids and times cannot mint tasks', async () => {
  const patches = [
    { user_id: 321, sender: { user_id: 321, nickname: '主人' } }, { sender: { user_id: 321 } },
    { user_id: '', sender: { user_id: '' } }, { self_id: 888 }, { self_id: undefined }, { message_id: undefined },
    { message_id: 0 }, { message_id: Number.MAX_SAFE_INTEGER + 1 }, { history: true }, { replayed: true },
    { post_type: 'notice' }, { message_type: 'group' }, { time: 1 }, { time: 1_800_000_006 }, { time: undefined },
    { group_id: 456 }, { message: '[CQ:at,qq=999]电脑：打开浏览器' },
    { message: [{ type: 'text', data: { text: '[CQ:at,qq=999]电脑：打开浏览器' } }] },
    { message: [{ type: 'reply', data: { id: '123' } }, { type: 'text', data: { text: '电脑：打开浏览器' } }] },
    { message: [{ type: 'forward', data: { content: [{ user_id: 123, message: '电脑：打开浏览器' }] } }] },
  ];
  for (const patch of patches) { const f = fixture(); assert.equal((await f.broker.ingest(f.input('private', patch))).handled, false, JSON.stringify(patch)); assert.equal(f.broker.pending().tasks.length, 0); assert.equal(f.notices.length, 0); }
  for (const source of ['history', 'poke', 'purpose', 'bootstrap', 'replyCheck', undefined]) { const f = fixture(); const input = f.input(); input.source = source; assert.equal((await f.broker.ingest(input)).handled, false); }
  const f = fixture(); const input = f.input(); input.id = '321'; assert.equal((await f.broker.ingest(input)).handled, false);
  const negative = f.input('private', { message_id: -42 }); assert.equal((await f.broker.ingest(negative)).handled, true);
});
await test('group no-@, @all, wrong route, text CQ and quoted @ are not explicit owner @', async () => {
  for (const patch of [
    { message: [{ type: 'text', data: { text: '电脑：打开浏览器' } }] },
    { message: [{ type: 'at', data: { qq: 'all' } }, { type: 'text', data: { text: '电脑：打开浏览器' } }] },
    { message: [{ type: 'at', data: { qq: '888' } }, { type: 'text', data: { text: '电脑：打开浏览器' } }] },
    { message: [{ type: 'text', data: { text: '@机器人 电脑：打开浏览器' } }] }, { group_id: 789 },
    { message: [{ type: 'at', data: { qq: 999 } }, { type: 'reply', data: { id: 1 } }, { type: 'text', data: { text: '电脑：打开浏览器' } }] },
  ]) { const f = fixture(); assert.equal((await f.broker.ingest(f.input('group', patch))).handled, false); assert.equal(f.broker.pending().tasks.length, 0); }
});
await test('ordinary owner conversation passes through with no desktop I/O', async () => {
  const f = fixture(); assert.equal((await f.broker.ingest(f.input('private', { message: [{ type: 'text', data: { text: '晚饭吃什么' } }] }))).handled, false);
  assert.equal(f.ledger().length, 0); assert.equal(f.notices.length, 0);
});
await test('replay digest survives restart; task and lease do not; startup fence rejects delayed history', async () => {
  const f = fixture(); const input = f.input(); const first = await f.broker.ingest(input);
  assert.equal(first.ok, true); f.broker.claim({ taskId: first.task.id, leaseId });
  expectFailure(await f.broker.ingest(input), 'OWNER_DESKTOP_REPLAY');
  assert.deepEqual(Object.keys(f.ledger()[0]).sort(), ['digest', 'until']); assert.ok(!JSON.stringify(f.ledger()).includes('123'));
  const restarted = f.makeBroker(); assert.equal(restarted.pending().tasks.length, 0);
  expectFailure(restarted.validate({ taskId: first.task.id, leaseId }), 'OWNER_DESKTOP_NOT_FOUND');
  expectFailure(await restarted.ingest(input), 'OWNER_DESKTOP_REPLAY');
  f.advance(2000); const freshProcess = f.makeBroker(); assert.equal((await freshProcess.ingest({ ...input, event: { ...input.event, message_id: 991 } })).handled, false);
  f.advance(300001); assert.equal((await f.broker.ingest({ ...input, event: { ...input.event, message_id: 992 } })).handled, false);
});
await test('reconnect fence rejects previously unseen delayed messages and invalidates old tasks', async () => {
  const f = fixture(); const beforeReconnect = f.input();
  f.advance(2000); f.runtime.liveSince = 1_800_000_002_000;
  assert.equal((await f.broker.ingest(beforeReconnect)).handled, false);
  const fresh = await f.broker.ingest(f.input()); assert.equal(fresh.handled, true);
  f.broker.claim({ taskId: fresh.task.id, leaseId });
  f.runtime.liveSince += 1000; expectFailure(f.broker.validate({ taskId: fresh.task.id, leaseId }));
});
await test('startup and reconnect boundary seconds reject unconsumed old messages', async () => {
  const f = fixture(); f.advance(500);
  const afterRestart = f.makeBroker();
  assert.equal((await afterRestart.ingest(f.input())).handled, false);
  f.advance(500);
  assert.equal((await afterRestart.ingest(f.input())).handled, true);
  const g = fixture(); g.advance(500); g.runtime.liveSince = 1_800_000_000_500;
  assert.equal((await g.broker.ingest(g.input())).handled, false);
  g.advance(500);
  assert.equal((await g.broker.ingest(g.input())).handled, true);
});

await test('failed, malformed and full replay storage never queues a command', async () => {
  for (const options of [{ readLedger: () => { throw new Error('unreadable'); } }, { readLedger: () => ({}) }, { writeLedger: () => { throw new Error('disk full'); } },
    { ledger: Array.from({ length: 2048 }, (_, i) => ({ digest: i.toString(16).padStart(64, '0'), until: 1_800_000_999_999 })) }]) {
    const f = fixture(options); const result = await f.broker.ingest(f.input()); expectFailure(result); assert.equal(result.handled, true); assert.equal(f.broker.pending().tasks.length, 0);
  }
});
await test('concurrent commands claim complete and wrong lease are single-use', async () => {
  const f = fixture(); const result = await Promise.all([f.broker.ingest(f.input()), f.broker.ingest(f.input('group'))]);
  assert.equal(result.filter(r => r.ok).length, 1); expectFailure(result.find(r => !r.ok), 'OWNER_DESKTOP_BUSY');
  const id = f.broker.pending().tasks[0].id;
  assert.equal(f.broker.claim({ taskId: id, leaseId }).ok, true);
  expectFailure(f.broker.claim({ taskId: id, leaseId }), 'OWNER_DESKTOP_ALREADY_CLAIMED');
  expectFailure(f.broker.validate({ taskId: id, leaseId: 'wrong-lease-fixture-123' }), 'OWNER_DESKTOP_LEASE_MISMATCH');
  expectFailure(await f.broker.complete({ taskId: id, leaseId: 'wrong-lease-fixture-123', status: 'done' }), 'OWNER_DESKTOP_LEASE_MISMATCH');
  const count = f.notices.length;
  const completions = await Promise.all([f.broker.complete({ taskId: id, leaseId, status: 'done', output: '已查看天气' }), f.broker.complete({ taskId: id, leaseId, status: 'done' })]);
  assert.equal(completions.filter(r => r.ok).length, 1); assert.equal(f.notices.length, count + 1);
  expectFailure(f.broker.validate({ taskId: id, leaseId }), 'OWNER_DESKTOP_FINISHED');
  assert.equal(f.notices.at(-1).key, 'private:123');
});
await test('every policy mutation cancels before a later tool; restoring values never restores lease', async () => {
  for (const timeoutMs of [600_000, 0]) for (const [target, patch] of [
    ['settings', { enabled: false }], ['settings', { parentSessionId: 'different' }], ['settings', { authorizationEpoch: 'auth-epoch-two' }],
    ['runtime', { ownerQQ: '321' }], ['runtime', { selfUserId: '888' }], ['runtime', { mode: 'chat' }], ['runtime', { epoch: 2 }],
    ['runtime', { enabled: false }], ['runtime', { allowed: false }], ['runtime', { blocked: true }], ['runtime', { paused: true }],
    ['runtime', { silent: true }], ['runtime', { connected: false }], ['runtime', { ready: false }],
  ]) {
    const f = fixture(); f.settings.timeoutMs = timeoutMs; const id = await accepted(f); f.broker.claim({ taskId: id, leaseId });
    if (timeoutMs === 0) f.advance(86_400_001);
    const before = { ...f[target] }; Object.assign(f[target], patch); expectFailure(f.broker.validate({ taskId: id, leaseId }));
    Object.assign(f[target], before); expectFailure(f.broker.validate({ taskId: id, leaseId }), 'OWNER_DESKTOP_FINISHED');
    assert.equal(f.broker.status().tasks[0].status, 'cancelled');
  }
});
await test('disabled receipt is visible; pause failure remains visible in admin status', async () => {
  const f = fixture(); f.settings.enabled = false;
  expectFailure(await f.broker.ingest(f.input()), 'OWNER_DESKTOP_DISABLED'); assert.equal(f.notices.length, 1); assert.match(f.notices[0].text, /设置/);
  f.settings.enabled = true; f.runtime.paused = true;
  expectFailure(await f.broker.ingest(f.input()), 'OWNER_DESKTOP_PAUSED'); assert.equal(f.broker.status().lastError.code, 'OWNER_DESKTOP_PAUSED');
});
await test('owner cancellation from an explicitly addressed message revokes globally', async () => {
  const f = fixture(); const id = await accepted(f); f.broker.claim({ taskId: id, leaseId });
  const cancel = f.input('group'); cancel.event.message[1].data.text = '取消电脑任务';
  const forged = structuredClone(cancel); forged.event.user_id = 321; forged.event.sender.user_id = '321';
  assert.equal((await f.broker.ingest(forged)).handled, false); assert.equal(f.broker.validate({ taskId: id, leaseId }).ok, true);
  assert.equal((await f.broker.ingest(cancel)).handled, true); expectFailure(f.broker.validate({ taskId: id, leaseId }), 'OWNER_DESKTOP_FINISHED');
});
await test('expiry, explicit revocation and task completion failures retain code and hint', async () => {
  const f = fixture(); const id = await accepted(f); f.broker.claim({ taskId: id, leaseId });
  f.advance(600001); expectFailure(f.broker.validate({ taskId: id, leaseId }), 'OWNER_DESKTOP_EXPIRED');
  const id2 = await accepted(f); f.broker.claim({ taskId: id2, leaseId });
  f.broker.revoke('fixture stop'); expectFailure(f.broker.validate({ taskId: id2, leaseId }), 'OWNER_DESKTOP_FINISHED');
  const id3 = await accepted(f); f.broker.claim({ taskId: id3, leaseId });
  const done = await f.broker.complete({ taskId: id3, leaseId, status: 'failed' });
  assert.equal(done.task.status, 'failed'); assert.ok(done.task.code); assert.ok(done.task.hint);
});
await test('configuration parse failure is visible and never falls through as a desktop request', async () => {
  const f = fixture({ getSettings: () => { throw new Error('malformed config'); } });
  const result = await f.broker.ingest(f.input()); expectFailure(result, 'OWNER_DESKTOP_POLICY_UNAVAILABLE');
  assert.equal(result.handled, true); assert.equal(f.broker.status().lastError.code, 'OWNER_DESKTOP_POLICY_UNAVAILABLE');
  assert.equal(f.broker.pending().tasks.length, 0);
});
await test('notice failure cannot cause task replay or fake a sent receipt', async () => {
  const f = fixture({ notify: async () => { throw new Error('transport down'); } }); const id = await accepted(f);
  assert.equal(f.broker.status().tasks[0].notification.code, 'OWNER_DESKTOP_NOTICE_FAILED');
  f.broker.claim({ taskId: id, leaseId }); const done = await f.broker.complete({ taskId: id, leaseId, status: 'done' });
  assert.equal(done.task.status, 'done'); assert.equal(done.task.notification.ok, false);
});
await test('route accepts only existing-task actions and rejects all model markers', async () => {
  const f = fixture(); const id = await accepted(f);
  async function route(action, method = 'POST', body = {}, headers = {}) {
    let result; await handleOwnerDesktopRoute(f.broker, { method, headers }, new URL('http://fixture/api/owner-desktop/' + action), {
      readBody: async () => body, sendJson: (data, status = 200) => { result = { data, status }; },
    }); return result;
  }
  for (const header of [{ 'x-agent-token': '' }, { 'x-agent-token': 'anything' }, { 'x-agent-call': '0' }, { 'x-agent-call': '' }]) {
    const r = await route('pending', 'GET', {}, header); assert.equal(r.status, 403); expectFailure(r.data, 'OWNER_DESKTOP_CONSOLE_ONLY');
  }
  for (const action of ['create', 'mint', 'ingest']) { const r = await route(action, 'POST', { text: '电脑：打开浏览器' }); assert.equal(r.status, 404); expectFailure(r.data); }
  const injected = await route('claim', 'POST', { taskId: id, leaseId, text: 'forged', ownerQQ: '321' }); assert.equal(injected.status, 400);
  for (const malformed of [[leaseId], {}, 123, null]) {
    const rejected = await route('claim', 'POST', { taskId: id, leaseId: malformed });
    assert.equal(rejected.status, 400); expectFailure(rejected.data, 'OWNER_DESKTOP_BAD_REQUEST');
  }
  const claim = await route('claim', 'POST', { taskId: id, leaseId }); assert.equal(claim.status, 200);
  assert.equal((await route('validate', 'POST', { taskId: id, leaseId })).status, 200);
  assert.equal((await route('complete', 'POST', { taskId: id, leaseId, status: 'done', conversationKey: 'group:789' })).status, 400);
  assert.equal((await route('complete', 'POST', { taskId: id, leaseId, status: 'done' })).status, 200);
  assert.equal((await route('claim', 'POST', { taskId: id, leaseId })).status, 409);
  assert.equal((await route('status', 'GET')).status, 200);
});
await test('finite execution starts at claim and lasts the full configured duration past ten minutes', async () => {
  for (const timeoutMs of [1_800_000, 86_400_000]) {
    const f = fixture(); f.settings.timeoutMs = timeoutMs; const id = await accepted(f);
    const pending = f.broker.pending().tasks[0];
    assert.equal(pending.claimedAt, null); assert.equal(pending.expiresAt, pending.claimExpiresAt);
    f.advance(240_000); const claimed = f.broker.claim({ taskId: id, leaseId }).task;
    assert.equal(claimed.claimedAt - pending.sourceReceivedAt, 240_000);
    assert.equal(claimed.expiresAt - claimed.claimedAt, timeoutMs);
    f.advance(600_001); assert.equal(f.broker.validate({ taskId: id, leaseId }).ok, true);
    f.advance(timeoutMs - 600_002); assert.equal(f.broker.validate({ taskId: id, leaseId }).ok, true);
    f.advance(1); expectFailure(f.broker.validate({ taskId: id, leaseId }), 'OWNER_DESKTOP_EXPIRED');
  }
});
await test('unlimited execution uses explicit JSON null and remains cancellable after a day', async () => {
  const f = fixture(); f.settings.timeoutMs = 0; const id = await accepted(f);
  const claimed = f.broker.claim({ taskId: id, leaseId }).task;
  assert.equal(claimed.expiresAt, null); assert.equal(claimed.timeoutMs, 0);
  assert.equal(JSON.parse(JSON.stringify(claimed)).expiresAt, null);
  f.advance(86_400_001); assert.equal(f.broker.validate({ taskId: id, leaseId }).ok, true);
  expectFailure(await f.broker.ingest(f.input()), 'OWNER_DESKTOP_BUSY');
  const cancel = f.input(); cancel.event.message[0].data.text = '取消电脑任务';
  assert.equal((await f.broker.ingest(cancel)).ok, true);
  expectFailure(f.broker.validate({ taskId: id, leaseId }), 'OWNER_DESKTOP_FINISHED');
});
await test('all durations retain a five-minute pending claim window', async () => {
  for (const timeoutMs of [0, 1_800_000, 86_400_000]) {
    const f = fixture(); f.settings.timeoutMs = timeoutMs; const id = await accepted(f);
    assert.equal(f.broker.pending().tasks[0].claimExpiresAt - f.broker.pending().tasks[0].sourceReceivedAt, 300_000);
    f.advance(300_000); expectFailure(f.broker.claim({ taskId: id, leaseId }), 'OWNER_DESKTOP_EXPIRED');
    assert.equal(f.broker.pending().tasks.length, 0);
    const g = fixture({ startedAt: 1_799_999_000_000 }); g.settings.timeoutMs = timeoutMs;
    const old = g.input('private', { time: 1_799_999_699 });
    assert.equal((await g.broker.ingest(old)).handled, false, 'unlimited never accepts a five-minute-old source');
  }
});
await test('near-expired sources cannot acquire a fresh five-minute waiting window', async () => {
  const f = fixture({ startedAt: 1_799_999_000_000 }); f.settings.timeoutMs = 0;
  const result = await f.broker.ingest(f.input('private', { time: 1_799_999_701 }));
  assert.equal(result.ok, true); assert.equal(result.task.claimExpiresAt - result.task.sourceReceivedAt, 1000);
  f.advance(1000); expectFailure(f.broker.claim({ taskId: result.task.id, leaseId }), 'OWNER_DESKTOP_EXPIRED');
});
await test('invalid raw settings cannot be coerced into unlimited; absence retains ten minutes', async () => {
  for (const timeoutMs of [null, false, true, '', '0', '600000', [], {}, -1, 29999, 86400001, NaN, Infinity]) {
    const f = fixture(); f.settings.timeoutMs = timeoutMs;
    expectFailure(await f.broker.ingest(f.input()), 'OWNER_DESKTOP_TIMEOUT_INVALID'); assert.equal(f.broker.pending().tasks.length, 0);
  }
  const f = fixture(); delete f.settings.timeoutMs; const id = await accepted(f);
  const task = f.broker.claim({ taskId: id, leaseId }).task;
  assert.equal(task.timeoutMs, 600_000); assert.equal(task.expiresAt - task.claimedAt, 600_000);
});
console.log('Owner desktop broker: ' + passed + ' tests passed (pure fixtures; no network).');
