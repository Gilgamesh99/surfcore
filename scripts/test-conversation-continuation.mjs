// Pure deterministic fixtures: no QQ, runtime, network, files, or persisted state.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  DEFAULT_CONTINUATION_WINDOW_MS,
  normalizeContinuation,
  recordConversationReply,
  continuationMatches,
  continuationExpiresAt,
} from '../src/conversation-continuation.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('PASS', name);
  } catch (error) {
    console.error('FAIL', name, '\n ', error.stack);
    process.exitCode = 1;
  }
}

const NOW = 1_800_000_000_000;
const WINDOW = 300_000;
const inbound = (seq = 1, userId = '101', overrides = {}) => ({
  seq, userId, messageId: String(-1000 - seq), time: NOW - 1000,
  isSelf: false, fish: false, kind: 'message', addressedToOther: false,
  plain: '原神和命运二你更喜欢哪个',
  ...overrides,
});
const state = (participants = [{ userId: '101', until: NOW + 100_000 }], lastReplyAt = NOW - 1000) => ({ lastReplyAt, participants });
const reply = (overrides = {}) => recordConversationReply({
  now: NOW, messages: [inbound()], seenSeqs: new Set([1]), ...overrides,
});
const expected = (userId = '101', now = NOW, window = WINDOW) => ({
  lastReplyAt: now, participants: [{ userId, until: now + window }],
});

test('default window is five minutes; real question/request/plain messages establish continuation', () => {
  assert.equal(DEFAULT_CONTINUATION_WINDOW_MS, WINDOW);
  for (const plain of ['原神和命运二你更喜欢哪个', '你现在去了解一下', '我刚刚把这关打完了', '嗯嗯']) {
    assert.deepEqual(reply({ messages: [inbound(1, '101', { plain })] }), expected(), plain);
  }
});

test('matching is exact and per participant; the expiry boundary is exclusive', () => {
  const record = reply();
  assert.equal(continuationMatches(record, '101', NOW), true);
  assert.equal(continuationMatches(record, 101, NOW + WINDOW - 1), true);
  assert.equal(continuationMatches(record, '102', NOW), false);
  assert.equal(continuationMatches(record, '0101', NOW), false);
  assert.equal(continuationMatches(record, '101', NOW + WINDOW), false);
  assert.equal(continuationExpiresAt(record, NOW), NOW + WINDOW);
  assert.equal(continuationExpiresAt(record, NOW + WINDOW), 0);
  assert.equal(normalizeContinuation(record, NOW + WINDOW), null);
});

