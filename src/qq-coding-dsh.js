import { createHash } from 'node:crypto';
import path from 'node:path';
import { FOLLOW_SNAPSHOT_MESSAGES } from './dsh-client.js';

const checkCommand = 'node --test --test-reporter=tap surfcore-check.mjs';
// Windows restricted tokens cannot pipe from a child test process. The same Node runner supports in-process isolation.
const singleProcessCheck = 'node --test --test-isolation=none --test-reporter=tap surfcore-check.mjs';
const shellTools = new Set(['bash', 'pwsh', 'ops_bash']);
const recoveryHint = '请在 DSH 查看该任务的工作区、会话和权限，然后重试。';

function problem(code, message, retryable = false) {
  return Object.assign(new Error(message), { code, hint: recoveryHint, retryable });
}

// Name-based UUIDs keep both identities stable across bridge and host restarts.
function taskUuid(scope, taskId) {
  if (typeof taskId !== 'string' || !taskId.trim()) throw problem('CODING_TASK_ID', '缺少编程任务 ID');
  const h = createHash('sha256').update('surfcore/qq-coding/' + scope + '\0' + taskId).digest('hex');
  return [h.slice(0, 8), h.slice(8, 12), '8' + h.slice(13, 16), 'a' + h.slice(17, 20), h.slice(20, 32)].join('-');
}

export function codingRequestId(taskId) {
  return taskUuid('prompt', taskId);
}

function taskPrompt(task, requestId, taskId) {
  return [
    'SurfCore 编程任务 #' + taskId,
    '请在这个专属工作区实际完成下面的编程任务。先确认验收目标，再生成可用成品，亲自运行、检查其行为或打开产物验证。失败时定位并修复，重复验收直至通过。',
    '成品放入 deliverables/。使用当前工作区和宿主正常人工审批，遇到必须由主人决定的问题请在 DSH 提问。',
    '在工作区根编写 surfcore-check.mjs，使用 node:test 验证本任务的成品，至少一个顶层 test 的名字精确为 surfcore-acceptance ' + requestId + '。断言必须检查实际产物或实际运行结果。其它工具链可由此测试调用。',
    '在此工作区根用 bash、pwsh 或 ops_bash 前台运行下列完整命令。若工具通过 run_code 提供，请 await 对应的 shell 工具。不要指定其它工作目录、追加命令或后台运行。',
    checkCommand,
    '若 Windows 工作区沙箱限制了测试子进程管道，请保留当前权限，用相同的 Node 测试运行器在同一进程运行：', singleProcessCheck,
    '检查真实退出状态与 TAP 断言，失败、超时或转为后台均须处理后重新进行可前台结束的验收。',
    '仅在最终成品验收全部通过后，于工作区根新建 UTF-8 的 surfcore-result.json。格式为 {"files":["成品相对deliverables的文件名"],"checks":["真实验收操作和结果"]}。只列本次实际交付的文件，验收脚本与清单留在根目录。无法完成时在 DSH 报告具体原因。',
    '', '主人要求：', task,
  ].join('\n');
}

