// Dependency-free fixtures only. No provider, QQ, bridge, user state, or network calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createGeneratedImageService, normalizeGeneratedImageConfig } from '../src/generated-images.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdAAr/2Q==', 'base64');
const WEBP = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
const SECRET = 'fixture-session-token-never-on-disk';
const REQUEST = { key: 'group:123', token: SECRET, prompt: 'a small whale' };
const allow = { assertAllowed: () => {} };
const tick = () => new Promise(resolve => setImmediate(resolve));
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const errorIs = code => error => {
  assert.equal(error.code, code);
  assert.ok(error.error && error.hint && Number.isInteger(error.statusCode));
  assert.equal(JSON.stringify(error).includes(SECRET), false);
  return true;
};
const fails = (promise, code) => assert.rejects(promise, errorIs(code));

// A real process death leaves both the pending reservation and stale PID lock on disk.
if (process.argv[2] === '--crash-fixture') {
  const service = createGeneratedImageService({ root: process.argv[3], now: () => Number(process.argv[4]), getConfig: () => ({ enabled: true }), generate: async () => { throw new Error('must not run before exit'); } });
  const started = await service.start(REQUEST, allow);
  process.stdout.write(JSON.stringify(started));
  process.exit(0);
}

async function fixture(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'surfcore-generated-images-'));
  const root = path.join(base, 'generated-images');
  const state = { cfg: { enabled: true, ...options.config }, stamp: new Date(2026, 10, 12, 12).getTime(), calls: [], services: [] };
  const create = (overrides = {}) => {
    const service = createGeneratedImageService({ root, now: () => state.stamp, getConfig: () => state.cfg, generate: async (request, context) => {
      state.calls.push({ ...request, signal: context.signal });
      return options.generate ? options.generate(request, context, state) : fs.writeFile(request.path, PNG);
    }, ...overrides });
    state.services.push(service);
    return service;
  };
  const service = create();
  t.after(async () => {
    options.release?.();
    for (const item of state.services) { try { await item.close(); } catch { /* Attack fixtures intentionally invalidate storage. */ } }
    await tick();
    // Only this test's mkdtemp directory is disposable; links are removed, never followed.
    assert.equal(path.dirname(base), path.resolve(os.tmpdir()));
    assert.ok(path.basename(base).startsWith('surfcore-generated-images-'));
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, root, state, service, create };
}
const owned = (started, overrides = {}) => ({ key: REQUEST.key, token: REQUEST.token, imageId: started.imageId, ...overrides });
// Completion assertions wait for disk work; response-latency cases pass their own short waitMs.
const done = (service, started, options = {}) => service.result(owned(started), { ...allow, waitMs: 30000, ...options });
const ready = async (service, input = REQUEST) => {
  const started = await service.start(input, allow);
  const result = await service.result({ ...input, imageId: started.imageId }, { ...allow, waitMs: 30000 });
  assert.equal(result.status, 'ready', JSON.stringify(result));
  return started;
};

async function fileLinksAvailable(t, base) {
  const target = path.join(base, 'link-probe-target'), link = path.join(base, 'link-probe');
  await fs.writeFile(target, PNG);
  try { await fs.symlink(target, link, 'file'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('Host does not permit file symlinks; junction and hard-link tests still run.'); return false; }
    throw error;
  }
  await fs.unlink(link);
  return true;
}

test('config defaults disable paid work and clamp all resource bounds', () => {
  const defaults = normalizeGeneratedImageConfig();
  assert.deepEqual(defaults, { enabled: false, dailyPerKey: 3, dailyGlobal: 12, cooldownMs: 60000, concurrencyGlobal: 2, concurrencyPerKey: 1, retentionMs: 86400000, maxBytes: 10485760, maxEntries: 128, generationTimeoutMs: 300000 });
  const clamped = normalizeGeneratedImageConfig({ enabled: 'true', dailyPerKey: 999, dailyGlobal: 9999, cooldownMs: -1, concurrencyGlobal: 99, concurrencyPerKey: 99, retentionMs: 1e12, maxBytes: 1e12, maxEntries: 1e12, generationTimeoutMs: 1e12 });
  assert.deepEqual(clamped, { enabled: false, dailyPerKey: 100, dailyGlobal: 1000, cooldownMs: 0, concurrencyGlobal: 2, concurrencyPerKey: 1, retentionMs: 86400000, maxBytes: 10485760, maxEntries: 512, generationTimeoutMs: 600000 });
  assert.equal(normalizeGeneratedImageConfig({ maxBytes: Infinity }).maxBytes, 10485760);
  assert.equal(normalizeGeneratedImageConfig(null).enabled, false);
  assert.equal(normalizeGeneratedImageConfig({ dailyPerKey: 0 }).dailyPerKey, 0);
});

