import crypto from 'node:crypto';

export const exactId = (value) => typeof value === 'string' && /^[1-9]\d{0,29}$/.test(value) ? value : Number.isSafeInteger(value) && value > 0 ? String(value) : '';
export const clipText = (value, max = 2000) => String(value ?? '').slice(0, max).replace(/[\uD800-\uDBFF]$/, '').toWellFormed();
export const taskId = (mid, seq, kind) => crypto.createHash('sha256').update([mid, seq, kind].join(':')).digest('hex').slice(0, 32);
const bvidOf = (text) => [...new Set(String(text ?? '').match(/BV[0-9A-Za-z]{10}(?![0-9A-Za-z])/g) ?? [])];
const err = (code, error, hint) => ({ code, error, hint });

// Only direct, positive owner instructions create a cross-platform task. Video titles
// and other people's messages are data, never instructions or routing authority.
export function shareIntent(text) {
  const value = String(text ?? '').trim();
  const action = /(?:分享|转发|发送|发)(?:一下)?(?:这个视频|该视频|视频)?(?:给|到)\s*(?:QQ\s*)?/i.exec(value);
  if (!action || !/(?:视频|BV[0-9A-Za-z]{10})/.test(value)) return null;
  const prefix = value.slice(0, action.index).trim();
  const direct = /^(?:(?:请|麻烦)(?:你|帮我)?|帮我|你)?\s*(?:把|将)?\s*(?:(?:这个|这条|该|上面(?:的)?)?视频)(?:\s*BV[0-9A-Za-z]{10}(?:\s*(?:和|与|、)\s*BV[0-9A-Za-z]{10})*)?\s*$/.test(prefix);
  if ((!direct && !(prefix === '' && /视频/.test(action[0]))) || /[?？]|需要怎么|如何操作/.test(value)) return null;
  if (/(?:^|[，,。；;\n])\s*(?:算了[,，]?\s*)?(?:别发|不要发|不用发|取消分享|停止分享)(?:了)?\s*(?=$|[，,。；;\n])/.test(value)) return null;
  if (/(?:不要|别|不准|不许|取消|停止)[^，,。;；\n]{0,16}$/.test(value.slice(0, action.index))
      || /(?:取消|停止)(?:分享|发送)|(?:别|不要)(?:分享|转发|发送|发到)/.test(value)) return null;
  const tail = value.slice(action.index + action[0].length);
  let target = '';
  const quoted = /^(?:群聊|群)?\s*[「“"']([^」”"'\n]{1,80})[」”"'](?:群|群聊)?/.exec(tail);
  const named = /^(?:群聊|群)\s*(.+?)(?:中|里|内)?(?=[，,。.!！；;\n]|$)/.exec(tail);
  const suffix = /^(.+?)(?:群|群聊)(?:中|里|内)?(?=[，,。.!！；;\n]|$)/.exec(tail);
  if (quoted) {
    target = quoted[1];
    if (tail.slice(quoted[0].length).trim() && !/^[，,。.!！；;\n]/.test(tail.slice(quoted[0].length).trim())) return { target: '', error: err('dm.target-ambiguous', '引号后的内容还包含不明确的群目标。', '请每条指令只指定一个完整群名或群号。') };
  }
  else if (named) target = named[1];
  else if (suffix) target = suffix[1];
  else if (/^\d{5,12}(?=[，,。.!！\s]|$)/.test(tail)) target = tail.match(/^\d+/)[0];
  else if (!/群/.test(tail)) return null;
  target = target.trim();
  if (!target || /^(?:里|中|内|聊)$/.test(target)) return { target: '', error: err('dm.target-missing', '还没有明确要分享到哪个群。', '请补发明确的群名或群号，例如：把这个视频分享到群聊「命运糕手」。') };
  if (target.length > 80 || /[、;；\n]|(?:以及|还有|和|与).*(?:群|QQ)/.test(target)) return { target, error: err('dm.target-ambiguous', '这条指令包含多个或不明确的群目标。', '请每次只指定一个群，用引号写出完整群名。') };
  return { target };
}

