import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createOwnerDesktopConversationStore } from '../lib/owner-desktop-conversation-store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'surf-desktop-conversations-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const PREFIX = 'owner-desktop.conversation-store-';
const MAX_BYTES = 2 * 1024 * 1024;
const identity = Object.freeze({ conversationKey: 'private:42', ownerQQ: '42', selfUserId: '88', sourceSessionId: 'qq-source' });
const record = (id = 'desktop-1', overrides = {}) => ({ ...identity, sessionId: id, ...overrides });
function fixture(maxSessions = 10000) {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  const file = path.join(dir, 'nested', 'conversations.json');
  const options = { file, maxSessions };
  return { dir, file, options, store: createOwnerDesktopConversationStore(options) };
}
function visible(suffix) {
  return error => error.code === PREFIX + suffix && error.ok === false
    && typeof error.message === 'string' && Boolean(error.message) && typeof error.hint === 'string' && Boolean(error.hint);
}
function assertClosed(f, suffix = 'unreadable') {
  for (const store of [f.store, createOwnerDesktopConversationStore(f.options)]) {
    assert.throws(() => store.list(), visible(suffix));
    assert.throws(() => store.find(identity), visible(suffix));
    assert.throws(() => store.isSession('desktop-1'), visible(suffix));
    assert.throws(() => store.isSession('unknown'), visible(suffix));
    assert.throws(() => store.reserve(record('next')), visible(suffix));
    assert.throws(() => store.confirm('desktop-1'), visible(suffix));
    const status = store.status();
    assert.equal(status.ok, false);
    assert.equal(status.code, PREFIX + suffix);
    assert.ok(status.error && status.hint);
    assert.equal(Object.hasOwn(status, 'count'), false, 'failure must not look like an empty catalog');
  }
}
function seed(f, sessions) {
  fs.mkdirSync(path.dirname(f.file), { recursive: true });
  fs.writeFileSync(f.file + '.initialized', '1\n');
  fs.writeFileSync(f.file, JSON.stringify({ version: 1, sessions }) + '\n');
}

test('fresh read-only catalog does not create directories, marker, lock or authority', () => {
  const f = fixture();
  assert.deepEqual(Object.keys(f.store).sort(), ['confirm', 'find', 'isSession', 'list', 'reserve', 'status']);
  assert.deepEqual(f.store.status(), { ok: true, initialized: false, count: 0, reserved: 0, ready: 0, maxSessions: 10000 });
  assert.deepEqual(f.store.list(), []);
  assert.equal(f.store.find(identity), null);
  assert.equal(f.store.isSession('desktop-1'), false);
  assert.deepEqual(fs.readdirSync(f.dir), []);
});

