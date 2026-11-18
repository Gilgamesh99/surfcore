import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOwnerDesktopPolicy } from '../lib/owner-desktop-policy.js';
import { readOwnerDesktopSettings, normalizeOwnerDesktopSettings, readQqSessionSources, recordQqSessionSources } from '../../../src/owner-desktop-config.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'surf-owner-policy-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
const agent = (id, header = {}) => ({ id, session: { id, title: id, header } });
function fixture() {
  const dir = fs.mkdtempSync(path.join(root, 'case-')); const qq = path.join(dir,'qq'); fs.mkdirSync(qq);
  const entries = new Map(); const agents = { get: (id) => entries.get(id), list: () => [...entries.values()] };
  const ledgerFile = path.join(dir, 'workers.json'); const bili = path.join(dir, 'bili');
  const sourceFile = path.join(qq, 'qq-session-sources.json');
  recordQqSessionSources(sourceFile, [], { initialize: true });
  const options = { ledgerFile, qqStateDir: qq, biliWorkspace: bili, agents, maxWorkers: 3 };
  return { qq, bili, ledgerFile, sourceFile, entries, options, policy: createOwnerDesktopPolicy(options) };
}
test('disabled defaults and malformed authorization fail visibly', () => {
  assert.equal(readOwnerDesktopSettings(path.join(root, 'absent.json')).enabled, false);
  for (const input of [{enabled:true}, {enabled:true,parentSessionId:'root'}, {timeoutMs:86400001}, {parentSessionId:'../root'}]) assert.throws(() => normalizeOwnerDesktopSettings(input), (e) => e.code.startsWith('owner-desktop.') && Boolean(e.hint));
  const f=path.join(root, 'bad-config.json'); fs.writeFileSync(f,'{'); assert.throws(() => readOwnerDesktopSettings(f), {code:'owner-desktop.config-unreadable'});
});
test('duration defaults and explicit numeric unlimited survive configuration reads', () => {
  assert.equal(normalizeOwnerDesktopSettings({}).timeoutMs, 600000);
  const file = path.join(root, 'durations.json');
  for (const timeoutMs of [0, 30000, 600000, 1800000, 86400000]) {
    const value = normalizeOwnerDesktopSettings({ timeoutMs });
    assert.equal(value.timeoutMs, timeoutMs);
    fs.writeFileSync(file, JSON.stringify({ ownerDesktop: value }));
    assert.equal(readOwnerDesktopSettings(file).timeoutMs, timeoutMs);
  }
});
test('coerced zero, invalid numeric limits and non-numbers never mean unlimited', () => {
  for (const timeoutMs of [null, false, true, '', ' ', '0', '600000', [], {}, -1, 29999, 30000.5, 86400001, NaN, Infinity, -Infinity])
    assert.throws(() => normalizeOwnerDesktopSettings({ timeoutMs }), error => error.code === 'owner-desktop.timeout-invalid' && Boolean(error.hint));
});
test('private/group sessions and all modes stay managed, title is not authority', () => {
  const f=fixture(); fs.writeFileSync(path.join(f.qq,'sessions.json'),JSON.stringify({sessions:{'p:42':'private-custom','g:8':'group-custom'}}));
  for(const id of ['private-custom','group-custom','bili-whale','bili-whale-proplus']) assert.equal(f.policy.isManagedAgent(agent(id)),true,id);
  assert.equal(f.policy.isManagedAgent(agent('custom-full',{cwd:path.join(f.qq,'agents')})),true);
  assert.equal(f.policy.isManagedAgent(agent('retired-bili',{cwd:f.bili})),true);
  assert.equal(f.policy.isManagedAgent(agent('safe-preset',{agentPreset:'qq-chat-v2'})),true);
  const ownerNamed=agent('plain'); ownerNamed.session.title='主人私聊'; assert.equal(f.policy.isManagedAgent(ownerNamed),false);
});
test('descendants follow actual registered ancestry; missing and cyclic ancestry denied', () => {
  const f=fixture(); f.entries.set('qq',agent('qq',{agentPreset:'qq-chat'})); f.entries.set('child',agent('child',{parentSession:'qq'}));
  assert.equal(f.policy.isManagedAgent(agent('grandchild',{parentSession:'child'})),true);
  assert.equal(f.policy.isManagedAgent(agent('unknown',{parentSession:'missing'})),true);
  const loop=agent('loop',{parentSession:'loop'});f.entries.set('loop',loop);assert.equal(f.policy.isManagedAgent(loop),true);
  f.entries.set('root',agent('root')); assert.equal(f.policy.isManagedAgent(agent('legitimate-management-child',{parentSession:'root'})),false);
});
test('worker denial survives restart and renamed title without ever granting rights', () => {
  const f=fixture();assert.equal(f.policy.registerWorkerSession('worker-1'),true);assert.equal(f.policy.registerWorkerSession('worker-1'),true);
  const reloaded=createOwnerDesktopPolicy(f.options);const renamed=agent('worker-1');renamed.session.title='普通会话';
  assert.equal(reloaded.isWorkerSession('worker-1'),true);assert.equal(reloaded.isManagedAgent(renamed),true);
  f.entries.set('worker-1',renamed); assert.equal(reloaded.parentSessions().length,0);
});
test('full ledger preserves all previous workers and fails closed', () => {
  const f=fixture();for(let i=1;i<=3;i++)f.policy.registerWorkerSession('worker-'+i);
  f.policy.registerWorkerSession('worker-1');assert.throws(()=>f.policy.registerWorkerSession('worker-4'),{code:'owner-desktop.worker-ledger-full'});
  assert.equal(f.policy.isWorkerSession('worker-1'),true);
});
test('corrupt, deleted or externally locked worker ledger cannot permit a task', () => {
  const f=fixture();f.policy.registerWorkerSession('worker');fs.unlinkSync(f.ledgerFile);
  assert.throws(()=>f.policy.isWorkerSession('worker'),{code:'owner-desktop.worker-ledger-unreadable'});
  const g=fixture();fs.writeFileSync(g.ledgerFile,'{}');assert.throws(()=>g.policy.registerWorkerSession('next'),{code:'owner-desktop.worker-ledger-unreadable'});
  const h=fixture();fs.writeFileSync(h.ledgerFile+'.lock','held');assert.throws(()=>h.policy.registerWorkerSession('next'),{code:'owner-desktop.worker-ledger-write'});assert.equal(fs.existsSync(h.ledgerFile+'.lock'),true);
});
test('QQ provenance survives reset, restart, cwd changes and non-QQ closed-agent presets', () => {
  const f = fixture(); const custom = path.join(root, 'custom-qq-workspace');
  recordQqSessionSources(f.sourceFile, ['retired-closed', 'retired-group'], { cwd: custom });
  fs.writeFileSync(path.join(f.qq, 'sessions.json'), JSON.stringify({ sessions: {} }));
  const reloaded = createOwnerDesktopPolicy(f.options);
  const restored = agent('retired-closed', { agentPreset: 'standard', cwd: path.join(root, 'renamed-workspace') });
  f.entries.set(restored.id, restored); f.entries.set('human', agent('human'));
  assert.equal(reloaded.isManagedAgent(restored), true);
  assert.equal(reloaded.isManagedAgent(agent('unknown-old-cwd', { cwd: custom })), true);
  assert.equal(reloaded.isWorkerSession('retired-closed'), false, 'social origin must not deny ordinary QQ tools');
  assert.deepEqual(reloaded.parentSessions().map(row => row.id), ['human']);
});
test('missing, corrupt, locked and previously deleted QQ source records fail closed visibly', () => {
  for (const mode of ['missing', 'corrupt', 'locked']) {
    const f = fixture(); f.entries.set('human', agent('human'));
    if (mode === 'missing') fs.unlinkSync(f.sourceFile);
    if (mode === 'corrupt') fs.writeFileSync(f.sourceFile, '{}');
    if (mode === 'locked') fs.writeFileSync(f.sourceFile + '.lock', 'held');
    const visible = error => error.code.startsWith('owner-desktop.qq-source-') && Boolean(error.hint);
    assert.throws(() => f.policy.isManagedAgent(agent('unknown')), visible, mode);
    assert.throws(() => f.policy.parentSessions(), visible, mode);
    assert.throws(() => recordQqSessionSources(f.sourceFile, [], { initialize: true }), visible, mode);
    if (mode === 'missing') assert.equal(fs.existsSync(f.sourceFile), false, 'lost ledger must not become fresh migration');
  }
});
test('QQ source capacity preserves every identity and never evicts to admit a new task', () => {
  const f = fixture(); const ids = Array.from({ length: 10000 }, (_, index) => 'qq-' + index);
  recordQqSessionSources(f.sourceFile, ids);
  const before = fs.readFileSync(f.sourceFile, 'utf8');
  assert.throws(() => recordQqSessionSources(f.sourceFile, ['overflow']), { code: 'owner-desktop.qq-source-full' });
  assert.equal(fs.readFileSync(f.sourceFile, 'utf8'), before);
  assert.equal(readQqSessionSources(f.sourceFile).sessions.length, 10000);
  assert.throws(() => recordQqSessionSources(f.sourceFile, ['../forged']), { code: 'owner-desktop.qq-source-invalid' });
});

test('management list excludes QQ, Bili, child and retired worker sessions', () => {
  const f=fixture();for(const a of [agent('human'),agent('qq',{agentPreset:'qq-chat-v2'}),agent('bili-whale'),agent('child',{parentSession:'human'}),agent('worker')])f.entries.set(a.id,a);
  f.policy.registerWorkerSession('worker');assert.deepEqual(f.policy.parentSessions().map(r=>r.id),['human']);
});
