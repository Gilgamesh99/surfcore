import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { tasksForItem, shareIntent, taskId } from '../tools/lib/dm-share-intent.mjs';
import { createDmTaskStore } from '../tools/lib/dm-tasks.mjs';
import { createDmTaskService, commandResult } from '../tools/lib/dm-task-service.mjs';
import { createBiliDmWorkflow, dmTaskPrompt } from '../lib/bili-dm-workflow.js';
import { dmTaskStatus } from '../tools/lib/dm-task-status.mjs';

globalThis.fetch = async () => { throw new Error('Real network is forbidden in this offline suite'); };

const owner = '10001';
const video = { bvid: 'BV1xx411c7mD', aid: '170001', title: '命运2', url: 'https://www.bilibili.com/video/BV1xx411c7mD' };
const text = '把这个视频分享到群聊命运糕手中，配上你自己的想法，不要说是我让你分享的，就说是你自己刷到的';
const card = { seq: '90071992547409931', ts: 1001, type: 7, text: '', video };
const instruction = { seq: '90071992547409932', ts: 1002, type: 1, text };
const batchOf = (messages = [card, instruction], mid = owner, extra = {}) => ({ ok: true, hit: true, batchId: 'batch-1', items: [{ mid, isOwner: mid === owner, messages, ...extra }] });
const wrap = (result) => ({ ok: result.ok, out: JSON.stringify(result), err: '' });
const failure = (code = 'OFFLINE', retryable = true) => ({ ok: false, status: 'failed', code, error: '步骤失败。', hint: '修复后重试。', retryable });
function fixture(t, options = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-dm-flow-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  let time = options.now ?? 2000000, poll = options.batch || batchOf(), role = true;
  const cfg = { owner: { mid: owner }, interact: { enabled: true }, listen: { dm: true } };
  const store = createDmTaskStore({ file: path.join(tmp, 'dm-tasks.json'), now: () => time, ...(options.maxJobs ? { maxJobs: options.maxJobs } : {}) });
  const calls = [], prompts = [];
  const runBili = async (args) => {
    calls.push(args);
    if (args[0] === 'dm-await' && args.includes('--ack')) {
      assert.ok(store.list().length, 'all jobs must be persisted before acknowledging incoming messages');
      if (options.ackError) return wrap(failure('ACK'));
      poll = { ok: true, hit: false, items: [] }; return wrap({ ok: true });
    }
    if (args[0] === 'dm-await') return wrap(options.pollError || poll);
    assert.equal(args[0], 'dm');
    if (options.reportHook) { const value = await options.reportHook(args); if (value) return wrap(value); }
    assert.ok(args.includes('--json') && args.includes('--go'));
    return wrap(options.reportResult || { ok: true, receipt: { accepted: true, messageKey: '999' } });
  };
  const bridgeCalls = [];
  const bridge = async (route, optionsArg) => {
    bridgeCalls.push({ route, ...optionsArg });
    if (options.bridgeHook) { const value = await options.bridgeHook(route, optionsArg); if (value) return value; }
    if (route.endsWith('/resolve')) return { data: options.resolveResult || { ok: true, group: { id: '100002', name: '命运糕手' } } };
    if (route.endsWith('/send')) return { data: options.sendResult || { ok: true, status: 'sent', receipt: { messageId: '-501', groupId: '100002', groupName: '命运糕手', sentAt: '2026-11-13T10:10:59Z' } } };
    return { data: options.statusResult || failure('NOT_FOUND') };
  };
  const service = createDmTaskService({ store, bridge, runBili, getConfig: () => cfg, now: () => time, isCurrent: () => role });
  const workflow = createBiliDmWorkflow({ store, service, runBili, getConfig: () => cfg, now: () => time, isCurrent: () => role,
    queue: async (job, prompt) => { prompts.push({ job, prompt }); if (options.queueFails) throw new Error('host unavailable'); }, queueLeaseMs: 1000 });
  return { tmp, store, service, workflow, calls, prompts, bridgeCalls, cfg, now: () => time, advance: (ms) => time += ms, setBatch: (batch) => poll = batch, changeRole: () => role = false };
}