test('reservation precedes host creation, remains deny-only until explicit confirmation', () => {
  const f = fixture();
  assert.equal(f.store.reserve(record()), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')).sessions, [{ ...record(), phase: 'reserved' }]);
  assert.equal(fs.readFileSync(f.file + '.initialized', 'utf8'), '1\n');
  assert.equal(f.store.isSession('desktop-1'), true);
  assert.equal(f.store.find(identity), null);
  const restarted = createOwnerDesktopConversationStore(f.options);
  assert.equal(restarted.isSession('desktop-1'), true);
  assert.equal(restarted.find(identity), null);
  assert.equal(restarted.confirm('desktop-1'), true);
  assert.deepEqual(f.store.find(identity), { ...record(), phase: 'ready' });
  assert.deepEqual(f.store.status(), { ok: true, initialized: true, count: 1, reserved: 0, ready: 1, maxSessions: 10000 });
});

test('each exact identity component prevents cross-binding and latest ready ignores reservations', () => {
  const f = fixture();
  f.store.reserve(record('old')); f.store.confirm('old');
  for (const [key, value] of Object.entries({ conversationKey: 'group:42', ownerQQ: '43', selfUserId: '89', sourceSessionId: 'qq-other' })) {
    const other = { ...identity, [key]: value };
    assert.equal(f.store.find(other), null, key);
    f.store.reserve({ ...other, sessionId: 'other-' + key });
    f.store.confirm('other-' + key);
    assert.equal(f.store.find(other).sessionId, 'other-' + key);
    assert.equal(f.store.find(identity).sessionId, 'old');
  }
  f.store.reserve(record('new'));
  assert.equal(f.store.find(identity).sessionId, 'old');
  f.store.confirm('new');
  f.store.reserve(record('abandoned'));
  assert.equal(f.store.find(identity).sessionId, 'new');
  assert.equal(f.store.isSession('abandoned'), true);
  assert.equal(createOwnerDesktopConversationStore(f.options).find(identity).sessionId, 'new');
});

test('latest is reservation order even when older receipts arrive late', () => {
  const f = fixture();
  f.store.reserve(record('old')); f.store.reserve(record('new'));
  f.store.confirm('new'); f.store.confirm('old');
  assert.equal(f.store.find(identity).sessionId, 'new');
});

test('exact duplicate reservation/confirmation is idempotent and never downgrades ready', () => {
  const f = fixture(1);
  f.store.reserve(record());
  const reserved = fs.readFileSync(f.file, 'utf8');
  assert.equal(f.store.reserve(record()), true);
  assert.equal(fs.readFileSync(f.file, 'utf8'), reserved);
  f.store.confirm('desktop-1');
  const ready = fs.readFileSync(f.file, 'utf8');
  assert.equal(f.store.reserve(record()), true);
  assert.equal(f.store.confirm('desktop-1'), true);
  assert.equal(fs.readFileSync(f.file, 'utf8'), ready);
  assert.equal(f.store.find(identity).phase, 'ready');
});

test('session collision with another identity or source cannot overwrite provenance', () => {
  const f = fixture(); f.store.reserve(record());
  const before = fs.readFileSync(f.file, 'utf8');
  for (const overrides of [{ ownerQQ: '43' }, { selfUserId: '89' }, { sourceSessionId: 'other' }, { conversationKey: 'group:7' }])
    assert.throws(() => f.store.reserve(record('desktop-1', overrides)), visible('conflict'));
  assert.throws(() => f.store.reserve(record('qq-source', { sourceSessionId: 'elsewhere' })), visible('conflict'));
  assert.throws(() => f.store.reserve(record('new', { sourceSessionId: 'desktop-1' })), visible('conflict'));
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});

test('all returned rows are detached and supplied records cannot mutate persistence', () => {
  const f = fixture(); const supplied = record();
  f.store.reserve(supplied); supplied.ownerQQ = '43'; f.store.confirm('desktop-1');
  const rows = f.store.list(); rows[0].ownerQQ = '44'; rows[0].phase = 'reserved'; rows.push(record('fake'));
  const found = f.store.find(identity); found.sessionId = 'fake'; found.phase = 'reserved';
  assert.equal(f.store.list().length, 1);
  assert.deepEqual(f.store.find(identity), { ...record(), phase: 'ready' });
  assert.equal(f.store.isSession('fake'), false);
});

test('identity validation accepts canonical positive QQ only and rejects extra content', () => {
  const f = fixture();
  for (const value of [0, -1, false, null, undefined, '', '0', '01', '+42', ' 42', '42 ', '1.2', '1e3', 1.2, Number.MAX_SAFE_INTEGER + 1, {}, []]) {
    assert.throws(() => f.store.reserve(record('valid', { ownerQQ: value })), visible('identity-invalid'));
    assert.throws(() => f.store.find({ ...identity, selfUserId: value }), visible('identity-invalid'));
  }
  for (const conversationKey of ['private:0', 'private:01', 'group:-2', 'p:42', 'private:42\n', 'private:42:88', null])
    assert.throws(() => f.store.reserve(record('valid', { conversationKey })), visible('identity-invalid'));
  for (const id of ['', '../target', 'a/b', 'a\\b', 'bad\0id', 'x'.repeat(161), 1, null]) {
    assert.throws(() => f.store.reserve(record(id)), visible('identity-invalid'));
    assert.throws(() => f.store.reserve(record('valid', { sourceSessionId: id })), visible('identity-invalid'));
    assert.throws(() => f.store.isSession(id), visible('identity-invalid'));
    assert.throws(() => f.store.confirm(id), visible('identity-invalid'));
  }
  assert.throws(() => f.store.reserve(record('qq-source')), visible('identity-invalid'));
  for (const key of ['command', 'persona', 'token', 'phase'])
    assert.throws(() => f.store.reserve({ ...record(), [key]: 'must-not-persist' }), visible('identity-invalid'));
  assert.throws(() => f.store.find(record()), visible('identity-invalid'));
  assert.deepEqual(fs.readdirSync(f.dir), []);
  f.store.reserve(record('valid', { ownerQQ: 42, selfUserId: 88 })); f.store.confirm('valid');
  assert.equal(f.store.find({ ...identity, ownerQQ: 42, selfUserId: 88 }).ownerQQ, '42');
  assert.deepEqual(Object.keys(f.store.list()[0]).sort(), ['conversationKey', 'ownerQQ', 'phase', 'selfUserId', 'sessionId', 'sourceSessionId']);
});

test('invalid factory options and unreserved confirmation fail with actionable errors', () => {
  for (const options of [{}, { file: '' }, { file: null }, { file: 'bad\0path' }, ...[0, -1, 10001, 1.5, '2', null].map(maxSessions => ({ file: 'unused', maxSessions }))])
    assert.throws(() => createOwnerDesktopConversationStore(options), visible('options-invalid'));
  const f = fixture();
  assert.throws(() => f.store.confirm('unknown'), visible('not-found'));
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(fs.existsSync(f.file + '.initialized'), false);
});

test('lost catalog is detected after restart by the durable initialized marker', () => {
  const f = fixture(); f.store.reserve(record()); f.store.confirm('desktop-1');
  fs.renameSync(f.file, f.file + '.quarantined');
  assertClosed(f);
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(fs.existsSync(f.file + '.quarantined'), true);
});

test('missing/corrupt marker, marker-only crash and markerless catalog all fail closed', () => {
  for (const mode of ['missing', 'corrupt', 'marker-only', 'catalog-only']) {
    const f = fixture(); f.store.reserve(record());
    if (mode === 'missing' || mode === 'catalog-only') fs.renameSync(f.file + '.initialized', f.file + '.marker-quarantined');
    if (mode === 'corrupt') fs.writeFileSync(f.file + '.initialized', '2\n');
    if (mode === 'marker-only') fs.renameSync(f.file, f.file + '.quarantined');
    assertClosed(f);
  }
});

test('corrupt schema, unknown fields, duplicate identities and oversized files are visible', () => {
  const row = { ...record(), phase: 'ready' };
  const malformed = [
    '{', '{}', JSON.stringify({ version: 2, sessions: [] }),
    JSON.stringify({ version: 1, sessions: [], command: 'unexpected' }),
    JSON.stringify({ version: 1, sessions: [row, row] }),
    ...[{ phase: 'active' }, { sessionId: '../bad' }, { sourceSessionId: 'desktop-1' }, { ownerQQ: 42 }, { token: 'unexpected' }].map(change => JSON.stringify({ version: 1, sessions: [{ ...row, ...change }] })),
    JSON.stringify({ version: 1, sessions: [row, { ...record('other', { sourceSessionId: 'desktop-1' }), phase: 'reserved' }] }),
    ' '.repeat(MAX_BYTES + 1),
  ];
  for (const text of malformed) {
    const f = fixture(); f.store.reserve(record()); fs.writeFileSync(f.file, text); assertClosed(f);
    assert.equal(fs.readFileSync(f.file, 'utf8'), text, 'failure cannot replace damaged evidence');
  }
});

test('observed invalid files cannot become fresh if both files disappear in the same process', () => {
  const f = fixture();
  fs.mkdirSync(path.dirname(f.file), { recursive: true });
  fs.writeFileSync(f.file + '.initialized', 'x'.repeat(17));
  assert.equal(f.store.status().ok, false);
  fs.renameSync(f.file + '.initialized', f.file + '.invalid-marker-quarantined');
  assert.throws(() => f.store.list(), visible('unreadable'));
  assert.throws(() => f.store.reserve(record()), visible('unreadable'));
  assert.equal(fs.existsSync(f.file), false);
});

test('same-size corruption with restored mtime is still read and rejected', () => {
  const f = fixture(); f.store.reserve(record()); f.store.confirm('desktop-1');
  const stat = fs.statSync(f.file); const raw = fs.readFileSync(f.file, 'utf8');
  fs.writeFileSync(f.file, raw.replace('ready', 'bogus')); fs.utimesSync(f.file, stat.atime, stat.mtime);
  assertClosed(f);
});

test('external lock closes reads and writes without deleting another process lock', () => {
  for (const initialized of [false, true]) {
    const f = fixture();
    if (initialized) f.store.reserve(record());
    fs.mkdirSync(path.dirname(f.file), { recursive: true }); fs.writeFileSync(f.file + '.lock', 'another-owner');
    assertClosed(f, 'locked');
    assert.equal(fs.readFileSync(f.file + '.lock', 'utf8'), 'another-owner');
    assert.equal(fs.existsSync(f.file), initialized);
  }
});

test('capacity never evicts abandoned reservations and still allows existing confirmation', () => {
  const f = fixture(2); f.store.reserve(record('first')); f.store.reserve(record('second'));
  const before = fs.readFileSync(f.file, 'utf8');
  assert.throws(() => f.store.reserve(record('overflow')), visible('full'));
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.equal(f.store.isSession('first'), true);
  assert.equal(f.store.find(identity), null);
  assert.equal(f.store.confirm('first'), true);
  assert.equal(f.store.reserve(record('first')), true);
  assert.equal(f.store.find(identity).sessionId, 'first');
});

test('2 MiB mutation limit rejects append without changing registered identities', () => {
  const f = fixture(); const rows = [];
  const make = index => ({ ...record('desktop-' + String(index).padStart(6, '0') + '-'.repeat(140), { sourceSessionId: 'source-' + 's'.repeat(150) }), phase: 'reserved' });
  let bytes = Buffer.byteLength(JSON.stringify({ version: 1, sessions: [] }) + '\n');
  for (let index = 0; ; index++) {
    const row = make(index); const delta = Buffer.byteLength(JSON.stringify(row)) + (index ? 1 : 0);
    if (bytes + delta > MAX_BYTES) break;
    rows.push(row); bytes += delta;
  }
  seed(f, rows);
  assert.ok(rows.length < 10000);
  const before = fs.readFileSync(f.file);
  const next = make(rows.length); delete next.phase;
  assert.throws(() => f.store.reserve(next), visible('full'));
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal(f.store.list().length, rows.length);
  assert.equal(f.store.isSession(rows[0].sessionId), true);
});

test('record count above configured limit is corrupt rather than silently truncated', () => {
  const f = fixture(1); seed(f, ['one', 'two'].map(id => ({ ...record(id), phase: 'reserved' })));
  assertClosed(f);
});

test('separate store instances reload under the writer lock without losing older rows', () => {
  const f = fixture(); const other = createOwnerDesktopConversationStore(f.options);
  assert.deepEqual(other.list(), []);
  f.store.reserve(record('one')); other.reserve(record('two')); f.store.reserve(record('three')); other.confirm('two');
  assert.deepEqual(f.store.list().map(row => row.sessionId), ['one', 'two', 'three']);
  assert.equal(f.store.find(identity).sessionId, 'two');
});

test('failed first rename leaves durable failure provenance and never permits reinitialization', t => {
  const f = fixture(); const original = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === f.file) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
    return original(source, destination);
  });
  assert.throws(() => f.store.reserve(record()), visible('write'));
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(f.file + '.initialized', 'utf8'), '1\n');
  assert.equal(fs.existsSync(f.file), false);
  assertClosed(f);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['conversations.json.initialized']);
});