function json(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

function sameDirectory(a, b) {
  return typeof a === 'string' && typeof b === 'string' && path.isAbsolute(a) && path.isAbsolute(b) && path.relative(a, b) === '';
}

function checkInvocation(name, args) {
  const checkAttempt = shellTools.has(name) && (args?.command === checkCommand || args?.command === singleProcessCheck);
  const eligible = checkAttempt && !args.script_path && (args.workdir === undefined || args.workdir === '.')
    && !args.run_in_background && !args.sandbox_permissions;
  return { checkAttempt, checkCommand: eligible };
}

// Native shell renderers omit an exit marker on success; host-backed ops_bash writes [exit code: 0].
// Never use the enclosing run_code result, a description, stdout from an arbitrary command, or job admission as proof.
function checkReceipt(text) {
  // PTC journals the native renderer's content. A single JSON text projection may instead contain the host's canonical ops_bash value.
  const structured = text.trimStart().startsWith('{');
  let resolvedFrom;
  if (structured) {
    const value = json(text);
    if (value?.kind !== 'foreground' || value.status !== 'completed' || value.exitCode !== 0 || value.signal != null
      || value.timedOut || value.aborted || value.cancelled || value.stopped != null || value.error != null || value.failure
      || value.permission || value.restriction || value.sandbox?.denied || value.stdout?.truncated || value.stderr?.truncated
      || typeof value.stdout?.text !== 'string' || typeof value.stderr?.text !== 'string' || value.stderr.text.trim()) return null;
    resolvedFrom = value.resolvedFrom;
    text = value.stdout.text.replace(/\r\n/g, '\n');
  } else if (text.startsWith('[cwd:')) {
    // ops_bash prepends this host-generated line before the process output.
    const header = /^\[cwd: resolvedFrom=("(?:\\.|[^"\\])*"); cwdSource="[^"\n]+"\]\n/.exec(text);
    if (!header) return null;
    resolvedFrom = json(header[1]);
    if (typeof resolvedFrom !== 'string') return null;
  }
  if (!/^TAP version 13$/m.test(text) || !/^# tests [1-9]\d*$/m.test(text) || !/^# pass [1-9]\d*$/m.test(text)
    || /^\[stderr\]$/m.test(text) || !/^# fail 0$/m.test(text) || /^# (?:(?:tests|pass) 0|(?:fail|cancelled) [1-9]\d*)$/m.test(text)
    || /^\[[^\]\n]+; effects: [^\]\n]+; retry: /m.test(text) || /^(?:not ok |\[(?:still running|timed out|stopped:|killed by signal:|cancelled|error:|sandbox:|output truncated|signal:|exit code: (?!0\])))/m.test(text)) return null;
  const requestId = /^ok \d+ - surfcore-acceptance ([a-f\d-]{36})$/m.exec(text)?.[1];
  return requestId ? { requestId, structured, ...(resolvedFrom !== undefined && { resolvedFrom }), exitZero: structured || /\[exit code: 0\]\s*$/.test(text) } : null;
}

/** Normalize a native session wire event. Retain tool identities, never the task text, arguments or command output. */
export function codingObservation(event) {
  if (!event || !event.data) return null;
  const { type, seq, data } = event;
  const base = { seq };
  if (Number.isSafeInteger(data.turn)) base.turn = data.turn;
  switch (type) {
    case 'turn/start': return { ...base, type: 'turn-start' };
    case 'turn/end': {
      const kind = data.reason?.kind;
      const outcome = kind === 'completed' ? 'completed' : kind === 'aborted' ? 'aborted' : 'failed';
      const detail = data.reason?.error?.code ?? data.reason?.reason?.kind;
      return { ...base, type: 'turn-end', outcome, reason: [kind || 'unknown', detail].filter(Boolean).join(':') };
    }
    case 'user/message':
      if (data.source?.kind === 'user-question-reply') return { ...base, type: 'question-decided', callId: data.source.callId };
      if (data.source?.kind === 'user' || data.source?.kind === 'retry') return { ...base, type: 'prompt', requestId: data.source.rpcId };
      return null;
    case 'approval/asked': return { ...base, type: 'approval', id: data.id, name: data.toolName };
    case 'approval/decided': return { ...base, type: 'approval-decided', id: data.id, outcome: data.outcome };
    case 'tool/call':
    case 'tool/ptc-dispatch-start': {
      const nested = type === 'tool/ptc-dispatch-start';
      return { ...base, type: 'tool-call', name: data.name, callId: nested ? data.subCallId : data.callId,
        ...(nested && { parentCallId: data.parentCallId, rootCallId: data.rootCallId }), ...checkInvocation(data.name, nested ? data.arguments : json(data.arguments)) };
    }
    case 'tool/result':
    case 'tool/ptc-dispatch': {
      const nested = type === 'tool/ptc-dispatch';
      const message = nested ? data : data.message;
      const callId = nested ? data.subCallId : message?.source?.callId ?? message?.toolCallId;
      if (!callId) return null;
      const blocks = message?.content;
      const text = Array.isArray(blocks) && blocks.length === 1 && blocks[0]?.type === 'text' ? String(blocks[0].text).replace(/\r\n/g, '\n') : '';
      const ok = !data.error && message?.isError !== true;
      const time = Number.isSafeInteger(event.time) && event.time > 0 ? event.time : null;
      const questionPending = data.error?.code === 'TOOL_OUTCOME_UNKNOWN' || (text.startsWith('{') && json(text)?.pending === true);
      return { ...base, type: 'tool-result', callId, time, ok, questionPending,
        ...(nested && { name: data.name, parentCallId: data.parentCallId, rootCallId: data.rootCallId, ...checkInvocation(data.name, data.arguments) }),
        check: ok ? checkReceipt(text) : null, ...(data.error?.code && { errorCode: data.error.code }) };
    }
    case 'assistant/attempt': {
      const failure = data.stream?.findLast?.(record => record.chunk?.type === 'error')?.chunk;
      return failure ? { ...base, type: 'error', reason: failure.error?.code || 'model-error' } : null;
    }
    default: return null;
  }
}