test('screenshot instruction binds the preceding card and exact group without repeating private text', () => {
  assert.equal(shareIntent(text).target, '命运糕手');
  const jobs = tasksForItem(batchOf().items[0], 'batch', owner);
  assert.equal(jobs.length, 1); assert.equal(jobs[0].kind, 'share');
  assert.deepEqual(jobs[0].video, { bvid: video.bvid, title: video.title, url: video.url });
  assert.equal(jobs[0].sourceSeq, instruction.seq);
  assert.equal(shareIntent('不要把这个视频分享到群聊命运糕手'), null);
  assert.equal(tasksForItem(batchOf(undefined, '10009').items[0], 'batch', owner)[0].kind, 'conversation');
});
test('cards from an earlier poll can supply context; unrelated later card is preserved', () => {
  const context = tasksForItem({ mid: owner, messages: [instruction], context: [card] }, 'b', owner);
  assert.equal(context[0].video.bvid, video.bvid);
  const later = { ...card, seq: '90071992547409933', video: { ...video, title: '另一个视频' } };
  const jobs = tasksForItem({ mid: owner, messages: [card, instruction, later] }, 'b', owner);
  assert.equal(jobs.length, 2); assert.deepEqual(jobs[1].messages, [later]);
});
test('missing or ambiguous video and group ask for input without a guessed target', () => {
  assert.equal(tasksForItem({ mid: owner, messages: [instruction] }, 'b', owner)[0].error.code, 'dm.video-missing');
  const jobs = tasksForItem({ mid: owner, messages: [card, { ...instruction, text: '把这个视频分享到群里' }] }, 'b', owner);
  assert.equal(jobs[0].status, 'needs_input'); assert.equal(jobs[0].error.code, 'dm.target-missing');
  const many = { ...instruction, text: '把视频 BV1xx411c7mD 和 BV1aa411c7mD 分享到群聊命运糕手' };
  assert.equal(tasksForItem({ mid: owner, messages: [many] }, 'b', owner)[0].error.code, 'dm.video-ambiguous');
});
test('high precision ids are stable, invalid ids fail before consumption', () => {
  assert.notEqual(taskId(owner, card.seq, 'share'), taskId(owner, instruction.seq, 'share'));
  assert.throws(() => tasksForItem({ mid: owner, messages: [{ ...card, seq: Number(card.seq) }] }, 'b', owner), { code: 'dm.batch-invalid' });
});
test('task acceptance is durable and idempotent across replay and restart', (t) => {
  const f = fixture(t); f.store.accept(batchOf(), owner); f.store.accept(batchOf(), owner);
  const reopened = createDmTaskStore({ file: f.store.file });
  assert.equal(reopened.list().length, 1); assert.equal(reopened.list()[0].video.bvid, video.bvid);
  assert.throws(() => f.store.update(f.store.list()[0].id, { mid: '20002' }), { code: 'dm.task-conflict' });
});
test('corrupt or locked task storage does not acknowledge messages', async (t) => {
  const f = fixture(t); fs.writeFileSync(f.store.file, '{broken');
  assert.equal((await f.workflow.tick()).ok, false); assert.equal(f.calls.filter((a) => a.includes('--ack')).length, 0);
  fs.unlinkSync(f.store.file); fs.writeFileSync(f.store.file + '.lock', JSON.stringify({ pid: process.pid }));
  assert.equal((await f.workflow.tick()).ok, false); assert.equal(f.calls.filter((a) => a.includes('--ack')).length, 0);
});
test('all messages survive model budget deferral and repeated ack failure', async (t) => {
  const f = fixture(t, { ackError: true });
  await f.workflow.tick(); await f.workflow.tick();
  assert.equal(f.store.list().length, 1); assert.equal(f.prompts.length, 0);
  assert.equal(f.store.read().lastPoll.code, 'ACK');
  const deferred = fixture(t); await deferred.workflow.tick({ canQueue: false, gate: 'token额度等待' });
  assert.equal(deferred.prompts.length, 0); assert.equal(deferred.store.list()[0].status, 'pending');
  await deferred.workflow.tick(); assert.equal(deferred.prompts.length, 1);
});
test('five model tasks per tick keeps additional tasks durable', async (t) => {
  const messages = Array.from({ length: 7 }, (_, i) => ({ ...instruction, seq: String(9000 + i), text: '把视频 ' + video.bvid + ' 分享到群聊命运糕手' }));
  const f = fixture(t, { batch: batchOf(messages) });
  await f.workflow.tick(); assert.equal(f.prompts.length, 5); assert.equal(f.store.list().length, 7);
  await f.workflow.tick(); assert.equal(f.prompts.length, 7);
});
test('model queue failure preserves retry and makes the failure visible', async (t) => {
  const f = fixture(t, { queueFails: true }); await f.workflow.tick();
  assert.equal(f.store.list()[0].status, 'pending'); assert.equal(f.store.read().lastPoll.code, 'dm.queue-failed');
  await f.workflow.tick(); assert.equal(f.prompts.length, 1);
  f.advance(60001); await f.workflow.tick(); assert.equal(f.prompts.length, 2);
});
test('model prompts retain the bound video and enforce receipt-based completion', async (t) => {
  const f = fixture(t); await f.workflow.tick(); const prompt = f.prompts[0].prompt;
  assert.ok(prompt.includes(video.bvid)); assert.ok(prompt.includes('命运糕手'));
  assert.match(prompt, /dm-task send/); assert.match(prompt, /不编造观看经历或来源/);
});
test('successful group receipt produces exactly one private report and no duplicate group send', async (t) => {
  const f = fixture(t); await f.workflow.tick(); const job = f.store.list()[0];
  const first = await f.service.send(job.id, '这段技能配合很流畅。');
  assert.equal(first.status, 'sent'); assert.equal(first.receipt.messageId, '-501');
  await f.service.send(job.id, '这段技能配合很流畅。'); await f.workflow.tick();
  assert.equal(f.bridgeCalls.filter((x) => x.route.endsWith('/send')).length, 1);
  assert.equal(f.calls.filter((a) => a[0] === 'dm').length, 1);
  const body = f.bridgeCalls.find((x) => x.route.endsWith('/send')).body;
  assert.deepEqual(Object.keys(body.video).sort(), ['bvid', 'title', 'url']);
  assert.ok(!JSON.stringify(body).includes('不要说是我'));
  assert.equal(f.store.get(job.id).report.status, 'sent');
});
test('ambiguous groups and missing video report a concrete failure without model or QQ send', async (t) => {
  const f = fixture(t, { resolveResult: failure('DM_SHARE_GROUP_AMBIGUOUS', false) }); await f.workflow.tick();
  assert.equal(f.prompts.length, 0); assert.equal(f.bridgeCalls.filter((x) => x.route.endsWith('/send')).length, 0);
  assert.equal(f.calls.filter((a) => a[0] === 'dm').length, 1);
  const missing = fixture(t, { batch: batchOf([instruction]) }); await missing.workflow.tick();
  assert.equal(missing.bridgeCalls.length, 0); assert.equal(missing.calls.filter((a) => a[0] === 'dm').length, 1);
});
test('ambiguous QQ send or malformed receipt never becomes success or gets resent', async (t) => {
  for (const sendResult of [{ ...failure('TIMEOUT', false), status: 'unknown' }, { ok: true, status: 'sent', receipt: { messageId: 0 } }]) {
    const f = fixture(t, { sendResult }); await f.workflow.tick(); const id = f.store.list()[0].id;
    assert.equal((await f.service.send(id, '一点想法')).status, 'unknown');
    assert.equal(f.service.retry(id).ok, false); await f.service.send(id, '一点想法');
    assert.equal(f.bridgeCalls.filter((x) => x.route.endsWith('/send')).length, 1);
    assert.equal(f.store.get(id).status, 'unknown');
  }
});
test('unknown send can reconcile an existing real receipt without reposting', async (t) => {
  const receipt = { messageId: '1000', groupId: '100002', groupName: '命运糕手', sentAt: '2026-11-13T10:10:59Z' };
  const f = fixture(t, { sendResult: { ...failure('TIMEOUT', false), status: 'unknown' }, statusResult: { ok: true, status: 'sent', receipt } });
  await f.workflow.tick(); const id = f.store.list()[0].id; await f.service.send(id, '一点想法');
  await f.service.reconcile(id); assert.equal(f.store.get(id).status, 'sent');
  await f.workflow.tick(); assert.equal(f.bridgeCalls.filter((x) => x.route.endsWith('/send')).length, 1);
});
test('failed private report can retry without resending a successful group share', async (t) => {
  const f = fixture(t, { reportResult: failure('dm.preflight-failed') }); await f.workflow.tick();
  const id = f.store.list()[0].id; await f.service.send(id, '一点想法');
  assert.equal(f.store.get(id).status, 'sent'); assert.equal(f.store.get(id).report.status, 'failed');
  assert.equal(f.service.retry(id).reportOnly, true); await f.workflow.tick();
  assert.equal(f.bridgeCalls.filter((x) => x.route.endsWith('/send')).length, 1);
  assert.equal(f.calls.filter((a) => a[0] === 'dm').length, 2);
});
test('ordinary private replies also retain a durable single-send boundary', async (t) => {
  const f = fixture(t, { batch: batchOf([{ ...instruction, text: '在吗？' }]) }); await f.workflow.tick();
  const id = f.store.list()[0].id; await f.service.reply(id, '在的。'); await f.service.reply(id, '在的。');
  assert.equal(f.calls.filter((a) => a[0] === 'dm').length, 1); assert.equal(f.store.get(id).status, 'completed');
});
test('current owner and character changes block stale model commands', async (t) => {
  const f = fixture(t); await f.workflow.tick(); const id = f.store.list()[0].id;
  f.cfg.owner.mid = '20002'; assert.equal((await f.service.send(id, '想法')).code, 'dm.owner-changed');
  f.cfg.owner.mid = owner; f.changeRole(); assert.equal((await f.service.send(id, '想法')).code, 'dm.role-changed');
  assert.equal(f.bridgeCalls.filter((x) => x.route.endsWith('/send')).length, 0);
});
test('settings projection exposes failures and retry controls without private raw text', async (t) => {
  const f = fixture(t, { sendResult: failure('PAUSED') }); await f.workflow.tick();
  await f.service.send(f.store.list()[0].id, '一点想法'); const status = dmTaskStatus(f.store);
  assert.equal(status.ok, true); assert.equal(status.jobs[0].canRetry, true); assert.ok(status.jobs[0].error.hint);
  assert.ok(!JSON.stringify(status).includes('不要说是我'));
  assert.equal(commandResult({ ok: false, out: '', err: 'SECRET' }).status, 'unknown');
  assert.ok(!JSON.stringify(commandResult({ out: '' })).includes('SECRET'));
});
test('negated, conditional, questioning and cancelled messages never authorize QQ sharing', () => {
  for (const text of ['不是让你把视频分享到群聊A', '如果想把视频分享到群聊A，需要怎么做？', '把视频分享到群聊A，别发', '把视频分享到群聊A，取消分享']) {
    assert.equal(shareIntent(text), null, text);
  }
  assert.equal(shareIntent('把视频分享到「A」和「B」').error.code, 'dm.target-ambiguous');
  assert.equal(shareIntent('请把这个视频分享到群聊「A」，加一句想法。').target, 'A');
});
test('truncated instruction or invalid latest video cannot reuse an older valid card', () => {
  const short = tasksForItem({ mid: owner, messages: [card, { ...instruction, truncated: true }] }, 'b', owner)[0];
  assert.equal(short.status, 'needs_input'); assert.equal(short.error.code, 'dm.instruction-truncated');
  const invalid = { seq: '90071992547409930', type: 7, ts: 1000, text: 'unreadable', error: failure('dm.unsupported-card') };
  const result = tasksForItem({ mid: owner, messages: [invalid, instruction], context: [{ ...card, seq: '90071992547409929' }] }, 'b', owner);
  assert.equal(result.find((j) => j.kind === 'share').error.code, 'dm.video-missing');
});
test('late failed resolution cannot downgrade an already sent task', async (t) => {
  let release, started;
  const ready = new Promise((resolve) => started = resolve);
  let resolves = 0;
  const f = fixture(t, { bridgeHook: async (route) => {
    if (route.endsWith('/resolve') && resolves++ === 0) { started(); return new Promise((resolve) => release = () => resolve({ data: failure('LATE_RESOLVE') })); }
  } });
  const [job] = f.store.accept(batchOf(), owner);
  const old = f.service.prepare(job.id); await ready;
  assert.equal((await f.service.send(job.id, '一点想法')).status, 'sent');
  release(); await old;
  assert.equal(f.store.get(job.id).status, 'sent'); assert.equal(f.service.retry(job.id).ok, false);
});
test('old failed private report cannot overwrite a newer success report claim', async (t) => {
  let release, started, reports = 0;
  const ready = new Promise((resolve) => started = resolve);
  const f = fixture(t, { reportHook: async () => {
    if (++reports === 1) { started(); return new Promise((resolve) => release = () => resolve(failure('OLD_REPORT'))); }
  } });
  const [job] = f.store.accept(batchOf(), owner);
  f.store.update(job.id, { status: 'failed', retryable: true, error: failure('PRE_SEND') });
  const old = f.service.report(job.id); await ready;
  assert.equal(f.service.retry(job.id).ok, true);
  await f.service.send(job.id, '一点想法'); const newReport = f.store.get(job.id).report;
  assert.equal(newReport.status, 'sent'); release(); await old;
  assert.deepEqual(f.store.get(job.id).report, newReport); await f.service.report(job.id);
  assert.equal(reports, 2);
});
test('obsolete-owner failures cannot starve the current owner action budget', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 8; i++) {
    const [job] = f.store.accept(batchOf([{ ...instruction, seq: String(7000 + i), text: '把视频 ' + video.bvid + ' 分享到群聊命运糕手' }], '20002'), '20002');
    f.store.update(job.id, { status: 'failed', error: failure('OLD_OWNER') });
  }
  await f.workflow.tick(); assert.equal(f.prompts.length, 1); assert.equal(f.calls.filter((a) => a[0] === 'dm').length, 0);
});

