import { clipText } from './dm-share-intent.mjs';

export function dmTaskStatus(store) {
  try {
    const state = store.read();
    const jobs = Object.values(state.jobs).sort((a, b) => b.createdAt - a.createdAt);
    const counts = {};
    for (const job of jobs) counts[job.status] = (counts[job.status] || 0) + 1;
    return { ok: true, lastPoll: state.lastPoll, counts, jobs: jobs.slice(0, 30).map((job) => ({
      id: job.id, kind: job.kind, status: job.status, updatedAt: job.updatedAt,
      title: clipText(job.video?.title || (job.kind === 'share' ? '视频分享' : '私信回复'), 160),
      target: clipText(job.group?.name || job.target || '', 80),
      error: job.error || null, report: job.report ? { status: job.report.status, error: job.report.error || null } : null,
      canRetry: job.status === 'failed' && job.retryable === true || job.status === 'sent' && job.report?.status === 'failed',
    })) };
  } catch (e) {
    return { ok: false, code: e.code || 'dm.tasks-unreadable', error: e.error || '私信任务状态无法读取。', hint: e.hint || '备份记录后检查数据目录权限和文件内容；不要清空发送记录。' };
  }
}
