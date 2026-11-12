// Real bridge handlers in the isolated VM harness. HTTP is an in-memory handler,
// QQ/DSH peers are fixtures, and long timers are inert: no sockets or real waits.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { continuationMatches, continuationExpiresAt } from '../src/conversation-continuation.js';
import { evaluateWakeBudget } from '../src/token-guard.js';
import { localDayKey } from '../src/token-budget.js';

const KEY = 'group:456';
const SELF = '999';
const WINDOW = 300_000;
const plain = (value) => JSON.parse(JSON.stringify(value));
let passed = 0;
let failures = 0;

async function test(name, run, options = {}) {
  let handler;
  const timers = [];
  const gateway = [];
  const server = {
    listen(_port, _host, callback) { callback?.(); return this; },
    on() { return this; },
    address() { return { port: 1 }; },
  };
  const h = await bridgeHarness({
    ...options,
    config: {
      fishGuard: { enabled: false },
      ...options.config,
      socialV2: {
        tokenGuard: { enabled: false },
        ...options.config?.socialV2,
      },
    },
    globals: {
      ...options.globals,
      http: { createServer(fn) { handler = fn; return server; } },
      setTimeout(fn, ms = 0) {
        const timer = { fn, ms, cancelled: false, unref() {} };
        timers.push(timer);
        // Only fixture burst spacing gets advanced. Wake/expiry/body timers stay inert.
        if (ms <= 100) queueMicrotask(() => { if (!timer.cancelled) fn(); });
        return timer;
      },
      clearTimeout(timer) { if (timer) timer.cancelled = true; },
      fetch: async (url, init = {}) => {
        const body = JSON.parse(init.body || '{}');
        const call = { url: String(url), body };
        gateway.push(call);
        if (options.gatewayReply) return options.gatewayReply(call, gateway);
        return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
      },
    },
  });
  try {
    h.setMode('reserved2');
    h.setSelfIdentity('fixture-ai', SELF);
    h.bot.getMessage = async (id) => {
      for (const [key, st] of h.socialV2.conversations) {
        const message = st.recentMessages.find((m) => String(m.messageId) === String(id));
        if (message) return {
          message_id: id,
          ...(key.startsWith('group:') ? { group_id: Number(key.slice(6)) } : {}),
          user_id: Number(message.userId), sender: { user_id: Number(message.userId), nickname: message.sender },
          message: [{ type: 'text', data: { text: message.plain } }],
        };
      }
      return null;
    };
    h.cfg.socialV2.send = { ...h.cfg.socialV2.send, burstIntervalMinMs: 100, maxGapMs: 100, maxSendPerMinute: 100, maxSendPerHour: 100 };
    h.startConsoleServer(); // Fake createServer: captures the real callback, never binds.
    const post = async (endpoint, body, key = KEY) => {
      const req = new EventEmitter();
      const st = h.getSocialV2State(key);
      Object.assign(req, {
        url: endpoint, method: 'POST',
        headers: { host: '127.0.0.1:1', 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken, 'x-agent-call': '1' },
        pause() {},
      });
      let status;
      let data;
      const res = {
        writeHead(value) { status = value; },
        end(value) { data = JSON.parse(value); },
      };
      const pending = handler(req, res);
      req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
      await pending;
      assert.notEqual(status, undefined, 'handler must return a response');
      return { status, data };
    };
    await run(h, { post, timers, gateway });
    passed += 1;
    console.log('PASS', name);
  } catch (error) {
    failures += 1;
    console.error('FAIL', name, '\n ', error.stack);
  } finally {
    await h.close();
  }
}

function configureWake(st) {
  st.bootstrapSent = true;
  st.wakeConfig.mode = 'diving';
  st.wakeConfig.infinite = true;
  st.wakeConfig.triggers = { anyMessage: false, atMention: true, nameMention: false, question: true, probability: 0, keywords: [], speakerIds: [], poke: false };
}