test('immediate pending result, fixed backend path, bounded image read, no secret persistence', async t => {
  const gate = defer(), entered = defer();
  const f = await fixture(t, { release: gate.resolve, generate: async request => { entered.resolve(); await gate.promise; await fs.writeFile(request.path, PNG); } });
  const started = await f.service.start({ ...REQUEST, size: '1536x1024', path: '../ignored', n: 4 }, allow);
  assert.deepEqual(Object.keys(started).sort(), ['imageId', 'ok', 'status']);
  assert.equal(started.status, 'pending');
  assert.match(started.imageId, /^[a-f0-9]{48}$/);
  await entered.promise;
  assert.equal(f.state.calls[0].path, path.join(f.root, started.imageId, 'image.png'));
  assert.equal(f.state.calls[0].size, '1536x1024');
  assert.equal('n' in f.state.calls[0], false);
  assert.equal((await done(f.service, started, { waitMs: 5 })).status, 'pending');
  gate.resolve();
  const result = await done(f.service, started);
  assert.deepEqual(result, { ok: true, status: 'ready', imageId: started.imageId, bytes: PNG.length, mimeType: 'image/png' });
  const image = await f.service.readReady(owned(started));
  assert.deepEqual(image, { buffer: PNG, mimeType: 'image/png' });
  const disk = await fs.readFile(path.join(f.root, 'ledger.json'), 'utf8');
  for (const secret of [SECRET, REQUEST.prompt, REQUEST.key, f.root]) assert.equal(disk.includes(secret), false);
  assert.equal(JSON.stringify(result).includes(f.root), false);
});

test('pending and ready requests deduplicate under concurrent starts and after restart', async t => {
  const gate = defer(), entered = defer();
  const f = await fixture(t, { release: gate.resolve, generate: async request => { entered.resolve(); await gate.promise; await fs.writeFile(request.path, PNG); } });
  const starts = await Promise.all(Array.from({ length: 12 }, () => f.service.start(REQUEST, allow)));
  assert.equal(new Set(starts.map(item => item.imageId)).size, 1);
  assert.equal(starts.filter(item => item.deduplicated).length, 11);
  await entered.promise;
  assert.equal(f.state.calls.length, 1);
  gate.resolve();
  await done(f.service, starts[0]);
  assert.equal((await f.service.start(REQUEST, allow)).status, 'ready');
  await f.service.close();
  const resumed = f.create();
  assert.equal((await resumed.start(REQUEST, allow)).imageId, starts[0].imageId);
  assert.equal(f.state.calls.length, 1);
});

test('concurrent reservation enforces one per key even with different tokens', async t => {
  const gate = defer(), entered = defer();
  const f = await fixture(t, { release: gate.resolve, generate: async request => { entered.resolve(); await gate.promise; await fs.writeFile(request.path, PNG); } });
  const values = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => f.service.start({ ...REQUEST, prompt: `different ${index}`, token: `${SECRET}${index}` }, allow)));
  assert.equal(values.filter(item => item.status === 'fulfilled').length, 1);
  for (const failure of values.filter(item => item.status === 'rejected')) errorIs('IMAGE_BUSY')(failure.reason);
  await entered.promise;
  assert.equal(f.state.calls.length, 1);
  gate.resolve();
});

test('concurrent reservation enforces two global backend calls', async t => {
  const gate = defer(), entered = defer();
  let calls = 0;
  const f = await fixture(t, { release: gate.resolve, generate: async request => { if (++calls === 2) entered.resolve(); await gate.promise; await fs.writeFile(request.path, PNG); } });
  const values = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => f.service.start({ ...REQUEST, key: `group:${index + 1}` }, allow)));
  assert.equal(values.filter(item => item.status === 'fulfilled').length, 2);
  assert.equal(values.filter(item => item.status === 'rejected' && item.reason.code === 'IMAGE_BUSY').length, 3);
  await entered.promise;
  assert.equal(f.state.calls.length, 2);
  gate.resolve();
});

