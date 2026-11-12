#!/usr/bin/env node
/** Deferred updater: never overwrite a plugin loaded by a live DSH host.
 * Git jobs pin repoRoot/gitDir, expectedBranch, fromHead, targetSha and policy.
 * ZIP jobs retain the existing copy/manifest/version verification contract.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const pendingArg = args.indexOf('--pending');
if (pendingArg < 0 || !args[pendingArg + 1]) { console.error('Missing --pending'); process.exit(2); }
const pendingFile = path.resolve(args[pendingArg + 1]);
let pending = {}, ownsJob = false, ownsLock = false;
const lockFile = pendingFile + '.lock';
const defaultHint = '查看更新记录，保留备份并处理失败原因后重新检查；不要用 ZIP 覆盖 Git 工作区';
const log = (message) => {
  const line = '[' + new Date().toISOString() + '] ' + message + '\n';
  try { fs.appendFileSync(pending.logFile || path.join(path.dirname(pendingFile), 'apply-update.log'), line); } catch {}
  console.log(line.trim());
};
function failure(code, message, hint = defaultHint, extra = {}) {
  return Object.assign(new Error(message), { code, hint, ...extra });
}
function alive(pid) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
async function waitExit(pid) {
  const start = Date.now();
  while (alive(pid)) {
    if (Date.now() - start >= 60 * 60_000) throw failure('stage.expired', '等待宿主退出已超过 60 分钟', '上次暂存已过期：重新检查并排队更新');
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
}
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
function copyZip(staging, target) {
  // robocopy 比 cpSync 可靠：能处理大量文件、失败会返回码。
  // 2026-10-29：从 /MIR 改成 /E —— **只覆盖、不删除**。
  // /MIR 会删掉"源里没有"的文件，连用户自建文件一起删；现在宁可留旧文件也不误删。
  const exDirs = ['state', 'backups', 'node_modules', '.git', 'logs', 'staging', 'pet', 'characters', 'voice-packs', 'tmp-update*'];
  const exFiles = ['config.json', 'bili.config.json', 'updates-pending.json'];
  const argv = [
    staging, target,
    '/E',
    '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:2', '/W:1',
    '/XD', ...exDirs,
    '/XF', ...exFiles,
  ];
  try {
    execFileSync('robocopy', argv, { windowsHide: true, stdio: 'pipe', timeout: 10 * 60_000 });
    return { ok: true };
  } catch (error) {
    // robocopy: 0/1 成功，>=8 失败
    const code = Number(error?.status ?? -1);
    if (code >= 0 && code < 8) return { ok: true, code };
    const detail = `${error?.stdout || ''}${error?.stderr || ''}`.trim().slice(-500);
    return { ok: false, error: `robocopy 失败（exit ${code}）：${detail}` };
  }
}


function gitTransaction(job) {
  const { target, repoRoot, gitDir, fromHead, targetSha, expectedBranch, policy, txn } = job;
  const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
  if (!target || !repoRoot || !gitDir || !sha.test(fromHead || '') || !sha.test(targetSha || '') || !expectedBranch || !txn || !['ff-only', 'preserve-local'].includes(policy)) {
    throw failure('git.invalid-job', 'Git 更新任务缺少固定提交或仓库状态', '旧任务不可安全执行：重新检查并排队更新');
  }
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_MERGE_AUTOEDIT: 'no', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_NO_REPLACE_OBJECTS: '1' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']) delete env[key];
  const run = (argv, config = []) => {
    try {
      return { ok: true, code: 0, stdout: execFileSync('git', ['-C', target, ...config, ...argv], { encoding: 'utf8', env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }) };
    } catch (error) { return { ok: false, code: error.status, stdout: String(error.stdout || '') }; }
  };
  const must = (argv, code = 'git.command-failed', config = [], raw = false) => {
    const r = run(argv, config);
    if (!r.ok) throw failure(code, 'Git 操作失败：' + argv[0], '检查 Git 仓库权限、配置及 hooks，保留备份后重试');
    return raw ? r.stdout : r.stdout.trim();
  };
  const canonical = (p) => { const real = fs.realpathSync(p); return process.platform === 'win32' ? real.toLowerCase() : real; };
  const head = () => must(['rev-parse', '--verify', 'HEAD^{commit}']);
  const branch = () => must(['symbolic-ref', '--quiet', '--short', 'HEAD'], 'git.branch-drift');
  const clean = () => !must(['status', '--porcelain=v1', '--untracked-files=all'], 'git.status-failed');
  const marker = (name) => path.resolve(target, must(['rev-parse', '--git-path', name]));
  const operations = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_LOG', 'index.lock'];
  const noOperation = () => !operations.some((name) => fs.existsSync(marker(name)));
  const identity = () => {
    if (canonical(target) !== canonical(repoRoot) || canonical(must(['rev-parse', '--show-toplevel'])) !== canonical(repoRoot)
      || canonical(must(['rev-parse', '--absolute-git-dir'])) !== canonical(gitDir)) throw failure('git.repo-drift', '排队后仓库目录发生变化');
  };
  const validate = () => {
    identity();
    if (branch() !== expectedBranch) throw failure('git.branch-drift', '排队后当前分支发生变化', '切回已检查的分支后重新检查，不会自动切换分支');
    if (head() !== fromHead) throw failure('git.head-drift', '排队后本地 HEAD 发生变化', '保留新提交，重新检查并排队更新');
    if (!noOperation()) throw failure('git.operation-in-progress', '已有 Git 操作尚未结束', '先自行完成或中止现有操作，再重新检查');
    if (!clean()) throw failure('git.dirty', '排队后出现未提交或未跟踪文件', '先自行保存并提交本地改动，再重新检查');
  };
  validate();
  const repositoryLock = marker('surfcore-updater.lock');
  try { fs.writeFileSync(repositoryLock, String(process.pid), { flag: 'wx' }); }
  catch { throw failure('git.updater-busy', '此仓库已有更新事务锁', '确认其他助手已退出后，由维护者检查并移除 Git 元数据目录里的 surfcore-updater.lock 再重试'); }
  try {
  if (must(['rev-parse', '--verify', targetSha + '^{commit}'], 'git.target-missing') !== targetSha) throw failure('git.target-missing', '固定目标提交不可读取');
  if (must(['rev-parse', '--is-shallow-repository']) !== 'false' || !run(['merge-base', fromHead, targetSha]).ok) throw failure('git.history-unproven', '浅历史或无共同祖先，无法证明安全合并', '人工检查并补全仓库历史后再试');
  // Replace/graft history would make ancestry verification claim something untrue.
  if (must(['replace', '-l']) || fs.existsSync(marker('info/grafts'))) throw failure('git.history-rewritten', '存在 replace/graft 历史替换', '先人工检查历史替换配置，再重新检查');
  const ancestor = (a, b) => {
    const r = run(['merge-base', '--is-ancestor', a, b]);
    if (!r.ok && r.code !== 1) throw failure('git.ancestry-failed', '无法验证提交祖先关系');
    return r.ok;
  };
  const ff = ancestor(fromHead, targetSha);
  if (!ff && policy !== 'preserve-local') throw failure('git.diverged', '当前组件只允许快进更新', '保留本地提交，人工合并或显式启用 preserve-local 策略');
  // Ignored runtime files must survive even if the upstream starts tracking their paths.
  const ignored = must(['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], 'git.ignored-scan-failed', [], true).split('\0').filter(Boolean);
  const tracked = must(['ls-tree', '-r', '--name-only', '-z', targetSha], 'git.tree-scan-failed', [], true).split('\0').filter(Boolean);
  const fold = (p) => process.platform === 'win32' ? p.toLowerCase() : p;
  const collisions = ignored.filter((a) => tracked.some((b) => { a = fold(a); b = fold(b); return a === b || a.startsWith(b + '/') || b.startsWith(a + '/'); }));
  if (collisions.length) throw failure('git.ignored-collision', '远端文件与本地忽略的运行数据冲突', '先备份并自行迁移冲突文件，再重新检查', { paths: collisions.slice(0, 30) });
  const identityConfig = [];
  for (const [key, fallback] of [['user.name', 'SurfCore Updater'], ['user.email', 'surfcore-updater@localhost']]) {
    const setting = run(['config', '--get', key]);
    if (!setting.ok && setting.code !== 1) throw failure('git.identity-failed', '无法读取 Git 提交身份');
    if (!setting.stdout.trim()) identityConfig.push('-c', key + '=' + fallback);
  }
  // Command-local identity only: never mutate global or repository configuration.
  const mergeConfig = ['-c', 'merge.autoStash=false', '-c', 'rerere.enabled=false', ...identityConfig];
  validate();
  const backupRef = 'refs/surfcore-backups/' + Date.now() + '-' + randomUUID();
  must(['update-ref', backupRef, fromHead, '0'.repeat(fromHead.length)], 'git.backup-failed');
  job.backupRef = backupRef;
  let touched = false, committedHead = '', observedHead = '';
  try {
    validate();
    touched = true;
    const merged = run(['merge', ff ? '--ff-only' : '--no-ff', '--no-commit', '--no-edit', '--no-autostash', '--no-overwrite-ignore', targetSha], mergeConfig);
    if (!merged.ok) {
      const conflicts = must(['diff', '--name-only', '--diff-filter=U', '-z'], 'git.conflict-scan-failed', [], true).split('\0').filter(Boolean);
      throw failure(conflicts.length ? 'git.merge-conflict' : 'git.merge-failed', conflicts.length ? '更新与本地提交冲突，已停止合并' : 'Git 合并失败', '保留本地提交，按冲突文件人工合并后重新检查', { paths: conflicts });
    }
    if (!ff) {
      if (head() !== fromHead || branch() !== expectedBranch || must(['rev-parse', 'MERGE_HEAD']) !== targetSha) throw failure('git.merge-state-drift', '合并过程中仓库状态发生变化');
      must(['commit', '--no-edit', '-m', 'Merge SurfCore update ' + targetSha.slice(0, 12)], 'git.commit-failed', identityConfig);
    }
    observedHead = head();
    const parents = must(['show', '-s', '--format=%P', observedHead]);
    if ((ff && observedHead !== targetSha) || (!ff && parents !== fromHead + ' ' + targetSha)) throw failure('git.result-drift', '钩子或其他进程改变了预期更新提交', '保留当前现场与备份，由维护者检查提交；不会自动重置不属于本事务的提交');
    committedHead = observedHead;
    identity();
    if (branch() !== expectedBranch || !clean() || !noOperation()
      || !ancestor(fromHead, committedHead) || !ancestor(targetSha, committedHead)) throw failure('git.verify-failed', '更新后提交历史、分支或工作区验证失败');
    return { verified: true, fromHead, targetSha, resultHead: committedHead, backupRef, policy, txn, identityFallback: identityConfig.length > 0 };
  } catch (error) {
    let restored = false;
    try {
      identity();
      if (touched && branch() === expectedBranch) {
        if (head() === fromHead && fs.existsSync(marker('MERGE_HEAD')) && must(['rev-parse', 'MERGE_HEAD']) === targetSha) must(['merge', '--abort'], 'git.abort-failed', ['-c', 'merge.autoStash=false']);
        // Only our own committed, exactly matching clean result may be reset.
        else if (committedHead && head() === committedHead && noOperation() && clean()) must(['reset', '--merge', fromHead], 'git.restore-failed');
        restored = head() === fromHead && clean() && noOperation();
      }
    } catch {}
    throw failure(error.code || 'git.apply-failed', error.message, restored ? error.hint : '恢复验证未通过：停止自动重试，保留现场；用 git show ' + backupRef + ' 检查原提交并请维护者协助恢复', { paths: error.paths || [], backupRef, restored, resultHead: observedHead || committedHead, causeCode: error.code });
  }
  } finally { try { fs.rmSync(repositoryLock); } catch {} }
}

try {
  // One helper per pending file. A live helper must never be duplicated on resume.
  try { fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' }); ownsLock = true; }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = Number(fs.readFileSync(lockFile, 'utf8'));
    if (!owner || alive(owner)) { console.error('Updater already running or lock unreadable'); process.exit(6); }
    fs.rmSync(lockFile);
    fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' }); ownsLock = true;
  }
  ownsJob = true;
  const parsed = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw failure('apply.invalid-job', '更新任务格式无效');
  pending = parsed;
  writeJson(pendingFile + '.started', { pid: process.pid, txn: pending.txn, at: new Date().toISOString() });
  if (!['zip', 'git'].includes(pending.kind)) throw failure('apply.unknown-kind', '未知更新任务类型：' + String(pending.kind));
  log('等待 DSH 宿主退出');
  await waitExit(pending.waitPid);
  // The captured job must still be the job on disk after the host exits.
  const current = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  if (JSON.stringify(current) !== JSON.stringify(pending)) throw failure('stage.job-changed', '等待期间更新任务被修改', '重新检查并排队更新');
  let result = {};
  if (pending.kind === 'git') { result = gitTransaction(pending); Object.assign(pending, result); }
  else {
    const copied = copyZip(pending.staging, pending.target);
    if (!copied.ok) throw failure(copied.code || 'apply.failed', copied.error, '备份与 staging 仍保留；检查文件占用或权限后重试');
    const manifest = path.join(pending.staging, 'release', 'install-manifest.json');
    if (fs.existsSync(manifest)) fs.copyFileSync(manifest, path.join(pending.target, '.installed-manifest.json'));
    if (pending.meta) writeJson(path.join(pending.target, '.installed-meta.json'), { ...pending.meta, at: new Date().toISOString() });
  }
  let version = '';
  try { version = String(JSON.parse(fs.readFileSync(path.join(pending.target, 'package.json'), 'utf8')).version ?? ''); } catch {}
  // Git success is ancestry + clean state, never a semver-to-SHA comparison.
  if (pending.kind === 'zip' && pending.to && version.replace(/^v/i, '') !== String(pending.to).replace(/^v/i, '')) throw failure('verify.version-mismatch', '更新后版本不一致：期望 ' + pending.to + '，实际 ' + version, '发布包与清单不一致：手动下载该版本，重试无效');
  const doneDir = path.join(path.dirname(pendingFile), 'updates-applied');
  fs.mkdirSync(doneDir, { recursive: true });
  writeJson(path.join(doneDir, Date.now() + '-' + randomUUID() + '.json'), {
    component: pending.component, kind: pending.kind, from: pending.from || '', to: pending.to, version,
    verified: true, txn: pending.txn || '', backup: pending.backup || '', ...result, at: new Date().toISOString(),
  });
  if (pending.kind === 'zip') {
    try { fs.rmSync(pending.staging, { recursive: true, force: true }); } catch {}
    try {
      const stagingRoot = path.resolve(path.dirname(pendingFile), 'staging');
      const parent = path.resolve(path.dirname(pending.staging));
      if (parent.startsWith(stagingRoot + path.sep)) fs.rmSync(parent, { recursive: true, force: true });
    } catch {}
  }
  fs.rmSync(pendingFile, { force: true });
  fs.rmSync(pendingFile + '.failed', { force: true });
  log('更新完成并验证');
} catch (error) {
  log('更新失败：' + String(error.message || error));
  if (ownsJob) {
    try {
      writeJson(pendingFile + '.failed', { ...pending, ok: false, verified: false, error: String(error.message || error), code: error.code || 'apply.exception', hint: error.hint || defaultHint,
        backupRef: error.backupRef || pending.backupRef || '', resultHead: error.resultHead || pending.resultHead || '', restored: error.restored === true, paths: error.paths || [], at: new Date().toISOString() });
      fs.rmSync(pendingFile, { force: true });
    } catch (persistError) { console.error('Cannot persist updater failure: ' + persistError.message); }
  }
  process.exitCode = 5;
} finally {
  if (ownsJob) { try { fs.rmSync(pendingFile + '.started', { force: true }); } catch {} }
  if (ownsLock) { try { fs.rmSync(lockFile, { force: true }); } catch {} }
}