test('risk-control pauses intake for fifteen minutes while durable work can progress', async (t) => {
  const f = fixture(t, { pollError: failure('dm.risk-control', false) });
  f.store.accept(batchOf(), owner);
  const first = await f.workflow.tick(); assert.equal(first.ok, false);
  assert.equal(f.prompts.length, 1, 'previously accepted work is independent of new inbox reads');
  assert.equal(f.store.read().nextPollAt, f.now() + 900000);
  await f.workflow.tick(); f.advance(60000); await f.workflow.tick();
  assert.equal(f.calls.filter(a => a[0] === 'dm-await').length, 1);
  f.advance(840001); await f.workflow.tick();
  assert.equal(f.calls.filter(a => a[0] === 'dm-await').length, 2);
  assert.equal(f.calls.filter(a => a.includes('--ack')).length, 0);
});
test('interrupted QQ sends become visible unknown after 90 seconds without resend permission', async (t) => {
  const f = fixture(t); await f.workflow.tick(); const job = f.store.list()[0];
  f.store.update(job.id, { status: 'sending', sendingAt: f.now() });
  await f.service.reconcile(job.id); assert.equal(f.store.get(job.id).status, 'sending');
  f.advance(90001); await f.workflow.tick();
  const current = f.store.get(job.id);
  assert.equal(current.status, 'unknown'); assert.equal(current.retryable, false);
  assert.equal(current.error.code, 'dm.delivery-unconfirmed'); assert.ok(current.error.hint);
  assert.equal((await f.service.retry(job.id)).ok, false);
  await f.service.send(job.id, '不能再发'); await f.workflow.tick();
  assert.equal(f.bridgeCalls.filter((x) => x.route.endsWith('/send')).length, 0);
  assert.equal(f.calls.filter((a) => a[0] === 'dm').length, 1, 'one honest unknown-result report');
});
test('interrupted ordinary private replies become unknown without silently retrying', async (t) => {
  const f = fixture(t, { batch: batchOf([{ ...instruction, text: '这个视频怎样？' }]) });
  await f.workflow.tick(); const job = f.store.list()[0];
  f.store.update(job.id, { status: 'replying', replyStartedAt: f.now() });
  f.advance(90001); await f.workflow.tick(); await f.workflow.tick();
  const current = f.store.get(job.id);
  assert.equal(current.status, 'unknown'); assert.equal(current.error.code, 'dm.reply-unconfirmed');
  assert.ok(current.error.hint); assert.equal(f.calls.filter((a) => a[0] === 'dm').length, 0);
  assert.equal(dmTaskStatus(f.store).jobs[0].canRetry, false);
});
test('interrupted result reports leave successful QQ receipts intact and cannot resend', async (t) => {
  const f = fixture(t); await f.workflow.tick(); const job = f.store.list()[0];
  f.store.update(job.id, { status: 'sent', receipt: { messageId: '-501', groupId: '100002', sentAt: '2026-11-13T10:10:59Z' }, report: { status: 'sending', key: 'sent:-501', attemptId: 'interrupted', at: f.now(), attempts: 1 } });
  f.advance(90001); await f.workflow.tick(); await f.workflow.tick();
  const current = f.store.get(job.id);
  assert.equal(current.status, 'sent'); assert.equal(current.report.status, 'unknown');
  assert.equal(current.report.error.code, 'dm.report-unconfirmed'); assert.ok(current.report.error.hint);
  assert.equal(f.calls.filter((a) => a[0] === 'dm').length, 0);
  assert.equal(f.bridgeCalls.filter((x) => x.route.endsWith('/send')).length, 0);
});