function seed(h, { key = KEY, userId = '101', text = '原神和命运二你更喜欢哪个', seen = true, ago = 2000, addressedToOther = false, sender = 'fixture-human' } = {}) {
  const st = h.getSocialV2State(key);
  configureWake(st);
  const messageId = String(-1000 - st.lastUnreadSeq - 1);
  h.appendSocialV2Message(key, sender, text, text, false, false, messageId, [], userId, [], addressedToOther);
  const message = st.recentMessages.at(-1);
  message.time = Date.now() - ago;
  if (seen) st.modelSeenSeqs.add(message.seq); // Actual bridge-realm Set, not a replacement.
  return { st, message };
}

function event(userId = '101', text = '我也这样想', segments = [], sender = 'fixture-human') {
  return { user_id: Number(userId), self_id: Number(SELF), group_id: 456, message_id: -9000,
    sender: { user_id: Number(userId), nickname: sender },
    message: [...segments, { type: 'text', data: { text } }], raw_message: text };
}

function trigger(h, st, ev = event(), text = ev.raw_message, quoteSelf = false) {
  return h.evaluateWakeTriggerV2(KEY, st, ev, 'group', text, text, quoteSelf);
}

function send(post, overrides = {}) {
  return post('/api/socialV2/send-message', { key: KEY, messages: '我更喜欢探索开放世界，原神这一点很吸引我。', ...overrides });
}

await test('actual successful send records only the latest eligible seen human', async (h, { post, gateway }) => {
  const { st } = seed(h, { userId: '101', ago: 3000 });
  seed(h, { userId: '102', ago: 2000 });
  seed(h, { userId: '103', ago: 1000, seen: false });
  assert.equal(st.continuation, null);
  const before = Date.now();
  const result = await send(post);
  assert.equal(result.status, 200);
  assert.equal(result.data.sent, 1);
  assert.equal(gateway.filter(({ url }) => url.endsWith('/send_group_msg')).length, 1);
  assert.deepEqual(plain(st.continuation.participants).map(({ userId }) => userId), ['102']);
  assert.ok(st.continuation.lastReplyAt >= before);
  assert.equal(continuationExpiresAt(st.continuation), st.continuation.lastReplyAt + WINDOW);
});

await test('successful quoted/@ reply retains the older explicit human target', async (h, { post }) => {
  const { st, message } = seed(h, { userId: '101', ago: 3000 });
  seed(h, { userId: '102', ago: 1000 });
  const result = await send(post, { replyToMessageId: message.messageId, atUserId: '101' });
  assert.equal(result.data.ok, true);
  assert.equal(continuationMatches(st.continuation, '101'), true);
  assert.equal(continuationMatches(st.continuation, '102'), false);
});

await test('failed actual send cannot establish a continuation or record a self reply', async (h, { post, gateway }) => {
  const { st } = seed(h);
  const result = await send(post);
  assert.equal(result.status, 500);
  assert.equal(result.data.ok, false);
  assert.match(result.data.error, /发送失败/);
  assert.equal(gateway.filter(({ url }) => url.endsWith('/send_group_msg')).length, 1);
  assert.equal(st.continuation, null);
  assert.equal(st.recentMessages.filter((m) => m.isSelf).length, 0);
}, { gatewayReply: async () => ({ ok: false, status: 400, json: async () => ({ status: 'failed', retcode: 100, wording: 'fixture-rejection' }) }) });

await test('partial successful burst retains explicit routing and records only delivered messages', async (h, { post }) => {
  const { st, message } = seed(h, { userId: '101', ago: 3000 });
  seed(h, { userId: '102', ago: 1000 });
  const result = await send(post, { messages: ['先回应你的原神偏好。', '再补一点命运二的差异。'], atUserId: '101', replyToMessageId: message.messageId, gapMode: 'fixed', gapMs: 100 });
  assert.equal(result.status, 500);
  assert.equal(result.data.ok, false);
  assert.equal(continuationMatches(st.continuation, '101'), true);
  assert.equal(continuationMatches(st.continuation, '102'), false);
  assert.equal(st.recentMessages.filter((m) => m.isSelf).length, 1);
}, { gatewayReply: async (_call, calls) => {
  const success = calls.filter(({ url }) => url.endsWith('/send_group_msg')).length === 1;
  return { ok: success, status: success ? 200 : 400, json: async () => success ? { status: 'ok', retcode: 0, data: { message_id: 9001 } } : { status: 'failed', retcode: 100, wording: 'fixture-second-message-rejection' } };
} });

