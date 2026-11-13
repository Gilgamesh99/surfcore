// End-to-end offline coverage: inbox -> detail -> original -> command output.
// The same file can preload a strict fetch fixture into spawned read-only CLI commands.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const id = '1270031871116312601';
const originalId = '1262230883329376274';
const announcement = '《蓝色星原：旅谣》公测正式定档 11月26日！';
const rawItem = {
  id_str: id, type: 'DYNAMIC_TYPE_FORWARD', basic: { comment_id_str: id, comment_type: 17 },
  modules: { module_author: { name: 'Outer author', mid: 10001 }, module_dynamic: { desc: { text: '@Offline bot' } } },
  orig: { id_str: originalId, type: 'DYNAMIC_TYPE_DRAW', basic: { comment_id_str: '54321', comment_type: 11 }, modules: {
    module_author: { name: 'Original author', mid: 10002 },
    module_dynamic: { desc: null, major: { type: 'MAJOR_TYPE_OPUS', opus: { summary: { text: announcement, has_more: false }, pics: [{ url: 'https://i0.hdslb.com/bfs/new_dyn/offline.jpg' }] } } },
  } },
};
const notice = {
  id: '70001', at_time: Math.floor(Date.now() / 1000), user: { nickname: 'Outer author', mid: '10001' },
  item: { business_id: 17, subject_id: 1270031871116312601, uri: 'https://t.bilibili.com/' + id + '#reply444', root_id: '333', source_id: '444', source_content: '@Offline bot' },
};
const calls = [];
async function fixtureFetch(input, options = {}) {
  const url = new URL(String(input));
  calls.push(url.pathname);
  if (process.env.SURFCORE_FLOW_REQUEST_LOG) fs.appendFileSync(process.env.SURFCORE_FLOW_REQUEST_LOG, url.pathname + '\n');
  assert.equal(url.origin, 'https://api.bilibili.com');
  assert.equal(options.method ?? 'GET', 'GET', 'reading must never send a write request');
  assert.equal(options.body, undefined);
  if (process.env.SURFCORE_FLOW_GUEST === '1') assert.equal(new Headers(options.headers).has('cookie'), false, 'public inspection sends no synthetic cookie');
  let body;
  if (url.pathname === '/x/msgfeed/at') {
    const event = structuredClone(notice);
    if (process.env.SURFCORE_FLOW_UNKNOWN) event.item = { ...event.item, business_id: Number(process.env.SURFCORE_FLOW_UNKNOWN), uri: '', subject_id: process.env.SURFCORE_FLOW_UNKNOWN === '11' ? 54321 : 1270031871116312601 };
    body = { code: 0, data: { items: [event], cursor: '' } };
  }
  else if (url.pathname === '/x/msgfeed/reply') body = { code: 0, data: { items: [], cursor: '' } };
  else if (url.pathname === '/x/web-interface/nav') body = { code: process.env.SURFCORE_FLOW_GUEST === '1' ? -101 : 0, data: { wbi_img: {
    img_url: 'https://i0.hdslb.com/bfs/wbi/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
    sub_url: 'https://i0.hdslb.com/bfs/wbi/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png',
  } } };
  else if (url.pathname === '/x/polymer/web-dynamic/v1/detail') {
    assert.equal(url.searchParams.get('id'), id);
    assert.equal(url.searchParams.get('features'), 'itemOpusStyle');
    assert.ok(url.searchParams.get('w_rid'));
    body = process.env.SURFCORE_FLOW_RISK === '1' ? { code: -352, message: 'risk' } : process.env.SURFCORE_FLOW_LOGIN_REQUIRED === '1' ? { code: -101, message: 'login required' } : { code: 0, data: { item: rawItem } };
  } else throw new Error('Forbidden test request: ' + url.pathname);
  return Response.json(body);
}

