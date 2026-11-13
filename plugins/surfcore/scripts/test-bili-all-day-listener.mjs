// Offline behavioral regression: exercise the real exported scheduler, feed parser,
// configuration, pricing gate, and cursor file. No session or feed leaves this process.
// Run: node plugins/surfcore/scripts/test-bili-all-day-listener.mjs
// Original-source control (Node >=22.15):
// git show <pre-fix-ref>:plugins/surfcore/lib/scheduler.js | node plugins/surfcore/scripts/test-bili-all-day-listener.mjs --scheduler-source-stdin
// Loads that scheduler in memory with its real relative imports; the same tests
// must fail on the pre-fix source (exit 1), without editing production files.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nodeModule from 'node:module';
import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import timers from 'node:timers';

const sourceFromStdin = process.argv.includes('--scheduler-source-stdin');
assert.ok(process.argv.slice(2).every((arg) => arg === '--scheduler-source-stdin'), 'unknown argument');
const schedulerSource = sourceFromStdin ? fs.readFileSync(0, 'utf8') : null;
if (sourceFromStdin) assert.ok(schedulerSource.trim(), 'provide the original scheduler source on stdin');
const realDate = Date;
const peakTime = realDate.parse('2026-11-11T17:15:00+08:00'); // Wednesday, real pricing peak.
let clock = peakTime;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-bili-listener-'));
const home = path.join(root, 'profile');
const dshHome = path.join(home, '.dsh');
const stateDir = path.join(dshHome, 'surfcore', 'bili');
const configFile = path.join(dshHome, 'surfcore', 'bili.config.json');
const unifiedFile = path.join(dshHome, 'surfcore', 'config.json');
const qqRoot = path.join(root, 'qq-fixture');
const schedulerUrl = new URL('../lib/scheduler.js', import.meta.url).href;
const restore = [];
const activeTimers = new Set();
const forbiddenCalls = [];
const schedulers = new Set();
let fixture;
let loaderHook;
let configRevision = 0;
let passed = 0;
let failed = 0;