test('failed paid attempts count per-key quota across tokens and restart, errors stay sanitized', async t => {
  const raw = `provider failure path=/private/provider/key.json password=${SECRET}`;
  const f = await fixture(t, { config: { cooldownMs: 0 }, generate: async () => { const error = new Error(raw); error.code = raw; throw error; } });
  for (let i = 0; i < 3; i++) {
    const started = await f.service.start({ ...REQUEST, prompt: `attempt ${i}` }, allow);
    const result = await done(f.service, started);
    assert.equal(result.status, 'failed');
    errorIs('IMAGE_GENERATION_FAILED')(result);
    assert.equal(JSON.stringify(result).includes('/private/'), false);
  }
  await fails(f.service.start({ ...REQUEST, token: 'rotated-fixture-token', prompt: 'fourth' }, allow), 'IMAGE_DAILY_LIMIT');
  await f.service.close();
  await fails(f.create().start({ ...REQUEST, prompt: 'after restart' }, allow), 'IMAGE_DAILY_LIMIT');
  assert.equal(f.state.calls.length, 3);
});

test('global quota resets only on the next local day, including a backward clock', async t => {
  const f = await fixture(t, { config: { dailyGlobal: 2, cooldownMs: 0 } });
  f.state.stamp = new Date(2026, 10, 12, 23, 59, 59).getTime();
  await ready(f.service);
  await ready(f.service, { ...REQUEST, key: 'private:2' });
  await fails(f.service.start({ ...REQUEST, key: 'private:3' }, allow), 'IMAGE_DAILY_LIMIT');
  f.state.stamp -= 86400000;
  await fails(f.service.start({ ...REQUEST, key: 'private:3' }, allow), 'IMAGE_DAILY_LIMIT');
  f.state.stamp = new Date(2026, 10, 13, 0, 0, 1).getTime();
  await ready(f.service, { ...REQUEST, key: 'private:3' });
});

test('cooldown survives failed generation and restart, boundary permits new attempt', async t => {
  const f = await fixture(t, { generate: async () => { throw new Error('provider unavailable'); } });
  const first = await f.service.start(REQUEST, allow);
  await done(f.service, first);
  await f.service.close();
  const resumed = f.create();
  f.state.stamp += 59999;
  await fails(resumed.start({ ...REQUEST, prompt: 'different' }, allow), 'IMAGE_COOLDOWN');
  f.state.stamp += 1;
  await resumed.start({ ...REQUEST, prompt: 'different' }, allow);
});

test('real process death recovers pending as failed without generation or quota reset', async t => {
  const f = await fixture(t);
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--crash-fixture', f.root, String(f.state.stamp)], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  const started = JSON.parse(child.stdout);
  const resumed = await f.service.result(owned(started), allow);
  errorIs('IMAGE_INTERRUPTED')(resumed);
  assert.equal(resumed.status, 'failed');
  assert.equal(f.state.calls.length, 0);
  f.state.cfg.dailyPerKey = 1;
  await fails(f.service.start({ ...REQUEST, prompt: 'new paid attempt' }, allow), 'IMAGE_DAILY_LIMIT');
});

test('a second service cannot reserve against a stale in-memory quota snapshot', async t => {
  const f = await fixture(t);
  await ready(f.service);
  await fails(f.create().start({ ...REQUEST, key: 'private:5' }, allow), 'IMAGE_STORAGE_BUSY');
  assert.equal(f.state.calls.length, 1);
});

test('blank auth, absent callback, invalid prompt/size and disabled config fail before backend', async t => {
  const f = await fixture(t);
  await fails(f.service.start(REQUEST), 'IMAGE_NOT_ALLOWED');
  await fails(f.service.start({ ...REQUEST, token: '' }, allow), 'IMAGE_NOT_ALLOWED');
  await fails(f.service.start({ ...REQUEST, key: '../outside' }, allow), 'IMAGE_NOT_ALLOWED');
  for (const prompt of ['', ' ', 'x'.repeat(2001), null]) await fails(f.service.start({ ...REQUEST, prompt }, allow), 'IMAGE_BAD_REQUEST');
  for (const size of ['auto', '../1024x1024', '2048x2048', null]) await fails(f.service.start({ ...REQUEST, size }, allow), 'IMAGE_BAD_REQUEST');
  await fails(f.service.start(REQUEST, { assertAllowed: () => ({ ok: false, error: SECRET }) }), 'IMAGE_NOT_ALLOWED');
  f.state.cfg = {};
  await fails(f.service.start(REQUEST, allow), 'IMAGE_DISABLED');
  assert.equal(f.state.calls.length, 0);
  await assert.rejects(fs.stat(f.root), { code: 'ENOENT' });
});