test('failed confirmation cannot promote a reserved row or lose existing provenance', t => {
  const f = fixture(); f.store.reserve(record()); const before = fs.readFileSync(f.file, 'utf8');
  const original = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === f.file) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
    return original(source, destination);
  });
  assert.throws(() => f.store.confirm('desktop-1'), visible('write'));
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.equal(f.store.find(identity), null);
  assert.equal(f.store.isSession('desktop-1'), true);
});

test('CAS detects an uncooperative change before rename without replacing the newer catalog', t => {
  const f = fixture(); f.store.reserve(record());
  const original = fs.fsyncSync; let injected = false;
  const externallyUpdated = { version: 1, sessions: [{ ...record(), phase: 'reserved' }, { ...record('external'), phase: 'reserved' }] };
  t.mock.method(fs, 'fsyncSync', fd => {
    original(fd);
    if (!injected) { injected = true; fs.writeFileSync(f.file, JSON.stringify(externallyUpdated) + '\n'); }
  });
  assert.throws(() => f.store.reserve(record('next')), visible('changed'));
  t.mock.restoreAll();
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), externallyUpdated);
  assert.equal(f.store.isSession('external'), true);
  assert.equal(f.store.isSession('next'), false);
});

test('parallel processes preserve all committed reservations across lock contention', async () => {
  const f = fixture(); f.store.reserve(record('initial'));
  const moduleUrl = new URL('../lib/owner-desktop-conversation-store.js', import.meta.url).href;
  await Promise.all(Array.from({ length: 4 }, (_, worker) => new Promise((resolve, reject) => {
    const code = `import { createOwnerDesktopConversationStore } from ${JSON.stringify(moduleUrl)};
      const store = createOwnerDesktopConversationStore(${JSON.stringify(f.options)});
      for (let index=0;index<6;index++) {
        const row={...${JSON.stringify(identity)},sessionId:'child-${worker}-'+index};
        for(let attempt=0;;attempt++) {
          try { store.reserve(row); break; } catch(error) {
            if(error.code !== '${PREFIX}locked' || attempt>=200) throw error;
            await new Promise(resolve=>setTimeout(resolve,2));
          }
        }
      }`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('child failed: ' + stderr)));
  })));
  assert.equal(f.store.list().length, 25);
  assert.equal(f.store.status().reserved, 25);
  assert.equal(f.store.find(identity), null);
  for (let worker = 0; worker < 4; worker++) for (let index = 0; index < 6; index++)
    assert.equal(f.store.isSession(`child-${worker}-${index}`), true);
});