await test('unseen and explicitly foreign-addressed inbound never establish participants', async (h, { post }) => {
  const { st } = seed(h, { seen: false });
  seed(h, { userId: '102', addressedToOther: true });
  assert.equal((await send(post)).data.ok, true);
  assert.equal(st.continuation, null);
});

await test('deferred close acknowledges seen only, cancels replyCheck and adds no wait/prompt/cooldown', async (h, { post, timers }) => {
  const { st, message } = seed(h);
  assert.equal((await send(post)).data.ok, true);
  const replyTimer = st.replyCheckTimer;
  assert.ok(replyTimer);
  const unseen = seed(h, { userId: '102', text: '另一个话题', seen: false, ago: 0 }).message;
  const wakeBefore = JSON.stringify(st.wakeConfig);
  const timerCount = timers.length;
  const promptCount = h.calls.prompts.length;
  const result = h.closeConversationV2(KEY, { reason: 'topic-done', summary: '回答了原神偏好' });
  assert.equal(result.ok, true);
  assert.equal(result.deferred, true);
  assert.equal(result.code, 'CONTINUATION_WINDOW_OPEN');
  assert.equal(result.markedCount, 1);
  assert.equal(st.lastReadThroughSeq, message.seq);
  assert.deepEqual(Array.from(st.unread, (m) => m.seq), [unseen.seq]);
  assert.equal(st.closure, null);
  assert.equal(st.replyCheckTimer, null);
  assert.equal(replyTimer.cancelled, true);
  assert.equal(timers.length, timerCount, 'no new sleep or empty model-wait timer');
  assert.equal(h.calls.prompts.length, promptCount);
  assert.equal(JSON.stringify(st.wakeConfig), wakeBefore);
  assert.equal(result.continuationUntil, continuationExpiresAt(st.continuation));
  assert.match(result.note, /无需再等/);
  assert.equal(h.markReadCalledKeys.has(KEY), true, 'turn/end must not nag for another close/wait');
  assert.equal(trigger(h, st, event('101', '你现在去了解一下')), 'continuation');
});

await test('short acknowledgment answer to a question preserves the window for a later implicit follow-up', async (h, { post }) => {
  const { st } = seed(h, { text: '你喜欢原神吗', ago: 32_000 });
  assert.equal((await send(post, { messages: '是的' })).data.ok, true);
  // Represent a close 30 seconds after the successful short answer, without sleeping.
  for (const message of st.recentMessages) if (message.isSelf) message.time -= 30_000;
  st.lastAiReplyAt -= 30_000;
  st.lastActionAt -= 30_000;
  st.continuation.lastReplyAt -= 30_000;
  for (const participant of st.continuation.participants) participant.until -= 30_000;
  const until = continuationExpiresAt(st.continuation);
  const assessment = h.assessClosureV2(KEY, st);
  assert.equal(assessment.signals.lastOtherKind, 'question');
  assert.equal(assessment.signals.lastSelfKind, 'ack');
  assert.equal(assessment.signals.awaitingTheirAnswer, false);
  const result = h.closeConversationV2(KEY, { reason: 'topic-done' });
  assert.equal(result.deferred, true, 'a short answer does not establish mutual topic closure');
  assert.equal(result.code, 'CONTINUATION_WINDOW_OPEN');
  assert.equal(result.continuationUntil, until);
  assert.equal(st.closure, null);
  assert.equal(continuationMatches(st.continuation, '101'), true);
  assert.equal(h.isDirectedAtAi('那剧情呢'), false, 'follow-up relies on recent participation, not a direct trigger');
  assert.equal(trigger(h, st, event('101', '那剧情呢')), 'continuation');
  assert.equal(trigger(h, st, event('102', '那剧情呢')), null);
});

await test('true acknowledgment/goodbye close clears the continuation and starts normal cooldown', async (h, { post }) => {
  const { st } = seed(h);
  assert.equal((await send(post)).data.ok, true);
  seed(h, { text: '谢谢', ago: 0 });
  const result = h.closeConversationV2(KEY, { summary: '对方确认收到' });
  assert.equal(result.ok, true);
  assert.notEqual(result.deferred, true);
  assert.equal(st.continuation, null);
  assert.ok(result.cooldownUntil > Date.now());
  assert.equal(h.closureSuppressesWake(st.closure, 'replyCheck'), true);
});