const firstRequest = { ...instruction, seq: '90071992547409941', ts: 2000 };
const followingCard = { ...card, seq: '90071992547409942', ts: 2001 };
const laterCard = { ...followingCard, seq: '90071992547409943', ts: 2002, video: { ...video, bvid: 'BV1aa411c7mD', title: '另一个视频' } };
const nextBatch = (messages, mid = owner) => ({ ...batchOf(messages, mid), batchId: 'batch-2' });
const shareJob = (f) => f.store.list().find((job) => job.kind === 'share');

test('text before video in one complete batch binds exact sequence once even when input is reversed', async (t) => {
  const f = fixture(t, { batch: batchOf([followingCard, firstRequest]) });
  await f.workflow.tick();
  const job = shareJob(f);
  assert.equal(f.store.list().length, 1); assert.equal(f.prompts.length, 1);
  assert.equal(job.sourceSeq, firstRequest.seq); assert.equal(job.videoSourceSeq, followingCard.seq);
  assert.deepEqual(job.messages.map((m) => m.seq), [firstRequest.seq, followingCard.seq]);
  assert.equal(job.id, taskId(owner, firstRequest.seq, 'share'));
  assert.equal(f.calls.filter((args) => args[0] === 'dm').length, 0);
  await f.service.send(job.id, '节奏不错。'); await f.service.send(job.id, '节奏不错。');
  f.setBatch(batchOf([firstRequest, followingCard])); await f.workflow.tick();
  assert.equal(f.store.list().length, 1); assert.equal(f.prompts.length, 1);
  assert.equal(f.bridgeCalls.filter((r) => r.route.endsWith('/send')).length, 1);
  assert.equal(f.calls.filter((args) => args[0] === 'dm').length, 1);
});

