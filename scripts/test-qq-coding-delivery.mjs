// Isolated filesystem fixtures and an in-memory socket exercise the installed SDK without contacting QQ.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SnowLumaWebSocketClient } from '@snowluma/sdk/client';
import { readCodingDelivery, uploadCodingFile } from '../src/qq-coding-delivery.js';

const group = 'group:321';
const privateKey = 'private:654';
const checks = ['运行 node --test，3 项通过'];
const success = { status: 'ok', retcode: 0, data: { file_id: '/qq-file-123' } };
const digest = data => createHash('sha256').update(data).digest('hex');

function fixture(t, entries = { '报告.txt': '成品内容' }) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'surfcore-coding-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'task');
  const out = path.join(workspace, 'deliverables');
  const manifest = path.join(workspace, 'surfcore-result.json');
  fs.mkdirSync(out, { recursive: true });
  for (const [name, bytes] of Object.entries(entries)) {
    const file = path.join(out, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  const writeManifest = input => fs.writeFileSync(manifest, JSON.stringify(input));
  writeManifest({ files: Object.keys(entries), checks });
  return { root, workspace, out, manifest, writeManifest };
}

function gateway(reply = () => success) {
  const calls = [];
  const onebot = { async request(action, params) {
    calls.push({ action, params });
    return reply(action, params);
  } };
  return { onebot, calls };
}
function readFails(workspace, code) {
  return assert.rejects(() => readCodingDelivery(workspace), e => e.code === code && !!e.hint && !!e.message);
}
function failure(result, code, status = 'rejected') {
  assert.equal(result.ok, false);
  assert.equal(result.code, code);
  assert.equal(result.status, status);
  assert.ok(result.error && result.hint);
}
async function first(t, originKey = group) {
  const { workspace } = fixture(t);
  return (await readCodingDelivery(workspace, { originKey })).files[0];
}

test('已安装的 SnowLumaWebSocketClient 在内存中完成请求编码、echo 配对和真实回包解包', async t => {
  const requests = [];
  class MemorySocket extends EventTarget {
    readyState = 1;
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(raw) {
      const request = JSON.parse(raw);
      requests.push(request);
      const response = request.action === 'upload_group_file' ? success
        : { status: 'failed', retcode: 1400, wording: 'user_id: invalid user id', data: null };
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ ...response, echo: request.echo }) }));
    }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const onebot = new SnowLumaWebSocketClient({ webSocket: MemorySocket, reconnect: false, requestTimeoutMs: 500 });
  await onebot.connect();
  t.after(() => onebot.close());
  assert.equal((await uploadCodingFile({ onebot, originKey: group, file: await first(t) })).fileId, '/qq-file-123');
  failure(await uploadCodingFile({ onebot, originKey: privateKey, file: await first(t, privateKey) }), 'CODING_UPLOAD_REJECTED');
  assert.deepEqual(requests.map(r => r.action), ['upload_group_file', 'upload_private_file']);
  assert.equal(requests[0].params.group_id, 321);
  assert.equal(requests[1].params.user_id, 654);
  assert.ok(requests.every(r => r.echo && r.params.upload_file && r.params.file.startsWith('base64://')));
});

test('验收按清单顺序返回嵌套文件、摘要和可持久化来源元数据', async t => {
  const binary = Buffer.from([0, 255, 23, 10]);
  const { workspace, out, writeManifest } = fixture(t, { '界面/游戏 包.zip': binary, '说明.txt': 'ok' });
  fs.writeFileSync(path.join(workspace, 'scratch.log'), 'private scratch, outside deliverables');
  writeManifest({ files: ['说明.txt', '界面\\游戏 包.zip'], checks: ['  已验证  '] });
  const { files, checks: result } = await readCodingDelivery(workspace, { originKey: group });
  assert.deepEqual(result, ['已验证']);
  assert.deepEqual(files.map(f => f.name), ['说明.txt', '游戏 包.zip']);
  assert.deepEqual(JSON.parse(JSON.stringify(files[1])), { name: '游戏 包.zip', path: path.join(out, '界面', '游戏 包.zip'),
    relativePath: '界面/游戏 包.zip', sha256: digest(binary), size: binary.length, originKey: group });
  assert.ok(files.every(f => Object.isFrozen(f)));
});

