// Dynamic context shared by the inbox CLI and scheduler. No state writes or sending.
import { createDynamicReader, dynamicIdFrom, formatDynamicRead } from './dynamic-reader.mjs';

export function notificationDynamicId(item) {
  const fromUri = dynamicIdFrom(item?.uri);
  if (fromUri) return fromUri;
  // Type 11 oid is a drawing's reply resource ID, not a dynamic ID; it needs a URI.
  return Number(item?.business) === 17 ? dynamicIdFrom(item?.oid) : '';
}

// Newest notifications get the budget first; repeated mentions share one GET/result.
export async function readInboxDynamics(items, {
  headers = {}, readDynamic = createDynamicReader({ headers }),
  maxDynamics = 8, maxChars = 16000, raw = false,
} = {}) {
  const contexts = new Map();
  const skipped = [];
  if (raw) return { contexts, skipped, unresolved: 0, unreadNotice: '', text: '' };
  const unresolved = items.filter((item) => [11, 17].includes(Number(item?.business)) && !notificationDynamicId(item)).length;
  const unreadNotice = unresolved ? `【原文未读取】${unresolved} 条动态通知缺少可靠的链接或精确 ID；不能用图文评论资源号或已丢精度的数字推测。请从 B站复制完整动态链接，再运行 node bili.mjs read-dynamic <动态链接>。` : '';
  const limit = Number.isFinite(Number(maxDynamics)) ? Math.max(0, Math.min(20, Math.floor(Number(maxDynamics)))) : 8;
  const budget = Number.isFinite(Number(maxChars)) ? Math.max(1000, Math.min(30000, Math.floor(Number(maxChars)))) : 16000;
  const ids = [...new Set([...items].sort((a, b) => Number(b.t || 0) - Number(a.t || 0)).map(notificationDynamicId).filter(Boolean))];
  let used = unreadNotice ? unreadNotice.length + 2 : 0;
  for (const id of ids) {
    // Leave space for a single actionable omission notice in the wake-up context.
    if (contexts.size >= limit || budget - used < 800) { skipped.push(id); continue; }
    let result;
    try { result = await readDynamic(id); }
    catch { result = { ok: false, code: 'dynamic.read-failed', error: '动态读取失败，尚未取得原文。', hint: '稍后用 read-dynamic 重试；不要把收件箱摘要当成完整正文。' }; }
    const text = formatDynamicRead(result, { maxChars: Math.min(6000, budget - used - 250) });
    const block = `【通知对应动态 ${id}】
${text}`;
    contexts.set(id, { result, text: block });
    used += block.length + 2;
  }
  const blocks = [...(unreadNotice ? [unreadNotice] : []), ...[...contexts.values()].map((entry) => entry.text)];
  if (skipped.length) blocks.push(`【阅读预算】另有 ${skipped.length} 条动态未展开；需要时运行 node bili.mjs read-dynamic <动态id>。这些原文尚未读取，不要据此判断为空。`);
  return { contexts, skipped, unresolved, unreadNotice, text: blocks.join('\n\n') };
}