test('ownership is bound to both key and token and rejects path-shaped IDs', async t => {
  const f = await fixture(t);
  const started = await ready(f.service);
  for (const input of [owned(started, { key: 'private:123' }), owned(started, { token: 'different-token' }), owned(started, { imageId: '../ledger.json' })]) {
    await fails(f.service.result(input, allow), 'IMAGE_NOT_FOUND');
    await fails(f.service.readReady(input), 'IMAGE_NOT_FOUND');
    await fails(f.service.recordSending(input), 'IMAGE_NOT_FOUND');
    await fails(f.service.recordSent(input, 1), 'IMAGE_NOT_FOUND');
  }
});

test('authorization invalidated before backend prevents any provider call', async t => {
  let checks = 0;
  const f = await fixture(t);
  const started = await f.service.start(REQUEST, { assertAllowed: () => ++checks < 2 });
  errorIs('IMAGE_NOT_ALLOWED')(await done(f.service, started));
  assert.equal(f.state.calls.length, 0);
});

test('authorization invalidated by completion cannot promote the file to ready', async t => {
  let allowed = true;
  const f = await fixture(t, { generate: async request => { await fs.writeFile(request.path, PNG); allowed = false; } });
  const started = await f.service.start(REQUEST, { assertAllowed: () => { if (!allowed) throw new Error(SECRET); } });
  errorIs('IMAGE_NOT_ALLOWED')(await done(f.service, started));
  await fails(f.service.readReady(owned(started)), 'IMAGE_NOT_READY');
});

test('result checks current authorization again after its wait', async t => {
  const gate = defer(), inspected = defer();
  const f = await fixture(t, { release: gate.resolve, generate: async request => { await gate.promise; await fs.writeFile(request.path, PNG); } });
  const started = await f.service.start(REQUEST, allow);
  let allowed = true;
  const waiting = f.service.result(owned(started), { waitMs: 2000, assertAllowed: () => { inspected.resolve(); return allowed; } });
  const rejection = fails(waiting, 'IMAGE_NOT_ALLOWED');
  await inspected.promise;
  allowed = false;
  gate.resolve();
  await rejection;
});

test('feature disabled mid-flight blocks readiness and access', async t => {
  const f = await fixture(t, { generate: async (request, context, state) => { await fs.writeFile(request.path, PNG); state.cfg.enabled = false; } });
  const started = await f.service.start(REQUEST, allow);
  await fails(done(f.service, started), 'IMAGE_DISABLED');
  f.state.cfg.enabled = true;
  errorIs('IMAGE_DISABLED')(await done(f.service, started));
  await fails(f.service.readReady(owned(started)), 'IMAGE_NOT_READY');
});

test('TTL makes assets inert without deleting files and stops reads and sends', async t => {
  const f = await fixture(t, { config: { retentionMs: 1000, cooldownMs: 0 } });
  const started = await ready(f.service);
  f.state.stamp += 1000;
  await fails(f.service.result(owned(started), allow), 'IMAGE_EXPIRED');
  await fails(f.service.readReady(owned(started)), 'IMAGE_EXPIRED');
  await fails(f.service.recordSent(owned(started), 12), 'IMAGE_EXPIRED');
  assert.deepEqual(await fs.readFile(f.state.calls[0].path), PNG);
  const next = await f.service.start(REQUEST, allow);
  assert.notEqual(next.imageId, started.imageId);
});

test('expired/failed entries still bound total storage with no automatic deletion', async t => {
  const f = await fixture(t, { config: { maxEntries: 1, retentionMs: 1, cooldownMs: 0 } });
  const started = await ready(f.service);
  f.state.stamp += 86400000;
  await fails(f.service.start({ ...REQUEST, prompt: 'after expiration' }, allow), 'IMAGE_STORAGE_FULL');
  assert.deepEqual(await fs.readFile(path.join(f.root, started.imageId, 'image.png')), PNG);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'ledger.json'), 'utf8')).entries.length, 1);
});

test('valid PNG, JPEG, WebP signatures return exact bytes and actual MIME', async t => {
  for (const [buffer, mimeType] of [[PNG, 'image/png'], [JPEG, 'image/jpeg'], [WEBP, 'image/webp']]) {
    await t.test(mimeType, async child => {
      const f = await fixture(child, { generate: request => fs.writeFile(request.path, buffer) });
      const started = await ready(f.service);
      assert.deepEqual(await f.service.readReady(owned(started)), { buffer, mimeType });
    });
  }
});