test('可信验收时间按毫秒比较；允许晚写清单，拒绝晚改成品和回拨 mtime', async t => {
  const { workspace, out, manifest, writeManifest } = fixture(t, { '成品.bin': 'first' });
  const file = path.join(out, '成品.bin');
  const initial = fs.statSync(file, { bigint: true });
  const verifiedAt = Number((initial.ctimeNs > initial.mtimeNs ? initial.ctimeNs : initial.mtimeNs) / 1_000_000n);
  writeManifest({ files: ['成品.bin'], checks });
  const afterCheck = new Date(verifiedAt + 60_000);
  fs.utimesSync(manifest, afterCheck, afterCheck);
  assert.equal((await readCodingDelivery(workspace, { originKey: group, verifiedAt })).files[0].sha256, digest('first'));

  await new Promise(resolve => setTimeout(resolve, 30));
  fs.writeFileSync(file, 'later');
  const backdated = new Date(verifiedAt - 60_000);
  fs.utimesSync(file, backdated, backdated);
  const changed = fs.statSync(file, { bigint: true });
  assert.ok(changed.mtimeNs / 1_000_000n < BigInt(verifiedAt) && changed.ctimeNs / 1_000_000n > BigInt(verifiedAt));
  const expectChanged = time => assert.rejects(() => readCodingDelivery(workspace, { verifiedAt: time }),
    error => error.code === 'CODING_FILE_CHANGED_AFTER_CHECK' && /重新运行验收测试/u.test(error.hint));
  await expectChanged(verifiedAt);

  fs.utimesSync(file, afterCheck, afterCheck);
  const touched = fs.statSync(file, { bigint: true });
  assert.ok(touched.mtimeNs / 1_000_000n > touched.ctimeNs / 1_000_000n);
  await expectChanged(Number(touched.ctimeNs / 1_000_000n));
  assert.equal((await readCodingDelivery(workspace)).files[0].sha256, digest('later'));
});

