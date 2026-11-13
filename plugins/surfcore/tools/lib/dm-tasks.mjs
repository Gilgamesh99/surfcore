import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tasksForItem, resolveWaitingVideo } from './dm-share-intent.mjs';

const failure = (code, error, hint) => Object.assign(new Error(error), { code, error, hint });
const clone = (value) => structuredClone(value);

export function createDmTaskStore({ file, now = Date.now, maxJobs = 2000 }) {
  const lock = file + '.lock';
  function read() {
    try {
      const text = fs.readFileSync(file, 'utf8');
      if (text.length > 16_000_000) throw new Error('size');
      const state = JSON.parse(text);
      if (state.version !== 1 || !state.jobs || Array.isArray(state.jobs) || typeof state.jobs !== 'object') throw new Error('shape');
      return state;
    } catch (e) {
      if (e.code === 'ENOENT') return { version: 1, jobs: {}, lastPoll: null };
      throw failure('dm.tasks-unreadable', '私信任务记录无法读取，已停止推进消息游标。', '备份任务记录后修复文件；不要清空游标或重复发群消息。');
    }
  }
  function transaction(fn) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let fd;
    try { fd = fs.openSync(lock, 'wx'); }
    catch (e) {
      if (e.code !== 'EEXIST') throw failure('dm.tasks-unwritable', '私信任务记录无法写入。', '检查数据目录权限和磁盘空间后重试。');
      // Never unlink a lock based on a previous observation: another process may own it now.
      throw failure('dm.tasks-busy', '私信任务记录被锁定。', '稍后重试；若持续锁定，请先停止插件并核对记录和锁持有者，再备份处理。消息游标保持不变。');
    }
    let temporary;
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: now() }));
      const state = read();
      const value = fn(state);
      temporary = file + '.' + crypto.randomUUID() + '.tmp';
      const out = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(out, JSON.stringify(state, null, 2) + '\n'); fs.fsyncSync(out); } finally { fs.closeSync(out); }
      fs.renameSync(temporary, file);
      let dir;
      try { dir = fs.openSync(path.dirname(file), 'r'); fs.fsyncSync(dir); }
      catch (e) { if (!['EPERM', 'EACCES', 'EISDIR', 'EINVAL', 'ENOTSUP'].includes(e.code)) throw e; }
      finally { if (dir !== undefined) fs.closeSync(dir); }
      return clone(value);
    } finally {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(lock); } catch {}
      if (temporary) try { fs.unlinkSync(temporary); } catch {}
    }
  }
  return {
    file, read,
    list: () => Object.values(read().jobs).map(clone),
    get: (id) => clone(read().jobs[id] ?? null),
    accept(batch, ownerMid) {
      if (!batch?.batchId || !Array.isArray(batch.items) || !batch.items.length) throw failure('dm.batch-invalid', '私信读取结果缺少持久批次。', '保留游标并检查私信读取器。');
      return transaction((state) => {
        const at = now();
        const jobs = batch.items.flatMap((item) => tasksForItem(item, batch.batchId, String(ownerMid), { existing: Object.values(state.jobs), now: at }));
        if (!jobs.length) throw failure('dm.batch-empty', '私信批次没有可保留的消息。', '保留游标并检查不支持的消息类型。');
        const fresh = jobs.filter((j) => !state.jobs[j.id]);
        if (Object.keys(state.jobs).length + fresh.length > maxJobs) throw failure('dm.tasks-full', '私信任务记录已到容量上限。', '先备份并归档已完成任务；当前消息不会被确认消费。');
        for (const job of jobs) {
          const old = state.jobs[job.id];
          if (!old) state.jobs[job.id] = { ...job, createdAt: at, updatedAt: at, queueAttempts: 0, report: null };
          else if (old.status === 'waiting_video' && old.mid === String(ownerMid) && old.ownerMid === String(ownerMid)) state.jobs[job.id] = { ...job, updatedAt: at };
        }
        state.lastPoll = { ok: true, at, batchId: batch.batchId };
        return jobs.map((job) => state.jobs[job.id]);
      });
    },
    // Call only after a complete successful inbox read; a failed/rate-limited read
    // may still contain an in-window card once it recovers.
    expireWaiting(ownerMid) {
      const eligible = (job) => job.status === 'waiting_video' && job.mid === String(ownerMid) && job.ownerMid === String(ownerMid) && now() >= job.waitingUntil;
      if (!Object.values(read().jobs).some(eligible)) return [];
      return transaction((state) => {
        const changed = [];
        for (const job of Object.values(state.jobs)) {
          if (!eligible(job)) continue;
          const resolved = resolveWaitingVideo(job, [], now());
          state.jobs[job.id] = { ...resolved, updatedAt: now() };
          changed.push(state.jobs[job.id]);
        }
        return changed;
      });
    },
    update(id, change) {
      return transaction((state) => {
        const job = state.jobs[id];
        if (!job) throw failure('dm.task-missing', '找不到这条私信任务。', '先运行 dm-task list，使用其中的任务编号。');
        const next = typeof change === 'function' ? change(clone(job)) : { ...job, ...change };
        if (!next || next.id !== job.id || next.kind !== job.kind || next.mid !== job.mid || next.sourceSeq !== job.sourceSeq) throw failure('dm.task-conflict', '私信任务身份发生变化。', '重新读取当前任务；不要修改原消息编号或发送对象。');
        state.jobs[id] = { ...next, updatedAt: now() };
        return state.jobs[id];
      });
    },
    pollStatus(status) { return transaction((state) => { if (Number.isFinite(status.nextPollAt)) state.nextPollAt = status.nextPollAt; state.lastPoll = { ...status, at: now() }; return state.lastPoll; }); },
  };
}
