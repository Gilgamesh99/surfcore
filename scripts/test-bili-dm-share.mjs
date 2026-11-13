// Pure/injected service plus real temporary persistence; no HTTP, QQ or production state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { createBiliDmShareService, createBiliDmShareStore, dmShareError } from '../src/bili-dm-share.js';

const BV = 'BV1xx411c7mD';
const now = () => '2026-11-13T12:00:00.000Z';
const request = (patch = {}) => ({ requestId: 'dm-123-900', ownerMid: '123', sourceSeq: '9007199254740993', groupId: '456',
  video: { bvid: BV, title: '示例视频', url: 'https://www.bilibili.com/video/' + BV }, commentary: '这段剪辑很有意思。', ...patch });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function failed(result, code, status = 'failed', retryable) {
  assert.equal(result.ok, false); assert.equal(result.code, code); assert.equal(result.status, status);
  assert.ok(result.error); assert.ok(result.hint);
  if (retryable !== undefined) assert.equal(result.retryable, retryable);
  return result;
}
function setup(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-dm-share-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const config = { owner: '123', groups: ['456', '789'], names: { 456: '测试群', 789: 'Other Group' } };
  const store = createBiliDmShareStore({ root, now });
  const deps = { store, now, getOwnerMid: () => config.owner, getAllowedGroups: () => config.groups,
    getGroup: async (id) => ({ name: config.names[id] }), authorize: () => () => {},
    transport: async (id, text) => { calls.push({ id, text }); return { message_id: -9001 }; }, ...overrides };
  return { root, calls, config, store, deps, service: createBiliDmShareService(deps) };
}

