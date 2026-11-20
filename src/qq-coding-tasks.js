import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { codingRequestId } from './qq-coding-dsh.js';

const phases = {
  creating: '正在创建独立 DSH 会话', waiting: '会话已建，等主人补充任务',
  submitting: '正在向 DSH 投递任务', queued: 'DSH 已接单，等待执行', running: '正在制作',
  approval: '等待主人在 DSH 中审批', question: '等待主人在 DSH 中回答问题',
  verifying: '正在核对运行记录和成品清单', delivering: '正在上传成品',
  delivered: '成品已送达', rejected: '文件交付被拒绝', unknown: '文件送达情况待核对',
  failed: '任务失败', aborted: '任务已中止',
};
const monitored = new Set(['queued', 'running', 'approval', 'question']);
const terminal = new Set(['delivered', 'rejected', 'unknown', 'failed', 'aborted']);
const hints = {
  HOST: '请在 DSH 中检查该编程会话及宿主连接。',
  PERMISSION: '会话权限与任务要求不符。请在 DSH 检查工作区写入及人工审批设置，确认后重新发起。',
  SCOPE: 'DSH 工作区或会话归属发生变化。请核对原任务目录，在原处重新发起。',
  NO_RUN: 'DSH 已结束，但未取得这次任务的验收脚本成功运行记录。请在 DSH 中检查成品和验收结果。',
  MANIFEST: '请在 DSH 中核对 surfcore-result.json 以及 deliverables 目录里的成品。',
  CHANGED: '验收后的文件清单或内容已变化，请在 DSH 中重新核对成品。',
  REFUSED: '请检查原会话的文件权限和大小限制，处理后由主人发送“重试交付 #编号”。',
  UNKNOWN: '请先在原会话核对实际收到的文件。桥接会保留文件回执，暂停自动补传。',
};

function workspaceFor(root, id) {
  if (!/^[a-f0-9]{8}$/.test(id)) throw new Error('无效编程任务编号');
  return path.join(root, id);
}
function fileIdentity(file) {
  const { name, relativePath, originKey, size, sha256 } = file;
  return { name, relativePath, originKey, size, sha256 };
}
function sameFiles(receipts, files) {
  return receipts.length === files.length && receipts.every((receipt, i) =>
    Object.entries(fileIdentity(files[i])).every(([key, value]) => receipt[key] === value));
}
function readTasks(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const data = JSON.parse(raw);
  if (data?.version !== 1 || !Array.isArray(data.tasks)) throw new Error('编程任务记录格式错误');
  const ids = new Set();
  for (const task of data.tasks) {
    if (!task || !/^[0-9a-f]{8}$/.test(task.id) || ids.has(task.id) || !Object.hasOwn(phases, task.phase)
        || !/^(group|private):[1-9][0-9]*$/.test(task.originKey) || !/^[1-9][0-9]*$/.test(task.ownerId)
        || !/^[1-9][0-9]*$/.test(task.selfId) || !Array.isArray(task.files)) throw new Error('编程任务记录不完整');
    ids.add(task.id);
  }
  return data.tasks;
}
function activity(toolName) {
  const name = String(toolName ?? '');
  if (/bash|exec|test|job_output/.test(name)) return '正在运行或验收';
  if (/write|edit|patch/.test(name)) return '正在编写文件';
  if (/read|glob|grep/.test(name)) return '正在检查项目文件';
  return '正在制作';
}
function describe(task, now) {
  const phase = task.phase;
  const count = task.files.length;
  const sent = task.files.filter(file => file.status === 'sent').length;
  let message = '编程任务 #' + task.id + ' · ' + (phase === 'running' ? (task.progress || phases.running) : phases[phase]);
  if (count) message += '（已确认送达 ' + sent + '/' + count + ' 个文件）';
  if (phase === 'waiting') message += '。请主人在原会话发送“任务 #' + task.id + '：要做的事”。';
  if (phase === 'approval' || phase === 'question') message += '。请在 DSH 打开带此编号的会话处理，随后会继续。';
  if (task.issue && hints[task.issue]) message += '。' + hints[task.issue].replace('#编号', '#' + task.id);
  if (task.unreachable && !terminal.has(phase)) message += '。连接 DSH 暂未成功，显示上次确认的进度。';
  else if (monitored.has(phase) && task.startedAt) message += '（已用 ' + Math.max(0, Math.floor((now - task.startedAt) / 60000)) + ' 分钟）';
  return message;
}

