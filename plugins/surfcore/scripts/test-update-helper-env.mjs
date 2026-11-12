// 更新助手（apply-update.mjs）的启动方式与"启动标记"：
// 插件在 DSH（Electron）里跑，process.execPath 是宿主可执行文件；不带 ELECTRON_RUN_AS_NODE
// 直接 spawn .mjs 会静默退出（exit 0），更新永远不落地 —— 2026-10-28 用户反馈的核心原因。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { helperSpawnEnv, resumePendingApply } from '../lib/updates.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-update-helper-'));
let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label} ${extra}`); }
};

try {
  // 1) 环境变量：Electron 宿主必须带 RUN_AS_NODE；node 本身不需要
  const envElectron = helperSpawnEnv('C:\\DSH\\DeepSeek Harness.exe', {});
  ok(envElectron.ELECTRON_RUN_AS_NODE === '1', 'Electron 宿主 → 带 ELECTRON_RUN_AS_NODE=1');
  const envNode = helperSpawnEnv('C:\\nodejs\\node.exe', {});
  ok(envNode.ELECTRON_RUN_AS_NODE === undefined, 'node.exe → 不额外加环境变量');

  // 2) 助手跑起来会写 .started；成功应用后写目标文件、删 pending 与 started
  const stateDir = path.join(base, 'state');
  const staging = path.join(base, 'staging');
  const target = path.join(base, 'target');
  fs.mkdirSync(staging, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(staging, 'package.json'), '{"version":"9.9.9"}');
  fs.writeFileSync(path.join(target, 'config.json'), '{"keep":true}');
  fs.mkdirSync(stateDir, { recursive: true });
  const pendingFile = path.join(stateDir, 'updates-pending.json');
  fs.writeFileSync(pendingFile, JSON.stringify({
    kind: 'zip', component: 'surfcore', target, staging, to: '9.9.9', waitPid: 999999,
    logFile: path.join(stateDir, 'apply.log'),
  }, null, 2));

  execFileSync(process.execPath, [path.resolve('../../scripts/apply-update.mjs'), '--pending', pendingFile], { stdio: 'ignore' });

  ok(fs.existsSync(path.join(target, 'package.json')), '助手真的执行了（目标目录有 package.json）');
  ok(fs.readFileSync(path.join(target, 'config.json'), 'utf8').includes('keep'), '用户的 config.json 被保留');
  ok(!fs.existsSync(pendingFile), '成功后 pending 被删除');
  ok(!fs.existsSync(`${pendingFile}.started`), '成功后 .started 被清理');

  // 3) 失败要留证据：staging 不存在 → .failed，pending 保留，便于下次重试
  const badPending = path.join(stateDir, 'updates-pending.json');
  fs.writeFileSync(badPending, JSON.stringify({
    kind: 'zip', component: 'surfcore', target, staging: path.join(base, 'nope'), to: '9.9.9', waitPid: 999999,
    logFile: path.join(stateDir, 'apply2.log'),
  }, null, 2));
  let exitCode = 0;
  try {
    execFileSync(process.execPath, [path.resolve('../../scripts/apply-update.mjs'), '--pending', badPending], { stdio: 'ignore' });
  } catch (error) { exitCode = error.status ?? 1; }
  ok(exitCode !== 0, 'staging 缺失时助手以非 0 退出');
  ok(fs.existsSync(`${badPending}.failed`), '失败留下 .failed 证据');
  // 2026-11-01 起：失败 = 本次尝试结束，删 pending、只留 .failed（避免下次启动重试坏包/永远显示旧失败）
  ok(!fs.existsSync(badPending), '失败后删除 pending（.failed 是唯一真相）');
  ok(!fs.existsSync(`${badPending}.started`), '失败后清理 .started');

  // 4) Resume uses the same real child-process handshake as a fresh queue.
  const previousHelper = process.env.SURFCORE_UPDATE_HELPER;
  const fixtures = [];
  const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const fixturePrelude = "import fs from 'node:fs'; const file=process.argv[3]; const job=JSON.parse(fs.readFileSync(file,'utf8')); fs.writeFileSync(file+'.fixture-pid',String(process.pid)); ";
  const resumeFixture = (name, { source, missing = false, lock = '', staleMarker = false } = {}) => {
    const stateDir = path.join(base, name);
    fs.mkdirSync(stateDir);
    const file = path.join(stateDir, 'updates-pending.json');
    const job = { kind: 'zip', component: 'surfcore', txn: name, target, staging, to: '9.9.9', waitPid: 999999 };
    fs.writeFileSync(file, JSON.stringify(job));
    if (lock) fs.writeFileSync(file + '.lock', lock);
    if (staleMarker) fs.writeFileSync(file + '.started', JSON.stringify({ pid: process.pid, txn: 'other-transaction' }));
    if (source !== undefined || missing) {
      const helper = path.join(stateDir, 'helper.mjs');
      if (!missing) fs.writeFileSync(helper, source);
      process.env.SURFCORE_UPDATE_HELPER = helper;
    } else delete process.env.SURFCORE_UPDATE_HELPER;
    const resumed = resumePendingApply({ stateDir });
    fixtures.push(file);
    return { file, resumed, job };
  };
  const expectFailure = async (f, code) => {
    const deadline = Date.now() + 6000;
    while (!fs.existsSync(f.file + '.failed') && Date.now() < deadline) await pause(50);
    const result = JSON.parse(fs.readFileSync(f.file + '.failed', 'utf8'));
    assert.equal(result.code, code);
    assert.ok(result.error && result.hint);
    assert.equal(result.txn, f.job.txn);
    assert.equal(fs.existsSync(f.file), false, 'failed resume releases only its pending job');
  };
  try {
    const missing = resumeFixture('missing-helper', { missing: true });
    assert.equal(missing.resumed, false);
    const corrupt = resumeFixture('corrupt-helper', { source: 'this is invalid JS!', staleMarker: true });
    const locked = resumeFixture('invalid-lock', { lock: 'not-a-pid' });
    const silent = resumeFixture('no-handshake', { source: fixturePrelude + 'setTimeout(()=>{},10000);' });
    const wrongMarker = resumeFixture('wrong-handshake', { source: fixturePrelude + "fs.writeFileSync(file+'.started',JSON.stringify({txn:'wrong-job',pid:process.pid})); setTimeout(()=>{},10000);" });
    const wrongPid = resumeFixture('wrong-pid', { source: fixturePrelude + "fs.writeFileSync(file+'.started',JSON.stringify({txn:job.txn,pid:process.pid+1})); setTimeout(()=>{},10000);" });
    const healthy = resumeFixture('valid-handshake', { source: fixturePrelude + "fs.writeFileSync(file+'.started',JSON.stringify({txn:job.txn,pid:process.pid})); setTimeout(()=>{},10000);" });
    const moved = resumeFixture('newer-job', { source: fixturePrelude + "fs.writeFileSync(file,JSON.stringify({...job,txn:'newer-transaction'})); fs.writeFileSync(file+'.failed',JSON.stringify({txn:'newer-transaction',code:'newer-evidence'}));" });
    const active = resumeFixture('active-lock', { lock: String(process.pid) });
    assert.equal(active.resumed, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(active.file, 'utf8')), active.job, 'live helper lock prevents duplicate resume');
    await Promise.all([
      expectFailure(missing, 'stage.helper-missing'),
      expectFailure(corrupt, 'stage.helper-exited'),
      expectFailure(locked, 'stage.helper-exited'),
      expectFailure(silent, 'stage.helper-not-started'),
      expectFailure(wrongMarker, 'stage.helper-not-started'),
      expectFailure(wrongPid, 'stage.helper-not-started'),
    ]);
    assert.equal(fs.existsSync(healthy.file), true, 'matching live helper handshake keeps queue');
    assert.equal(fs.existsSync(healthy.file + '.failed'), false);
    assert.equal(JSON.parse(fs.readFileSync(moved.file, 'utf8')).txn, 'newer-transaction');
    assert.equal(JSON.parse(fs.readFileSync(moved.file + '.failed', 'utf8')).code, 'newer-evidence', 'old exit/timeout cannot overwrite new evidence');
    ok(true, '恢复队列：助手缺失、语法损坏、坏锁和启动超时均留下可操作失败并释放队列');
    ok(true, '恢复队列：启动标记必须匹配事务，活跃锁与新事务不被旧回调改动');
  } finally {
    if (previousHelper === undefined) delete process.env.SURFCORE_UPDATE_HELPER; else process.env.SURFCORE_UPDATE_HELPER = previousHelper;
    for (const file of fixtures) {
      try { process.kill(Number(fs.readFileSync(file + '.fixture-pid', 'utf8'))); } catch {}
    }
  }
} finally {
  await fs.promises.rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n✅ test-update-helper-env 通过');