test('nonimages, incomplete signatures and malformed structures are rejected', async t => {
  for (const [name, content] of [['html', Buffer.from('<html>password=hidden</html>')], ['svg', Buffer.from('<svg/>')], ['png header', PNG.subarray(0, 8)], ['truncated png', PNG.subarray(0, -1)], ['jpeg prefix', Buffer.from([255, 216, 255, 217])], ['truncated webp', WEBP.subarray(0, -1)]]) {
    await t.test(name, async child => {
      const f = await fixture(child, { generate: request => fs.writeFile(request.path, content) });
      const started = await f.service.start(REQUEST, allow);
      errorIs('IMAGE_INVALID_CONTENT')(await done(f.service, started));
    });
  }
});

test('byte caps apply before allocation and apply again if settings are tightened', async t => {
  const f = await fixture(t, { config: { maxBytes: PNG.length - 1 } });
  const started = await f.service.start(REQUEST, allow);
  errorIs('IMAGE_TOO_LARGE')(await done(f.service, started));
  f.state.cfg.maxBytes = 10485760;
  const second = await ready(f.service, { ...REQUEST, key: 'private:7' });
  f.state.cfg.maxBytes = 1;
  await fails(f.service.readReady(owned(second, { key: 'private:7' })), 'IMAGE_TOO_LARGE');
});

test('same-length valid image modification is detected by the original SHA256', async t => {
  const f = await fixture(t);
  const started = await ready(f.service);
  const changed = Buffer.from(PNG);
  changed[changed.length - 13] ^= 1; // IDAT CRC byte: structural signature is unchanged.
  await fs.writeFile(f.state.calls[0].path, changed);
  await fails(f.service.readReady(owned(started)), 'IMAGE_TAMPERED');
});

test('file replacement between open and read is rejected even for identical bytes', async t => {
  const f = await fixture(t);
  const started = await ready(f.service), target = f.state.calls[0].path, original = fs.open;
  fs.open = async (...args) => {
    const handle = await original(...args);
    if (args[0] === target) {
      await fs.rename(target, `${target}.old`);
      await fs.writeFile(target, PNG);
    }
    return handle;
  };
  try { await fails(f.service.readReady(owned(started)), 'IMAGE_TAMPERED'); }
  finally { fs.open = original; }
});

test('file symlink output cannot expose unrelated image bytes', async t => {
  const f = await fixture(t, { generate: async request => fs.symlink(path.join(f.base, 'outside.png'), request.path, 'file') });
  if (!await fileLinksAvailable(t, f.base)) return;
  await fs.writeFile(path.join(f.base, 'outside.png'), PNG);
  const started = await f.service.start(REQUEST, allow);
  errorIs('IMAGE_UNSAFE_FILE')(await done(f.service, started));
});

test('hard-link output is rejected without touching the original file', async t => {
  const f = await fixture(t, { generate: async request => fs.link(path.join(f.base, 'outside.png'), request.path) });
  await fs.writeFile(path.join(f.base, 'outside.png'), PNG);
  const started = await f.service.start(REQUEST, allow);
  errorIs('IMAGE_UNSAFE_FILE')(await done(f.service, started));
  assert.deepEqual(await fs.readFile(path.join(f.base, 'outside.png')), PNG);
});

test('root and ancestor junctions are refused before generation', async t => {
  const f = await fixture(t);
  const outside = path.join(f.base, 'outside'), link = path.join(f.base, 'junction');
  await fs.mkdir(outside);
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  for (const root of [link, path.join(link, 'nested')]) await fails(f.create({ root }).start(REQUEST, allow), 'IMAGE_UNSAFE_PATH');
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal(f.state.calls.length, 0);
});

test('provider-replaced entry junction is rejected after generation', async t => {
  const f = await fixture(t, { generate: async request => {
    const dir = path.dirname(request.path), outside = path.join(f.base, 'outside');
    await fs.rename(dir, `${dir}-original`);
    await fs.symlink(outside, dir, process.platform === 'win32' ? 'junction' : 'dir');
  } });
  await fs.mkdir(path.join(f.base, 'outside'));
  await fs.writeFile(path.join(f.base, 'outside', 'image.png'), PNG);
  const started = await f.service.start(REQUEST, allow);
  errorIs('IMAGE_UNSAFE_PATH')(await done(f.service, started));
});