await test('unanswered real question/request still prevents close with existing continuation', async (h, { post }) => {
  const { st } = seed(h);
  assert.equal((await send(post)).data.ok, true);
  st.recentMessages.filter((m) => m.isSelf).forEach((m) => { m.time -= 2000; });
  for (const text of ['原神和命运二你更喜欢哪个', '你现在去了解一下']) {
    seed(h, { text, ago: 0 });
    assert.throws(() => h.closeConversationV2(KEY, {}), (error) => error.statusCode === 409 && error.code === 'open-question');
    assert.equal(st.closure, null);
    assert.ok(st.continuation);
  }
});

await test('five-minute continuation routes only that participant; expiry and foreign addressing reject', async (h, { post }) => {
  const { st } = seed(h);
  await send(post);
  assert.equal(trigger(h, st), 'continuation');
  assert.equal(trigger(h, st, event('102')), null);
  const foreignAt = event('101', '你现在去了解一下', [{ type: 'at', data: { qq: '102' } }]);
  const foreignQuote = event('101', '原神和命运二你更喜欢哪个', [{ type: 'reply', data: { id: '-777' } }]);
  assert.equal(trigger(h, st, foreignAt), null);
  assert.equal(trigger(h, st, foreignQuote), null);
  const selfAt = event('101', '我也这样想', [{ type: 'at', data: { qq: SELF } }]);
  assert.equal(trigger(h, st, selfAt), 'atMention');
  st.continuation.participants[0].until = Date.now() - 1;
  assert.equal(trigger(h, st), null);
  assert.equal(trigger(h, st, event('101', '原神和命运二你更喜欢哪个')), 'question', 'direct question remains independently wakeable after expiry');
});

await test('current fish sender cannot reuse a previously human continuation', async (h, { post }) => {
  const { st } = seed(h);
  await send(post);
  assert.equal(trigger(h, st, event('101', '我也这样想', [], 'fixture-fish')), null);
  await h.handleIncoming('group', 456, event('101', '我也这样想', [], 'fixture-fish'), h.cfg);
  assert.equal(st.recentMessages.at(-1).fish, true);
  assert.equal(st.pendingWakeTimer, null);
});

await test('inbound @other is stored as foreign-directed and does not reopen closed conversation', async (h) => {
  const st = h.getSocialV2State(KEY);
  configureWake(st);
  st.closure = { at: Date.now() - 1000, cooldownUntil: Date.now() + 1_200_000, reopenedAt: 0 };
  await h.handleIncoming('group', 456, event('101', '原神和命运二你更喜欢哪个', [{ type: 'at', data: { qq: '102' } }]), h.cfg);
  assert.equal(st.recentMessages.at(-1).addressedToOther, true);
  assert.equal(st.closure.reopenedAt, 0);
  assert.equal(st.pendingWakeTimer, null);
});

await test('inbound goodbye clears the continuing participant without another reply', async (h, { post }) => {
  const { st } = seed(h);
  await send(post);
  await h.handleIncoming('group', 456, event('101', '别回复了'), h.cfg);
  assert.equal(continuationMatches(st.continuation, '101'), false);
  h.loadSocialV2State();
  assert.equal(continuationMatches(h.getSocialV2State(KEY).continuation, '101'), false, 'restart must not revive a goodbye');
});

await test('actual direct reopen is persisted before the queued model turn starts', async (h) => {
  const st = h.getSocialV2State(KEY);
  configureWake(st);
  st.closure = { at: Date.now() - 1000, cooldownUntil: Date.now() + 1_200_000, reopenedAt: 0 };
  await h.handleIncoming('group', 456, event('101', '你更喜欢哪个', [{ type: 'at', data: { qq: SELF } }]), h.cfg);
  assert.equal(h.calls.prompts.length, 0, 'batch timer has not fired');
  h.loadSocialV2State();
  const restored = h.getSocialV2State(KEY);
  assert.ok(restored.closure.reopenedAt > 0);
  assert.equal(h.closureSuppressesWake(restored.closure, 'replyCheck'), false);
});