test('normalization rejects malformed envelopes, clocks and timestamps', () => {
  for (const raw of [null, undefined, false, 1, '101', [], {}, { lastReplyAt: NOW }, { lastReplyAt: NOW, participants: {} }]) {
    assert.equal(normalizeContinuation(raw, NOW), null);
    assert.equal(continuationMatches(raw, '101', NOW), false);
    assert.equal(continuationExpiresAt(raw, NOW), 0);
  }
  for (const invalid of [undefined, null, false, '', String(NOW), NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(normalizeContinuation({ ...state(), lastReplyAt: invalid }, NOW), null);
  }
  for (const invalidNow of [null, String(NOW), NaN, Infinity, -1, 1.5]) {
    assert.equal(normalizeContinuation(state(), invalidNow), null);
    assert.equal(reply({ now: invalidNow }), null);
    assert.equal(continuationMatches(state(), '101', invalidNow), false);
    assert.equal(continuationExpiresAt(state(), invalidNow), 0);
  }
});

test('normalization removes invalid IDs and expiries without coercing junk', () => {
  const invalidIds = ['', '0', 0, -1, '-1', '01', '+1', '1e3', '1.1', ' 101', '101 ', 'all', {}, [], true, null, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1];
  const invalidUntil = [null, false, '', String(NOW + 1000), NaN, Infinity, -1, 1.5, NOW, NOW - 1, Number.MAX_SAFE_INTEGER + 1];
  const participants = [
    ...invalidIds.map((userId) => ({ userId, until: NOW + 1000 })),
    ...invalidUntil.map((until) => ({ userId: '102', until })),
    null, false, [], '101',
    { userId: 103, until: NOW + 2000, ignored: true },
  ];
  assert.deepEqual(normalizeContinuation(state(participants), NOW), state([{ userId: '103', until: NOW + 2000 }]));
  for (const userId of invalidIds) assert.equal(continuationMatches(state(), userId, NOW), false);
});

test('future reply time and forged long expiry clamp to five minutes without sliding deadlines', () => {
  const forged = state([{ userId: '101', until: NOW + 100 * WINDOW }], NOW + 10 * WINDOW);
  const clean = normalizeContinuation(forged, NOW);
  assert.deepEqual(clean, expected());
  assert.deepEqual(normalizeContinuation(clean, NOW + 1), clean);
  const staleAnchor = state([{ userId: '101', until: NOW + 100 * WINDOW }], NOW - WINDOW);
  assert.equal(normalizeContinuation(staleAnchor, NOW), null);
  const recentAnchor = state([{ userId: '101', until: NOW + 100 * WINDOW }], NOW - 1000);
  assert.equal(continuationExpiresAt(recentAnchor, NOW), NOW - 1000 + WINDOW);
});

test('normalization caps participants at eight and deduplicates conservatively', () => {
  const participants = Array.from({ length: 1000 }, (_, index) => ({ userId: String(index + 1), until: NOW + 1000 + index }));
  participants.push({ userId: '1', until: NOW + 500 });
  const clean = normalizeContinuation(state(participants), NOW);
  assert.equal(clean.participants.length, 8);
  assert.deepEqual(clean.participants.map(({ userId }) => userId), ['1', '2', '3', '4', '5', '6', '7', '8']);
  assert.equal(clean.participants[0].until, NOW + 500);
  assert.equal(continuationExpiresAt(clean, NOW), NOW + 1007);
});

test('recording is immutable and preserves other participants individual expiries', () => {
  const previous = state([{ userId: '101', until: NOW + 5000 }, { userId: '102', until: NOW + 50_000 }], NOW - 2000);
  previous.participants.forEach(Object.freeze);
  Object.freeze(previous.participants);
  Object.freeze(previous);
  const message = Object.freeze(inbound());
  const messages = Object.freeze([message]);
  const seenSeqs = new Set([1]);
  const next = reply({ previous, messages, seenSeqs });
  assert.deepEqual(next, { lastReplyAt: NOW, participants: [{ userId: '101', until: NOW + WINDOW }, { userId: '102', until: NOW + 50_000 }] });
  assert.equal(previous.participants[0].until, NOW + 5000);
  assert.deepEqual([...seenSeqs], [1]);
  assert.notEqual(next, previous);
  assert.equal(continuationMatches(next, '102', NOW + 50_000), false);
  assert.equal(continuationMatches(next, '101', NOW + 50_000), true);
});

test('a newly answered ninth participant is retained and evicts the oldest stored participant', () => {
  const previous = state(Array.from({ length: 8 }, (_, index) => ({ userId: String(index + 1), until: NOW + 100_000 })), NOW - 2000);
  const next = reply({ previous, messages: [inbound(1, '9')], windowMs: 1000 });
  assert.equal(next.participants.length, 8);
  assert.deepEqual(next.participants.map(({ userId }) => userId), ['9', '1', '2', '3', '4', '5', '6', '7']);
  assert.equal(next.participants[0].until, NOW + 1000);
  assert.equal(next.participants[1].until, NOW + 100_000);
});

test('unseen messages and nonnumeric/missing local sequences never become participants', () => {
  assert.equal(reply({ seenSeqs: new Set() }), null);
  assert.equal(reply({ seenSeqs: new Set(['1']) }), null);
  for (const seq of [undefined, null, '1', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(reply({ messages: [inbound(seq, '101', { seq })], seenSeqs: new Set([seq]) }), null);
  }
  const messages = [inbound(1, '101'), inbound(2, '102', { time: NOW })];
  assert.deepEqual(reply({ messages, seenSeqs: new Set([1]) }), expected('101'));
});

test('seen evidence must be a real Set, including cross-realm Sets', () => {
  const crossRealm = vm.runInNewContext('new Set([1])');
  assert.deepEqual(reply({ seenSeqs: crossRealm }), expected());
  for (const seenSeqs of [undefined, null, [1], {}, { has: () => true }, new Map([[1, true]]), { [Symbol.toStringTag]: 'Set', has: () => true }]) {
    assert.equal(reply({ seenSeqs }), null);
  }
  const realSet = new Set([1]);
  realSet.has = () => false;
  assert.deepEqual(reply({ seenSeqs: realSet }), expected(), 'the intrinsic reads actual membership');
});

test('self, fish, poke, invalid sender, and messages addressed to another person are excluded', () => {
  for (const flags of [{ isSelf: true }, { fish: true }, { kind: 'poke' }, { addressedToOther: true }, { userId: null }, { userId: 'all' }]) {
    assert.equal(reply({ messages: [inbound(1, '101', flags)] }), null);
    const messages = [inbound(1, '101'), inbound(2, '102', { time: NOW, ...flags })];
    assert.deepEqual(reply({ messages, seenSeqs: new Set([1, 2]) }), expected('101'));
  }
});

test('candidate time must be valid, inside the window, and never in the future', () => {
  for (const time of [undefined, null, String(NOW), NaN, Infinity, -1, 1.5, NOW + 1, NOW - WINDOW - 1]) {
    assert.equal(reply({ messages: [inbound(1, '101', { time })] }), null);
  }
  assert.deepEqual(reply({ messages: [inbound(1, '101', { time: NOW - WINDOW })] }), expected());
  assert.deepEqual(reply({ messages: [inbound(1, '101', { time: NOW })] }), expected());
});

test('latest eligible seen inbound wins regardless of array order; seq breaks time ties', () => {
  const older = inbound(1, '101', { time: NOW - 2000 });
  const newer = inbound(2, '102', { time: NOW - 1000 });
  assert.deepEqual(reply({ messages: [newer, older], seenSeqs: new Set([1, 2]) }), expected('102'));
  const tied = inbound(3, '103', { time: newer.time });
  assert.deepEqual(reply({ messages: [tied, newer, older], seenSeqs: new Set([1, 2, 3]) }), expected('103'));
});

test('explicit at selects an older eligible seen human; reply accepts negative QQ message IDs', () => {
  const older = inbound(1, '101', { time: NOW - 20_000 });
  const newer = inbound(2, '102');
  const args = { previous: state(undefined, NOW - 10_000), messages: [older, newer], seenSeqs: new Set([1, 2]) };
  assert.deepEqual(reply({ ...args, atUserId: 101 }), expected('101'));
  assert.deepEqual(reply({ ...args, replyToMessageId: -1001 }), expected('101'));
  assert.deepEqual(reply({ ...args, atUserId: '101', replyToMessageId: '-1001' }), expected('101'));
});

test('invalid, unknown and conflicting explicit targets fail closed without inferring latest person', () => {
  const messages = [inbound(1, '101'), inbound(2, '102', { time: NOW })];
  const previous = state();
  for (const target of [
    { atUserId: '999' }, { atUserId: null }, { atUserId: 'all' }, { atUserId: 0 }, { atUserId: ' 101' },
    { replyToMessageId: '999' }, { replyToMessageId: 0 }, { replyToMessageId: null }, { replyToMessageId: '' },
    { replyToMessageId: '1' }, // A local seq is not a QQ message ID.
    { replyToMessageId: '-1001', atUserId: '102' },
    { replyToMessageId: '-1001', atUserId: null },
  ]) {
    assert.equal(reply({ messages, seenSeqs: new Set([1, 2]), ...target }), null, JSON.stringify(target));
    assert.deepEqual(reply({ previous, messages, seenSeqs: new Set([1, 2]), ...target }), previous);
  }
});

test('explicit targets still reject unseen, fish, self, poke, addressed-to-other, stale and future messages', () => {
  for (const overrides of [{}, { fish: true }, { isSelf: true }, { kind: 'poke' }, { addressedToOther: true }, { time: NOW + 1 }, { time: NOW - WINDOW - 1 }]) {
    const targeted = inbound(1, '101', overrides);
    const messages = [targeted, inbound(2, '102')];
    const seenSeqs = Object.keys(overrides).length ? new Set([1, 2]) : new Set([2]);
    assert.equal(reply({ messages, seenSeqs, atUserId: '101' }), null);
    assert.equal(reply({ messages, seenSeqs, replyToMessageId: targeted.messageId }), null);
  }
});

test('proactive/repeated sends do not renew already answered context or advance lastReplyAt', () => {
  const previous = reply();
  const second = reply({ previous, now: NOW + 1000 });
  assert.deepEqual(second, previous);
  assert.deepEqual(reply({ previous: second, now: NOW + 100_000 }), previous);
  assert.equal(reply({ previous: second, now: NOW + WINDOW }), null);
  assert.deepEqual(reply({ previous, messages: [], now: NOW + 1000 }), previous);
  assert.deepEqual(reply({ previous, messages: null, now: NOW + 1000 }), previous);
});

test('fresh inbound at/after lastReplyAt renews only that participant', () => {
  const previous = reply();
  const now = NOW + 5000;
  assert.deepEqual(reply({ previous, now, messages: [inbound(2, '101', { time: NOW + 1 })], seenSeqs: new Set([2]) }), expected('101', now));
  assert.deepEqual(reply({ previous, now, messages: [inbound(2, '101', { time: NOW })], seenSeqs: new Set([2]) }), expected('101', now));
  const twoPeople = reply({ previous, now, messages: [inbound(2, '102', { time: NOW + 1 })], seenSeqs: new Set([2]) });
  assert.deepEqual(twoPeople, { lastReplyAt: now, participants: [{ userId: '102', until: now + WINDOW }, { userId: '101', until: NOW + WINDOW }] });
});

test('expired short-window participants retain the lastReplyAt cutoff for stale implicit context', () => {
  const previous = { lastReplyAt: NOW - 2000, participants: [{ userId: '101', until: NOW - 1000 }] };
  const messages = [inbound(1, '101', { time: NOW - 3000 })];
  assert.equal(reply({ previous, messages }), null);
  assert.deepEqual(reply({ previous, messages, atUserId: '101' }), expected());
});

test('window configuration is bounded, zero disables, and invalid values fail closed', () => {
  assert.deepEqual(reply({ windowMs: 10 * WINDOW }), expected());
  assert.deepEqual(reply({ windowMs: 5000 }), expected('101', NOW, 5000));
  assert.deepEqual(reply({ windowMs: 5000.9 }), expected('101', NOW, 5000));
  assert.equal(reply({ windowMs: 999 }), null, 'inbound is older than configured window');
  for (const windowMs of [0, -1, 0.9, NaN, Infinity, -Infinity, null, '5000', false, {}]) {
    assert.equal(reply({ windowMs, previous: state() }), null);
  }
});

test('explicit goodbye or requested stop removes only the selected participant', () => {
  const previous = state([{ userId: '101', until: NOW + 100_000 }, { userId: '102', until: NOW + 200_000 }], NOW - 5000);
  for (const plain of ['晚安', '先这样，我下了', '不聊了', '别回复了']) {
    const messages = [inbound(1, '101', { plain })];
    assert.equal(reply({ messages }), null, plain);
    assert.deepEqual(reply({ previous, messages }), state([{ userId: '102', until: NOW + 200_000 }], previous.lastReplyAt), plain);
  }
});

test('ending selection does not fall back to a different human or revive a quoted earlier message', () => {
  const earlier = inbound(1, '101', { time: NOW - 3000 });
  const other = inbound(2, '102', { time: NOW - 2000 });
  const ending = inbound(3, '101', { time: NOW - 1000, plain: '晚安' });
  const messages = [earlier, other, ending];
  const seenSeqs = new Set([1, 2, 3]);
  assert.equal(reply({ messages, seenSeqs }), null);
  assert.equal(reply({ messages, seenSeqs, replyToMessageId: earlier.messageId }), null);
  assert.equal(reply({ messages, seenSeqs, atUserId: '101' }), null);
  assert.deepEqual(reply({ messages, seenSeqs: new Set([1, 2]), replyToMessageId: earlier.messageId }), expected(), 'unseen ending is not model evidence; bridge handles inbound clearing');
});

test('new substantive message after a goodbye can start a fresh continuation', () => {
  const ending = inbound(1, '101', { time: NOW - 2000, plain: '晚安' });
  const fresh = inbound(2, '101', { time: NOW - 1000, plain: '你现在去了解一下' });
  assert.deepEqual(reply({ messages: [ending, fresh], seenSeqs: new Set([1, 2]) }), expected());
});

console.log(`\n${process.exitCode ? 'FAILED' : 'OK'} (conversation-continuation ${passed} groups)`);