test('a replaced root directory invalidates all subsequent reads', async t => {
  const f = await fixture(t);
  const started = await ready(f.service);
  await fs.rename(f.root, `${f.root}-original`);
  await fs.mkdir(f.root);
  await fails(f.service.readReady(owned(started)), 'IMAGE_UNSAFE_PATH');
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('a directory output and backend-selected alternate file path are rejected', async t => {
  await t.test('directory', async child => {
    const f = await fixture(child, { generate: request => fs.mkdir(request.path) });
    errorIs('IMAGE_UNSAFE_FILE')(await done(f.service, await f.service.start(REQUEST, allow)));
  });
  await t.test('alternate path', async child => {
    const f = await fixture(child, { generate: async () => ({ path: '/private/provider/credentials.png', token: SECRET }) });
    const result = await done(f.service, await f.service.start(REQUEST, allow));
    errorIs('IMAGE_OUTPUT_MISSING')(result);
    assert.equal(JSON.stringify(result).includes('/private/'), false);
  });
});

test('invalid ledger fails closed without overwriting or resetting attempts', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.root);
  await fs.writeFile(path.join(f.root, 'ledger.json'), '{broken-private-data');
  await fails(f.service.start(REQUEST, allow), 'IMAGE_STATE_INVALID');
  assert.equal(await fs.readFile(path.join(f.root, 'ledger.json'), 'utf8'), '{broken-private-data');
  assert.equal(f.state.calls.length, 0);
});

test('unfinished ledger staging file cannot be silently overwritten on restart', async t => {
  const f = await fixture(t);
  await ready(f.service);
  await f.service.close();
  await fs.writeFile(path.join(f.root, 'ledger.next'), 'interrupted write');
  await fails(f.create().start({ ...REQUEST, key: 'private:9' }, allow), 'IMAGE_STORAGE');
  assert.equal(await fs.readFile(path.join(f.root, 'ledger.next'), 'utf8'), 'interrupted write');
});

test('timeout aborts generation, preserves budget and keeps an ignored-abort backend slot', async t => {
  const gate = defer(), entered = defer(), completed = defer();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t, { config: { generationTimeoutMs: 10, cooldownMs: 0 }, release: gate.resolve, generate: async request => {
    entered.resolve();
    await gate.promise;
    await fs.writeFile(request.path, PNG);
    completed.resolve();
  } });
  const started = await f.service.start(REQUEST, allow);
  await entered.promise;
  t.mock.timers.tick(10);
  errorIs('IMAGE_TIMEOUT')(await done(f.service, started));
  assert.equal(f.state.calls[0].signal.aborted, true);
  await fails(f.service.start({ ...REQUEST, prompt: 'retry while backend stuck' }, allow), 'IMAGE_BUSY');
  gate.resolve();
  await completed.promise;
  await tick();
  errorIs('IMAGE_TIMEOUT')(await done(f.service, started));
  await fails(f.service.readReady(owned(started)), 'IMAGE_NOT_READY');
});