if (process.env.SURFCORE_DYNAMIC_FLOW_FIXTURE === '1') {
  globalThis.fetch = fixtureFetch;
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-dynamic-flow-'));
  const saved = new Map();
  const realFetch = globalThis.fetch;
  const setEnv = (key, value) => { saved.set(key, process.env[key]); process.env[key] = value; };
  try {
    setEnv('DSH_HOME', tmp);
    setEnv('SURFCORE_BILI_CONFIG', path.join(tmp, 'bili.config.json'));
    const credentialFile = path.join(tmp, 'surfcore', 'bili', 'credentials.json');
    fs.mkdirSync(path.dirname(credentialFile), { recursive: true });
    fs.writeFileSync(credentialFile, JSON.stringify({ sessdata: 'OFFLINE_ONLY', bili_jct: 'OFFLINE_CSRF', buvid3: 'OFFLINE_DEVICE' }));
    globalThis.fetch = fixtureFetch;
    const { pullFeed } = await import('../tools/lib/msgfeed.mjs');
    const { readInboxDynamics, notificationDynamicId } = await import('../tools/lib/inbox-dynamics.mjs');
    const { createDynamicReader } = await import('../tools/lib/dynamic-reader.mjs');
    const feed = await pullFeed('at', { headers: {}, pages: 1 });
    assert.equal(feed.items[0].oid, id, 'URI preserves the 19-digit ID despite unsafe subject_id');
    const before = JSON.stringify(feed.items);
    const context = await readInboxDynamics([...feed.items, ...feed.items], { readDynamic: createDynamicReader({ fetchImpl: fixtureFetch }) });
    assert.equal(context.contexts.size, 1);
    assert.equal(context.contexts.get(id).result.item.original.id, originalId);
    assert.ok(context.text.includes(announcement));
    assert.match(context.text, /Original author/);
    assert.equal(calls.filter((p) => p.endsWith('/detail')).length, 1);
    assert.equal(JSON.stringify(feed.items), before, 'reading must not mutate reply coordinates');
    assert.equal(feed.items[0].root, '333');
    assert.equal(feed.items[0].parent, '444');
    assert.equal(notificationDynamicId({ business: 1, oid: '12345', uri: 'https://www.bilibili.com/video/BV1xx411c7mD/' }), '');
    assert.equal(notificationDynamicId({ business: 17, oid: 1270031871116312601 }), '');
    assert.equal(notificationDynamicId({ business: 11, oid: '54321' }), '', 'drawing reply resource IDs are not dynamic IDs');
    assert.equal(notificationDynamicId({ business: 11, oid: '54321', uri: 'https://www.bilibili.com/opus/' + originalId }), originalId);
    let extraReads = 0;
    const raw = await readInboxDynamics(feed.items, { raw: true, readDynamic: async () => { extraReads++; } });
    assert.equal(raw.text, '');
    assert.equal(extraReads, 0, '--raw must not resolve dynamic details');
    const budget = await readInboxDynamics([{ business: 17, oid: id, t: 1 }, { business: 17, oid: originalId, t: 2 }], {
      maxDynamics: 1, maxChars: 1200,
      readDynamic: async (requested) => { assert.equal(requested, originalId); return { ok: false, code: 'fixture.failed', error: '测试失败', hint: '重试 read-dynamic' }; },
    });
    assert.deepEqual(budget.skipped, [id], 'latest messages get limited read slots first');
    assert.match(budget.text, /fixture.failed/);
    assert.match(budget.text, /阅读预算/);
    assert.ok(budget.text.length <= 1200);
    const unresolved = await readInboxDynamics([{ business: 11, oid: '54321' }, { business: 17, oid: 1270031871116312601 }, { business: 1, oid: '12345' }], { readDynamic: async () => { throw new Error('unrecoverable IDs must never be requested'); } });
    assert.equal(unresolved.unresolved, 2);
    assert.equal(unresolved.contexts.size, 0);
    assert.match(unresolved.text, /原文未读取/);
    assert.match(unresolved.unreadNotice, /缺少可靠的链接或精确 ID/);
    const mixed = await readInboxDynamics([{ business: 11, oid: '54321' }, { business: 17, oid: id }], { maxChars: 1000, readDynamic: createDynamicReader({ fetchImpl: fixtureFetch }) });
    assert.ok(mixed.text.length <= 1000, 'unresolved notices also consume the total output budget');
    assert.match(mixed.text, /原文未读取/);
    const failure = await readInboxDynamics(feed.items, { readDynamic: async () => { throw new Error('private error must never print'); } });
    assert.match(failure.text, /dynamic.read-failed/);
    assert.doesNotMatch(failure.text, /private error/);

    const entry = fileURLToPath(new URL('../tools/bili.mjs', import.meta.url));
    const requestLog = path.join(tmp, 'requests.log');
    function command(args, extraEnv = {}) {
      fs.writeFileSync(requestLog, '');
      // File descriptors also work in Windows hosts where anonymous pipes return EPERM.
      const stdoutPath = path.join(tmp, 'stdout.txt');
      const stderrPath = path.join(tmp, 'stderr.txt');
      const output = [fs.openSync(stdoutPath, 'w'), fs.openSync(stderrPath, 'w')];
      let run;
      try {
        run = spawnSync(process.execPath, [entry, ...args], {
          stdio: ['ignore', ...output], timeout: 15000,
          env: { ...process.env, NODE_OPTIONS: '--import=' + import.meta.url, SURFCORE_DYNAMIC_FLOW_FIXTURE: '1', SURFCORE_FLOW_REQUEST_LOG: requestLog, ...extraEnv },
        });
      } finally { for (const fd of output) fs.closeSync(fd); }
      run.stdout = fs.readFileSync(stdoutPath, 'utf8');
      run.stderr = fs.readFileSync(stderrPath, 'utf8');
      assert.equal(run.error, undefined, String(run.error));
      assert.doesNotMatch(run.stdout + run.stderr, /OFFLINE_ONLY|OFFLINE_CSRF|OFFLINE_DEVICE/, 'credentials must never enter command output');
      const requests = fs.readFileSync(requestLog, 'utf8').trim().split('\n').filter(Boolean);
      assert.ok(requests.every((p) => ['/x/msgfeed/at', '/x/msgfeed/reply', '/x/web-interface/nav', '/x/polymer/web-dynamic/v1/detail'].includes(p)));
      return { ...run, requests };
    }
    for (const args of [['read-dynamic', id], ['check-dynamic', id], ['dynamic', 'check', '--id', id]]) {
      const run = command(args);
      assert.equal(run.status, 0, run.stderr + run.stdout);
      assert.ok(run.stdout.includes(announcement), args.join(' ') + ' must show the original');
      assert.match(run.stdout, /Original author/);
      assert.match(run.stdout, /转发原文/);
    }
    const digest = command(['comment-digest', '--hours', '24']);
    assert.equal(digest.status, 0, digest.stderr);
    assert.ok(digest.stdout.includes(announcement));
    assert.ok(digest.stdout.includes('type=17 oid=' + id + ' root=333 parent=444'));
    const rawDigest = command(['comment-digest', '--raw']);
    assert.equal(rawDigest.status, 0);
    assert.equal(rawDigest.requests.length, 2);
    assert.ok(!rawDigest.stdout.includes(announcement));
    const coordinatesOnly = command(['comment-digest', '--max-dynamics', '0']);
    assert.equal(coordinatesOnly.status, 0, coordinatesOnly.stderr);
    assert.equal(coordinatesOnly.requests.length, 2, 'the wake-up inbox command must not refetch already-enriched dynamic details');
    assert.ok(coordinatesOnly.stdout.includes('type=17 oid=' + id + ' root=333 parent=444'));
    for (const business of ['11', '17']) {
      const unknown = command(['comment-digest'], { SURFCORE_FLOW_UNKNOWN: business });
      assert.equal(unknown.status, 0, unknown.stderr);
      assert.match(unknown.stdout, /原文未读取/);
      assert.match(unknown.stdout, /复制完整动态链接/);
      assert.equal(unknown.requests.length, 2, 'missing exact IDs must not trigger guessed detail requests');
    }
    const json = command(['read-dynamic', '--id', id, '--json']);
    assert.equal(JSON.parse(json.stdout).item.original.text, announcement);
    const blocked = command(['read-dynamic', id, '--json'], { SURFCORE_FLOW_RISK: '1' });
    assert.equal(blocked.status, 4);
    const error = JSON.parse(blocked.stdout);
    assert.equal(error.ok, false);
    assert.ok(error.code && error.error && error.hint);
    const invalid = command(['read-dynamic', 'https://example.com/' + id, '--json']);
    assert.equal(invalid.status, 2);
    assert.equal(invalid.requests.length, 0);
    assert.ok(JSON.parse(invalid.stdout).hint);
    fs.unlinkSync(credentialFile);
    for (const args of [['read-dynamic', id], ['check-dynamic', id], ['dynamic', 'check', '--id', id]]) {
      const guest = command(args, { SURFCORE_FLOW_GUEST: '1' });
      assert.equal(guest.status, 0, guest.stderr + guest.stdout);
      assert.ok(guest.stdout.includes(announcement), 'public inspection still reads the original without stored login');
      assert.deepEqual(guest.requests, ['/x/web-interface/nav', '/x/polymer/web-dynamic/v1/detail']);
    }
    const loginRequired = command(['check-dynamic', id, '--json'], { SURFCORE_FLOW_GUEST: '1', SURFCORE_FLOW_LOGIN_REQUIRED: '1' });
    assert.equal(loginRequired.status, 4);
    assert.match(JSON.parse(loginRequired.stdout).hint, /登录/);
    fs.writeFileSync(credentialFile, '{broken');
    const damaged = command(['read-dynamic', id, '--json']);
    assert.equal(damaged.status, 3);
    assert.equal(JSON.parse(damaged.stdout).code, 'dynamic.credentials');
    assert.equal(damaged.requests.length, 0);
    console.log('Dynamic reading flow OK: inbox, real CLI aliases/digest, precision, raw mode, budgets and visible failures; fixture GETs only.');
  } finally {
    globalThis.fetch = realFetch;
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