// Only the bridge owns this journal. Each external side effect follows a synchronous atomic write.
export function createCodingTasks({ stateFile, workspacesDir, writeState, host, readDelivery, upload,
  notify, authorized, canWork, canSend, now = Date.now, log = () => {} }) {
  const tasks = new Map(readTasks(stateFile).map(task => [task.id, task]));
  const busy = new Map();
  const nextPoll = new Map();
  const watched = new Set();
  const bySession = new Map([...tasks.values()].filter(t => t.sessionId && monitored.has(t.phase)).map(t => [t.sessionId, t.id]));
  const readInFlight = new Map();
  const progressCache = new Map();

  function save(task, fields) {
    const next = { ...task, ...fields, updatedAt: now() };
    const rows = [...tasks.values()].filter(t => t.id !== next.id);
    writeState(stateFile, { version: 1, tasks: [...rows, next] });
    Object.assign(task, next);
    tasks.set(task.id, task);
    if (task.sessionId) {
      if (terminal.has(task.phase) || task.phase === 'verifying' || task.phase === 'delivering') {
        bySession.delete(task.sessionId);
        if (watched.delete(task.sessionId)) host.forget?.(task.sessionId);
        progressCache.delete(task.id);
        nextPoll.delete(task.id);
      } else bySession.set(task.sessionId, task.id);
    }
    return task;
  }
  function finish(task, phase, issue = '', extra = {}) {
    save(task, { phase, issue, unreachable: false, notice: true, ...extra });
  }
  // A crash while the gateway owned the request leaves that one file ambiguous.
  for (const task of tasks.values()) {
    if (task.files.some(file => file.status === 'sending')) {
      finish(task, 'unknown', 'UNKNOWN', { files: task.files.map(file => file.status === 'sending' ? { ...file, status: 'unknown' } : file) });
    }
  }
  async function notice(task) {
    if (!task.notice || !canSend(task.originKey, task)) return;
    const phase = task.phase;
    if ((await notify(task.originKey, describe(task, now()), task))?.ok && task.phase === phase) save(task, { notice: false });
  }
  function updateFile(task, index, patch, fields = {}) {
    const files = task.files.map((file, i) => i === index ? { ...file, ...patch } : file);
    save(task, { ...fields, files });
  }
  async function deliver(task, workspace) {
    if (!canSend(task.originKey, task)) return;
    if (task.files.some(file => file.status === 'sending' || file.status === 'unknown')) {
      finish(task, 'unknown', 'UNKNOWN'); return;
    }
    if (!Number.isSafeInteger(task.verifiedAt) || task.verifiedAt <= 0) { finish(task, 'failed', 'NO_RUN'); return; }
    let files;
    try { ({ files } = await readDelivery(workspace, { originKey: task.originKey, verifiedAt: task.verifiedAt })); }
    catch (error) { finish(task, 'failed', error?.code === 'CODING_FILE_CHANGED_AFTER_CHECK' ? 'CHANGED' : 'MANIFEST'); return; }
    if (task.phase === 'verifying') {
      save(task, { phase: 'delivering', files: files.map(file => ({ ...fileIdentity(file), status: 'pending' })) });
    } else if (!sameFiles(task.files, files)) {
      finish(task, 'failed', 'CHANGED'); return;
    }
    for (const [index, file] of files.entries()) {
      if (task.files[index].status === 'sent') continue;
      if (!canSend(task.originKey, task)) return;
      updateFile(task, index, { status: 'sending' });
      let response;
      try {
        response = await upload({ originKey: task.originKey, file, assertCurrent: () => canSend(task.originKey, task) });
      } catch { response = { status: 'unknown' }; }
      if (response?.ok === true && response.status === 'sent' && response.fileId) {
        updateFile(task, index, { status: 'sent', fileId: String(response.fileId) });
      } else {
        const rejected = response?.status === 'rejected';
        const phase = rejected ? 'rejected' : 'unknown';
        updateFile(task, index, { status: phase }, { phase, issue: rejected ? 'REFUSED' : 'UNKNOWN', notice: true });
        return;
      }
    }
    finish(task, 'delivered');
  }
  function projectSnapshot(task, snapshot) {
    const id = codingRequestId(task.id);
    const run = snapshot.runs.find(row => row.requestId === id);
    if (run?.waitingApproval) return { phase: 'approval' };
    if (run?.waitingQuestion) return { phase: 'question' };
    if (run?.outcome === 'completed') {
      if (run.executionVerified && Number.isSafeInteger(run.verifiedAt) && run.verifiedAt > 0) {
        return { phase: 'verifying', verifiedAt: run.verifiedAt };
      }
      return { phase: 'failed', issue: 'NO_RUN' };
    }
    if (run?.outcome === 'aborted' || run?.outcome === 'failed') return { phase: run.outcome, issue: 'HOST' };
    if (run) return { phase: 'running', progress: activity(run.lastTool) };
    if (snapshot.acceptedRequestIds?.includes(id) && snapshot.openTurn === null && !snapshot.queuedRequestIds?.includes(id)) {
      return { phase: 'aborted', issue: 'HOST' };
    }
    return { phase: task.phase };
  }
  // Queries may refresh the host's read-only projection. Only the monitor advances the job or sends files.
  async function progressOf(task, force = false) {
    const cached = progressCache.get(task.id);
    if (!force && cached && now() - cached.at < 5000) return cached.fields;
    if (!readInFlight.has(task.id)) {
      const read = host.snapshot(task.sessionId).then(snapshot => {
        const fields = projectSnapshot(task, snapshot);
        progressCache.set(task.id, { at: now(), fields });
        return fields;
      }).finally(() => readInFlight.delete(task.id));
      readInFlight.set(task.id, read);
    }
    return readInFlight.get(task.id);
  }
  async function advance(task) {
    if (!authorized(task)) return;
    if (terminal.has(task.phase) || task.phase === 'waiting') { await notice(task); return; }
    const workspace = workspaceFor(workspacesDir, task.id);
    if (task.phase === 'creating' || task.phase === 'submitting' || monitored.has(task.phase)) {
      if (!canWork(task)) {
        if (canSend(task.originKey, task) && !task.unreachable) save(task, { unreachable: true, notice: true });
        await notice(task);
        return;
      }
      try {
        if (task.phase === 'creating') {
          fs.mkdirSync(workspace, { recursive: true });
          if (fs.lstatSync(workspace).isSymbolicLink() || path.relative(fs.realpathSync(workspacesDir), fs.realpathSync(workspace)) !== task.id) {
            throw Object.assign(new Error('任务工作区已改变'), { code: 'CODING_WORKSPACE_CONFLICT', retryable: false });
          }
          const sessionId = await host.create({ workspace, taskId: task.id });
          save(task, { sessionId, phase: task.task ? 'submitting' : 'waiting', notice: !task.task, unreachable: false });
        }
        if (task.phase !== 'waiting' && task.sessionId && !watched.has(task.sessionId)) {
          host.watch(task.sessionId);
          watched.add(task.sessionId);
        }
        if (task.phase === 'submitting' && canWork(task)) {
          await host.start({ sessionId: task.sessionId, workspace, taskId: task.id, task: task.task });
          save(task, { phase: 'queued', unreachable: false });
        }
        if (monitored.has(task.phase)) {
          const fields = await progressOf(task, true);
          if (fields.phase !== task.phase || fields.progress !== task.progress || task.unreachable) {
            const changed = fields.phase !== task.phase;
            save(task, { ...fields, progress: fields.progress, unreachable: false,
              notice: changed && (terminal.has(fields.phase) || fields.phase === 'approval' || fields.phase === 'question') });
          }
        }
      } catch (error) {
        // A lost create/prompt acknowledgement can safely be reconciled under the same host IDs.
        if (error?.retryable === false) {
          const scopeError = ['CODING_SESSION_SCOPE', 'CODING_SESSION_CONFLICT', 'CODING_WORKSPACE', 'CODING_WORKSPACE_CONFLICT'].includes(error.code);
          const issue = error.code === 'CODING_PERMISSION' ? 'PERMISSION' : scopeError ? 'SCOPE' : 'HOST';
          finish(task, 'failed', issue);
        }
        else if (!task.unreachable) save(task, { unreachable: true, notice: true });
        log('DSH 编程任务 ' + task.id + ' 暂无法确认宿主状态');
      }
    }
    if ((task.phase === 'verifying' || task.phase === 'delivering') && authorized(task)) await deliver(task, workspace);
    await notice(task);
  }
  function schedule(task, force = false) {
    if (busy.has(task.id)) return busy.get(task.id);
    if (!force && now() < (nextPoll.get(task.id) || 0)) return;
    nextPoll.set(task.id, now() + 30000);
    const work = Promise.resolve().then(() => advance(task)).catch(() => {
      log('编程任务 ' + task.id + ' 状态未能保存或通知；保留上次持久记录。');
    }).finally(() => busy.delete(task.id));
    busy.set(task.id, work);
    return work;
  }
  function tick() {
    const pending = [];
    for (const task of tasks.values()) {
      if (task.notice || (!terminal.has(task.phase) && task.phase !== 'waiting')) pending.push(schedule(task));
    }
    return Promise.all(pending);
  }
  function onEvent(sessionId, type) {
    const task = tasks.get(bySession.get(sessionId));
    if (!task || !monitored.has(task.phase)) return;
    if (['turn/start', 'turn/end', 'approval/asked', 'approval/decided', 'question/asked', 'question/answered', 'question/requested', 'approval/requested'].includes(type)) return schedule(task, true);
  }
  function visible(key, ownerId, selfId) {
    return [...tasks.values()].filter(task => task.ownerId === ownerId && task.selfId === selfId && authorized(task)
      && (key === task.originKey || key === 'private:' + ownerId));
  }
  async function handle({ request, key, actorId, ownerId, selfId, messageId }) {
    if (!request) return false;
    const actor = { ownerId, selfId, originKey: key };
    if (!authorized(actor) || !messageId) return false;
    const isOwner = actorId === ownerId && request.isOwner === true;
    if (request.kind === 'status') {
      if (key.startsWith('private:') && !isOwner) return false;
      const topic = request.topic?.toLowerCase();
      const rows = visible(key, ownerId, selfId)
        .filter(task => (!request.taskId || request.taskId === task.id) && (!topic || task.task.toLowerCase().includes(topic)))
        .sort((a, b) => b.startedAt - a.startedAt);
      const descriptions = await Promise.all(rows.slice(0, 4).map(async task => {
        if (monitored.has(task.phase) && canWork(task)) {
          try {
            const fields = await progressOf(task);
            return describe(monitored.has(task.phase) ? { ...task, ...fields, unreachable: false } : task, now());
          } catch { return describe({ ...task, unreachable: true }, now()); }
        }
        const needsHost = monitored.has(task.phase) || task.phase === 'creating' || task.phase === 'submitting';
        if (needsHost && !canWork(task) && canSend(task.originKey, task)) return describe({ ...task, unreachable: true }, now());
        return describe(task, now());
      }));
      if (rows.length > descriptions.length) descriptions.push('共有 ' + rows.length + ' 个任务，可按编号查询较早的任务。');
      const message = descriptions.join('\n') || '这里没有符合条件的编程任务。';
      await notify(key, message, actor);
      return true;
    }
    if (!isOwner) return false;
    const own = visible(key, ownerId, selfId);
    const command = key + '/' + messageId;
    if (own.some(t => (t.originKey === key && t.messageId === messageId) || t.commands?.includes(command))) return true;
    if (request.kind === 'new') {
      let id;
      do { id = randomBytes(4).toString('hex'); } while (tasks.has(id) || fs.existsSync(workspaceFor(workspacesDir, id)));
      const task = save({ id, ...actor, messageId, startedAt: now(), files: [], task: request.task || '' }, { phase: 'creating', notice: false });
      await notify(key, '已登记编程任务 #' + id + '。正在创建独立 DSH 会话，可随时问“任务 #' + id + ' 进度”。', actor);
      await schedule(task, true);
      return true;
    }
    if (request.kind === 'supply') {
      const pending = own.filter(t => t.originKey === key && (t.phase === 'waiting' || (t.phase === 'creating' && !t.task))
        && (!request.taskId || request.taskId === t.id));
      if (!pending.length && !request.taskId) return false;
      if (pending.length !== 1) {
        await notify(key, pending.length ? '请用“任务 #编号：要做的事”指定等候中的会话。' : '原会话中没有这个等候任务的编号。', actor);
        return true;
      }
      const task = pending[0];
      save(task, { task: request.task, phase: task.sessionId ? 'submitting' : 'creating', notice: false, commands: [...(task.commands || []), command] });
      await notify(key, '任务 #' + task.id + ' 已收到制作要求，正在交给原来的编程会话。', actor);
      await schedule(task, true);
      return true;
    }
    if (request.kind === 'retry') {
      const task = own.find(t => t.id === request.taskId);
      if (task?.phase !== 'rejected' || task.files.some(file => file.status === 'unknown' || file.status === 'sending')) {
        await notify(key, '只可重试已确认遭拒的文件。请先查该任务进度及原会话的文件记录。', actor);
        return true;
      }
      save(task, { phase: 'delivering', issue: '', commands: [...(task.commands || []), command], notice: false });
      await schedule(task, true);
      return true;
    }
    return false;
  }
  return { handle, tick, onEvent };
}
