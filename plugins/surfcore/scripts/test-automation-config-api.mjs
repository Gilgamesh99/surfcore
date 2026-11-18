/**
 * 设置页保存链路（额度 / 四类动态 / QQ 视频分享）端到端：
 *   GET /config → 有 limits/dynamics；
 *   POST /config → 落盘并收敛；
 *   GET /bili/automation → 快照能读到刚改的值。
 *
 * 全程临时 DSH_HOME / QQBOT_ROOT，不碰真实配置。
 * 运行：node scripts/test-automation-config-api.mjs
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-auto-api-root-'));
const tempDsh = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-auto-api-dsh-'));
const tempState = path.join(tempDsh, 'surfcore');
fs.mkdirSync(path.join(tempRoot, 'src'), { recursive: true });
fs.mkdirSync(tempState, { recursive: true });
fs.writeFileSync(path.join(tempRoot, 'src', 'bridge.js'), '// fixture\n');
fs.writeFileSync(path.join(tempRoot, 'config.json'), JSON.stringify({
  ownerQQ: '10001',
  allow: { private: ['10001'], groups: ['767098733'] },
  biliBridge: {
    enabled: true,
    share: { enabled: true, times: ['09:00'], groups: [], gapMs: 4000, card: true, cardMode: 'miniapp' },
    dynamics: { enabled: true, pollIntervalMs: 180000, groups: [] },
  },
}, null, 2));
fs.writeFileSync(path.join(tempState, 'bili.config.json'), JSON.stringify({
  owner: { mid: '20002', name: '测试B站昵称' },
  quota: { shareDaily: 4 },
  limits: { daily: 12, globalMin: 3 },
  dynamics: { gapMin: 20, kinds: { anime: { slot: 15 } } },
}, null, 2));
fs.writeFileSync(path.join(tempState, 'config.json'), JSON.stringify({ version: 1 }, null, 2));

process.env.SURFCORE_ROOT = tempRoot;
process.env.DSH_HOME = tempDsh;
process.env.USERPROFILE = tempDsh;
process.env.SURFCORE_SKIP_AUTOSTART = '1';
process.env.SURFCORE_DISABLE_CHARACTER_MIGRATION = '1';
process.env.SURFCORE_DISABLE_MEMORY_TIMER = '1';

const { apply } = await import('../lib/index.js');

const routes = [];
const effects = [];
const ctx = {
  agents: { list: () => [] },
  on() { return () => {}; },
  webServer: { register(route) { routes.push(route); return () => {}; } },
  get(name) { return name === 'connection' ? { requestRejection: () => false, browserAuth: { isAuthenticated: (req) => req.headers['x-test-browser'] === 'owner' } } : null; },
  effect(fn) { effects.push(fn); return () => {}; },
  sessionController: {
    inspect: async () => ({ events: [] }),
    create: async () => ({}),
    prompt: async () => ({ accepted: true }),
  },
  settings: null,
};
apply(ctx);

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers ?? {}; },
    end(body = '') { this.body += body; },
  };
}
function fakeReq(method, url, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:58750', ...(body ? { 'content-type': 'application/json' } : {}) };
  if (body) {
    process.nextTick(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    });
  }
  return req;
}
async function invoke(method, p, body, headers = {}) {
  const route = routes.find((r) => r.path === '/dsh-surfcore/api');
  const res = fakeRes();
  const req = fakeReq(method, `/dsh-surfcore/api${p}`, body);
  Object.assign(req.headers, headers);
  await route.handler(req, res);
  return { status: res.statusCode, data: JSON.parse(res.body || '{}') };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const qqFile = path.join(tempRoot, 'config.json');
const biliFile = path.join(tempState, 'bili.config.json');

try {
  // ① GET /config：两组可编辑项要在
  const config = await invoke('GET', '/config');
  assert.equal(config.status, 200);
  assert.equal(config.data.bili.limits.daily, 12);
  assert.equal(config.data.bili.limits.replyDaily, 50, '没写的额度要有默认值');
  assert.equal(config.data.bili.dynamics.kinds.anime.slot, 15);
  assert.equal(config.data.bili.dynamics.kinds.best.slot, 8, '没写的类要有默认值');
  assert.deepEqual(config.data.qq.biliBridge.share.times, ['09:00']);
  assert.equal(config.data.qq.biliBridge.share.cardMode, 'miniapp', '卡片样式要能读回来');

  // ② POST /config：按设置页的方式整体保存 bili + qq
  const bili = readJson(biliFile);
  bili.limits = { ...bili.limits, daily: 8, taDaily: -3, minePerPerson: 2 };
  bili.dynamics = { enabled: true, gapMin: 15, kinds: { ...bili.dynamics.kinds, best: { slot: 7, minLen: 30, maxLen: 120, prefix: '【早】' } } };
  const qq = readJson(qqFile);
  qq.biliBridge.share.times = ['20:00', '8:00', '99:99'];
  qq.biliBridge.share.groups = ['767098733'];
  qq.biliBridge.share.gapMs = 1234;
  qq.biliBridge.share.cardMode = 'off';
  const saved = await invoke('POST', '/config', { bili, qq });
  assert.equal(saved.status, 200, JSON.stringify(saved.data).slice(0, 300));
  assert.equal(saved.data.saved.bili, true);
  assert.equal(saved.data.saved.qq, true);

  const diskBili = readJson(biliFile);
  assert.equal(diskBili.limits.daily, 8);
  assert.equal(diskBili.limits.taDaily, 0, '负数要收敛到 0');
  assert.equal(diskBili.limits.minePerPerson, 2);
  assert.equal(diskBili.dynamics.gapMin, 15);
  assert.equal(diskBili.dynamics.kinds.best.slot, 7);
  assert.equal(diskBili.dynamics.kinds.best.minLen, 30);
  assert.equal(diskBili.dynamics.kinds.best.prefix, '【早】');

  const diskQq = readJson(qqFile);
  assert.deepEqual(diskQq.biliBridge.share.times, ['08:00', '20:00'], '时间点要规范化/排序，非法项丢弃');
  assert.equal(diskQq.biliBridge.share.gapMs, 1234);
  assert.deepEqual(diskQq.biliBridge.share.groups, ['767098733']);
  assert.equal(diskQq.biliBridge.share.cardMode, 'off', '卡片样式要落盘');
  assert.equal(diskQq.biliBridge.share.card, false, 'card 是派生值：off 时必须是 false');

  // ③ GET /bili/automation：快照读到刚保存的值
  const snap = await invoke('GET', '/bili/automation');
  assert.equal(snap.status, 200);
  assert.equal(snap.data.limits.daily, 8);
  assert.equal(snap.data.limits.taDaily, 0);
  assert.equal(snap.data.dynamics.gapMin, 15);
  assert.equal(snap.data.dynamics.kinds.find((k) => k.key === 'best').slot, 7);
  assert.deepEqual(snap.data.qqShare.times, ['08:00', '20:00']);
  assert.equal(snap.data.qqShare.gapMs, 1234);
  assert.equal(snap.data.qqShare.cardMode, 'off', '快照要带卡片样式，UI 才能显示对不对');
  assert.equal(snap.data.qqShare.card, false);

  // DM tasks are visible through the real settings handler, including corrupt state.
  const emptyTasks = await invoke('GET', '/bili/dm-tasks');
  assert.equal(emptyTasks.status, 200); assert.equal(emptyTasks.data.ok, true); assert.deepEqual(emptyTasks.data.jobs, []);
  const { createDmTaskStore } = await import('../tools/lib/dm-tasks.mjs');
  const taskFile = path.join(tempState, 'bili', 'dm-tasks.json');
  const taskStore = createDmTaskStore({ file: taskFile });
  const [task] = taskStore.accept({ batchId: 'settings-fixture', items: [{ mid: '20002', messages: [{ seq: '90071992547409931', ts: 123, type: 1, text: 'PRIVATE_BODY_MUST_STAY_LOCAL' }] }] }, '20002');
  taskStore.update(task.id, { status: 'failed', retryable: true, error: { code: 'dm.fixture', error: '未能排队', hint: '检查后重试' } });
  const taskView = await invoke('GET', '/bili/dm-tasks');
  assert.equal(taskView.status, 200); assert.equal(taskView.data.jobs[0].canRetry, true);
  assert.equal(taskView.data.jobs[0].error.hint, '检查后重试');
  assert.ok(!JSON.stringify(taskView.data).includes('PRIVATE_BODY_MUST_STAY_LOCAL'));
  const badRetry = await invoke('POST', '/bili/dm-task-retry', { id: 'invalid' });
  assert.equal(badRetry.status, 400); assert.equal(badRetry.data.ok, false); assert.ok(badRetry.data.code && badRetry.data.hint);
  fs.writeFileSync(taskFile, '{broken');
  const brokenTasks = await invoke('GET', '/bili/dm-tasks');
  assert.equal(brokenTasks.status, 500); assert.equal(brokenTasks.data.ok, false);
  assert.equal(brokenTasks.data.code, 'dm.tasks-unreadable'); assert.ok(brokenTasks.data.hint);

  const desktop = await invoke('GET', '/owner-desktop');
  assert.equal(desktop.status, 200); assert.equal(desktop.data.settings.enabled, false);
  const agentAttempt = await invoke('POST', '/owner-desktop', { enabled: true }, { 'x-agent-token': 'fake' });
  assert.equal(agentAttempt.status, 403); assert.equal(agentAttempt.data.code, 'owner-desktop.admin-only'); assert.ok(agentAttempt.data.hint);
  const unsigned = await invoke('POST', '/owner-desktop', { enabled: false, expectedEpoch: '' });
  assert.equal(unsigned.status, 401); assert.equal(unsigned.data.code, 'owner-desktop.browser-required');
  const dedicatedOnly = await invoke('POST', '/config', { unified: { ownerDesktop: { enabled: true } } });
  assert.equal(dedicatedOnly.status, 409); assert.equal(dedicatedOnly.data.code, 'owner-desktop.dedicated-settings');
  const disabled = await invoke('POST', '/owner-desktop', { enabled: false, expectedEpoch: '' }, { 'x-test-browser': 'owner' });
  assert.equal(disabled.status, 200, JSON.stringify(disabled.data)); assert.equal(disabled.data.settings.enabled, false); assert.ok(disabled.data.settings.authorizationEpoch);
  const diskDesktop = readJson(path.join(tempState, 'config.json')).ownerDesktop;
  assert.equal(diskDesktop.authorizationEpoch, disabled.data.settings.authorizationEpoch);
  let durationEpoch = diskDesktop.authorizationEpoch;
  for (const timeoutMs of [1800000, 86400000, 0]) {
    const saved = await invoke('POST', '/owner-desktop', { enabled: false, timeoutMs, expectedEpoch: durationEpoch }, { 'x-test-browser': 'owner' });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(saved.data.settings.timeoutMs, timeoutMs);
    durationEpoch = saved.data.settings.authorizationEpoch;
    assert.equal(readJson(path.join(tempState, 'config.json')).ownerDesktop.timeoutMs, timeoutMs);
    const reread = await invoke('GET', '/owner-desktop'); assert.equal(reread.data.settings.timeoutMs, timeoutMs);
  }
  const invalidDuration = await invoke('POST', '/owner-desktop', { enabled: false, timeoutMs: null, expectedEpoch: durationEpoch }, { 'x-test-browser': 'owner' });
  assert.equal(invalidDuration.data.code, 'owner-desktop.timeout-invalid'); assert.ok(invalidDuration.data.hint);
  assert.equal(readJson(path.join(tempState, 'config.json')).ownerDesktop.authorizationEpoch, durationEpoch);
  // Exercise the real generic owner-save route twice without any worker heartbeat in between.
  const unifiedFile = path.join(tempState, 'config.json');
  const priorOwner = String(readJson(qqFile).ownerQQ);
  const priorConfig = readJson(unifiedFile);
  priorConfig.ownerDesktop = { enabled: true, parentSessionId: 'human-root', timeoutMs: 600000, authorizationEpoch: 'lease-A' };
  fs.writeFileSync(unifiedFile, JSON.stringify(priorConfig));
  const changedOwner = await invoke('POST', '/config', { unified: { admin: { qq: '10009' } } });
  assert.equal(changedOwner.status, 200, JSON.stringify(changedOwner.data));
  const epochB = readJson(unifiedFile).ownerDesktop;
  assert.equal(epochB.enabled, false); assert.notEqual(epochB.authorizationEpoch, 'lease-A');
  assert.equal(String(readJson(qqFile).ownerQQ), '10009');
  const restoredOwner = await invoke('POST', '/config', { unified: { admin: { qq: priorOwner } } });
  assert.equal(restoredOwner.status, 200, JSON.stringify(restoredOwner.data));
  const epochA2 = readJson(unifiedFile).ownerDesktop;
  assert.equal(epochA2.enabled, false); assert.notEqual(epochA2.authorizationEpoch, 'lease-A');
  assert.notEqual(epochA2.authorizationEpoch, epochB.authorizationEpoch);
  assert.equal(String(readJson(qqFile).ownerQQ), priorOwner);
  console.log('automation config, private-message status and owner desktop API tests OK');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const fn of effects) {
    try {
      const dispose = fn();
      if (typeof dispose === 'function') dispose();
    } catch {}
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.rmSync(tempDsh, { recursive: true, force: true });
}
// 调度器可能还挂着 60s tick；测完主动退出（退出码反映断言结果）。
process.exit(process.exitCode ?? 0);