test('a waiting request is durable before ack and a later poll completes the original task', async (t) => {
  const f = fixture(t, { batch: batchOf([firstRequest]) });
  await f.workflow.tick();
  const waiting = shareJob(f);
  assert.equal(waiting.status, 'waiting_video'); assert.equal(waiting.waitingUntil, 2120000);
  assert.equal(f.prompts.length, 0); assert.equal(f.bridgeCalls.length, 0);
  assert.equal(f.calls.filter((args) => args.includes('--ack')).length, 1);
  assert.equal(f.calls.filter((args) => args[0] === 'dm').length, 0);
  assert.equal(dmTaskStatus(f.store).counts.waiting_video, 1);
  f.advance(5000); f.setBatch(nextBatch([followingCard])); await f.workflow.tick();
  const bound = shareJob(f);
  assert.equal(bound.id, waiting.id); assert.equal(bound.sourceSeq, firstRequest.seq);
  assert.equal(bound.batchId, waiting.batchId); assert.equal(bound.videoSourceSeq, followingCard.seq);
  assert.equal(bound.status, 'queued'); assert.equal(f.store.list().length, 1);
  assert.equal(f.prompts.length, 1); assert.equal(f.calls.filter((args) => args[0] === 'dm').length, 0);
});

test('restart and repeated card-batch acceptance preserve wait identity without another reply task', (t) => {
  const f = fixture(t, { maxJobs: 1 });
  const [waiting] = f.store.accept(batchOf([firstRequest]), owner);
  const reopened = createDmTaskStore({ file: f.store.file, now: () => f.now() + 3000, maxJobs: 1 });
  assert.equal(reopened.get(waiting.id).status, 'waiting_video');
  reopened.accept(nextBatch([followingCard]), owner);
  reopened.accept(nextBatch([followingCard]), owner);
  reopened.accept(batchOf([firstRequest]), owner);
  const jobs = reopened.list();
  assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'pending');
  assert.equal(jobs[0].id, waiting.id); assert.equal(jobs[0].videoSourceSeq, followingCard.seq);
  assert.equal(jobs[0].messages.length, 2); assert.equal(jobs[0].queueAttempts, 0);
});