test('resolves only exact normalized allowed names or IDs', async (t) => {
  const { service, config, calls } = setup(t);
  assert.deepEqual(await service.resolve('  ＯＴＨＥＲ   group '), { ok: true, group: { id: '789', name: 'Other Group' } });
  assert.equal((await service.resolve('４５６')).group.id, '456');
  const noMatch = failed(await service.resolve('测试'), 'DM_SHARE_GROUP_NOT_FOUND');
  assert.equal(noMatch.candidates.length, 2);
  failed(await service.resolve('999'), 'DM_SHARE_GROUP_NOT_ALLOWED');
  config.groups = [];
  failed(await service.resolve('456'), 'DM_SHARE_GROUP_NOT_ALLOWED');
  assert.equal(calls.length, 0);
});
test('same normalized names require an explicit ID, never first match', async (t) => {
  const { service, config } = setup(t);
  config.names['789'] = ' 测试群 ';
  const result = failed(await service.resolve('测试群'), 'DM_SHARE_GROUP_AMBIGUOUS');
  assert.deepEqual(result.candidates.map((x) => x.id), ['456', '789']);
  assert.equal((await service.resolve('789')).group.id, '789');
});
test('partial metadata failure cannot falsely prove a unique name', async (t) => {
  const { service, calls } = setup(t, { getGroup: async (id) => {
    if (id === '789') throw new Error('fixture network secret');
    return { name: '测试群' };
  } });
  failed(await service.resolve('测试群'), 'DM_SHARE_GROUPS_UNAVAILABLE', 'failed', true);
  assert.equal((await service.resolve('456')).group.id, '456');
  assert.equal(calls.length, 0);
});
test('metadata resolution rejects allowlist changes during lookup', async (t) => {
  const f = setup(t); const wait = deferred();
  f.deps.getGroup = async () => { await wait.promise; return { name: '测试群' }; };
  const service = createBiliDmShareService(f.deps);
  const pending = service.resolve('测试群'); f.config.groups = ['456']; wait.resolve();
  failed(await pending, 'DM_SHARE_GROUPS_UNAVAILABLE');
});
test('one combined title/link/commentary, marker before transport, receipt afterwards', async (t) => {
  const f = setup(t);
  f.deps.transport = async (id, text) => {
    assert.equal(f.store.read('dm-123-900').sending, true);
    assert.equal(f.store.read('dm-123-900').receipt, null);
    f.calls.push({ id, text }); return { message_id: -9001 };
  };
  const service = createBiliDmShareService(f.deps);
  const result = await service.send(request());
  assert.deepEqual(result, { ok: true, status: 'sent', receipt: { messageId: '-9001', groupId: '456', groupName: '测试群', sentAt: now() } });
  assert.deepEqual(f.calls, [{ id: '456', text: '示例视频\nhttps://www.bilibili.com/video/' + BV + '\n这段剪辑很有意思。' }]);
  assert.deepEqual(service.status('dm-123-900'), result);
  const records = fs.readdirSync(f.root).flatMap((dir) => fs.readdirSync(path.join(f.root, dir)).map((file) => fs.readFileSync(path.join(f.root, dir, file), 'utf8'))).join('');
  assert.ok(!records.includes('这段剪辑') && !records.includes('示例视频'), 'no private text sync into delivery store');
});
test('sent requests survive independent service/store restart without resending', async (t) => {
  const f = setup(t); const first = await f.service.send(request());
  const restart = createBiliDmShareService({ ...f.deps, store: createBiliDmShareStore({ root: f.root }) });
  assert.deepEqual(await restart.send(request()), first);
  assert.deepEqual(restart.status(request().requestId), first);
  assert.equal(f.calls.length, 1);
});
test('concurrent independent instances cannot resubmit an in-flight request', async (t) => {
  const entered = deferred(), release = deferred(); const f = setup(t);
  const transport = async () => { f.calls.push('send'); entered.resolve(); await release.promise; return { message_id: '9007199254740993' }; };
  const a = createBiliDmShareService({ ...f.deps, transport });
  const b = createBiliDmShareService({ ...f.deps, transport, store: createBiliDmShareStore({ root: f.root }) });
  const pending = a.send(request()); await entered.promise;
  failed(await b.send(request()), 'DM_SHARE_UNKNOWN', 'unknown', false);
  failed(a.status(request().requestId), 'DM_SHARE_UNKNOWN', 'unknown', false);
  release.resolve(); const result = await pending;
  assert.equal(result.receipt.messageId, '9007199254740993'); assert.equal(f.calls.length, 1);
  assert.deepEqual(await b.send(request()), result);
});
test('exact request binding rejects target/content/source/owner/type changes', async (t) => {
  const f = setup(t); await f.service.send(request());
  for (const patch of [{ groupId: '789' }, { commentary: '另一条感想' }, { ownerMid: '321' }, { sourceSeq: '2' }, { groupId: 456 }, { video: { ...request().video, title: ' 示例视频 ' } }]) {
    failed(await f.service.send(request(patch)), 'DM_SHARE_REQUEST_CONFLICT', 'failed', false);
  }
  assert.equal(f.calls.length, 1);
});
test('current owner and explicit group allowlist are required, blocked retries remain safe', async (t) => {
  const f = setup(t); f.config.owner = '321';
  failed(await f.service.send(request()), 'DM_SHARE_OWNER_MISMATCH');
  f.config.owner = '123'; f.config.groups = [];
  failed(await f.service.send(request()), 'DM_SHARE_GROUP_NOT_ALLOWED', 'failed', true);
  f.config.groups = ['456'];
  assert.equal((await f.service.send(request())).status, 'sent'); assert.equal(f.calls.length, 1);
});
test('guard failure before transport remains queryable/retryable after restart', async (t) => {
  let blocked = true; const f = setup(t, { authorize: () => () => {
    if (blocked) throw dmShareError('FIXTURE_PAUSED', 'paused', 'resume first');
  } });
  failed(await f.service.send(request()), 'FIXTURE_PAUSED', 'failed', true);
  const restart = createBiliDmShareService({ ...f.deps, store: createBiliDmShareStore({ root: f.root }) });
  failed(restart.status(request().requestId), 'FIXTURE_PAUSED');
  blocked = false; assert.equal((await restart.send(request())).status, 'sent'); assert.equal(f.calls.length, 1);
});
test('queue-time owner/allowlist/guard changes stop a pending request', async (t) => {
  for (const change of ['owner', 'groups', 'guard']) {
    const tasks = []; let denied = false; const f = setup(t, { enqueue: (task) => new Promise((resolve) => tasks.push(() => resolve(task()))),
      authorize: () => () => { if (denied) throw dmShareError('FIXTURE_CHANGED', 'changed', 'retry current'); } });
    const pending = f.service.send(request());
    while (!tasks.length) await Promise.resolve();
    if (change === 'owner') f.config.owner = '321'; else if (change === 'groups') f.config.groups = []; else denied = true;
    tasks[0](); failed(await pending, change === 'owner' ? 'DM_SHARE_OWNER_MISMATCH' : change === 'groups' ? 'DM_SHARE_GROUP_NOT_ALLOWED' : 'FIXTURE_CHANGED');
    assert.equal(f.calls.length, 0);
  }
});
test('metadata failure prevents send and permits exact retry', async (t) => {
  let available = false; const f = setup(t, { getGroup: async () => available ? { name: '测试群' } : null });
  failed(await f.service.send(request()), 'DM_SHARE_GROUPS_UNAVAILABLE', 'failed', true);
  assert.equal(f.calls.length, 0); available = true;
  assert.equal((await f.service.send(request())).status, 'sent');
});
for (const result of [{}, { queued: true }, { message_id: 0 }, { message_id: 9007199254740992 }]) {
  test('missing/queued/invalid receipt stays unknown: ' + JSON.stringify(result), async (t) => {
    let sends = 0; const f = setup(t, { transport: async () => { sends++; return result; } });
    failed(await f.service.send(request()), 'DM_SHARE_UNKNOWN', 'unknown', false);
    failed(await f.service.send(request()), 'DM_SHARE_UNKNOWN', 'unknown', false);
    assert.equal(sends, 1);
  });
}
test('timeout or partial response after network submission never resends or leaks error', async (t) => {
  let sends = 0; const f = setup(t, { transport: async () => { sends++; throw new Error('fixture-credential timeout after acceptance'); } });
  const result = failed(await f.service.send(request()), 'DM_SHARE_UNKNOWN', 'unknown', false);
  assert.ok(!JSON.stringify(result).includes('fixture-credential'));
  const restart = createBiliDmShareService({ ...f.deps, store: createBiliDmShareStore({ root: f.root }) });
  failed(await restart.send(request()), 'DM_SHARE_UNKNOWN', 'unknown', false); assert.equal(sends, 1);
});
test('receipt write failure preserves uncertainty and durable sending marker', async (t) => {
  const f = setup(t); f.deps.store = { ...f.store, sent() { throw new Error('disk full'); } };
  failed(await createBiliDmShareService(f.deps).send(request()), 'DM_SHARE_STORE_UNAVAILABLE', 'unknown', false);
  const restart = createBiliDmShareService({ ...f.deps, store: createBiliDmShareStore({ root: f.root }) });
  failed(await restart.send(request()), 'DM_SHARE_UNKNOWN', 'unknown', false); assert.equal(f.calls.length, 1);
});
test('begin write failure prevents network and releases only unused reservation', async (t) => {
  let rolledBack = 0; const f = setup(t, { reserveSend: () => () => { rolledBack++; } });
  f.deps.store = { ...f.store, begin() { throw new Error('disk unavailable'); } };
  failed(await createBiliDmShareService(f.deps).send(request()), 'DM_SHARE_STORE_UNAVAILABLE', 'unknown', false);
  assert.equal(f.calls.length, 0); assert.equal(rolledBack, 1);
});
test('receipt remains successful if optional local history update fails', async (t) => {
  const f = setup(t, { recordSent() { throw new Error('history full'); } });
  assert.equal((await f.service.send(request())).status, 'sent');
  assert.equal(f.service.status(request().requestId).status, 'sent');
});
test('corrupt or partial sending files fail closed across restart', async (t) => {
  for (const corrupt of ['', 'null', '{}', '{']) {
    const f = setup(t); const payload = request();
    await f.service.send(payload);
    const dir = path.join(f.root, crypto.createHash('sha256').update(payload.requestId).digest('hex'));
    fs.unlinkSync(path.join(dir, 'sent.json')); fs.writeFileSync(path.join(dir, 'sending.json'), corrupt);
    const restarted = createBiliDmShareService({ ...f.deps, store: createBiliDmShareStore({ root: f.root }) });
    failed(await restarted.send(payload), 'DM_SHARE_STORE_UNAVAILABLE', 'unknown', false);
    assert.equal(f.calls.length, 1);
  }
});
test('corrupt request record blocks new send rather than rebuilding it', async (t) => {
  const f = setup(t); const dir = path.join(f.root, crypto.createHash('sha256').update(request().requestId).digest('hex'));
  fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'request.json'), 'null');
  failed(await f.service.send(request()), 'DM_SHARE_STORE_UNAVAILABLE', 'unknown', false); assert.equal(f.calls.length, 0);
});
test('request and text validation reject arbitrary URLs/paths/segments and bad BV', async (t) => {
  const f = setup(t);
  for (const commentary of ['https://evil.invalid/', 'www.evil.invalid', 'file:///C:/private', 'C:\\private', '/private/file', '[CQ:image,file=abc]', 'a\u0000b', 'x'.repeat(601)]) {
    failed(await f.service.send(request({ commentary })), 'DM_SHARE_TEXT_INVALID');
  }
  for (const patch of [{ url: 'https://evil.invalid/' }, { bvid: 'bv1xx411c7mD' }, { url: request().video.url + '?a=1' }]) {
    failed(await f.service.send(request({ video: { ...request().video, ...patch } })), 'DM_SHARE_VIDEO_INVALID');
  }
  for (const patch of [{ groupId: '456,789' }, { sourceSeq: 9007199254740992 }, { requestId: '../escape' }, { segments: [] }, { commentary: {} }]) {
    assert.equal((await f.service.send(request(patch))).ok, false);
  }
  assert.equal(f.calls.length, 0);
});
test('unknown request status permits same-ID first submission without inventing receipt', (t) => {
  const { service } = setup(t);
  failed(service.status('not-yet-sent'), 'DM_SHARE_NOT_FOUND', 'failed', true);
  failed(service.status('../invalid'), 'DM_SHARE_REQUEST_INVALID', 'failed', false);
});