test('显式传入无效宿主验收时间时拒绝交付', async t => {
  const { workspace } = fixture(t);
  for (const verifiedAt of [null, '', '1700000000000', 0, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(() => readCodingDelivery(workspace, { verifiedAt }),
      error => error.code === 'CODING_VERIFIED_AT_INVALID' && !!error.hint);
  }
});

test('只接受有效 UTF-8 正式清单、非空验收和有界结构', async t => {
  const { workspace, manifest, writeManifest } = fixture(t);
  for (const input of [null, [], {}, { files: [], checks }, { files: ['报告.txt'] }, { files: ['报告.txt'], checks: [] },
    { files: ['报告.txt'], checks: ['   '] }, { files: ['报告.txt'], checks: [true] }, { files: ['报告.txt'], checks: ['x'.repeat(2049)] },
    { files: ['报告.txt'], checks: Array(65).fill('pass') }, { files: Array(33).fill('a'), checks }, { files: ['报告.txt'], checks, group_id: 999 }]) {
    writeManifest(input);
    await readFails(workspace, 'CODING_MANIFEST_INVALID');
  }
  fs.writeFileSync(manifest, '{not JSON');
  await readFails(workspace, 'CODING_MANIFEST_INVALID');
  fs.writeFileSync(manifest, Buffer.concat([Buffer.from('{"files":["报告.txt"],"checks":["'), Buffer.from([0xc0, 0x80]), Buffer.from('"]}') ]));
  await readFails(workspace, 'CODING_MANIFEST_INVALID');
  fs.truncateSync(manifest, 64 * 1024 + 1);
  await readFails(workspace, 'CODING_FILE_SIZE');
  fs.rmSync(manifest);
  await readFails(workspace, 'CODING_DELIVERY_UNREADABLE');
  await readFails('', 'CODING_WORKSPACE_INVALID');
  await assert.rejects(() => readCodingDelivery(workspace, { originKey: 'group:0' }), { code: 'CODING_ORIGIN_INVALID' });
});

test('路径穿越、Win32 别名、流、重复显示名与文件目录冲突都在上传前失败', async t => {
  const { workspace, writeManifest } = fixture(t);
  for (const name of [null, {}, '', '.', '..', '../a', 'ok/../a', 'ok\\..\\a', './a', '/absolute', '\\\\host\\share',
    'C:/abs', 'C:drive-relative', 'file:///tmp/a', 'a:stream', 'CON.txt', 'LPT¹.txt', 'aux.', 'bad.', 'abc ', 't//x', 'a/', 'x\u202ey', 'x\0y']) {
    writeManifest({ files: [name], checks });
    await readFails(workspace, 'CODING_FILE_PATH');
  }
  for (const files of [['a', 'a'], ['Dir/test.js', 'Other/TEST.JS'], ['a/é', 'b/e\u0301'], ['nested/file', 'nested\\file']]) {
    writeManifest({ files, checks });
    await readFails(workspace, 'CODING_FILE_DUPLICATE');
  }
  writeManifest({ files: ['nested', 'nested/file'], checks });
  await readFails(workspace, 'CODING_FILE_PATH');
});

test('拒绝目录、遗漏文件、未声明的文件或目录', async t => {
  const { workspace, out, writeManifest } = fixture(t, {});
  writeManifest({ files: ['missing.txt'], checks });
  await readFails(workspace, 'CODING_FILE_MISSING');
  fs.mkdirSync(path.join(out, 'missing.txt'));
  await readFails(workspace, 'CODING_FILE_UNSAFE');
  fs.rmdirSync(path.join(out, 'missing.txt'));
  fs.writeFileSync(path.join(out, 'missing.txt'), 'final');
  fs.writeFileSync(path.join(out, '.env'), 'unlisted temporary content');
  await readFails(workspace, 'CODING_FILE_UNEXPECTED');
  fs.rmSync(path.join(out, '.env'));
  fs.mkdirSync(path.join(out, 'unlisted'));
  await readFails(workspace, 'CODING_FILE_UNEXPECTED');
});

test('成品和清单的硬链接都不能把其它位置的数据引入交付', async t => {
  const { root, workspace, out, manifest } = fixture(t, { 'out.txt': 'fixture' });
  const file = path.join(out, 'out.txt');
  fs.linkSync(file, path.join(root, 'external.txt'));
  await readFails(workspace, 'CODING_FILE_UNSAFE');
  fs.unlinkSync(path.join(root, 'external.txt'));
  fs.linkSync(manifest, path.join(root, 'external-manifest.json'));
  await readFails(workspace, 'CODING_FILE_UNSAFE');
});

test('工作区、deliverables 和嵌套目录中的 junction / 符号链接均被拒绝', async t => {
  const { root, workspace, out, writeManifest } = fixture(t, {});
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret'), 'private fixture');
  fs.symlinkSync(outside, path.join(out, 'linked'), type);
  writeManifest({ files: ['linked/secret'], checks });
  await readFails(workspace, 'CODING_FILE_UNSAFE');
  fs.renameSync(out, path.join(workspace, 'original'));
  fs.symlinkSync(outside, out, type);
  await readFails(workspace, 'CODING_FILE_UNSAFE');
  const alias = path.join(root, 'alias');
  fs.symlinkSync(workspace, alias, type);
  await readFails(alias, 'CODING_FILE_UNSAFE');
});

test('拒绝文件符号链接和清单符号链接', async t => {
  const { root, workspace, out, manifest, writeManifest } = fixture(t, {});
  const outside = path.join(root, 'outside');
  fs.writeFileSync(outside, 'fixture');
  writeManifest({ files: ['link.txt'], checks });
  try { fs.symlinkSync(outside, path.join(out, 'link.txt'), 'file'); }
  catch (e) { if (process.platform === 'win32' && e.code === 'EPERM') { t.skip('此 Windows 账户未获创建文件符号链接的权限'); return; } throw e; }
  await readFails(workspace, 'CODING_FILE_UNSAFE');
  fs.renameSync(manifest, path.join(root, 'actual-manifest'));
  fs.symlinkSync(path.join(root, 'actual-manifest'), manifest, 'file');
  await readFails(workspace, 'CODING_FILE_UNSAFE');
});

test('空文件、超大单件和超出整单预算均不生成可上传文件', async t => {
  const { workspace, out, writeManifest } = fixture(t, { a: '' });
  await readFails(workspace, 'CODING_FILE_SIZE');
  const limit = 32 * 1024 * 1024;
  fs.truncateSync(path.join(out, 'a'), limit + 1);
  await readFails(workspace, 'CODING_FILE_SIZE');
  fs.truncateSync(path.join(out, 'a'), limit);
  fs.writeFileSync(path.join(out, 'b'), '');
  fs.truncateSync(path.join(out, 'b'), limit);
  fs.writeFileSync(path.join(out, 'c'), 'x');
  writeManifest({ files: ['a', 'b', 'c'], checks });
  await readFails(workspace, 'CODING_FILE_SIZE');
});

test('正式群/私聊附件用绑定 ID、文件名和验收时的字节，无法改成任意本地路径', async t => {
  for (const [originKey, action, recipient] of [[group, 'upload_group_file', { group_id: 321 }], [privateKey, 'upload_private_file', { user_id: 654 }]]) {
    const binary = Buffer.from([0, 254, 18, 0]);
    const { workspace, out } = fixture(t, { '成品.bin': binary });
    const { files: [file] } = await readCodingDelivery(workspace, { originKey });
    fs.renameSync(file.path, path.join(out, 'old.tmp'));
    fs.writeFileSync(file.path, 'changed after acceptance');
    const { onebot, calls } = gateway();
    const params = { originKey, file, onebot, user_id: 123, group_id: 456 };
    failure(await uploadCodingFile({ ...params, originKey: originKey === group ? privateKey : group }), 'CODING_UPLOAD_BINDING');
    failure(await uploadCodingFile({ ...params, file: JSON.parse(JSON.stringify(file)) }), 'CODING_UPLOAD_BINDING');
    assert.equal(calls.length, 0);
    const result = await uploadCodingFile(params);
    assert.deepEqual(result, { ok: true, status: 'sent', fileId: '/qq-file-123' });
    assert.equal((await uploadCodingFile(params)).fileId, result.fileId);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, action);
    assert.deepEqual(calls[0].params, { ...recipient, file: 'base64://' + binary.toString('base64'), name: '成品.bin', upload_file: true });
  }
});