test('a complete batch with several following cards fails visibly instead of choosing the first', async (t) => {
  for (const split of [false, true]) {
    const f = fixture(t, { batch: batchOf(split ? [firstRequest] : [firstRequest, followingCard, laterCard]) });
    await f.workflow.tick();
    if (split) { f.setBatch(nextBatch([followingCard, laterCard])); await f.workflow.tick(); }
    const job = shareJob(f);
    assert.equal(job.status, 'needs_input'); assert.equal(job.error.code, 'dm.video-ambiguous');
    assert.ok(job.error.hint); assert.equal(f.store.list().length, 1);
    assert.equal(f.prompts.length, 0); assert.equal(f.bridgeCalls.length, 0);
    await f.workflow.tick(); assert.equal(f.calls.filter((args) => args[0] === 'dm').length, 1);
  }
});

test('an unsupported following card prevents fallback to another valid card', async (t) => {
  const unreadable = { ...followingCard, video: undefined, error: failure('dm.unsupported-card') };
  const f = fixture(t, { batch: batchOf([firstRequest, unreadable, laterCard]) });
  await f.workflow.tick();
  const job = shareJob(f);
  assert.equal(job.status, 'needs_input'); assert.equal(job.error.code, 'dm.video-unreadable');
  assert.ok(job.error.hint); assert.equal(job.video, null);
  assert.equal(f.store.list().length, 1); assert.equal(f.prompts.length, 0); assert.equal(f.bridgeCalls.length, 0);
});