await test('large-group policy and disabled continuation keep ordinary chat asleep', async (h, { post }) => {
  const { st } = seed(h);
  assert.equal((await send(post)).data.ok, true);
  assert.equal(st.continuation, null);
  st.continuation = { lastReplyAt: Date.now(), participants: [{ userId: '101', until: Date.now() + WINDOW }] };
  assert.equal(trigger(h, st), null);
  assert.equal(trigger(h, st, event('101', '原神和命运二你更喜欢哪个')), null);
  assert.equal(trigger(h, st, event('101', '我也这样想', [{ type: 'at', data: { qq: SELF } }])), 'atMention');
}, { files: { 'state/group-policy.json': { enabled: true, overrides: { [KEY]: 'large' } } } });

await test('zero configuration disables establishing and matching continuation', async (h, { post }) => {
  const { st } = seed(h);
  assert.equal((await send(post)).data.ok, true);
  assert.equal(st.continuation, null);
  st.continuation = { lastReplyAt: Date.now(), participants: [{ userId: '101', until: Date.now() + WINDOW }] };
  assert.equal(trigger(h, st), null);
}, { config: { socialV2: { wake: { continuationWindowMs: 0 } } } });

await test('direct reopen releases old cooldown and replyCheck can schedule again', async (h) => {
  const { st } = seed(h, { text: '谢谢' });
  h.recordSentMessagesV2(KEY, ['嗯嗯']);
  const closed = h.closeConversationV2(KEY, {});
  assert.ok(closed.cooldownUntil > Date.now());
  h.scheduleReplyCheckV2(KEY);
  assert.equal(st.replyCheckTimer, null);
  assert.equal(h.noteClosureReopenV2(KEY, st, { plain: '原神和命运二你更喜欢哪个', directAddress: true }), true);
  assert.ok(st.closure.reopenedAt >= st.closure.at);
  assert.ok(st.closure.cooldownUntil <= Date.now());
  assert.equal(h.closureSuppressesWake(st.closure, 'replyCheck'), false);
  h.scheduleReplyCheckV2(KEY);
  assert.ok(st.replyCheckTimer);
  assert.equal(h.noteClosureReopenV2(KEY, st, { plain: '你现在去了解一下', continuing: true, addressedToOther: true }), false);
});

await test('verified continuation bypasses only gap; forged flag/reason and daily cap stay blocked', async (h) => {
  const st = h.getSocialV2State(KEY);
  st.wakeTimes = [Date.now() - 1000];
  st.wakeBudgetTimes = [...st.wakeTimes];
  assert.equal(h.tokenGuardWakeBlock(KEY, st, { reason: 'continuation', continuation: true }), null);
  for (const options of [{ reason: 'continuation' }, { reason: 'continuation', continuation: 'true' }, { reason: 'probability', continuation: true }]) {
    assert.equal(h.tokenGuardWakeBlock(KEY, st, options).reason, 'gap');
  }
  st.wakeBudgetTimes = [Date.now() - 2000, Date.now() - 1000];
  assert.equal(h.tokenGuardWakeBlock(KEY, st, { reason: 'continuation', continuation: true }).reason, 'day');
  assert.equal(evaluateWakeBudget({ key: KEY, reason: 'continuation', continuation: true, now: Date.now(), guard: { maxWakesPerDay: 0, maxDailyCostCNY: 1 }, cost: 1 }).reason, 'cost');
}, { config: { socialV2: { tokenGuard: { enabled: true, minWakeGapMs: 120_000, maxWakesPerDay: 2, directBypassGap: true, directBypassDay: true } } } });

await test('active continuation delivers a real model prompt inside the gap and remains budget-counted', async (h, { post }) => {
  const { st } = seed(h);
  await send(post);
  seed(h, { text: '你现在去了解一下', ago: 0 });
  st.wakeTimes = [Date.now() - 1000];
  st.wakeBudgetTimes = [Date.now() - 1000];
  await h.sendWakePromptV2(KEY, 'continuation');
  assert.equal(h.calls.prompts.length, 1);
  assert.equal(st.wakeBudgetTimes.length, 2);
  assert.equal(st.lastWakeReason, 'continuation');
  assert.equal(st.tokenRetryTimer ?? null, null);
}, { config: { socialV2: { tokenGuard: { enabled: true, maxWakesPerDay: 5, minWakeGapMs: 120_000, directBypassGap: true } } } });