test('close cancels in-flight generation and does not launch queued work afterwards', async t => {
  const entered = defer();
  const f = await fixture(t, { generate: (request, { signal }) => new Promise((resolve, reject) => {
    entered.resolve();
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  const started = await f.service.start(REQUEST, allow);
  await entered.promise;
  await f.service.close();
  await tick();
  assert.equal(f.state.calls[0].signal.aborted, true);
  await fails(f.service.start({ ...REQUEST, key: 'private:10' }, allow), 'IMAGE_CLOSED');
  errorIs('IMAGE_INTERRUPTED')(await f.create().result(owned(started), allow));
});

test('send claim is atomic; ambiguous failure never grants another automatic send', async t => {
  const f = await fixture(t);
  const started = await ready(f.service), input = owned(started);
  const claims = await Promise.all([f.service.recordSending(input), f.service.recordSending(input)]);
  assert.deepEqual(claims.map(item => item.claimed).sort(), [false, true]);
  assert.equal((await done(f.service, started)).delivery.status, 'sending');
  assert.equal((await f.service.recordSendFailed(input)).delivery.status, 'unknown');
  assert.equal((await f.service.recordSending(input)).claimed, false);
  const sent = await f.service.recordSent(input, -1234);
  assert.deepEqual(sent.sent, { messageId: -1234 });
  assert.deepEqual(sent.delivery, { status: 'sent', messageId: -1234 });
  assert.equal((await f.service.recordSent(input, 999)).sent.messageId, -1234);
  assert.equal((await f.service.recordSending(input)).claimed, false);
  await fails(f.service.recordSent(input, SECRET), 'IMAGE_BAD_REQUEST');
  await f.service.close();
  assert.deepEqual((await f.create().result(input, allow)).sent, { messageId: -1234 });
});

test('a persisted sending marker recovers as unknown and cannot be reclaimed', async t => {
  const f = await fixture(t);
  const started = await ready(f.service), input = owned(started);
  assert.equal((await f.service.recordSending(input)).claimed, true);
  await f.service.close();
  const resumed = f.create();
  assert.equal((await resumed.result(input, allow)).delivery.status, 'unknown');
  assert.equal((await resumed.recordSending(input)).claimed, false);
});

test('config callbacks and constructor validation expose only stable safe errors', async t => {
  const f = await fixture(t);
  for (const root of ['relative/path', path.parse(f.root).root, `${f.root}/../escape`]) assert.throws(() => f.create({ root }), errorIs('IMAGE_UNSAFE_PATH'));
  await fails(f.create({ getConfig: () => { throw new Error(SECRET); } }).start(REQUEST, allow), 'IMAGE_CONFIG');
  await fails(f.create({ getConfig: async () => ({ enabled: true }) }).start(REQUEST, allow), 'IMAGE_CONFIG');
  await fails(f.create({ now: () => NaN }).start(REQUEST, allow), 'IMAGE_CONFIG');
});

test('adapter callback rechecks auth immediately before a paid call after discovery', async t => {
  const gate = defer(), discovered = defer();
  let allowed = true, paidCalls = 0;
  const f = await fixture(t, { release: gate.resolve, generate: async (request, context) => {
    assert.equal(typeof context.assertAllowed, 'function');
    discovered.resolve();
    await gate.promise;
    await context.assertAllowed();
    paidCalls++;
    await fs.writeFile(request.path, PNG);
  } });
  const started = await f.service.start(REQUEST, { assertAllowed: () => allowed });
  await discovered.promise;
  allowed = false;
  gate.resolve();
  errorIs('IMAGE_NOT_ALLOWED')(await done(f.service, started));
  assert.equal(paidCalls, 0);
});

test('adapter callback rechecks feature enablement immediately before a paid call', async t => {
  const gate = defer(), discovered = defer();
  let paidCalls = 0;
  const f = await fixture(t, { release: gate.resolve, generate: async (request, context) => {
    discovered.resolve();
    await gate.promise;
    await context.assertAllowed();
    paidCalls++;
    await fs.writeFile(request.path, PNG);
  } });
  const started = await f.service.start(REQUEST, allow);
  await discovered.promise;
  f.state.cfg.enabled = false;
  gate.resolve();
  await fails(done(f.service, started), 'IMAGE_DISABLED');
  await tick();
  f.state.cfg.enabled = true;
  errorIs('IMAGE_DISABLED')(await done(f.service, started));
  assert.equal(paidCalls, 0);
});

test('adapter pre-paid guard accepts the unchanged empty output directory', async t => {
  let paidCalls = 0;
  const f = await fixture(t, { generate: async (request, context) => {
    await context.assertAllowed();
    paidCalls++;
    await fs.writeFile(request.path, PNG);
  } });
  const started = await ready(f.service);
  assert.equal(paidCalls, 1);
  assert.deepEqual((await f.service.readReady(owned(started))).buffer, PNG);
});

test('discovery-time directory swaps stop before the paid call', async t => {
  for (const attack of ['junction', 'replacement']) await t.test(attack, async child => {
    const gate = defer(), discovered = defer();
    let paidCalls = 0;
    const f = await fixture(child, { release: gate.resolve, generate: async (request, context) => {
      discovered.resolve();
      await gate.promise;
      await context.assertAllowed();
      paidCalls++;
      await fs.writeFile(request.path, PNG);
    } });
    const outside = path.join(f.base, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'keep.txt'), 'user data stays unchanged');
    const started = await f.service.start(REQUEST, allow);
    await discovered.promise;
    const directory = path.dirname(f.state.calls[0].path);
    await fs.rename(directory, `${directory}-original`);
    if (attack === 'junction') await fs.symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
    else await fs.mkdir(directory);
    gate.resolve();
    errorIs('IMAGE_UNSAFE_PATH')(await done(f.service, started));
    assert.equal(paidCalls, 0);
    assert.deepEqual(await fs.readdir(outside), ['keep.txt']);
    assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'user data stays unchanged');
    if (attack === 'replacement') assert.deepEqual(await fs.readdir(directory), []);
  });
});

test('discovery-time output candidates are refused before payment or overwriting', async t => {
  const attacks = ['image.png', 'image.jpg', 'image.jpeg', 'image.webp', 'hard-link', 'directory'];
  for (const attack of attacks) await t.test(attack, async child => {
    const gate = defer(), discovered = defer();
    let paidCalls = 0;
    const f = await fixture(child, { release: gate.resolve, generate: async (request, context) => {
      discovered.resolve();
      await gate.promise;
      await context.assertAllowed();
      paidCalls++;
      await fs.writeFile(request.path, PNG);
    } });
    const started = await f.service.start(REQUEST, allow);
    await discovered.promise;
    const directory = path.dirname(f.state.calls[0].path);
    const candidate = path.join(directory, attack.startsWith('image.') ? attack : 'image.png');
    const sentinel = Buffer.from('existing user content must not be overwritten');
    if (attack === 'hard-link') {
      const source = path.join(f.base, 'outside.png');
      await fs.writeFile(source, sentinel);
      await fs.link(source, candidate);
    } else if (attack === 'directory') await fs.mkdir(candidate);
    else await fs.writeFile(candidate, sentinel);
    gate.resolve();
    errorIs('IMAGE_UNSAFE_FILE')(await done(f.service, started));
    assert.equal(paidCalls, 0);
    if (attack === 'directory') assert.deepEqual(await fs.readdir(candidate), []);
    else assert.deepEqual(await fs.readFile(candidate), sentinel);
    if (attack === 'hard-link') assert.deepEqual(await fs.readFile(path.join(f.base, 'outside.png')), sentinel);
  });
});

test('adapter guard rechecks shutdown after an asynchronous authorization callback', async t => {
  const gate = defer(), checking = defer(), adapterDone = defer();
  let inAdapter = false, paidCalls = 0, deniedCode;
  const f = await fixture(t, { release: gate.resolve, generate: async (request, context) => {
    inAdapter = true;
    try {
      await context.assertAllowed();
      paidCalls++;
      await fs.writeFile(request.path, PNG);
    } catch (error) { deniedCode = error.code; throw error; }
    finally { adapterDone.resolve(); }
  } });
  await f.service.start(REQUEST, { assertAllowed: async () => {
    if (inAdapter) { checking.resolve(); await gate.promise; }
  } });
  await checking.promise;
  await f.service.close();
  gate.resolve();
  await adapterDone.promise;
  assert.equal(deniedCode, 'IMAGE_CLOSED');
  assert.equal(paidCalls, 0);
});

test('persisted delivery metadata cannot add paths or secrets to public results', async t => {
  const f = await fixture(t);
  const started = await ready(f.service);
  await f.service.recordSent(owned(started), '987');
  await f.service.close();
  const ledger = path.join(f.root, 'ledger.json');
  const state = JSON.parse(await fs.readFile(ledger, 'utf8'));
  Object.assign(state.entries[0].delivery, { token: SECRET, path: f.root });
  await fs.writeFile(ledger, JSON.stringify(state));
  const resumed = f.create();
  const result = await done(resumed, started);
  assert.deepEqual(result.delivery, { status: 'sent', messageId: '987' });
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(JSON.stringify(result).includes(f.root), false);
});

test('adapter error code allowlist preserves actionable hints but never raw exceptions', async t => {
  for (const code of ['IMAGE_BACKEND_UNAVAILABLE', 'IMAGE_BACKEND_FAILED', 'IMAGE_BACKEND_INCOMPATIBLE', 'IMAGE_NOT_ALLOWED', 'unknown-provider-error']) {
    await t.test(code, async child => {
      const f = await fixture(child, { generate: async () => { throw Object.assign(new Error(`/private/provider/credentials ${SECRET}`), { code, hint: SECRET, statusCode: 599 }); } });
      const result = await done(f.service, await f.service.start(REQUEST, allow));
      const expected = code.startsWith('IMAGE_BACKEND_') ? code : 'IMAGE_GENERATION_FAILED';
      errorIs(expected)(result);
      assert.equal(JSON.stringify(result).includes('/private/provider'), false);
      assert.equal(result.statusCode === 599, false);
      assert.match(result.hint, /[\u4e00-\u9fff]/);
    });
  }
});
