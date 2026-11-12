#!/usr/bin/env node
// Offline, real Git repositories only. Every ref write stays under this temp root.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-git-apply-'));
const helper = fileURLToPath(new URL('./apply-update.mjs', import.meta.url));
const emptyConfig = path.join(base, 'empty.gitconfig');
fs.writeFileSync(emptyConfig, '');
const env = { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_SYSTEM: emptyConfig,
  GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', ELECTRON_RUN_AS_NODE: '1' };
for (const key of Object.keys(env)) if (/^GIT_(AUTHOR|COMMITTER)_/.test(key) || /^GIT_CONFIG_(COUNT|KEY_|VALUE_)/.test(key)) delete env[key];
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', ...args],
  { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (dir, name, text) => { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), text); };
const commit = (dir, name, text) => { put(dir, name, text); git(dir, 'add', '--', name); git(dir, 'commit', '-m', 'fixture ' + name); return git(dir, 'rev-parse', 'HEAD'); };
const head = (dir) => git(dir, 'rev-parse', 'HEAD');
const clean = (dir) => assert.equal(git(dir, 'status', '--porcelain=v1', '--untracked-files=all'), '');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
let count = 0, initial, targetSha, remote;
function fixture(name, diverge = false) {
  const root = path.join(base, name), repo = path.join(root, 'repo'), state = path.join(root, 'state');
  fs.mkdirSync(state, { recursive: true });
  git(base, 'clone', remote, repo);
  git(repo, 'reset', '--hard', initial);
  if (diverge) commit(repo, 'local.txt', 'precious local commit\n');
  const job = { kind: 'git', component: 'surfcore', target: repo, repoRoot: fs.realpathSync(repo),
    gitDir: fs.realpathSync(git(repo, 'rev-parse', '--absolute-git-dir')), expectedBranch: 'main',
    fromHead: head(repo), targetSha, policy: 'preserve-local', txn: name, from: '1.0.0', to: '1.0.0', waitPid: 0 };
  return { repo, state, job, pending: path.join(state, 'updates-pending.json') };
}
async function apply(f) {
  fs.writeFileSync(f.pending, JSON.stringify(f.job));
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, '--pending', f.pending], { env, windowsHide: true, stdio: 'pipe' });
    let output = '';
    child.stdout.on('data', (x) => { output += x; }); child.stderr.on('data', (x) => { output += x; });
    child.once('error', reject); child.once('exit', (code) => resolve(code));
  });
  assert.equal(fs.existsSync(f.pending), false, 'helper removes consumed pending');
  assert.equal(fs.existsSync(f.pending + '.started'), false, 'helper clears started');
  assert.equal(fs.existsSync(f.pending + '.lock'), false, 'helper clears lock');
  if (code !== 0) {
    const result = read(f.pending + '.failed');
    assert.equal(result.ok, false); assert.equal(result.verified, false);
    assert.ok(result.code); assert.ok(result.error); assert.ok(result.hint);
    return result;
  }
  assert.equal(fs.existsSync(f.pending + '.failed'), false);
  const done = fs.readdirSync(path.join(f.state, 'updates-applied')).filter((x) => x.endsWith('.json'));
  return read(path.join(f.state, 'updates-applied', done[0]));
}
function verify(f, result) {
  assert.equal(result.verified, true); assert.equal(result.fromHead, f.job.fromHead);
  assert.equal(result.targetSha, f.job.targetSha); assert.equal(result.resultHead, head(f.repo));
  assert.equal(git(f.repo, 'rev-parse', result.backupRef), f.job.fromHead);
  git(f.repo, 'merge-base', '--is-ancestor', f.job.fromHead, result.resultHead);
  git(f.repo, 'merge-base', '--is-ancestor', f.job.targetSha, result.resultHead);
  assert.equal(git(f.repo, 'branch', '--show-current'), 'main'); clean(f.repo);
  assert.equal(fs.existsSync(path.join(f.repo, '.installed-meta.json')), false);
  assert.equal(fs.existsSync(path.join(f.job.gitDir, 'surfcore-updater.lock')), false);
}
const test = async (name, run) => { await run(); count++; console.log('PASS ' + name); };
try {
  remote = path.join(base, 'remote.git'); const seed = path.join(base, 'seed');
  git(base, '-c', 'init.defaultBranch=main', 'init', '--bare', remote);
  git(base, 'clone', remote, seed);
  put(seed, 'package.json', JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  put(seed, '.gitignore', 'runtime/\n'); put(seed, 'common.txt', 'base\n');
  git(seed, 'add', '--', 'package.json', '.gitignore', 'common.txt'); git(seed, 'commit', '-m', 'initial');
  initial = head(seed); git(seed, 'push', '-u', 'origin', 'main');
  targetSha = commit(seed, 'remote.txt', 'upstream change same version\n'); git(seed, 'push', 'origin', 'main');
  await test('fast-forward fixed SHA succeeds despite equal package version', async () => {
    const f = fixture('ff'); const result = await apply(f); verify(f, result); assert.equal(head(f.repo), targetSha);
  });
  await test('clean divergence preserves both histories and files with fallback identity', async () => {
    const f = fixture('merge', true); const result = await apply(f); verify(f, result);
    assert.equal(git(f.repo, 'show', '-s', '--format=%P', 'HEAD').split(' ').length, 2);
    assert.equal(fs.readFileSync(path.join(f.repo, 'local.txt'), 'utf8'), 'precious local commit\n');
    assert.equal(fs.readFileSync(path.join(f.repo, 'remote.txt'), 'utf8'), 'upstream change same version\n');
    assert.equal(result.identityFallback, true); assert.equal(git(f.repo, 'show', '-s', '--format=%an', 'HEAD'), 'SurfCore Updater');
    assert.equal(git(f.repo, 'config', '--local', '--list').includes('user.name'), false);
  });
  await test('conflict abort restores original clean state and keeps backup', async () => {
    const f = fixture('conflict'); commit(f.repo, 'remote.txt', 'local conflicting content\n'); f.job.fromHead = head(f.repo);
    const result = await apply(f); assert.equal(result.code, 'git.merge-conflict'); assert.equal(result.restored, true);
    assert.ok(result.paths.includes('remote.txt')); assert.equal(head(f.repo), f.job.fromHead); clean(f.repo);
    assert.equal(git(f.repo, 'rev-parse', result.backupRef), f.job.fromHead);
    assert.equal(fs.readFileSync(path.join(f.repo, 'remote.txt'), 'utf8'), 'local conflicting content\n');
  });
  for (const kind of ['dirty', 'staged', 'untracked', 'head', 'branch', 'operation', 'target', 'repo']) await test('reject queued ' + kind + ' drift without changing files', async () => {
    const f = fixture('drift-' + kind);
    const codes = { dirty: 'git.dirty', staged: 'git.dirty', untracked: 'git.dirty', head: 'git.head-drift', branch: 'git.branch-drift', operation: 'git.operation-in-progress', target: 'git.target-missing', repo: 'git.repo-drift' };
    if (kind === 'dirty' || kind === 'staged') { put(f.repo, 'common.txt', 'uncommitted\n'); if (kind === 'staged') git(f.repo, 'add', '--', 'common.txt'); }
    if (kind === 'untracked') put(f.repo, 'my-note.txt', 'untracked\n');
    if (kind === 'head') commit(f.repo, 'new-local.txt', 'newer local commit\n');
    if (kind === 'branch') git(f.repo, 'switch', '-c', 'different');
    if (kind === 'operation') put(f.job.gitDir, 'CHERRY_PICK_HEAD', targetSha + '\n');
    if (kind === 'target') f.job.targetSha = '1'.repeat(40);
    if (kind === 'repo') f.job.repoRoot = f.state;
    const before = head(f.repo), status = git(f.repo, 'status', '--porcelain=v1', '--untracked-files=all');
    const result = await apply(f); assert.equal(result.code, codes[kind]); assert.equal(head(f.repo), before);
    assert.equal(git(f.repo, 'status', '--porcelain=v1', '--untracked-files=all'), status);
  });
  await test('pinned SHA ignores subsequent movement of origin/main', async () => {
    const f = fixture('pinned'); const next = commit(seed, 'later.txt', 'not queued\n'); git(seed, 'push', 'origin', 'main'); git(f.repo, 'fetch', 'origin');
    assert.equal(git(f.repo, 'rev-parse', 'origin/main'), next);
    const result = await apply(f); verify(f, result); assert.equal(head(f.repo), targetSha); assert.equal(fs.existsSync(path.join(f.repo, 'later.txt')), false);
  });
  await test('custom ff-only policy blocks divergence', async () => {
    const f = fixture('ff-policy', true); f.job.policy = 'ff-only'; const result = await apply(f);
    assert.equal(result.code, 'git.diverged'); assert.equal(head(f.repo), f.job.fromHead); clean(f.repo);
  });
  await test('commit hook failure aborts and restores clean state', async () => {
    const f = fixture('hook', true); put(f.job.gitDir, 'hooks/pre-commit', '#!/bin/sh\nexit 1\n');
    fs.chmodSync(path.join(f.job.gitDir, 'hooks/pre-commit'), 0o755);
    const result = await apply(f); assert.equal(result.code, 'git.commit-failed'); assert.equal(result.restored, true); assert.equal(head(f.repo), f.job.fromHead); clean(f.repo);
  });
  await test('post-merge hook foreign clean HEAD is never reset as our transaction', async () => {
    const f = fixture('foreign-head');
    const foreign = git(f.repo, 'commit-tree', git(f.repo, 'rev-parse', targetSha + '^{tree}'), '-m', 'foreign clean head');
    put(f.job.gitDir, 'hooks/post-merge', '#!/bin/sh\ngit update-ref HEAD ' + foreign + '\n');
    fs.chmodSync(path.join(f.job.gitDir, 'hooks/post-merge'), 0o755);
    const result = await apply(f); assert.equal(result.code, 'git.result-drift'); assert.equal(result.restored, false);
    assert.equal(head(f.repo), foreign); assert.equal(result.resultHead, foreign); clean(f.repo);
    assert.equal(git(f.repo, 'rev-parse', result.backupRef), f.job.fromHead);
  });
  await test('null pending job persists actionable failure', async () => {
    const f = fixture('null-job'); f.job = null; const result = await apply(f);
    assert.equal(result.code, 'apply.invalid-job'); assert.equal(head(f.repo), initial); clean(f.repo);
  });
  await test('invalid signing identity failure is persistent and restored', async () => {
    const f = fixture('signing', true); git(f.repo, 'config', 'commit.gpgSign', 'true'); git(f.repo, 'config', 'gpg.program', path.join(base, 'missing-signer'));
    const result = await apply(f); assert.equal(result.code, 'git.commit-failed'); assert.equal(result.restored, true); assert.equal(head(f.repo), f.job.fromHead); clean(f.repo);
  });
  await test('ignored runtime collision never overwrites local data', async () => {
    const f = fixture('ignored'); put(seed, 'runtime/private.txt', 'upstream tracked content\n'); git(seed, 'add', '-f', '--', 'runtime/private.txt'); git(seed, 'commit', '-m', 'track runtime path'); git(seed, 'push', 'origin', 'main'); git(f.repo, 'fetch', 'origin');
    f.job.targetSha = head(seed); put(f.repo, 'runtime/private.txt', 'precious runtime content\n');
    const result = await apply(f); assert.equal(result.code, 'git.ignored-collision'); assert.ok(result.paths.includes('runtime/private.txt'));
    assert.equal(fs.readFileSync(path.join(f.repo, 'runtime/private.txt'), 'utf8'), 'precious runtime content\n'); assert.equal(head(f.repo), f.job.fromHead); clean(f.repo);
  });
  await test('shallow history refuses an unprovable merge', async () => {
    const f = fixture('shallow'); put(f.job.gitDir, 'shallow', initial + '\n'); const result = await apply(f);
    assert.equal(result.code, 'git.history-unproven'); assert.equal(head(f.repo), f.job.fromHead);
  });
  await test('unrelated history refuses a merge', async () => {
    const f = fixture('unrelated'); const tree = git(f.repo, 'rev-parse', targetSha + '^{tree}');
    f.job.targetSha = git(f.repo, 'commit-tree', tree, '-m', 'unrelated root');
    const result = await apply(f); assert.equal(result.code, 'git.history-unproven'); assert.equal(head(f.repo), f.job.fromHead); clean(f.repo);
  });
  await test('repository lock rejects another state-directory transaction', async () => {
    const f = fixture('repo-lock'); put(f.job.gitDir, 'surfcore-updater.lock', String(process.pid));
    const result = await apply(f); assert.equal(result.code, 'git.updater-busy'); assert.equal(head(f.repo), f.job.fromHead);
    assert.equal(fs.readFileSync(path.join(f.job.gitDir, 'surfcore-updater.lock'), 'utf8'), String(process.pid));
  });
  console.log('PASS all ' + count + ' Git helper cases (offline)');
} finally { fs.rmSync(base, { recursive: true, force: true }); }