export const VIDEO_WAIT_MS = 120000;
const orderedMessages = (messages) => [...messages].sort((a, b) => BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0);
const publicVideo = (video) => video && /^BV[0-9A-Za-z]{10}$/.test(String(video.bvid ?? '')) ? { bvid: video.bvid, title: clipText(video.title || video.bvid, 160), url: 'https://www.bilibili.com/video/' + video.bvid } : null;
const sourceTime = (ts) => Number.isSafeInteger(ts) && ts > 0 && ts <= Math.floor((Number.MAX_SAFE_INTEGER - VIDEO_WAIT_MS) / 1000);
const cancellation = (text) => /(?:^|[，,。；;\n])\s*(?:算了(?:吧)?[,，]?\s*|(?:先)?(?:别|不要|不用)(?:分享|转发|发送|发)(?:了)?|取消(?:分享|发送|了)?|停止(?:分享|发送))(?:[，,。！!；;\s]|$)/.test(String(text ?? '').trim());
const missingVideo = () => err('dm.video-missing', '两分钟内没有读到这条分享指令对应的视频。', '请重新发一个视频卡片或 BV 链接，并重新说明要分享到哪个群；旧指令不会自动恢复。');

// Inspect the entire received segment before choosing a card. A later poll cannot
// change an already bound task; ambiguity in the current segment is never guessed.
export function resolveWaitingVideo(job, messages = [], now = Date.now()) {
  if (job.status !== 'waiting_video') return job;
  const stop = (error, attached = []) => ({ ...job, status: 'needs_input', error, retryable: false, messages: [...job.messages, ...attached] });
  if (!sourceTime(job.sourceTs) || job.waitingUntil !== job.sourceTs * 1000 + VIDEO_WAIT_MS || !exactId(job.sourceSeq)) return stop(err('dm.video-time-invalid', '分享指令缺少可靠的消息时间或序号。', '请重新发视频和完整指令，不能推测旧指令的关联窗口。'));
  const cards = [];
  let boundary = false, cancelled = null, invalidTime = false;
  for (const message of orderedMessages(messages)) {
    if (BigInt(message.seq) <= BigInt(job.sourceSeq)) continue;
    if (!sourceTime(message.ts) || message.ts < job.sourceTs) { invalidTime = true; break; }
    if (message.ts * 1000 > job.waitingUntil) break;
    if (Number(message.type) === 7) { cards.push(message); continue; }
    if (Number(message.type) === 1 && cancellation(message.text)) cancelled = message;
    boundary = true;
    break;
  }
  if (invalidTime) return stop(err('dm.video-time-invalid', '后续消息的时间无法可靠关联到分享指令。', '请重新发一个视频和完整分享指令。'), cards);
  if (cancelled) return stop(err('dm.share-cancelled', '已取消这条等待视频的分享。', '如需分享，请重新发送视频和明确的群目标。'), [...cards, cancelled]);
  if (cards.some((message) => message.error || !publicVideo(message.video))) return stop(err('dm.video-unreadable', '后续卡片无法确认为可分享的 B站视频，尚未执行。', '请发送一个明确的 BV 链接，并重新说明群目标。'), cards);
  if (cards.length > 1) return stop(err('dm.video-ambiguous', '这条分享指令后出现了多个视频卡片，尚未选择。', '请在一条新指令中写明一个 BV 链接和群目标。'), cards);
  if (cards.length === 1) return { ...job, status: 'pending', video: publicVideo(cards[0].video), videoSourceSeq: exactId(cards[0].seq), messages: [...job.messages, cards[0]], error: null, retryable: false };
  if (boundary) return stop(err('dm.video-interrupted', '补发视频前出现了其他消息，这条分享指令已停止等待。', '请重新发送视频和完整分享指令，避免把后来的无关视频发到群里。'));
  // Source timestamps decide association, even when intake is delayed. Expiry is
  // evaluated only after the complete current batch has had a chance to bind.
  return now >= job.waitingUntil ? stop(missingVideo()) : job;
}