await test('delayed continuation wake revalidates expiry before creating a model turn', async (h, { post }) => {
  const { st } = seed(h);
  await send(post);
  st.continuation.participants[0].until = Date.now() - 1;
  seed(h, { text: '我也这样想', ago: 0 });
  await h.sendWakePromptV2(KEY, 'continuation');
  assert.equal(h.calls.prompts.length, 0);
  assert.equal(h.calls.created.length, 0);
});

await test('delayed continuation wake rejects foreign-directed unread after earlier seen messages were acknowledged', async (h, { post }) => {
  const { st } = seed(h);
  await send(post);
  h.closeConversationV2(KEY, {});
  seed(h, { text: '原神和命运二你更喜欢哪个', addressedToOther: true, ago: 0 });
  await h.sendWakePromptV2(KEY, 'continuation');
  assert.equal(h.calls.prompts.length, 0);
  assert.equal(h.calls.created.length, 0);
});

await test('QQ/total cost budget still blocks a verified continuation wake', async (h) => {
  const blocked = h.tokenGuardWakeBlock(KEY, h.getSocialV2State(KEY), { reason: 'continuation', continuation: true });
  assert.equal(blocked.reason, 'budget');
  assert.match(blocked.error, /QQ/);
}, { files: {
  'dsh/surfcore/token-budget.json': { version: 1, updatedAt: Date.now(), limits: { qq: { cny: 1, tokens: null }, total: { cny: null, tokens: null } } },
  'dsh/surfcore/token-usage-daily.json': { day: localDayKey(), at: Date.now(), source: 'surfcore-plugin', qq: { cost: 2, tokens: 100 }, bili: { cost: 0, tokens: 0 }, other: { cost: 0, tokens: 0 }, total: { cost: 2, tokens: 100 }, sessions: {} },
} });

await test('save/load preserves bounded participant expiry without restoring model-seen receipts', async (h, { post }) => {
  const { st } = seed(h);
  await send(post);
  const before = plain(st.continuation);
  h.saveSocialV2State();
  const saved = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/social-v2.json'), 'utf8'));
  assert.deepEqual(saved.conversations[KEY].continuation, before);
  h.loadSocialV2State();
  const restored = h.getSocialV2State(KEY);
  assert.deepEqual(plain(restored.continuation), before);
  assert.equal(restored.modelSeenSeqs.size, 0);
  assert.equal(trigger(h, restored), 'continuation');
  assert.equal(continuationExpiresAt(restored.continuation), before.participants[0].until);
});

await test('load drops expired/malformed state and caps forged future persisted participants', async (h) => {
  const current = h.getSocialV2State(KEY).continuation;
  assert.equal(current.participants.length, 8);
  assert.ok(current.lastReplyAt <= Date.now());
  assert.ok(continuationExpiresAt(current) <= current.lastReplyAt + WINDOW);
  assert.equal(h.getSocialV2State('group:457').continuation, null);
  assert.equal(h.getSocialV2State('group:458').continuation, null);
}, { files: { 'state/social-v2.json': { conversations: {
  [KEY]: { continuation: { lastReplyAt: Date.now() + 999_000_000, participants: Array.from({ length: 100 }, (_, i) => ({ userId: String(100 + i), until: Date.now() + 999_000_000 })) } },
  'group:457': { continuation: { lastReplyAt: Date.now() - WINDOW - 1000, participants: [{ userId: '101', until: Date.now() - 1000 }] } },
  'group:458': { continuation: { lastReplyAt: 'invalid', participants: [{ userId: '101', until: Date.now() + WINDOW }] } },
} } } });

console.log(`\n${failures ? 'FAILED' : 'OK'} (continuation-wiring ${passed} passed, ${failures} failed)`);
process.exitCode = failures ? 1 : 0;