function patch(object, name, value) {
  const previous = object[name];
  object[name] = value;
  restore.push(() => { object[name] = previous; });
}
function env(name, value) {
  const previous = process.env[name];
  process.env[name] = value;
  restore.push(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}
function forbidden(label) {
  forbiddenCalls.push(label);
  throw new Error(`OFFLINE fixture forbids ${label}`);
}
function insideTemp(file) {
  const relative = path.relative(root, path.resolve(file));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function writeJson(file, value) {
  assert.ok(insideTemp(file), 'fixture writes must stay in its temporary directory');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function mockTimer(callback, delay) {
  const handle = { callback, delay, unref() { return this; }, ref() { return this; } };
  activeTimers.add(handle);
  return handle; // Deliberately never invoke any startup/interval callbacks.
}
function clearMockTimer(handle) { activeTimers.delete(handle); }
function writeConfig(options = {}) {
  const value = {
    self: { mid: '900001', name: 'Offline fixture' },
    owner: { mid: '900002', name: 'Offline owner' },
    interact: { enabled: true },
    night: { windows: [{ start: '20:00', end: '24:00' }] },
    ...options,
  };
  // Merge listen separately so individual cases need only override one switch.
  value.listen = { allDay: true, comment: true, commentIntervalSec: 120, scope: 'both', onlyOwner: false, dm: false, live: false, ...options.listen };
  writeJson(configFile, value);
  // config() caches on mtime:size; make every edit visible even on coarse clocks.
  const stamp = new realDate(peakTime + ++configRevision * 1000);
  fs.utimesSync(configFile, stamp, stamp);
}
function writeUnified(peakOffload = true) {
  writeJson(unifiedFile, {
    socialV2: { cost: { peakOffload } },
    persona: { injectInBili: false },
    alignment: { enabled: false },
    memory: { mode: 'narrative', qqToBili: false },
    memoryCard: { enabled: false },
    admin: { gentle: false },
  });
}
function incomingAt(t, id = '1001') {
  return {
    id, at_time: t, user: { mid: '900003', nickname: 'Offline visitor' },
    item: { root_id: '0', source_id: '2001', target_id: '0', subject_id: '3001', business_id: 1, title: 'Synthetic @ mention' },
  };
}

try {
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(qqRoot, 'src'), { recursive: true });
  writeJson(path.join(qqRoot, 'config.json'), {});
  fs.writeFileSync(path.join(qqRoot, 'src', 'bridge.js'), '// Root-discovery sentinel; never imported.\n');
  for (const [key, value] of Object.entries({
    DSH_HOME: dshHome, USERPROFILE: home, HOME: home, SURFCORE_BILI_CONFIG: configFile,
    SURFCORE_ROOT: qqRoot, SURFCORE_QQBOT_ROOT: qqRoot, QQBILI_QQBOT_ROOT: qqRoot,
    DSH_NODE: process.execPath, BILI_ME_MID: '900001', BILI_OWNER_MID: '900002', TZ: 'Asia/Shanghai',
  })) env(key, value);
  patch(os, 'homedir', () => home);
  patch(globalThis, 'Date', class extends realDate {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  });
  assert.equal(new Date().getHours(), 17, 'fake local clock must be 17:xx Beijing time');
  assert.equal(new Date().getDay(), 3, 'fixture must be a weekday');

  for (const object of [globalThis, timers]) {
    patch(object, 'setTimeout', mockTimer);
    patch(object, 'setInterval', mockTimer);
    patch(object, 'clearTimeout', clearMockTimer);
    patch(object, 'clearInterval', clearMockTimer);
  }
  for (const name of ['exec', 'execFile', 'execSync', 'execFileSync', 'spawn', 'spawnSync', 'fork']) {
    patch(childProcess, name, () => forbidden(`child_process.${name}`));
  }
  for (const [object, name, label] of [
    [http, 'request', 'http.request'], [http, 'get', 'http.get'],
    [https, 'request', 'https.request'], [https, 'get', 'https.get'],
    [net, 'connect', 'net.connect'], [net, 'createConnection', 'net.createConnection'],
    [net.Socket.prototype, 'connect', 'Socket.connect'], [tls, 'connect', 'tls.connect'],
    [dgram, 'createSocket', 'dgram.createSocket'],
  ]) patch(object, name, () => forbidden(label));
  // Explicitly fail any unexpected data read, even if production code catches it.
  const readFileSync = fs.readFileSync;
  patch(fs, 'readFileSync', (file, ...args) => {
    const filename = file instanceof URL ? fileURLToPath(file) : file;
    if (typeof filename === 'string' && !insideTemp(filename)
      && !/\.(?:mjs|cjs|js)$/.test(filename) && path.basename(filename) !== 'package.json') {
      return forbidden(`non-fixture data read: ${filename}`);
    }
    return readFileSync.call(fs, file, ...args);
  });
  patch(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(String(input));
    if (!fixture || url.origin !== 'https://api.bilibili.com'
      || !['/x/msgfeed/reply', '/x/msgfeed/at', '/x/web-interface/nav', '/x/polymer/web-dynamic/v1/detail'].includes(url.pathname)
      || (init.method ?? 'GET') !== 'GET' || init.body !== undefined) {
      return forbidden(`unexpected fetch: ${url.origin}${url.pathname}`);
    }
    assert.equal(init.headers?.cookie, 'SESSDATA=OFFLINE_ONLY; bili_jct=OFFLINE_CSRF; buvid3=OFFLINE_DEVICE');
    if (url.pathname === '/x/web-interface/nav') {
      fixture.fetches.push('nav');
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png' } } }) };
    }
    if (url.pathname.endsWith('/detail')) {
      fixture.fetches.push('detail');
      assert.equal(url.searchParams.get('features'), 'itemOpusStyle');
      assert.equal(url.searchParams.get('id'), '1270031871116312601');
      return { ok: true, status: 200, json: async () => fixture.dynamicResponse };
    }
    const kind = url.pathname.endsWith('/at') ? 'at' : 'reply';
    fixture.fetches.push(kind);
    return { json: async () => ({ code: 0, data: { items: structuredClone(fixture.feeds[kind]), cursor: '', last_view_at: fixture.initialCursor } }) };
  });
  nodeModule.syncBuiltinESMExports();
  writeConfig();
  writeUnified();
  writeJson(path.join(stateDir, 'credentials.json'), { sessdata: 'OFFLINE_ONLY', bili_jct: 'OFFLINE_CSRF', buvid3: 'OFFLINE_DEVICE' });

  if (sourceFromStdin) {
    assert.equal(typeof nodeModule.registerHooks, 'function', '--scheduler-source-stdin requires Node >=22.15');
    loaderHook = nodeModule.registerHooks({
      load(url, context, nextLoad) {
        const loaded = nextLoad(url, context);
        return url === schedulerUrl ? { ...loaded, source: schedulerSource } : loaded;
      },
    });
    console.log('Source control: testing the scheduler supplied on stdin, without changing production files.');
  }
  // Import ONLY after all environment, timer, process, and network isolation exists.
  const { startScheduler } = await import(schedulerUrl);
  const paths = await import('../lib/paths.js');
  const { isPeakAt, resolvePriceTable } = await import('../../../src/model-prices.js');
  assert.equal(paths.DSH_HOME, dshHome);
  assert.equal(paths.BILI_CONFIG, configFile);
  assert.equal(paths.QQBOT_ROOT, qqRoot);
  assert.equal(isPeakAt(clock, resolvePriceTable()), true, 'real price table must classify fixture time as peak');

  // Seed and inspect the real scheduler's persisted listener cursor.
  const cursorFile = path.join(stateDir, 'whale-listen.json');
  const nightFile = path.join(stateDir, 'whale-night.json');

  function begin(options = {}) {
    clock = peakTime;
    writeConfig(options.config);
    writeUnified();
    const initialCursor = Math.floor(peakTime / 1000) - 120;
    fixture = {
      initialCursor, incomingTime: initialCursor + 60, fetches: [], prompts: [], inspections: [], budgetCalls: [], logs: [],
      feeds: { reply: [], at: [] },
    };
    // One older reply and a duplicated @ entry exercise real filtering/deduplication.
    fixture.feeds.reply = [{ ...incomingAt(initialCursor - 1, 'older'), reply_time: initialCursor - 1 }];
    fixture.feeds.at = [incomingAt(fixture.incomingTime), incomingAt(fixture.incomingTime)];
    writeJson(cursorFile, { lastSeen: initialCursor });
    const current = fixture;
    const scheduler = startScheduler({
      sessionController: {
        async inspect(id) { current.inspections.push(id); return { sessionId: id }; },
        async create() { return forbidden('session creation'); },
        async prompt(args, signal) {
          assert.ok(signal instanceof AbortSignal, 'session prompt must receive an AbortSignal');
          current.prompts.push(structuredClone(args));
          // Record the queue only; no agent, command, reply, or service is started.
          return { queued: true };
        },
      },
    }, {
      dshHome, biliMjs: path.join(root, 'never-executed-bili.mjs'), cwd: root, workspacePath: root,
      sessionId: 'offline-bili-listener',
      tokenBudget: { async block(platform) {
        current.budgetCalls.push(platform);
        return { blocked: options.budget?.(current.budgetCalls.length) ?? false, message: 'Synthetic token budget' };
      } },
      log: (message) => current.logs.push(message),
    });
    schedulers.add(scheduler);
    return { ...current, scheduler, cursor: () => readJson(cursorFile).lastSeen };
  }
  async function check(name, run) {
    try {
      await run();
      assert.deepEqual(forbiddenCalls, [], 'no forbidden network/process/data access');
      console.log(`PASS ${name}`);
      passed++;
    } catch (error) {
      console.error(`FAIL ${name}: ${error.stack ?? error}`);
      if (fixture?.logs.length) console.error(`  scheduler logs: ${fixture.logs.join(' | ')}`);
      failed++;
    } finally {
      for (const scheduler of schedulers) scheduler.stop();
      schedulers.clear();
      assert.equal(activeTimers.size, 0, 'stop() must clear every mocked timer');
    }
  }

  await check('allDay=true queues an incoming @ at weekday peak, outside night windows, and advances the watermark', async () => {
    const f = begin();
    await f.scheduler.listenTick();
    assert.deepEqual(f.fetches, ['reply', 'at']);
    assert.equal(f.prompts.length, 1);
    assert.equal(f.prompts[0].mode, 'queue');
    assert.equal(f.prompts[0].sessionId, 'offline-bili-listener');
    const text = f.prompts[0].content.map((item) => item.text ?? '').join('\n');
    assert.match(text, /【有人找你】1 条新消息：Offline visitor（@）/);
    assert.deepEqual(f.inspections, ['offline-bili-listener']);
    assert.deepEqual(f.budgetCalls, ['bili', 'bili']);
    assert.equal(f.cursor(), f.incomingTime);
  });

  for (const scenario of ['complete', 'blocked', 'partial']) await check(`forwarded original scenario ${scenario} reaches the actual queued model prompt with appropriate hints`, async () => {
    const blocked = scenario === 'blocked';
    const f = begin();
    const notice = incomingAt(f.incomingTime);
    notice.item = { ...notice.item, business_id: 17, subject_id: 1270031871116312601, uri: 'https://t.bilibili.com/1270031871116312601', source_content: '@Offline fixture' };
    f.feeds.at.splice(0, f.feeds.at.length, notice);
    fixture.dynamicResponse = blocked ? { code: -352, message: 'risk control' } : { code: 0, data: { item: {
      id_str: '1270031871116312601', type: 'DYNAMIC_TYPE_FORWARD',
      basic: { comment_id_str: '1270031871116312601', comment_type: 17 },
      modules: { module_author: { name: 'Outer author' }, module_dynamic: { desc: { text: '@Offline fixture' } } },
      orig: { id_str: '1262230883329376274', type: 'DYNAMIC_TYPE_DRAW', modules: {
        module_author: { name: 'Original author' },
        module_dynamic: { desc: null, major: { type: 'MAJOR_TYPE_OPUS', opus: { summary: { text: '公测正式定档 11月26日！', has_more: scenario === 'partial' }, pics: [{ url: 'https://i0.hdslb.com/bfs/new_dyn/offline.jpg' }] } } },
      } },
    } } };
    await f.scheduler.listenTick();
    assert.deepEqual(f.fetches, ['reply', 'at', 'nav', 'detail']);
    assert.equal(f.prompts.length, 1);
    const text = f.prompts[0].content.map((part) => part.text ?? '').join('\n');
    if (blocked) {
      assert.match(text, /352|风控/);
      assert.match(text, /read-dynamic/);
      assert.doesNotMatch(text, /公测正式定档/);
    } else {
      assert.match(text, /Original author/);
      assert.match(text, /公测正式定档 11月26日/);
      assert.match(text, /转发原文/);
      assert.match(text, /1270031871116312601/);
      if (scenario === 'partial') assert.match(text, /原文内容不完整/);
    }
    assert.match(text, /仅当本次输出长度或批量阅读预算截断时/);
    assert.match(text, /不要立即重复请求/);
    assert.match(text, /comment-digest --hours 24 --max-dynamics 0/);
    assert.doesNotMatch(text, /缺失\/截断时先用/);
    assert.equal(f.cursor(), f.incomingTime, 'failure is delivered visibly, not silently replayed forever');
    assert.deepEqual(f.budgetCalls, ['bili', 'bili']);
  });

  for (const business of [11, 17]) await check(`dynamic type ${business} with no recoverable ID visibly reports unread original without guessing`, async () => {
    const f = begin();
    const notice = incomingAt(f.incomingTime);
    notice.item = { ...notice.item, business_id: business, subject_id: business === 11 ? 54321 : 1270031871116312601, uri: '' };
    f.feeds.at.splice(0, f.feeds.at.length, notice);
    await f.scheduler.listenTick();
    assert.deepEqual(f.fetches, ['reply', 'at']);
    assert.equal(f.prompts.length, 1);
    assert.match(f.prompts[0].content[0].text, /原文未读取/);
    assert.match(f.prompts[0].content[0].text, /缺少可靠的链接或精确 ID/);
    assert.equal(f.cursor(), f.incomingTime);
  });

  await check('allDay=false defers at peak even inside a listening window and preserves the cursor', async () => {
    const f = begin({ config: { listen: { allDay: false }, night: { windows: [{ start: '16:00', end: '18:00' }] } } });
    await f.scheduler.listenTick();
    assert.deepEqual(f.fetches, []);
    assert.deepEqual(f.prompts, []);
    assert.deepEqual(f.inspections, []);
    assert.equal(f.cursor(), f.initialCursor);
    assert.ok(f.logs.some((line) => line.includes('峰时顺延')));
  });

  await check('token budget blocks all-day listening before fetching and preserves the cursor', async () => {
    const f = begin({ budget: () => true });
    await f.scheduler.listenTick();
    assert.deepEqual(f.budgetCalls, ['bili']);
    assert.deepEqual(f.fetches, []);
    assert.deepEqual(f.prompts, []);
    assert.equal(f.cursor(), f.initialCursor);
  });

  await check('token budget becoming blocked after fetch still prevents queueing and cursor advancement', async () => {
    const f = begin({ budget: (call) => call >= 2 });
    await f.scheduler.listenTick();
    assert.deepEqual(f.fetches, ['reply', 'at']);
    assert.deepEqual(f.budgetCalls, ['bili', 'bili']);
    assert.deepEqual(f.prompts, []);
    assert.equal(f.cursor(), f.initialCursor);
  });

  for (const [name, config] of [
    ['interaction disabled', { interact: { enabled: false } }],
    ['comment listening disabled', { listen: { comment: false } }],
  ]) await check(`${name} stays blocked with allDay=true at peak`, async () => {
    const f = begin({ config });
    await f.scheduler.listenTick();
    assert.deepEqual(f.fetches, []);
    assert.deepEqual(f.prompts, []);
    assert.deepEqual(f.inspections, []);
    assert.equal(f.cursor(), f.initialCursor);
  });

  await check('duplicate polls respect the configured interval and do not queue the same message twice', async () => {
    const f = begin();
    await f.scheduler.listenTick();
    assert.equal(f.prompts.length, 1);
    const initialFetches = f.fetches.length;
    await f.scheduler.listenTick();
    clock += 119_999;
    await f.scheduler.listenTick();
    assert.equal(f.fetches.length, initialFetches, 'polls before 120s must not fetch');
    assert.equal(f.prompts.length, 1);
    clock += 1;
    await f.scheduler.listenTick();
    assert.equal(f.fetches.length, initialFetches + 2, 'poll at 120s must fetch');
    assert.equal(f.prompts.length, 1, 'already-seen @ must not queue again');
    assert.equal(f.cursor(), f.incomingTime);
    const nextTime = f.incomingTime + 180;
    f.feeds.at.push(incomingAt(nextTime, '1002'));
    clock += 120_000;
    await f.scheduler.listenTick();
    assert.equal(f.prompts.length, 2, 'a later incoming message still queues');
    assert.equal(f.cursor(), nextTime);
  });

  await check('first poll establishes a baseline without replaying historical mentions', async () => {
    const f = begin();
    fs.rmSync(cursorFile);
    await f.scheduler.listenTick();
    assert.deepEqual(f.fetches, ['reply', 'at']);
    assert.deepEqual(f.prompts, []);
    assert.equal(f.cursor(), Math.floor(clock / 1000));
  });

  await check('non-all-day listening still requires its night window outside peak', async () => {
    const f = begin({ config: { listen: { allDay: false } } });
    clock = realDate.parse('2026-11-11T19:15:00+08:00');
    assert.equal(isPeakAt(clock, resolvePriceTable()), false);
    await f.scheduler.listenTick();
    assert.deepEqual(f.fetches, []);
    assert.deepEqual(f.prompts, []);
    assert.equal(f.cursor(), f.initialCursor);
  });

  await check('autonomous tick stays peak-blocked with allDay=true; disabling peak offload lets the due plan run', async () => {
    const f = begin();
    const plan = { date: '2026-11-11', action: 'skip', at: 17 * 60, fired: false, reason: 'Offline due-plan fixture' };
    writeJson(nightFile, plan);
    await f.scheduler.tick();
    assert.deepEqual(f.prompts, []);
    assert.deepEqual(f.budgetCalls, []);
    assert.deepEqual(readJson(nightFile), plan);
    assert.ok(f.logs.some((line) => line.includes('峰时顺延') && line.includes('生物钟叫醒')));
    writeUnified(false);
    await f.scheduler.tick();
    assert.equal(f.prompts.length, 1, 'the seeded plan must actually be runnable without the peak gate');
    assert.equal(f.prompts[0].mode, 'queue');
    assert.equal(readJson(nightFile).fired, true);
    assert.deepEqual(f.fetches, []);
    assert.equal(f.cursor(), f.initialCursor);
  });

  assert.deepEqual(forbiddenCalls, []);
  console.log(`\nOffline listener regression: ${passed} passed, ${failed} failed; no real HTTP, subprocesses, or sessions.`);
  if (failed) process.exitCode = 1;
} finally {
  for (const scheduler of schedulers) scheduler.stop();
  loaderHook?.deregister();
  for (const undo of restore.reverse()) undo();
  nodeModule.syncBuiltinESMExports();
  fs.rmSync(root, { recursive: true, force: true });
}