export function tasksForItem(item, batchId, ownerMid, { existing = [], now = Date.now() } = {}) {
  const mid = exactId(item?.mid);
  const messages = Array.isArray(item?.messages) ? item.messages : [];
  if (!mid || !messages.length || messages.length > 200 || messages.some((m) => !exactId(m.seq)) || new Set(messages.map((m) => m.seq)).size !== messages.length) throw Object.assign(new Error('私信批次缺少准确的用户或消息序号。'), err('dm.batch-invalid', '私信批次缺少准确的用户或消息序号。', '保留游标并检查私信读取器，不能猜测消息编号。'));
  const ordered = orderedMessages(messages);
  const context = Array.isArray(item.context) ? item.context : Array.isArray(item.context?.messages) ? item.context.messages : [];
  const previousCard = orderedMessages(context.filter((m) => Number(m.type) === 7 && exactId(m.seq) && BigInt(m.seq) < BigInt(ordered[0].seq))).at(-1);
  let nearby = previousCard?.video ?? (previousCard ? null : item.context?.video ?? null);
  let nearbySeq = previousCard?.seq ?? null, invalidNearby = Boolean(previousCard && !publicVideo(previousCard.video));
  const jobs = new Map(), conversation = [], usedCards = new Set(), previous = new Map(existing.map((j) => [j.id, j]));
  const incoming = new Set(ordered.map((m) => m.seq));
  for (const job of existing) {
    if (job.kind !== 'share' || job.mid !== mid) continue;
    const owned = [job.sourceSeq, job.videoSourceSeq, ...(job.messages ?? []).map((m) => m.seq)].filter(Boolean);
    for (const seq of owned) usedCards.add(seq);
    if (owned.some((seq) => incoming.has(seq)) || job.status === 'waiting_video' && job.ownerMid === ownerMid && mid === ownerMid) jobs.set(job.id, structuredClone(job));
  }
  for (const message of ordered) {
    if (Number(message.type) === 7) { nearby = message.video || null; nearbySeq = message.seq; invalidNearby = Boolean(message.error || !publicVideo(nearby)); }
    const request = mid === ownerMid && Number(message.type) === 1 ? shareIntent(message.text) : null;
    if (!request) { conversation.push(message); continue; }
    const id = taskId(mid, message.seq, 'share');
    if (previous.has(id)) { jobs.set(id, structuredClone(previous.get(id))); continue; }
    const explicit = bvidOf(message.text);
    const video = publicVideo(explicit.length === 1 ? { bvid: explicit[0] } : nearby);
    if (!explicit.length && nearbySeq) usedCards.add(nearbySeq);
    const error = (message.truncated ? err('dm.instruction-truncated', '分享指令没有完整读到，尚未执行。', '请用一条简短私信重发完整的分享要求。') : null) ?? request.error ?? (explicit.length > 1 ? err('dm.video-ambiguous', '这条指令包含多个视频。', '请每次明确分享一个视频。') : !video ? missingVideo() : null);
    const waiting = error?.code === 'dm.video-missing' && !invalidNearby;
    jobs.set(id, { id, kind: 'share', batchId, mid, ownerMid, name: clipText(item.name, 80), sourceSeq: exactId(message.seq), sourceTs: message.ts, request: clipText(message.text, 8000), video, target: request.target, status: waiting ? 'waiting_video' : error ? 'needs_input' : 'pending', error: waiting ? err('dm.video-missing', '正在等待这条分享指令对应的视频。', '请在指令发出后两分钟内补发一个视频卡片；期间不要插入其他消息。') : error, messages: [message], ...(waiting ? { waitingUntil: sourceTime(message.ts) ? message.ts * 1000 + VIDEO_WAIT_MS : 0 } : video && !explicit.length && nearbySeq ? { videoSourceSeq: exactId(nearbySeq) } : {}) });
  }
  for (const [id, job] of jobs) {
    const resolved = job.ownerMid === ownerMid && mid === ownerMid ? resolveWaitingVideo(job, ordered, now) : job;
    jobs.set(id, resolved);
    for (const message of resolved.messages ?? []) usedCards.add(message.seq);
  }
  // Cards/cancellations retained by a share are not a second private reply task,
  // including when an already accepted inbox batch is replayed after a crash.
  const remaining = conversation.filter((m) => !usedCards.has(m.seq));
  if (remaining.length) {
    const id = taskId(mid, remaining.at(-1).seq, 'conversation');
    jobs.set(id, { id, kind: 'conversation', batchId, mid, ownerMid, name: clipText(item.name, 80), sourceSeq: exactId(remaining.at(-1).seq), messages: remaining, context, status: 'pending' });
  }
  return [...jobs.values()];
}