// Retain only folded facts. The host keeps the durable journal, tool arguments and output.
function makeHistory(workspace) {
  const runs = new Map();
  const accepted = new Set();
  const inbox = { 'next-step': [], 'next-turn': [] };
  const questions = new Map(); // callId -> originating request, including replies admitted on a later turn
  let current = null;
  // DSH initializes workingDirectory from header.cwd. Directory changes affect future processes.
  let atRoot = true, directoryRevision = 0;
  let sandbox, approval;
  let sandboxChanges = 0, approvalChanges = 0, touched = false;
  function apply(event) {
    const { type, data } = event;
    if (type === 'working-directory/change') {
      const nextAtRoot = sameDirectory(workspace, data.cwd);
      if (nextAtRoot !== atRoot) directoryRevision++;
      atRoot = nextAtRoot;
    }
    if (type === 'sandbox/mode') { sandbox = data.mode; sandboxChanges++; }
    if (type === 'approval/policy') { approval = data.policy; approvalChanges++; }
    if (['command/run', 'session/title', 'working-directory/change', 'turn/start'].includes(type)) touched = true;
    if (type === 'agent/inbox/spliced') {
      if (!Object.hasOwn(inbox, data.target) || !Array.isArray(data.inserted)) throw problem('CODING_HISTORY', '无效的 DSH 输入队列更新');
      const ids = data.inserted.map(({ source }) => source?.kind === 'user' || source?.kind === 'retry' ? source.rpcId : undefined);
      for (const id of ids) if (id) { accepted.add(id); touched = true; }
      inbox[data.target].splice(data.start, data.removedCount ?? 0, ...ids);
    }
    const obs = codingObservation(event);
    if (!obs) return;
    if (obs.type === 'turn-start') {
      current = { turn: obs.turn, run: null, calls: new Map(), approvals: new Set(), foreignPrompt: false };
      return;
    }
    if (obs.type === 'prompt' && obs.requestId) accepted.add(obs.requestId);
    const replyTo = obs.type === 'question-decided' ? questions.get(obs.callId) : null;
    if (replyTo) {
      questions.delete(obs.callId);
      runs.get(replyTo).waitingQuestion = [...questions.values()].includes(replyTo);
    }
    if (!current || (obs.turn !== undefined && obs.turn !== current.turn)) return;
    if (obs.type === 'prompt' || replyTo) {
      const requestId = replyTo ?? obs.requestId;
      if (!requestId) current.foreignPrompt = true;
      if (current.run && current.run.requestId !== requestId) {
        // A second GUI prompt sharing this turn makes exclusive attribution impossible.
        current.run.mixed = true;
        current.run.executionVerified = false;
        current.run.verifiedAt = null;
        return;
      }
      if (!current.run && requestId) {
        current.run = { requestId, turn: current.turn, outcome: 'running', reason: '', lastTool: '',
          waitingApproval: false, waitingQuestion: [...questions.values()].includes(requestId), executionVerified: false, verifiedAt: null };
        if (current.foreignPrompt) current.run.mixed = true;
        runs.set(requestId, current.run);
      }
    }
    const run = current.run;
    if (obs.type === 'turn-end') {
      if (run) {
        Object.assign(run, { outcome: obs.outcome, reason: obs.reason, waitingApproval: false });
        if (obs.outcome !== 'completed') {
          for (const [id, owner] of questions) if (owner === run.requestId) questions.delete(id);
          run.waitingQuestion = false;
        }
      }
      current = null;
      return;
    }
    if (!run) return;
    switch (obs.type) {
      case 'approval': current.approvals.add(obs.id); run.waitingApproval = true; break;
      case 'approval-decided': current.approvals.delete(obs.id); run.waitingApproval = current.approvals.size > 0; break;
      case 'tool-call': {
        if (obs.parentCallId && (obs.rootCallId !== obs.parentCallId || current.calls.get(obs.parentCallId)?.name !== 'run_code')) break;
        current.calls.set(obs.callId, obs.checkCommand ? { ...obs, directoryRevision } : obs);
        run.lastTool = obs.name;
        if (obs.checkAttempt) {
          current.latestCheck = obs.callId;
          run.executionVerified = false;
          run.verifiedAt = null;
        }
        if (obs.name === 'ask_user_question') { questions.set(obs.callId, run.requestId); run.waitingQuestion = true; }
        break;
      }
      case 'tool-result': {
        const call = current.calls.get(obs.callId);
        if (!call || call.parentCallId !== obs.parentCallId || call.rootCallId !== obs.rootCallId || (obs.name && call.name !== obs.name)) break;
        current.calls.delete(obs.callId);
        if (call.name === 'ask_user_question' && !obs.questionPending) {
          questions.delete(obs.callId);
          run.waitingQuestion = [...questions.values()].includes(run.requestId);
        }
        if (call.checkCommand && current.latestCheck === obs.callId && !run.mixed) {
          // Native bash/pwsh record the actual cwd in meta. OPS stamps its resolved basis (only default or '.' is eligible).
          const reported = call.name === 'ops_bash' ? obs.check?.resolvedFrom : data.meta?.cwd;
          const scopeKnown = call.directoryRevision === directoryRevision ? atRoot : reported !== undefined;
          run.executionVerified = scopeKnown && (reported === undefined || sameDirectory(workspace, reported))
            && obs.ok && obs.time !== null && obs.check?.requestId === run.requestId
            && (!call.parentCallId || obs.checkCommand) && (!obs.check.structured || call.name === 'ops_bash')
            && (call.name !== 'ops_bash' || obs.check.exitZero);
          run.verifiedAt = run.executionVerified ? obs.time : null;
        }
        break;
      }
    }
  }
  function view(cursor) {
    return { cursor, acceptedRequestIds: [...accepted], queuedRequestIds: Object.values(inbox).flat().filter(Boolean),
      untouched: !touched && sandboxChanges === 1 && approvalChanges === 1,
      openTurn: current?.turn ?? null, runs: Array.from(runs.values(), run => ({ ...run })), permissions: { sandbox, approval } };
  }
  return { apply, view };
}