test('单参数读取时，整份清单首次指定的原会话对后续文件同样生效', async t => {
  const { workspace } = fixture(t, { a: '1', b: '2' });
  const { files } = await readCodingDelivery(workspace);
  const { onebot, calls } = gateway();
  for (const originKey of ['group:0', 'group:01', 'group:-1', 'private:9007199254740992', 'group:123\n', 'private:123/path', null, 123]) {
    failure(await uploadCodingFile({ onebot, originKey, file: files[0] }), 'CODING_UPLOAD_BINDING');
  }
  assert.equal((await uploadCodingFile({ onebot, originKey: group, file: files[0] })).status, 'sent');
  failure(await uploadCodingFile({ onebot, originKey: privateKey, file: files[1] }), 'CODING_UPLOAD_BINDING');
  assert.equal(calls.length, 1);
});

test('授权重验可在发包前异步阻断，同一附件并发调用共享一次发送', async t => {
  const file = await first(t);
  const { onebot, calls } = gateway();
  const args = { onebot, file, originKey: group };
  for (const assertCurrent of [() => false, () => ({ ok: false }), () => { throw Error('revoked'); }, async () => null]) {
    failure(await uploadCodingFile({ ...args, assertCurrent }), 'CODING_UPLOAD_AUTH');
  }
  onebot.isConnected = false;
  failure(await uploadCodingFile(args), 'CODING_UPLOAD_OFFLINE');
  failure(await uploadCodingFile({ ...args, onebot: {} }), 'CODING_UPLOAD_UNAVAILABLE');
  assert.equal(calls.length, 0);
  onebot.isConnected = true;
  let release, entered;
  const wait = new Promise(r => { release = r; });
  const inGuard = new Promise(r => { entered = r; });
  let guards = 0;
  const assertCurrent = async identity => {
    assert.equal(identity.originKey, group); assert.equal(identity.file, file);
    guards += 1; entered(); await wait;
  };
  const firstAttempt = uploadCodingFile({ ...args, assertCurrent });
  await inGuard;
  const secondAttempt = uploadCodingFile({ ...args, assertCurrent });
  assert.equal(calls.length, 0);
  release();
  assert.deepEqual(await firstAttempt, await secondAttempt);
  assert.equal(guards, 1);
  assert.equal(calls.length, 1);
});

test('确定拦截与正式网关拒绝返回可行动的错误，不擅自重试', async t => {
  for (const [retcode, wording] of [[1400, 'file: expected string'], [1404, 'unknown action'], [1401, 'unauthorized'],
    [100, 'OneBot instance is shutting down'], [100, 'group file upload failed: code=-3 msg=denied']]) {
    const file = await first(t);
    const { onebot, calls } = gateway(() => ({ status: 'failed', retcode, wording, data: null }));
    failure(await uploadCodingFile({ onebot, file, originKey: group }), 'CODING_UPLOAD_REJECTED');
    assert.equal(calls.length, 1);
  }
});

test('回包缺失、事后失败及超时均为 unknown，同一快照拒绝再次投递', async t => {
  for (const reply of [() => null, () => ({ data: success.data }), () => ({ ...success, retcode: 100 }),
    () => ({ ...success, data: null }), () => ({ ...success, data: { file_id: null } }),
    () => ({ status: 'failed', retcode: 1400, wording: 'chat post could not be confirmed' }),
    () => ({ ...success, data: { file_id: ' ' } }), () => ({ ...success, data: { message_id: 12 } }),
    () => ({ status: 'failed', retcode: 100, wording: 'group file uploaded (fileId=x) but chat post failed: connection lost' }),
    () => ({ status: 'failed', retcode: 1200, wording: 'internal error' }), () => { throw new Error('connection reset / timeout'); }]) {
    const file = await first(t);
    const { onebot, calls } = gateway(reply);
    const args = { onebot, file, originKey: group };
    failure(await uploadCodingFile(args), 'CODING_UPLOAD_UNKNOWN', 'unknown');
    failure(await uploadCodingFile(args), 'CODING_UPLOAD_UNKNOWN', 'unknown');
    assert.equal(calls.length, 1);
  }
});
