// 组件更新（lib/updates.js）的离线回归：用真实的临时 git 仓库跑，不碰网络。
//
// 覆盖的是"会伤到用户"的几条边界：
//   · 只做 fetch 检查，不动工作区；
//   · SurfCore 正常合并保留本地提交；自定义组件默认 ff-only；未提交改动拒绝；
//   · "不再提示本次"按远端 commit 记，远端再前进会重新提示；
//   · 不是 git 仓库的目录只是"不可查"，不能让整个功能报错。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createUpdatesService, inspectComponent, compareVersions, gitAvailable } from '../lib/updates.js';

let failures = 0;
const ok = (cond, label) => {
  if (cond) console.log(`✅ ${label}`);
  else { failures += 1; console.error(`❌ ${label}`); }
};

// Apply isolation to the inspector's Git children as well as fixture commands.
const gitOverrides = { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: 'file' };
const gitKeys = new Set([...Object.keys(gitOverrides), 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE',
  ...Object.keys(process.env).filter((key) => /^GIT_(AUTHOR|COMMITTER)_|^GIT_CONFIG_(COUNT|KEY_|VALUE_)/.test(key))]);
const originalGitEnv = new Map([...gitKeys].map((key) => [key, process.env[key]]));
for (const key of gitKeys) delete process.env[key];
Object.assign(process.env, gitOverrides);
const GIT_ENV = { ...process.env };
const originalFetch = global.fetch;
let networkCalls = 0;
global.fetch = async () => { networkCalls++; throw new Error('Unexpected HTTP fetch in offline update test'); };
function git(args, cwd) {
  return execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-updates-'));
const remote = path.join(base, 'remote.git');
const work = path.join(base, 'work');
const other = path.join(base, 'other');
const stateDir = path.join(base, 'state');
fs.mkdirSync(stateDir, { recursive: true });

try {
  console.log('## 0. 准备两个克隆 + 一个裸仓库');
  git(['-c', 'init.defaultBranch=main', 'init', '--bare', remote], base);
  git(['clone', remote, work], base);
  git(['checkout', '-b', 'main'], work);
  fs.writeFileSync(path.join(work, 'README.md'), '# demo\n');
  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  git(['add', '.'], work);
  git(['commit', '-m', 'init'], work);
  git(['push', '-u', 'origin', 'main'], work);
  git(['clone', remote, other], base);
  ok(Boolean(await gitAvailable()), `git 可用（${await gitAvailable()}）`);

  console.log('## 1. 没更新时：available + behind=0');
  {
    const r = await inspectComponent({ id: 'core', name: '本体', dir: work }, { fetch: true });
    ok(r.available === true, '能识别为 git 工作区');
    ok(r.behind === 0 && r.updateAvailable === false, 'behind=0、无更新');
    ok(r.branch === 'main', '分支识别为 main');
  }

  console.log('## 2. 远端前进后：检出 behind 与 changelog');
  fs.writeFileSync(path.join(other, 'a.txt'), 'a\n');
  git(['add', '.'], other);
  git(['commit', '-m', 'feat: add a'], other);
  git(['push', 'origin', 'main'], other);
  {
    const r = await inspectComponent({ id: 'core', name: '本体', dir: work }, { fetch: true });
    ok(r.behind === 1, `behind=1（实际 ${r.behind}）`);
    ok(r.changelog.some((line) => line.includes('feat: add a')), 'changelog 带上了提交信息');
    ok(r.blocked === '', '干净的工作区可以自动更新');
    ok(r.channel === 'git' && r.updateAvailable && r.installedVersion === '1.0.0' && r.latestVersion === '1.0.0', '同版本号的远端新提交仍是 Git 更新，版本来自固定对象');
  }

  console.log('## 3. 本地有改动 / 未推送提交：拒绝，而不是覆盖');
  {
    fs.appendFileSync(path.join(work, 'README.md'), 'local edit\n');
    const dirty = await inspectComponent({ id: 'core', name: '本体', dir: work }, { fetch: false });
    ok(dirty.dirty >= 1, `识别出本地改动（${dirty.dirty} 处）`);
    ok(/未提交改动/.test(dirty.blocked), 'blocked 说明是"未提交改动"');
    git(['checkout', '--', 'README.md'], work);   // 还原测试现场
    const originalPackage = fs.readFileSync(path.join(work, 'package.json'), 'utf8');
    fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ version: '9.0.0-local' }));
    const actualVersion = await inspectComponent({ id: 'core', dir: work }, { fetch: false });
    ok(actualVersion.blocked && actualVersion.installedVersion === '9.0.0-local' && actualVersion.latestVersion === '1.0.0', '本机版本读取实际安装文件，远端版本只取固定 Git 对象');
    fs.writeFileSync(path.join(work, 'package.json'), originalPackage);

    // 本地领先：造一个未推送提交，再让它与远端分叉
    fs.writeFileSync(path.join(work, 'local.txt'), 'local\n');
    git(['add', '.'], work);
    git(['commit', '-m', 'local only'], work);
    await inspectComponent({ id: 'core', name: '本体', dir: work }, { fetch: false });
    // 本地领先 1、落后 1 → ff-only 会失败
    fs.writeFileSync(path.join(other, 'b.txt'), 'b\n');
    git(['add', '.'], other);
    git(['commit', '-m', 'feat: add b'], other);
    git(['push', 'origin', 'main'], other);
    const diverged = await inspectComponent({ id: 'core', name: '本体', dir: work }, { fetch: true });
    ok(diverged.ahead === 1 && diverged.behind === 2, `识别出分叉（ahead=${diverged.ahead} behind=${diverged.behind}）`);
    ok(/未推送提交/.test(diverged.blocked), '自定义组件分叉时默认拒绝自动更新');
    const surfcore = await inspectComponent({ id: 'surfcore', name: '本体', dir: work, branch: 'main' }, { fetch: false });
    ok(!surfcore.blocked && surfcore.updateAvailable && surfcore.policy === 'preserve-local', 'SurfCore 分叉允许保留本地提交的正常合并');
    const explicit = await inspectComponent({ id: 'core', dir: work, gitPolicy: 'preserve-local' }, { fetch: false });
    ok(!explicit.blocked && explicit.policy === 'preserve-local', '自定义组件可显式选择保留本地历史');
    const blockedCountSvc = createUpdatesService({ stateDir: path.join(base, 'blocked-count'), components: () => [{ id: 'core', dir: work }] });
    const counts = await blockedCountSvc.check({ fetch: false });
    ok(counts.availableUpdateCount === 1 && counts.blockedUpdateCount === 1 && counts.pendingCount === 0, '阻塞的远端更新仍计入可用更新，不冒充最新');
    // 收尾：回到与远端一致（测试继续用干净状态）
    git(['reset', '--hard', 'origin/main'], work);
    fs.writeFileSync(path.join(work, 'ahead.txt'), 'local only\n');
    git(['add', 'ahead.txt'], work); git(['commit', '-m', 'ahead only'], work);
    const aheadOnly = await inspectComponent({ id: 'surfcore', dir: work }, { fetch: false });
    ok(aheadOnly.ahead === 1 && aheadOnly.behind === 0 && !aheadOnly.blocked && aheadOnly.status === 'latest', '仅本地领先可以判定没有上游更新');
    git(['reset', '--hard', 'origin/main'], work);
    git(['switch', '-c', 'other-branch'], work);
    const branchMismatch = await inspectComponent({ id: 'surfcore', dir: work, branch: 'main' }, { fetch: false });
    ok(branchMismatch.code === 'git.branch-mismatch' && branchMismatch.hint, '配置 main 不会掩盖实际分支');
    git(['switch', 'main'], work);
    git(['remote', 'set-url', 'origin', path.join(base, 'missing-remote.git')], work);
    const fetchSvc = createUpdatesService({ stateDir: path.join(base, 'fetch-state'), components: () => [{ id: 'surfcore', dir: work, kind: 'git', versionRepo: 'never/request-http' }] });
    const failedFetch = await fetchSvc.check({ fetch: true });
    ok(failedFetch.results[0].code === 'git.fetch-failed' && failedFetch.unknownCount === 1 && failedFetch.availableUpdateCount === 0, 'fetch 失败不能用缓存或 HTTP 兜底冒充最新');
    git(['remote', 'set-url', 'origin', remote], work);
    const index = path.join(work, '.git', 'index'), originalIndex = fs.readFileSync(index);
    fs.writeFileSync(index, 'corrupt index');
    const badState = await inspectComponent({ id: 'surfcore', dir: work }, { fetch: false });
    ok(badState.available === false && badState.code === 'git.state-unreadable' && badState.hint, 'status 失败严格拒绝判定干净');
    fs.writeFileSync(index, originalIndex);
  }

  console.log('## 4. 服务层：check → pending → dismiss → 远端再前进 → 重新提示');
  {
    const svc = createUpdatesService({
      stateDir,
      components: () => [{ id: 'core', name: '本体', dir: work }],
      blockedReason: () => '',
    });
    let st = await svc.check({ fetch: true });
    ok(st.pendingCount === 0, '当前已是最新（pending=0）');

    fs.writeFileSync(path.join(other, 'c.txt'), 'c\n');
    git(['add', '.'], other);
    git(['commit', '-m', 'feat: add c'], other);
    git(['push', 'origin', 'main'], other);

    st = await svc.check({ fetch: true });
    ok(st.pendingCount === 1 && st.showPrompt === true, '远端新提交 → pending=1、showPrompt=true');
    ok(st.results[0].behind === 1, 'behind=1');

    const dismissed = svc.dismiss(['core']);
    ok(dismissed.showPrompt === false && dismissed.pendingCount === 0, '「不再提示本次」后不再 prompt');
    ok(dismissed.availableUpdateCount === 1, '忽略提示仍保留可用更新计数');
    ok(fs.existsSync(path.join(stateDir, 'updates.json')), 'dismiss 落盘到 updates.json');

    fs.writeFileSync(path.join(other, 'd.txt'), 'd\n');
    git(['add', '.'], other);
    git(['commit', '-m', 'feat: add d'], other);
    git(['push', 'origin', 'main'], other);
    st = await svc.check({ fetch: true });
    ok(st.showPrompt === true, '远端又有新提交 → 重新提示（dismiss 只对上一版生效）');
  }

  console.log('## 5. 应用更新：只快进，且拒绝被 blocked 的组件');
  {
    const svc = createUpdatesService({
      stateDir,
      components: () => [{ id: 'core', name: '本体', dir: work }],
      blockedReason: () => '',
    });
    await svc.check({ fetch: true });
    const headBefore = git(['rev-parse', 'HEAD'], work);
    process.env.SURFCORE_UPDATE_NO_SPAWN = '1'; // 测试里不起"等宿主退出"的进程
    const result = await svc.apply(['core']);
    delete process.env.SURFCORE_UPDATE_NO_SPAWN;
    // 2026-10-29 起：暂存（staged）不算"已更新"，单列为 pendingRestart；updated 只统计真正落地的
    ok(result.ok === true && result.updated === 0 && result.pendingRestart === 1,
      `git 更新排队成功（updated=${result.updated} pendingRestart=${result.pendingRestart}）`);
    // 2026-10-28 起：git 更新也必须等宿主退出后再 merge（进程内 merge 会动正在加载的文件）
    ok(git(['rev-parse', 'HEAD'], work) === headBefore, '宿主进程内不改工作区（更新排队到退出后）');
    ok(result.results[0]?.staged === true, 'git 更新标记为 staged（退出后应用）');
    ok(result.restartRequired === true, '提示需要重启');
    const pendingPath = path.join(stateDir, 'updates-pending.json');
    const queued = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
    ok(queued.fromHead === headBefore && queued.targetSha === git(['rev-parse', 'origin/main'], work) && queued.expectedBranch === 'main' && queued.policy === 'ff-only' && queued.txn, '排队任务固定 fromHead/targetSha/branch/policy/txn');
    process.env.SURFCORE_UPDATE_NO_SPAWN = '1';
    const duplicate = await svc.apply(['core']);
    delete process.env.SURFCORE_UPDATE_NO_SPAWN;
    ok(!duplicate.ok && duplicate.results[0].code === 'stage.pending-exists' && duplicate.results[0].hint, '拒绝覆盖已有排队任务');
    ok(JSON.parse(fs.readFileSync(pendingPath, 'utf8')).txn === queued.txn, '并发拒绝保留原排队任务');
    // A failed second attempt is independent of the successfully queued first job.
    const stagedSvc = createUpdatesService({ stateDir, components: () => [{ id: 'core', name: '本体', dir: work }] });
    const rollback = await stagedSvc.rollback('core');
    ok(!rollback.ok && rollback.code === 'rollback.git-manual' && rollback.hint, 'Git 回滚不会用 ZIP 文件拷贝覆盖仓库');
    const afterStage = await svc.check({ fetch: true });
    ok(afterStage.pendingCount === 0, 'staged 后再次检查不再把同一更新当 pending');
    ok(afterStage.availableUpdateCount === 1, '已排队更新仍计入远端可用更新');
    ok(afterStage.lastApply?.status === 'failed' && afterStage.lastApply.code === 'stage.pending-exists', '并发排队失败在状态中可见');
    const missingHelperState = path.join(base, 'missing-helper-state');
    const missingHelperSvc = createUpdatesService({ stateDir: missingHelperState, components: () => [{ id: 'core', name: '本体', dir: work }] });
    process.env.SURFCORE_UPDATE_HELPER = path.join(base, 'missing-helper.mjs');
    process.env.SURFCORE_UPDATE_NO_SPAWN = '1';
    const missingHelper = await missingHelperSvc.apply(['core']);
    delete process.env.SURFCORE_UPDATE_HELPER; delete process.env.SURFCORE_UPDATE_NO_SPAWN;
    ok(!missingHelper.ok && missingHelper.results[0].code === 'stage.helper-missing' && missingHelper.results[0].hint && missingHelper.pendingRestart === 0, '助手缺失的 stage 失败不报告排队成功');
    ok(!fs.existsSync(path.join(missingHelperState, 'updates-pending.json')), 'stage 失败不遗留 pending');
    const appliedDir = path.join(missingHelperState, 'updates-applied'); fs.mkdirSync(appliedDir);
    fs.writeFileSync(path.join(appliedDir, 'later.json'), JSON.stringify({ component: 'core', kind: 'git', verified: true, fromHead: headBefore, targetSha: queued.targetSha, resultHead: queued.targetSha, backupRef: 'refs/surfcore-backups/example', at: new Date(Date.now() + 1000).toISOString() }));
    const latestApply = missingHelperSvc.status().lastApply;
    ok(latestApply.status === 'success' && latestApply.kind === 'git' && latestApply.backupRef && latestApply.resultHead === queued.targetSha, '助手较新成功证据覆盖旧 stage 失败并暴露 Git 备份信息');

    // blocked 的组件不动
    const blockedSvc = createUpdatesService({
      stateDir: path.join(base, 'state2'),
      components: () => [{ id: 'core', name: '本体', dir: work }],
      blockedReason: () => '桌宠正在运行，先停止再更新',
    });
    fs.mkdirSync(path.join(base, 'state2'), { recursive: true });
    fs.writeFileSync(path.join(other, 'e.txt'), 'e\n');
    git(['add', '.'], other);
    git(['commit', '-m', 'feat: add e'], other);
    git(['push', 'origin', 'main'], other);
    await blockedSvc.check({ fetch: true });
    const blockedApply = await blockedSvc.apply(['core']);
    ok(blockedApply.ok === false && /正在运行/.test(blockedApply.results[0].error), '运行中的组件被拒绝更新');
  }

  console.log('## 6. fork dev 与原作者 main：独立来源、失败不回退、固定提交排队');
  {
    const forkRemote = path.join(base, 'fork.git'), forkWork = path.join(base, 'fork-work'), forkWriter = path.join(base, 'fork-writer');
    git(['-c', 'init.defaultBranch=dev', 'init', '--bare', forkRemote], base);
    git(['clone', remote, forkWork], base);
    git(['switch', '-c', 'dev'], forkWork);
    git(['remote', 'rename', 'origin', 'upstream'], forkWork);
    git(['remote', 'add', 'origin', forkRemote], forkWork);
    fs.writeFileSync(path.join(forkWork, 'local-fork.txt'), 'keep local history\n');
    git(['add', '--', 'local-fork.txt'], forkWork); git(['commit', '-m', 'local fork change'], forkWork);
    git(['push', '-u', 'origin', 'dev'], forkWork);
    git(['clone', forkRemote, forkWriter], base);
    fs.writeFileSync(path.join(forkWriter, 'fork-only.txt'), 'fork remote only\n');
    git(['add', '--', 'fork-only.txt'], forkWriter); git(['commit', '-m', 'fork remote change'], forkWriter);
    git(['push', 'origin', 'dev'], forkWriter);
    const forkTarget = git(['rev-parse', 'HEAD'], forkWriter);
    fs.writeFileSync(path.join(other, 'author-only.txt'), 'original author only\n');
    git(['add', '--', 'author-only.txt'], other); git(['commit', '-m', 'original author change'], other);
    git(['push', 'origin', 'main'], other);
    const authorTarget = git(['rev-parse', 'HEAD'], other);
    const component = { id: 'surfcore', name: '本体', dir: forkWork, kind: 'git', branch: 'dev', remote: 'upstream', remoteBranch: 'main', versionRepo: 'never/request-http' };
    const before = { head: git(['rev-parse', 'HEAD'], forkWork), index: git(['ls-files', '--stage'], forkWork), config: git(['config', '--local', '--list'], forkWork) };
    const selected = await inspectComponent(component, { fetch: true });
    ok(selected.available && selected.branch === 'dev' && selected.remoteName === 'upstream' && selected.remoteBranch === 'main', '本地 dev 独立读取 upstream/main 并暴露来源');
    ok(selected.remote === authorTarget && selected.remote !== forkTarget && selected.ahead === 1 && selected.behind === 1, '目标 SHA 与提交差异来自原作者，保留本地领先历史');
    ok(selected.policy === 'preserve-local' && !selected.blocked && selected.changelog.some((line) => line.includes('original author change')) && !selected.changelog.some((line) => line.includes('fork remote change')), '原作者 changelog 与 preserve-local 策略一致');
    ok(git(['rev-parse', 'origin/dev'], forkWork) === before.head, 'upstream 检查不会顺便抓取 origin');
    ok(git(['rev-parse', 'HEAD'], forkWork) === before.head && git(['branch', '--show-current'], forkWork) === 'dev'
      && git(['ls-files', '--stage'], forkWork) === before.index && git(['config', '--local', '--list'], forkWork) === before.config
      && git(['status', '--porcelain'], forkWork) === '' && !fs.existsSync(path.join(forkWork, 'author-only.txt')), '检查不切分支、不写工作树/索引内容、不改仓库配置');
    const defaults = await inspectComponent({ id: 'surfcore', dir: forkWork, branch: 'dev' }, { fetch: true });
    ok(defaults.remoteName === 'origin' && defaults.remoteBranch === 'dev' && defaults.remote === forkTarget, '未配置来源仍检查 origin/本地分支');
    const mismatch = await inspectComponent({ ...component, branch: 'main' }, { fetch: true });
    ok(mismatch.code === 'git.branch-mismatch' && mismatch.hint, '独立来源不会绕过本地分支保护');
    const missingBranch = await inspectComponent({ ...component, remoteBranch: undefined }, { fetch: true });
    ok(!missingBranch.available && missingBranch.code === 'git.fetch-failed' && missingBranch.remoteBranch === 'dev' && missingBranch.hint, '未配置 remoteBranch 时沿用本地分支；远端不存在就报错');
    const missingRemote = await inspectComponent({ ...component, remote: 'missing-upstream' }, { fetch: true });
    ok(!missingRemote.available && missingRemote.code === 'git.remote-missing' && missingRemote.hint && missingRemote.remoteName === 'missing-upstream', '显式远端缺失不会回退 origin 或 HTTP');
    for (const value of ['--upload-pack=unexpected', '../outside', 'https://example.test/unused.git', 'upstream\0hidden', 17]) {
      const invalid = await inspectComponent({ ...component, remote: value }, { fetch: true });
      ok(!invalid.available && invalid.code === 'git.invalid-remote' && invalid.error && invalid.hint, '非法 remote 被结构化拒绝');
    }
    for (const value of ['--all', 'main:refs/heads/dev', '../main', 'main\0hidden', {}]) {
      const invalid = await inspectComponent({ ...component, remoteBranch: value }, { fetch: true });
      ok(!invalid.available && invalid.code === 'git.invalid-remote-branch' && invalid.error && invalid.hint, '非法 remoteBranch 被结构化拒绝');
    }
    git(['remote', 'set-url', 'upstream', path.join(base, 'missing-upstream.git')], forkWork);
    const failedSvc = createUpdatesService({ stateDir: path.join(base, 'failed-upstream'), components: () => [component] });
    const failed = await failedSvc.check({ fetch: true });
    ok(failed.results[0].code === 'git.fetch-failed' && failed.results[0].hint && failed.results[0].remoteName === 'upstream'
      && failed.unknownCount === 1 && failed.availableUpdateCount === 0, 'upstream fetch 失败不使用已有缓存或可用的 origin');
    git(['remote', 'set-url', 'upstream', remote], forkWork);
    const forkState = path.join(base, 'fork-state');
    const svc = createUpdatesService({ stateDir: forkState, components: () => [component] });
    process.env.SURFCORE_UPDATE_NO_SPAWN = '1';
    let staged;
    try { staged = await svc.apply(['surfcore']); } finally { delete process.env.SURFCORE_UPDATE_NO_SPAWN; }
    ok(staged.ok && staged.pendingRestart === 1 && staged.updated === 0, 'dev 上的上游更新只排队，不在宿主内应用');
    const queued = JSON.parse(fs.readFileSync(path.join(forkState, 'updates-pending.json'), 'utf8'));
    ok(queued.expectedBranch === 'dev' && queued.fromHead === before.head && queued.targetSha === authorTarget
      && queued.policy === 'preserve-local' && queued.remoteName === 'upstream' && queued.remoteBranch === 'main' && queued.txn, 'dev 排队固定原作者 SHA、本地 HEAD/分支、策略和来源');
    ok(git(['rev-parse', 'HEAD'], forkWork) === before.head && git(['status', '--porcelain'], forkWork) === ''
      && fs.readFileSync(path.join(forkWork, 'local-fork.txt'), 'utf8') === 'keep local history\n'
      && !fs.existsSync(path.join(forkWork, 'author-only.txt')) && !fs.existsSync(path.join(forkWork, 'fork-only.txt')), '排队后本地文件和提交保持不变');
    ok(networkCalls === 0, 'Git 来源失败没有发起任何 HTTP fallback');
  }

  console.log('## 7. 版本号比较（semver，不是字符串比较）');
  {
    ok(compareVersions('0.10.0', '0.9.0') === 1, '0.10.0 > 0.9.0');
    ok(compareVersions('0.2.0', '0.2.0') === 0, '同版本相等');
    ok(compareVersions('v0.3', '0.2.9') === 1, 'v 前缀照常比较');
    ok(compareVersions('1.0.0-beta', '1.0.0') === -1, '预发布低于正式版');
    ok(compareVersions('2', '1.9.9') === 1, '位数不同也能比');
  }

  console.log('## 8. release 通道：读已装版本 + 比 version.json（桌宠这类 zip 安装）');
  {
    const petDir = path.join(base, 'petapp');
    fs.mkdirSync(petDir, { recursive: true });
    fs.writeFileSync(path.join(petDir, 'package.json'), JSON.stringify({ name: 'feiyu-pet', version: '0.2.0' }));
    const pack = path.join(base, 'pet-pack.zip');
    fs.writeFileSync(pack, 'fake-zip-bytes');
    const sha = createHash('sha256').update(fs.readFileSync(pack)).digest('hex');
    const manifest = path.join(base, 'version.json');
    fs.writeFileSync(manifest, JSON.stringify({
      version: '0.3.0',
      notes: 'fix: 气泡不消失\nfeat: 专注模式',
      file: { url: `file://${pack.replace(/\\/g, '/')}`, sha256: sha, size: fs.statSync(pack).size },
    }));

    const component = {
      id: 'surfpet', name: '桌宠', dir: petDir, kind: 'release',
      versionUrl: `file://${manifest.replace(/\\/g, '/')}`, versionFile: 'package.json',
    };
    const checked = await inspectComponent(component, { fetch: true });
    ok(checked.available === true && checked.channel === 'release', 'release 通道可用');
    ok(checked.installedVersion === '0.2.0' && checked.latestVersion === '0.3.0', `读出已装/最新版本（${checked.installedVersion} → ${checked.latestVersion}）`);
    ok(checked.updateAvailable === true && checked.behind === 1, '版本更高 → 有更新');
    ok(checked.changelog.length === 2, 'notes 折成 changelog');

    // 装了新版后：不再提示
    fs.writeFileSync(path.join(petDir, 'package.json'), JSON.stringify({ name: 'feiyu-pet', version: '0.3.0' }));
    const upToDate = await inspectComponent(component, { fetch: true });
    ok(upToDate.updateAvailable === false, '已是最新时不提示');

    // 应用更新：下载 → sha256 校验 → 交给 installZip
    let received = null;
    let receivedBytes = null;
    let receivedExisted = false;
    const svc = createUpdatesService({
      stateDir: path.join(base, 'state-pet'),
      components: () => [{
        ...component,
        installZip: async (zipPath) => {
          received = zipPath;
          receivedExisted = fs.existsSync(zipPath);
          receivedBytes = receivedExisted ? fs.readFileSync(zipPath, 'utf8') : null;
          return { ok: true };
        },
      }],
      pluginLog: () => {},
    });
    fs.mkdirSync(path.join(base, 'state-pet'), { recursive: true });
    fs.writeFileSync(path.join(petDir, 'package.json'), JSON.stringify({ name: 'feiyu-pet', version: '0.2.0' }));
    await svc.check({ fetch: true });
    const applied = await svc.apply(['surfpet']);
    ok(applied.ok === true && applied.updated === 1, `release 更新成功（updated=${applied.updated}）`);
    ok(receivedExisted && receivedBytes === 'fake-zip-bytes', '安装器收到的就是下载好的包');
    ok(received && !fs.existsSync(received), '安装完成后临时包被清理');
  }

  console.log('## 9. release 通道：sha256 不对必须拒绝');
  {
    const dir = path.join(base, 'petapp2');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', version: '0.1.0' }));
    const pack = path.join(base, 'bad.zip');
    fs.writeFileSync(pack, 'tampered');
    const manifest = path.join(base, 'bad-version.json');
    fs.writeFileSync(manifest, JSON.stringify({
      version: '0.2.0',
      file: { url: `file://${pack.replace(/\\/g, '/')}`, sha256: 'deadbeef' },
    }));
    let called = false;
    const svc = createUpdatesService({
      stateDir: path.join(base, 'state-bad'),
      components: () => [{
        id: 'surfpet', name: '桌宠', dir: dir, kind: 'release',
        versionUrl: `file://${manifest.replace(/\\/g, '/')}`,
        installZip: async () => { called = true; return { ok: true }; },
      }],
    });
    fs.mkdirSync(path.join(base, 'state-bad'), { recursive: true });
    await svc.check({ fetch: true });
    const applied = await svc.apply(['surfpet']);
    ok(applied.ok === false && /校验失败/.test(applied.results[0].error), `校验失败被拒（${applied.results[0].error}）`);
    ok(called === false, '校验没过就不会调用安装器');
  }

  {
    const plain = path.join(base, 'not-a-repo');
    fs.mkdirSync(plain, { recursive: true });
    const r = await inspectComponent({ id: 'x', name: 'X', dir: plain }, { fetch: true });
    ok(r.available === false && /git/.test(r.reason), `不可查原因可读（${r.reason}）`);
    const svc = createUpdatesService({ stateDir, components: () => [{ id: 'x', name: 'X', dir: plain }] });
    const st = await svc.check({ fetch: false });
    ok(st.pendingCount === 0, '不可查的组件不会算进 pending');
  }
  {
    const updatesSrc = fs.readFileSync(new URL('../lib/updates.js', import.meta.url), 'utf8');
    const clientSrc = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
    ok(updatesSrc.includes('stagedTargets'), 'staged 用下载前捕获的目标键，不能从 no-fetch 结果算 vnull');
    ok(updatesSrc.includes("phase: 'extract'") && updatesSrc.includes("'pending'"), '下载/解压/排队阶段可上报');
    ok(clientSrc.includes('phaseText') && clientSrc.includes('onStaged') && clientSrc.includes('dl.percent') && clientSrc.includes('indeterminate: !dl || dl.percent == null'),
      '进度条保留下载统计、有百分比时不再跑马灯，staged 后弹重启提示');
  }
} finally {
  global.fetch = originalFetch;
  for (const [key, value] of originalGitEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
}

console.log(failures === 0 ? '\n✅ 组件更新回归通过' : `\n❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