export function createCodingDsh({ api }) {
  const histories = new Map();

  async function rpc(method, args) {
    let envelope;
    try { envelope = await api.callUnary(method, args); }
    catch (error) {
      if (error instanceof SyntaxError || /^invalid server-response for /.test(error?.message)) throw problem('CODING_DSH_PROTOCOL', method + ' 响应不符合宿主协议');
      throw error;
    }
    const result = envelope?.result;
    if (result?.ok !== true) {
      const code = result?.error?.code || 'CODING_DSH_RPC';
      const temporary = ['gateway/internal', 'gateway/unavailable', 'session/agent-busy', 'session/writer-held', 'session/observation-ended'].includes(code);
      throw problem(code, method + ' 失败：' + (result?.error?.message || '无有效响应'), temporary);
    }
    return result.value;
  }

  async function readHistory(sessionId, entry) {
    const pages = [];
    let cursor, beforeSeq;
    do {
      const page = await rpc('session/page', { address: { kind: 'session', sessionId },
        maxMessages: entry.cursor >= 0 && beforeSeq === undefined ? 1 : FOLLOW_SNAPSHOT_MESSAGES,
        ...(beforeSeq !== undefined && { beforeSeq, throughSeq: cursor }) });
      cursor ??= page?.cursor;
      if (!Number.isSafeInteger(cursor) || cursor < -1 || page?.cursor !== cursor || typeof page.hasMore !== 'boolean' || !Array.isArray(page.records)) {
        throw problem('CODING_HISTORY', 'DSH 历史快照格式异常');
      }
      if (cursor < entry.cursor) throw problem('CODING_HISTORY', 'DSH 历史游标意外回退');
      const end = beforeSeq ?? cursor + 1;
      const first = end - page.records.length;
      if (first < 0 || page.hasMore !== (first > 0) || (page.hasMore && first >= end)) throw problem('CODING_HISTORY', 'DSH 历史分页缺失');
      const fresh = [];
      for (const [index, record] of page.records.entries()) {
        if (record?.type !== 'event' || record.event?.seq !== first + index || !record.event.data) throw problem('CODING_HISTORY', 'DSH 历史事件顺序不连续');
        if (record.event.seq > entry.cursor) fresh.push(record.event);
      }
      pages.push(fresh);
      beforeSeq = first;
    } while (beforeSeq > entry.cursor + 1);
    try {
      for (const events of pages.reverse()) for (const event of events) entry.fold.apply(event);
    } catch (error) {
      entry.cursor = -1;
      entry.fold = makeHistory(entry.workspace);
      throw error;
    }
    entry.cursor = cursor;
    return entry.fold.view(cursor);
  }

  function historyFor(sessionId) {
    if (!histories.has(sessionId)) histories.set(sessionId, { cursor: -1, tail: Promise.resolve() });
    return histories.get(sessionId);
  }

  async function workspaceRoot(sessionId, expected, entry) {
    let root = entry.workspace;
    if (root === undefined) {
      // SessionSummary.cwd is the immutable header directory, including when the bridge was offline during a cd.
      const list = await rpc('session/list', {});
      root = list?.items?.find(row => row.sessionId === sessionId && !row.parentSessionId && row.origin !== 'subagent')?.cwd;
    }
    if (!sameDirectory(root, expected === undefined ? root : expected)) throw problem('CODING_SESSION_SCOPE', '无法确认 DSH 编程会话的初始工作区');
    entry.workspace = root;
    return root;
  }

  function snapshot(sessionId, workspace) {
    const entry = historyFor(sessionId);
    const result = entry.tail.then(async () => {
      const root = await workspaceRoot(sessionId, workspace, entry);
      entry.fold ??= makeHistory(root);
      return readHistory(sessionId, entry);
    });
    // The caller observes each rejection. Keep the serialization lane available to later reconnects.
    entry.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function sessionScope(sessionId, workspace) {
    const projection = await rpc('session/projections', { sessionId });
    const values = projection?.values;
    if (projection?.kind !== 'sequenced' || values?.agentPreset !== 'standard' || !sameDirectory(workspace, values.workingDirectory)) {
      throw problem('CODING_SESSION_SCOPE', '无法确认 DSH 独立编程会话的预设或工作区');
    }
    return values;
  }

  const safe = state => state.permissions.sandbox === 'workspace-write' && state.permissions.approval === 'ask';
  async function requirePermissions(sessionId, workspace, initialize) {
    const state = await snapshot(sessionId, workspace);
    if (safe(state)) return;
    // Initialization can be retried after a lost create acknowledgement, only while the blank session still has its creation defaults.
    if (initialize && state.untouched) {
      const command = await rpc('commands/execute', { agentId: sessionId, line: '/permission workspace-write', submittedAttachments: [] });
      if (command?.result?.kind === 'success' && safe(await snapshot(sessionId, workspace))) return;
    }
    throw problem('CODING_PERMISSION', '请在 DSH 检查本会话的 workspace-write 沙箱与人工审批设置');
  }

  async function create({ workspace, taskId }) {
    if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) throw problem('CODING_WORKSPACE', '编程任务需要独立工作区的绝对路径');
    const sessionId = taskUuid('session', taskId);
    const row = (await rpc('workspace/create', { path: workspace }))?.workspace;
    if (!row?.workspaceId || !sameDirectory(workspace, row.path)
      || !Array.isArray(row.sessionIds) || row.sessionIds.some(id => id !== sessionId)) throw problem('CODING_WORKSPACE_CONFLICT', '无法独占该 DSH 任务工作区');
    if (!row.sessionIds.includes(sessionId)) {
      // session/create may mint another ID when given an unattached or nonblank session. Never adopt that replacement.
      if (await rpc('session/projections', { sessionId }) !== null) throw problem('CODING_SESSION_CONFLICT', '同一任务会话已存在，但宿主没有把它挂在本工作区');
      const created = await rpc('session/create', { workspaceId: row.workspaceId, sessionId, agentPreset: 'standard' });
      if (created?.sessionId !== sessionId || created.agentPreset !== 'standard') throw problem('CODING_SESSION_CONFLICT', '宿主返回了不同的任务会话或预设');
      // Native session/create sets the header cwd to the registered workspace.path.
      historyFor(sessionId).workspace = row.path;
    }
    await sessionScope(sessionId, workspace);
    await requirePermissions(sessionId, workspace, true);
    // Read the current title immediately before the native rename, including manual GUI edits during setup.
    const { title: currentTitle } = await sessionScope(sessionId, workspace);
    if (currentTitle === null) {
      const title = 'SurfCore 编程任务 #' + taskId;
      const renamed = await rpc('session/rename', { sessionId, title });
      if (renamed?.title !== title || !Number.isSafeInteger(renamed.seq)) throw problem('CODING_TITLE', 'DSH 未确认编程会话标题');
    } else if (typeof currentTitle !== 'string') throw problem('CODING_TITLE', 'DSH 缺少会话标题投影');
    return sessionId;
  }

  function watch(sessionId) {
    // NodeApiClient tracks desired follows and opens each stream at most once per connection.
    return api.events.follow(sessionId);
  }

  function forget(sessionId) {
    histories.delete(sessionId);
    api.events.forget?.(sessionId);
  }

  async function start({ sessionId, workspace, taskId, task }) {
    if (!sessionId || sessionId !== taskUuid('session', taskId)) throw problem('CODING_SESSION_CONFLICT', '编程任务与 DSH 会话身份不匹配');
    if (typeof task !== 'string' || !task.trim()) throw problem('CODING_TASK_EMPTY', '请提供明确的编程任务内容');
    workspace = await workspaceRoot(sessionId, workspace, historyFor(sessionId));
    await sessionScope(sessionId, workspace);
    await requirePermissions(sessionId, workspace, false);
    watch(sessionId);
    const requestId = codingRequestId(taskId);
    const receipt = await rpc('session/prompt', { sessionId, requestId, mode: 'queue', content: [{ type: 'text', text: taskPrompt(task, requestId, taskId) }] });
    if (receipt?.accepted !== true) throw problem('CODING_PROMPT_RECEIPT', 'DSH 没有返回有效的任务接收回执');
    return { requestId };
  }

  return { create, start, watch, forget, snapshot };
}