test('cancellation before a card or after a candidate in the same batch stops sharing', async (t) => {
  for (const afterCard of [false, true]) {
    const cancel = { ...instruction, seq: afterCard ? laterCard.seq : followingCard.seq, ts: 2002, text: '算了，别发了' };
    const messages = afterCard ? [firstRequest, followingCard, cancel] : [firstRequest, cancel, { ...laterCard, ts: 2003 }];
    const f = fixture(t, { batch: batchOf(messages) }); await f.workflow.tick();
    const job = shareJob(f);
    assert.equal(job.status, 'needs_input'); assert.equal(job.error.code, 'dm.share-cancelled');
    assert.ok(job.error.hint); assert.equal(job.video, null);
    assert.equal(f.prompts.filter((p) => p.job.kind === 'share').length, 0);
    assert.equal(f.bridgeCalls.length, 0); assert.equal(f.calls.filter((args) => args[0] === 'dm').length, 1);
    assert.ok(!f.store.list().filter((j) => j.kind === 'conversation').some((j) => j.messages.some((m) => m.seq === cancel.seq)));
  }
});

test('cancellation in a later poll persists and an even later card cannot revive it', async (t) => {
  const f = fixture(t, { batch: batchOf([firstRequest]) }); await f.workflow.tick();
  const id = shareJob(f).id;
  f.setBatch(nextBatch([{ ...instruction, seq: followingCard.seq, ts: 2001, text: '取消分享' }])); await f.workflow.tick();
  assert.equal(f.store.get(id).error.code, 'dm.share-cancelled');
  f.setBatch({ ...nextBatch([laterCard]), batchId: 'batch-3' }); await f.workflow.tick();
  assert.equal(f.store.get(id).status, 'needs_input'); assert.equal(f.store.get(id).video, null);
  assert.equal(f.prompts.filter((p) => p.job.kind === 'share').length, 0);
  assert.equal(f.calls.filter((args) => args[0] === 'dm').length, 1);
});

test('unrelated text interrupts a waiting share and preserves subsequent cards for ordinary conversation', async (t) => {
  const unrelated = { ...instruction, seq: followingCard.seq, ts: 2001, text: '今天你过得怎样？' };
  const f = fixture(t, { batch: batchOf([firstRequest]) }); await f.workflow.tick();
  f.setBatch(nextBatch([unrelated, laterCard])); await f.workflow.tick();
  const job = shareJob(f);
  assert.equal(job.status, 'needs_input'); assert.equal(job.error.code, 'dm.video-interrupted');
  assert.ok(job.error.hint); assert.equal(job.video, null);
  assert.equal(f.prompts.length, 1); assert.equal(f.prompts[0].job.kind, 'conversation');
  assert.deepEqual(f.prompts[0].job.messages.map((m) => m.seq), [unrelated.seq, laterCard.seq]);
  assert.equal(f.bridgeCalls.length, 0);
});

test('a newer share instruction closes the previous wait and owns the next card', async (t) => {
  const newer = { ...instruction, seq: followingCard.seq, ts: 2001, text: '把这个视频分享到群聊「另一个群」' };
  const f = fixture(t, { batch: batchOf([firstRequest, newer, laterCard]) }); await f.workflow.tick();
  const jobs = f.store.list();
  assert.equal(jobs.length, 2);
  assert.equal(jobs.find((j) => j.sourceSeq === firstRequest.seq).error.code, 'dm.video-interrupted');
  const bound = jobs.find((j) => j.sourceSeq === newer.seq);
  assert.equal(bound.videoSourceSeq, laterCard.seq); assert.equal(bound.target, '另一个群');
  assert.equal(f.prompts.length, 1); assert.equal(f.prompts[0].job.id, bound.id);
});

test('missing input expires after a successful poll and cannot be retried or revived by an old card', async (t) => {
  const f = fixture(t, { batch: batchOf([firstRequest]) }); await f.workflow.tick();
  const id = shareJob(f).id;
  f.advance(119999); await f.workflow.tick(); assert.equal(f.store.get(id).status, 'waiting_video');
  f.advance(1); await f.workflow.tick();
  const expired = f.store.get(id);
  assert.equal(expired.status, 'needs_input'); assert.equal(expired.error.code, 'dm.video-missing'); assert.ok(expired.error.hint);
  assert.equal(f.service.retry(id).ok, false);
  f.setBatch(nextBatch([followingCard])); await f.workflow.tick();
  assert.equal(f.store.get(id).status, 'needs_input'); assert.equal(f.store.get(id).video, null);
  assert.equal(f.prompts.filter((p) => p.job.kind === 'share').length, 0);
  assert.equal(f.calls.filter((args) => args[0] === 'dm').length, 1);
});

