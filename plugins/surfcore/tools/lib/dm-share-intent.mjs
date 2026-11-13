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

export function tasksForItem(item, batchId, ownerMid) {
  const mid = exactId(item?.mid);
  const messages = Array.isArray(item?.messages) ? item.messages : [];
  if (!mid || !messages.length || messages.some((m) => !exactId(m.seq))) throw Object.assign(new Error('私信批次缺少准确的用户或消息序号。'), err('dm.batch-invalid', '私信批次缺少准确的用户或消息序号。', '保留游标并检查私信读取器，不能猜测消息编号。'));
  const ordered = [...messages].sort((a, b) => BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0);
  const context = Array.isArray(item.context) ? item.context : Array.isArray(item.context?.messages) ? item.context.messages : [];
  let nearby = context.filter((m) => m.video && exactId(m.seq) && BigInt(m.seq) < BigInt(ordered[0].seq)).at(-1)?.video ?? item.context?.video ?? null;
  const jobs = [], conversation = [], usedCards = new Set();
  let nearbySeq = null;
  for (const message of ordered) {
    if (Number(message.type) === 7) { nearby = message.video || null; nearbySeq = message.seq; }
    const request = mid === ownerMid && Number(message.type) === 1 ? shareIntent(message.text) : null;
    if (!request) { conversation.push(message); continue; }
    const explicit = bvidOf(message.text);
    const chosen = explicit.length === 1 ? { bvid: explicit[0], title: explicit[0], url: 'https://www.bilibili.com/video/' + explicit[0] } : nearby;
    if (!explicit.length && nearbySeq) usedCards.add(nearbySeq);
    const video = chosen && /^BV[0-9A-Za-z]{10}$/.test(String(chosen.bvid ?? '')) ? { bvid: chosen.bvid, title: clipText(chosen.title || chosen.bvid, 160), url: 'https://www.bilibili.com/video/' + chosen.bvid } : null;
    const error = (message.truncated ? err('dm.instruction-truncated', '分享指令没有完整读到，尚未执行。', '请用一条简短私信重发完整的分享要求。') : null) ?? request.error ?? (explicit.length > 1 ? err('dm.video-ambiguous', '这条指令包含多个视频。', '请每次明确分享一个视频。') : !video ? err('dm.video-missing', '没有读到这条分享指令对应的视频。', '请重新发视频卡片或 BV 链接，再说明要分享到哪个群。') : null);
    jobs.push({ id: taskId(mid, message.seq, 'share'), kind: 'share', batchId, mid, ownerMid, name: clipText(item.name, 80), sourceSeq: exactId(message.seq), request: clipText(message.text, 8000), video, target: request.target, status: error ? 'needs_input' : 'pending', error, messages: [message] });
  }
  // Card-only messages used by an explicit share are context, not a second reply task.
  const remaining = conversation.filter((m) => !usedCards.has(m.seq));
  if (remaining.length) jobs.push({ id: taskId(mid, remaining.at(-1).seq, 'conversation'), kind: 'conversation', batchId, mid, ownerMid, name: clipText(item.name, 80), sourceSeq: exactId(remaining.at(-1).seq), messages: remaining, context, status: 'pending' });
  return jobs;
}
