import { randomUUID } from 'node:crypto';
import { clipText } from './dm-share-intent.mjs';

export const taskFailure = (code, error, hint, extra = {}) => ({ ok: false, code, error, hint, ...extra });
export function commandResult(run, fallback = 'dm.command-failed') {
  let result;
  try { result = JSON.parse(String(run?.out ?? '').trim().split('\n').at(-1)); } catch {}
  if (result && typeof result.ok === 'boolean') return result;
  return taskFailure(fallback, '私信命令没有返回可确认的执行结果。', '查看私信任务状态并检查登录或网络；不要假定消息已发送。', { status: 'unknown', retryable: false });
}
const publicError = (r, fallback = 'dm.failed') => taskFailure(String(r?.code || fallback).slice(0, 80), clipText(r?.error || '这一步没有完成。', 160), clipText(r?.hint || '请查看任务状态，解决问题后重试。', 200), { retryable: r?.retryable === true, status: r?.status === 'unknown' ? 'unknown' : 'failed' });
const groupLabel = (job) => /^\d+$/.test(job.group?.name || job.target || '') ? '指定群' : clipText(job.group?.name || job.target || '指定群', 40);

export function createDmTaskService({ store, bridge, runBili, getConfig, isCurrent = () => true, now = Date.now }) {
  function check(job, share = false) {
    if (!job) return taskFailure('dm.task-missing', '找不到这条私信任务。', '运行 dm-task list，使用当前角色的任务编号。');
    const cfg = getConfig();
    if (!isCurrent()) return taskFailure('dm.role-changed', '角色已经切换，这条任务已暂停。', '切回原角色后查看任务状态。');
    if (cfg.interact?.enabled === false) return taskFailure('dm.interaction-disabled', '互动已关闭，任务已保留。', '重新开启互动后重试。', { retryable: true });
    if (String(cfg.owner?.mid ?? '') !== job.ownerMid || (share && job.mid !== job.ownerMid)) return taskFailure('dm.owner-changed', '这条任务的主人身份与当前配置不一致。', '核对主人配置后重试；不能改成另一个接收人。');
    return null;
  }
  async function call(route, options) {
    try {
      const r = await bridge(route, options);
      if (r?.data && typeof r.data.ok === 'boolean') return r.data;
    } catch {}
    return taskFailure('dm.bridge-unavailable', 'QQ 桥接没有返回可确认的结果。', '检查 QQ 桥接状态；先查询原任务回执，不要重新建立分享任务。', { status: 'unknown', retryable: false });
  }
  function verifiedReceipt(result, job) {
    const r = result?.receipt;
    return result?.ok === true && result.status === 'sent' && r && /^-?\d+$/.test(String(r.messageId)) && String(r.messageId) !== '0' && String(r.groupId) === String(job.group?.id) && Number.isFinite(Date.parse(r.sentAt));
  }
  function rememberDelivery(id, result) {
    return store.update(id, (job) => {
      if (job.status === 'sent') return job;
      if (verifiedReceipt(result, job)) return { ...job, status: 'sent', receipt: result.receipt, error: null, retryable: false };
      const failure = publicError(result?.ok === true ? null : result, 'dm.receipt-invalid');
      if (result?.ok === true) { failure.status = 'unknown'; failure.retryable = false; failure.hint = '没有收到有效的群消息回执，请先核对群记录。'; }
      return { ...job, status: failure.status, error: failure, retryable: failure.retryable };
    });
  }
  async function reconcile(id) {
    const job = store.get(id), blocked = check(job, job?.kind === 'share');
    if (blocked) return blocked;
    if (job.kind !== 'share') return { ok: true, status: job.status };
    if (job.status === 'sent') return { ok: true, status: 'sent', receipt: job.receipt };
    if (!['sending', 'unknown'].includes(job.status)) return { ok: true, status: job.status };
    const result = await call('/api/bili/dm-share/status?requestId=' + encodeURIComponent(id), { timeoutMs: 8000 });
    // Not-found while another process is about to post is not permission to resend.
    if (verifiedReceipt(result, job)) rememberDelivery(id, result);
    else if (now() - (job.sendingAt || 0) >= 90000) {
      const last = publicError(result, 'dm.delivery-unconfirmed');
      const error = taskFailure('dm.delivery-unconfirmed', '上次群分享未取得可确认回执。' + last.error, '先核对目标群和桥接记录；旧失败记录或 NOT_FOUND 都不能证明最近一次未发送，请勿自动重发。', { status: 'unknown', retryable: false });
      store.update(id, (current) => ['sending', 'unknown'].includes(current.status) ? { ...current, status: 'unknown', error, retryable: false } : current);
    }
    store.update(id, { reconcileAt: now() });
    return result;
  }
  async function prepare(id) {
    const job = store.get(id), blocked = check(job, true);
    if (blocked) return blocked;
    if (job.kind !== 'share') return taskFailure('dm.not-share', '这是一条普通私信任务。', '使用 dm-task reply 回复。');
    if (job.error && job.status === 'needs_input') return job.error;
    if (job.group) return { ok: true, group: job.group };
    const result = await call('/api/bili/dm-share/resolve', { method: 'POST', body: { target: job.target }, timeoutMs: 20000 });
    const waiting = (current) => ['pending', 'queueing', 'queued'].includes(current.status) && !current.group;
    if (result.ok && /^[1-9]\d*$/.test(String(result.group?.id)) && typeof result.group?.name === 'string') {
      if (check(store.get(id), true)) return check(store.get(id), true);
      const current = store.update(id, (current) => waiting(current) ? { ...current, group: { id: String(result.group.id), name: clipText(result.group.name, 80) } } : current);
      return current.group ? { ok: true, group: current.group } : taskFailure('dm.resolution-superseded', '任务状态已变化，旧群解析结果未应用。', '重新查询原任务状态。');
    }
    const failure = publicError(result, 'dm.group-unresolved');
    // Resolving is read-only: a transport failure here is safe to retry explicitly.
    if (failure.code === 'dm.bridge-unavailable') { failure.status = 'failed'; failure.retryable = true; }
    store.update(id, (current) => waiting(current) ? { ...current, status: 'failed', error: failure, retryable: failure.retryable } : current);
    return failure;
  }
  async function report(id) {
    const job = store.get(id), blocked = check(job, true);
    if (blocked) return blocked;
    if (job.kind !== 'share' || !['sent', 'failed', 'unknown', 'needs_input'].includes(job.status)) return { ok: true, skipped: true };
    const key = job.status + ':' + (job.receipt?.messageId || job.error?.code || '');
    if (job.report?.key === key && ['sent', 'sending', 'unknown'].includes(job.report.status)) return { ok: job.report.status === 'sent', report: job.report, skipped: true };
    const title = clipText(job.video?.title || '视频', 50);
    const text = job.status === 'sent'
      ? '已把《' + title + '》分享到「' + groupLabel(job) + '」，附上了我的想法。'
      : job.status === 'unknown'
        ? '《' + title + '》的群分享结果暂时无法确认，我不会重复发送。请先查看「' + groupLabel(job) + '」的消息记录，再核对私信任务状态。'
        : '这次分享没有完成：' + clipText(job.error?.error || '任务尚未完成。', 80) + ' ' + clipText(job.error?.hint || '请到 B站设置的私信任务中查看并重试。', 100);
    let claimed = false;
    const attemptId = randomUUID();
    store.update(id, (current) => {
      if (current.report?.key === key && ['sent', 'sending', 'unknown'].includes(current.report.status)) return current;
      claimed = true;
      return { ...current, report: { key, attemptId, status: 'sending', at: now(), attempts: (current.report?.attempts || 0) + 1 } };
    });
    if (!claimed) return { ok: false, skipped: true, code: 'dm.report-in-progress' };
    let result;
    try { result = commandResult(await runBili(['dm', '--to', job.mid, '--msg', clipText(text, 290), '--go', '--json'])); }
    catch { result = taskFailure('dm.report-unknown', '回报私信的结果无法确认。', '先查看 B站私信记录；不要自动重发。', { status: 'unknown' }); }
    const status = result.ok ? 'sent' : result.status === 'failed' && result.retryable === true ? 'failed' : 'unknown';
    store.update(id, (current) => current.report?.key === key && current.report.attemptId === attemptId && current.report.status === 'sending' ? { ...current, report: { ...current.report, status, receipt: result.receipt ?? null, error: result.ok ? null : publicError(result), nextAt: now() + 300000 } } : current);
    return { ...result, reportStatus: status };
  }
  async function send(id, commentary) {
    let job = store.get(id), blocked = check(job, true);
    if (blocked) return blocked;
    if (job.kind !== 'share') return taskFailure('dm.not-share', '这条任务不是分享请求。', '普通私信用 dm-task reply。');
    if (['sent', 'sending', 'unknown'].includes(job.status)) {
      await reconcile(id);
      job = store.get(id);
      if (job.status === 'sent') { await report(id); return { ok: true, status: 'sent', receipt: job.receipt, duplicate: true }; }
      return taskFailure('dm.delivery-unknown', '已有一次发送正在进行或结果不明。', '先查询任务回执并核对群记录，不能自动重发。', { status: 'unknown' });
    }
    if (job.status === 'failed' || job.status === 'needs_input') return job.error || taskFailure('dm.retry-required', '任务需要处理失败原因。', '先查看状态，再使用 retry 重试。');
    const text = String(commentary ?? '').trim();
    if (!text || text.length > 600) return taskFailure('dm.commentary-invalid', '分享想法需要 1–600 个字符。', '写一两句与视频内容有关的想法，不要附加群号或私聊原文。');
    if (job.commentary && job.commentary !== text) return taskFailure('dm.payload-changed', '这条任务已经绑定了另一份分享内容。', '查询原任务状态；不要修改内容后重复投递。');
    const prepared = await prepare(id);
    if (!prepared.ok) { await report(id); return prepared; }
    let claimed = false;
    job = store.update(id, (current) => {
      if (!['pending', 'queueing', 'queued'].includes(current.status)) return current;
      claimed = true;
      return { ...current, status: 'sending', commentary: text, sendingAt: now() };
    });
    if (!claimed) return taskFailure('dm.delivery-in-progress', '这条任务已经被另一个处理过程接手。', '查询任务状态即可，不要重发。', { status: 'unknown' });
    blocked = check(job, true);
    if (blocked) { store.update(id, { status: 'failed', error: blocked, retryable: blocked.retryable === true }); return blocked; }
    const result = await call('/api/bili/dm-share/send', { method: 'POST', timeoutMs: 45000, body: { requestId: job.id, ownerMid: job.ownerMid, sourceSeq: job.sourceSeq, groupId: job.group.id, video: job.video, commentary: text } });
    const updated = rememberDelivery(id, result);
    await report(id);
    return updated.status === 'sent' ? { ok: true, status: 'sent', receipt: updated.receipt } : updated.error;
  }
  async function reply(id, text) {
    let job = store.get(id), blocked = check(job);
    if (blocked) return blocked;
    if (job.kind !== 'conversation') return taskFailure('dm.not-conversation', '分享任务通过 send 投递并自动回报。', '请勿额外发送一条“已完成”的私信。');
    if (job.status === 'completed') return { ok: true, duplicate: true, receipt: job.receipt };
    const limit = job.mid === job.ownerMid ? 300 : 200;
    if (!String(text ?? '').trim() || String(text).length > limit) return taskFailure('dm.reply-invalid', '私信内容为空或超出长度限制。', '请用简短文字回复，最多 ' + limit + ' 字。');
    let claimed = false;
    job = store.update(id, (current) => {
      if (!['pending', 'queueing', 'queued'].includes(current.status)) return current;
      claimed = true; return { ...current, status: 'replying', replyStartedAt: now() };
    });
    if (!claimed) return taskFailure('dm.reply-unknown', '这条回复已经开始或需要处理失败原因。', '查看任务状态；不要直接重复发送。', { status: 'unknown' });
    let result;
    try { result = commandResult(await runBili(['dm', '--to', job.mid, '--msg', String(text), '--go', '--json'])); }
    catch { result = taskFailure('dm.reply-unknown', '私信发送结果不明。', '先查看私信记录，不要自动重复发送。', { status: 'unknown' }); }
    store.update(id, { status: result.ok ? 'completed' : result.status === 'failed' ? 'failed' : 'unknown', receipt: result.receipt ?? null, error: result.ok ? null : publicError(result), retryable: result.retryable === true });
    return result;
  }
  function retry(id) {
    const job = store.get(id), blocked = check(job, job?.kind === 'share');
    if (blocked) return blocked;
    if (job.status === 'sent') {
      if (job.report?.status !== 'failed') return taskFailure('dm.retry-unsafe', '群分享已发送，回报无需重发或结果不明。', '核对 B站私信后处理；群消息不会再发。');
      store.update(id, { report: { ...job.report, nextAt: 0, attempts: 0 } });
      return { ok: true, reportOnly: true };
    }
    if (job.status !== 'failed' || job.retryable !== true) return taskFailure('dm.retry-unsafe', '这条任务不能安全自动重试。', '按错误提示补发明确指令或核对实际消息；不要盲目重发。');
    store.update(id, { status: 'pending', error: null, retryable: false, nextAt: 0, queueAttempts: 0 });
    return { ok: true };
  }
  return { prepare, send, reply, report, reconcile, retry, check };
}