test('source timestamps allow delayed history and the exact 120-second edge, but reject 121 seconds', (t) => {
  const f = fixture(t, { now: 3000000 });
  for (const offset of [1, 120, 121]) {
    const source = { ...firstRequest, seq: String(1000 + offset * 2) };
    const next = { ...followingCard, seq: String(1001 + offset * 2), ts: source.ts + offset };
    const jobs = f.store.accept({ ...batchOf([source, next]), batchId: 'delay-' + offset }, owner);
    const job = jobs.find((j) => j.kind === 'share');
    if (offset <= 120) { assert.equal(job.status, 'pending'); assert.equal(job.videoSourceSeq, next.seq); }
    else { assert.equal(job.status, 'needs_input'); assert.equal(job.error.code, 'dm.video-missing'); assert.equal(job.video, null); }
  }
});

test('failed or risk-limited intake does not expire a wait before in-window history can be read', async (t) => {
  const options = { pollError: failure('dm.risk-control', false) };
  const f = fixture(t, options); const [waiting] = f.store.accept(batchOf([firstRequest]), owner);
  await f.workflow.tick(); f.advance(200000); await f.workflow.tick();
  assert.equal(f.store.get(waiting.id).status, 'waiting_video');
  options.pollError = null; f.setBatch(nextBatch([followingCard])); f.advance(700001);
  await f.workflow.tick();
  assert.equal(f.store.get(waiting.id).status, 'queued'); assert.equal(f.prompts.length, 1);
  assert.equal(f.store.get(waiting.id).videoSourceSeq, followingCard.seq);
});

test('waiting video association requires the same current owner and conversation', (t) => {
  const f = fixture(t); const [waiting] = f.store.accept(batchOf([firstRequest]), owner);
  f.store.accept(nextBatch([followingCard], '20002'), owner);
  assert.equal(f.store.get(waiting.id).status, 'waiting_video');
  f.store.accept(nextBatch([followingCard]), '20002');
  assert.equal(f.store.get(waiting.id).status, 'waiting_video');
  assert.equal(f.store.get(waiting.id).video, null);
  f.advance(200000); f.store.expireWaiting('20002');
  assert.equal(f.store.get(waiting.id).status, 'waiting_video');
});

test('a later poll cannot replace a video already bound to an earlier share', async (t) => {
  const f = fixture(t, { batch: batchOf([firstRequest, followingCard]) }); await f.workflow.tick();
  const id = shareJob(f).id; await f.service.send(id, '一点想法。');
  f.setBatch(nextBatch([laterCard])); await f.workflow.tick();
  assert.equal(f.store.get(id).video.bvid, video.bvid);
  assert.equal(f.store.get(id).videoSourceSeq, followingCard.seq);
  assert.equal(f.store.get(id).status, 'sent');
  assert.equal(f.bridgeCalls.filter((r) => r.route.endsWith('/send')).length, 1);
  assert.equal(f.calls.filter((args) => args[0] === 'dm').length, 1);
  assert.equal(f.prompts.filter((p) => p.job.kind === 'conversation').length, 1);
});

test('invalid or regressing message timestamps cannot create a guessed association', () => {
  for (const pair of [[{ ...firstRequest, ts: 0 }, followingCard], [firstRequest, { ...followingCard, ts: 1999 }], [firstRequest, { ...followingCard, ts: undefined }]]) {
    const job = tasksForItem(batchOf(pair).items[0], 'invalid-time', owner, { now: 2000000 }).find((j) => j.kind === 'share');
    assert.equal(job.status, 'needs_input'); assert.equal(job.error.code, 'dm.video-time-invalid');
    assert.ok(job.error.hint); assert.equal(job.video, null);
  }
});

test('an explicit BV keeps its binding even with a subsequent different card', () => {
  const explicit = { ...firstRequest, text: '把视频 ' + video.bvid + ' 分享到群聊命运糕手' };
  const jobs = tasksForItem(batchOf([explicit, laterCard]).items[0], 'explicit', owner, { now: 2000000 });
  assert.equal(jobs.find((j) => j.kind === 'share').video.bvid, video.bvid);
  assert.equal(jobs.find((j) => j.kind === 'conversation').messages[0].seq, laterCard.seq);
});
