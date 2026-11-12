/**
 * Bounded conversation participants (pure logic; no I/O or mutable state).
 * The bridge calls recordConversationReply only after an actual successful send.
 * Reading messages, waking, or attempting a send never creates a continuation.
 */
import { classifyMessage } from './conversation-closure.js';

export const DEFAULT_CONTINUATION_WINDOW_MS = 300_000;
const MAX_PARTICIPANTS = 8;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isTime = (value) => Number.isSafeInteger(value) && value >= 0;
const deadline = (time, duration) => Math.min(Number.MAX_SAFE_INTEGER, time + duration);

function userIdOf(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? value : null;
}

function messageIdOf(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value !== 0 ? String(value) : null;
  return typeof value === 'string' && /^-?[1-9]\d*$/.test(value) ? value : null;
}

function replyTimeOf(raw, now) {
  return isRecord(raw) && isTime(raw.lastReplyAt) ? Math.min(raw.lastReplyAt, now) : null;
}

/**
 * Sanitize persisted state without renewing it. Invalid entries are discarded;
 * duplicates keep the shorter deadline. A future reply time clamps to now and
 * every expiry is bounded by that reply time plus five minutes. Order is most
 * recently replied first, so retaining the first eight also bounds loaded state.
 */
export function normalizeContinuation(raw, now = Date.now()) {
  if (!isTime(now) || !isRecord(raw) || !Array.isArray(raw.participants)) return null;
  const lastReplyAt = replyTimeOf(raw, now);
  if (lastReplyAt === null) return null;
  const maxUntil = deadline(lastReplyAt, DEFAULT_CONTINUATION_WINDOW_MS);
  const participants = new Map();
  for (const entry of raw.participants) {
    if (!isRecord(entry)) continue;
    const userId = userIdOf(entry.userId);
    if (!userId || !isTime(entry.until)) continue;
    const until = Math.min(entry.until, maxUntil);
    if (until <= now) continue;
    if (participants.has(userId)) {
      participants.set(userId, Math.min(participants.get(userId), until));
    } else if (participants.size < MAX_PARTICIPANTS) {
      participants.set(userId, until);
    }
  }
  if (!participants.size) return null;
  return { lastReplyAt, participants: [...participants].map(([userId, until]) => ({ userId, until })) };
}

// Calling the Set intrinsic checks its internal slot, including across VM realms.
// instanceof rejects real cross-realm Sets; duck typing accepts forged evidence.
function wasSeen(seenSeqs, seq) {
  if (!Number.isSafeInteger(seq) || seq <= 0) return false;
  try {
    return Set.prototype.has.call(seenSeqs, seq);
  } catch {
    return false;
  }
}

function isNewer(candidate, current) {
  return !current || candidate.message.time > current.message.time
    || (candidate.message.time === current.message.time && candidate.message.seq > current.message.seq);
}

/**
 * Record the human a successful outgoing message answered.
 *
 * messages is recent inbound/outbound context; seenSeqs contains numeric local
 * sequences actually shown to the model. Explicit targets must match eligible
 * seen inbound context, and conflicting/invalid targets never fall back to an
 * inferred person. An explicit target may select an older message in the window.
 * Without a target, the newest eligible inbound must be at/after lastReplyAt.
 *
 * Only the selected person's expiry changes. No candidate preserves existing
 * deadlines and lastReplyAt. A selected goodbye/stop removes that person, even
 * when an explicit quote points to their older message. Other participants stay.
 * windowMs affects new candidates/deadlines; zero or invalid values disable it.
 */
export function recordConversationReply({
  previous,
  messages = [],
  seenSeqs = new Set(),
  now = Date.now(),
  windowMs = DEFAULT_CONTINUATION_WINDOW_MS,
  replyToMessageId,
  atUserId,
} = {}) {
  if (!isTime(now)) return null;
  const window = typeof windowMs === 'number' && Number.isFinite(windowMs)
    ? Math.min(DEFAULT_CONTINUATION_WINDOW_MS, Math.max(0, Math.floor(windowMs))) : 0;
  if (!window) return null;

  const prior = normalizeContinuation(previous, now);
  // Keep this cutoff even when previous participants just expired (e.g. a short
  // configured window), or proactive sends could resurrect already answered text.
  const lastReplyAt = replyTimeOf(previous, now) ?? 0;
  const hasAt = atUserId !== undefined;
  const hasReply = replyToMessageId !== undefined;
  const targetUserId = hasAt ? userIdOf(atUserId) : null;
  const targetMessageId = hasReply ? messageIdOf(replyToMessageId) : null;
  if ((hasAt && !targetUserId) || (hasReply && !targetMessageId)) return prior;

  let candidate = null;
  const latestByUser = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isRecord(message) || message.isSelf || message.fish || message.kind === 'poke' || message.addressedToOther) continue;
    const userId = userIdOf(message.userId);
    if (!userId || !wasSeen(seenSeqs, message.seq) || !isTime(message.time)
      || message.time > now || message.time < now - window) continue;
    const item = { userId, message };
    if (isNewer(item, latestByUser.get(userId))) latestByUser.set(userId, item);

    if (hasReply && messageIdOf(message.messageId) !== targetMessageId) continue;
    if (hasAt && userId !== targetUserId) continue;
    if (!hasAt && !hasReply && message.time < lastReplyAt) continue;
    if (isNewer(item, candidate)) candidate = item;
  }
  if (!candidate) return prior;

  const { userId } = candidate;
  const latest = latestByUser.get(userId);
  const ending = classifyMessage(candidate.message).kind === 'ending'
    || classifyMessage(latest.message).kind === 'ending';
  const others = (prior?.participants ?? []).filter((entry) => entry.userId !== userId);
  if (ending) {
    return others.length ? { lastReplyAt: prior.lastReplyAt, participants: others } : null;
  }
  return normalizeContinuation({
    lastReplyAt: now,
    participants: [{ userId, until: deadline(now, window) }, ...others],
  }, now);
}

/** Whether a valid, unexpired participant has exactly this positive decimal ID. */
export function continuationMatches(record, userId, now = Date.now()) {
  const id = userIdOf(userId);
  return Boolean(id && normalizeContinuation(record, now)?.participants.some((entry) => entry.userId === id));
}

/** Latest valid per-user expiry, or zero when there is no continuing participant. */
export function continuationExpiresAt(record, now = Date.now()) {
  const valid = normalizeContinuation(record, now);
  return valid ? Math.max(...valid.participants.map((entry) => entry.until)) : 0;
}
