import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NodeApiClient } from '../src/dsh-client.js';
import { codingObservation, codingRequestId, createCodingDsh } from '../src/qq-coding-dsh.js';

const taskId = '15a45f2c';
const requestId = codingRequestId(taskId);
const workspace = path.resolve('fixture-coding-workspace');
const command = 'node --test --test-reporter=tap surfcore-check.mjs';
const tap = 'TAP version 13\nok 1 - surfcore-acceptance ' + requestId + '\n1..1\n# tests 1\n# pass 1\n# fail 0\n';
const content = text => [{ type: 'text', text }];
const user = (rpcId = requestId) => ({ id: 'user-' + rpcId, role: 'user', source: { kind: 'user', rpcId }, content: content('fixture') });

// Exercise the actual NodeApiClient wrapper and envelope validator. Replace its last I/O boundary with native package-shaped replies.
function fixture(initial = { sandbox: 'workspace-write', approval: 'ask' }) {
  const api = new NodeApiClient('http://example.invalid', 1000, {});
  const row = { workspaceId: 'workspace-1', path: workspace, sessionIds: [] };
  const events = [], calls = [], prompts = new Map();
  const state = { sessionId: null, title: null, agentPreset: 'standard', directory: workspace, pageLimit: 4 };
  const append = (type, data) => events.push({ type: 'event', event: { seq: events.length, time: 1_780_000_000_000 + events.length, type, data } }) - 1;
  function response(method, args) {
    switch (method) {
      case 'workspace/create': assert.deepEqual(args, { path: workspace }); return { workspace: row, created: !state.sessionId };
      case 'session/create': {
        assert.equal(args.workspaceId, row.workspaceId);
        assert.equal(args.agentPreset, 'standard');
        assert.ok(args.sessionId);
        assert.deepEqual(Object.keys(args).sort(), ['agentPreset', 'sessionId', 'workspaceId']);
        assert.equal(state.sessionId, null);
        state.sessionId = args.sessionId;
        row.sessionIds.push(args.sessionId);
        append('permission/preset', { preset: initial.sandbox });
        append('sandbox/mode', { mode: initial.sandbox });
        append('approval/policy', { policy: initial.approval });
        return { sessionId: state.sessionId, agentPreset: state.agentPreset };
      }
      case 'session/list': return { items: [{ sessionId: state.sessionId, cwd: workspace }] };
      case 'session/projections': return args.sessionId === state.sessionId ? { kind: 'sequenced', asOfSeq: events.length - 1,
        values: { agentPreset: state.agentPreset, workingDirectory: state.directory, title: state.title } } : null;
      case 'commands/execute': {
        assert.deepEqual(args, { agentId: state.sessionId, line: '/permission workspace-write', submittedAttachments: [] });
        append('command/run', { line: args.line });
        if (state.manualTitleDuringInit) state.title = state.manualTitleDuringInit;
        if (!state.brokenPreset) {
          append('sandbox/mode', { mode: 'workspace-write' });
          append('approval/policy', { policy: 'ask' });
        }
        return { commandId: 'command-1', result: { kind: 'success' } };
      }
      case 'session/rename': {
        assert.equal(args.sessionId, state.sessionId);
        state.title = args.title;
        return { title: args.title, seq: append('session/title', { title: args.title, source: { kind: 'user' } }) };
      }
      case 'session/page': {
        assert.deepEqual(args.address, { kind: 'session', sessionId: state.sessionId });
        const cursor = args.throughSeq ?? events.length - 1;
        const end = args.beforeSeq ?? cursor + 1;
        const first = Math.max(0, end - Math.min(args.maxMessages, state.pageLimit));
        const page = { cursor, records: events.slice(first, end), hasMore: first > 0 };
        return state.rewritePage?.(page, args) ?? page;
      }
      case 'session/prompt': {
        assert.equal(args.sessionId, state.sessionId);
        assert.equal(args.mode, 'queue');
        assert.equal(args.requestId, requestId);
        if (!prompts.has(args.requestId)) {
          prompts.set(args.requestId, args);
          append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [user(args.requestId)] });
        }
        return { accepted: true };
      }
      default: throw Error('Unexpected method ' + method);
    }
  }
  api.postJson = async (route, envelope) => {
    const method = envelope.method;
    assert.equal(route, '/api/' + method);
    const wire = envelope.payload.args;
    const wrapper = method === 'session/list' ? '_request' : 'request';
    const args = method === 'commands/execute' ? wire : wire[wrapper];
    if (method !== 'commands/execute') assert.deepEqual(Object.keys(wire), [wrapper]);
    calls.push({ method, args, rpcId: envelope.rpcId });
    const result = state.reject?.method === method ? { ok: false, error: state.reject.error } : { ok: true, value: response(method, args) };
    if (state.loseNext === method) { state.loseNext = null; throw Error('connection closed after commit'); }
    return { json: async () => ({ type: 'server-response', rpcId: envelope.rpcId, result }) };
  };
  const host = createCodingDsh({ api });
  const startTurn = (turn = 1, id = requestId) => {
    append('turn/start', { turn });
    append('user/message', user(id));
  };
  const toolCall = (name, args, id = 'c', turn = 1) => append('tool/call', { turn, step: 1, callId: id, arguments: JSON.stringify(args), name });
  const toolResult = (text, id = 'c', turn = 1, error) => append('tool/result', { turn, step: 1,
    message: { role: 'toolResult', toolCallId: id, source: { kind: 'tool', callId: id }, content: content(text), ...(error && { isError: true }) }, ...(error && { error }) });
  const end = (turn = 1, reason = { kind: 'completed' }) => append('turn/end', { turn, reason });
  return { api, host, calls, prompts, state, row, events, append, startTurn, end, toolCall, toolResult,
    create: () => host.create({ taskId, workspace }), fresh: () => createCodingDsh({ api }),
    methods: method => calls.filter(call => call.method === method), snapshot: () => host.snapshot(state.sessionId) };
}

function permanent(code) { return e => e.code === code && e.retryable === false && !!e.hint; }

test('创建可辨认的正常空会话；重试保留手动标题，订阅可重连与释放', async () => {
  const h = fixture({ sandbox: 'danger-full-access', approval: 'never' });
  const sid = await h.create();
  assert.equal(h.prompts.size, 0);
  assert.equal(h.state.title, 'SurfCore 编程任务 #' + taskId);
  h.state.title = '主人自己改过的标题';
  assert.equal(await h.fresh().create({ workspace, taskId }), sid);
  assert.equal(h.methods('session/create').length, 1);
  assert.equal(h.methods('commands/execute').length, 1);
  assert.equal(h.methods('session/rename').length, 1);
  assert.equal(h.state.title, '主人自己改过的标题');
  const race = fixture({ sandbox: 'danger-full-access', approval: 'never' });
  race.state.manualTitleDuringInit = 'GUI 手动命名';
  await race.create(); assert.equal(race.methods('session/rename').length, 0);
  h.host.watch(sid); h.host.watch(sid);
  assert.deepEqual([...h.api._desiredFollows], [sid]);
  h.host.forget(sid);
  assert.equal(h.api._desiredFollows.size, 0);
  h.calls.length = 0;
  await h.snapshot();
  assert.ok(h.methods('session/page').length > 1, 'forget releases incremental state');
});

test('丢失创建与投递回执后重试同一会话、同一 durable requestId', async () => {
  const h = fixture({ sandbox: 'danger-full-access', approval: 'never' });
  h.state.loseNext = 'session/create';
  await assert.rejects(h.create, /connection closed/);
  const resumed = h.fresh();
  const sid = await resumed.create({ workspace, taskId });
  assert.equal(h.methods('session/create').length, 1);
  const args = { sessionId: sid, taskId, task: '制作可运行的小程序' };
  h.state.loseNext = 'session/prompt';
  await assert.rejects(resumed.start(args), /connection closed/);
  assert.deepEqual(await h.fresh().start(args), { requestId });
  assert.equal(h.methods('session/list').length, 1, 'cold callers can omit workspace');
  assert.equal(h.methods('session/prompt').length, 2);
  assert.notEqual(h.methods('session/prompt')[0].rpcId, h.methods('session/prompt')[1].rpcId);
  assert.equal(h.prompts.size, 1);
  const prompt = h.prompts.get(requestId).content[0].text;
  for (const part of [taskId, args.task, command, 'surfcore-acceptance ' + requestId, '失败', 'UTF-8', 'deliverables/', 'surfcore-result.json', '"files"', '"checks"']) assert.ok(prompt.includes(part), part);
  const queued = await h.snapshot();
  assert.deepEqual(queued.queuedRequestIds, [requestId]);
  h.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' });
  const removed = await h.fresh().snapshot(sid);
  assert.deepEqual(removed.acceptedRequestIds, [requestId]);
  assert.deepEqual(removed.queuedRequestIds, []);
  assert.equal(removed.openTurn, null);
});

test('精确验证目录、权限、任务身份与生产错误；失败不触发 prompt', async () => {
  const h = fixture();
  const sid = await h.create();
  const args = { sessionId: sid, workspace, taskId, task: '写测试' };
  await assert.rejects(h.host.start({ ...args, task: ' ' }), permanent('CODING_TASK_EMPTY'));
  await assert.rejects(h.host.start({ ...args, taskId: 'other' }), permanent('CODING_SESSION_CONFLICT'));
  h.state.directory = path.resolve('elsewhere');
  await assert.rejects(h.host.start(args), permanent('CODING_SESSION_SCOPE'));
  h.state.directory = workspace;
  h.append('sandbox/mode', { mode: 'read-only' });
  await assert.rejects(h.host.start(args), permanent('CODING_PERMISSION'));
  await assert.rejects(h.create, permanent('CODING_PERMISSION'));
  assert.equal(h.methods('commands/execute').length, 0);
  h.append('sandbox/mode', { mode: 'workspace-write' });
  h.state.reject = { method: 'session/prompt', error: { code: 'session/writer-held', message: 'busy' } };
  await assert.rejects(h.host.start(args), e => e.code === 'session/writer-held' && e.retryable === true && !!e.hint);
  assert.equal(h.prompts.size, 0);
  h.row.sessionIds.length = 0;
  await assert.rejects(h.create, permanent('CODING_SESSION_CONFLICT'));
  h.row.sessionIds.push('ordinary-qq');
  await assert.rejects(h.create, permanent('CODING_WORKSPACE_CONFLICT'));
  const blocked = fixture({ sandbox: 'danger-full-access', approval: 'never' });
  blocked.state.brokenPreset = true;
  await assert.rejects(blocked.create, permanent('CODING_PERMISSION'));
  assert.equal(blocked.prompts.size, 0);
  blocked.api.postJson = async () => ({ json: async () => ({ type: 'wrong' }) });
  await assert.rejects(blocked.create, permanent('CODING_DSH_PROTOCOL'));
});

test('真实 Node TAP 与嵌套宿主 shell 回执可跨页、跨重启恢复；外层伪输出无效', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'surfcore-check-'));
  let text;
  try {
    writeFileSync(path.join(dir, 'answer.txt'), '42');
    writeFileSync(path.join(dir, 'surfcore-check.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs';\ntest('surfcore-acceptance " + requestId + "', () => assert.equal(fs.readFileSync('answer.txt','utf8'),'42'));\n");
    const child = spawnSync(process.execPath, command.split(' ').slice(1), { cwd: dir, encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, 0, child.stderr); text = child.stdout + '\n[exit code: 0]';
    if (process.allowedNodeEnvironmentFlags.has('--test-isolation')) {
      const single = spawnSync(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', 'surfcore-check.mjs'], { cwd: dir, encoding: 'utf8', timeout: 15000 });
      assert.equal(single.status, 0, single.stderr); assert.ok(single.stdout.includes('ok 1 - surfcore-acceptance ' + requestId));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const h = fixture(); const sid = await h.create();
  h.startTurn(); h.toolCall('run_code', { code: 'irrelevant outer text' }, 'root');
  const native = { rootCallId: 'root', parentCallId: 'root', subCallId: 'shell', name: 'ops_bash', arguments: { command, description: '检查成品' } };
  h.append('tool/ptc-dispatch-start', native);
  const active = await h.snapshot();
  assert.equal(active.runs[0].lastTool, 'ops_bash');
  assert.equal(active.runs[0].executionVerified, false);
  const resultSeq = h.append('tool/ptc-dispatch', { ...native, isError: false, content: content(text) });
  h.toolResult('这条外层消息对验收无影响', 'root'); h.end();
  const done = await h.snapshot();
  assert.equal(done.runs[0].executionVerified, true); assert.equal(done.runs[0].outcome, 'completed');
  assert.equal(done.runs[0].verifiedAt, h.events[resultSeq].event.time);
  assert.deepEqual(await h.fresh().snapshot(sid), done);
  h.calls.length = 0; await h.snapshot();
  assert.equal(h.methods('session/page').length, 1); assert.equal(h.methods('session/page')[0].args.maxMessages, 1);
  assert.equal(active.runs[0].outcome, 'running', 'old snapshots are immutable observations');
  h.state.rewritePage = page => ({ ...page, records: [{ type: 'event', event: { seq: 999, data: {} } }] });
  await assert.rejects(h.snapshot, permanent('CODING_HISTORY'));
});

test('PTC 单文本 JSON 回执必须属于原生 ops_bash 子调用且完整成功', async () => {
  const actual = { kind: 'foreground', status: 'completed', exitCode: 0, signal: null, timedOut: false, aborted: false,
    stdout: { text: tap, truncated: false }, stderr: { text: '', truncated: false } };
  for (const [changes, verified, child = 'ops_bash', parent = 'root'] of [
    [{}, true], [{ kind: 'promoted' }, false], [{ kind: 'background' }, false], [{ status: 'failed' }, false],
    [{ exitCode: 1 }, false], [{ exitCode: null }, false], [{ timedOut: true }, false], [{ signal: 'SIGKILL' }, false],
    [{ failure: { code: 'spawn-failed' } }, false], [{ stderr: { text: 'error' } }, false],
    [{ stdout: { text: tap, truncated: true } }, false], [{ stdout: { text: tap.replace('# fail 0', '# fail 1') } }, false],
    [{}, false, 'pwsh'], [{}, false, 'ops_bash', 'unrelated'],
  ]) {
    const h = fixture(); await h.create(); h.startTurn(); h.toolCall('run_code', { code: 'fixture' }, 'root');
    const data = { rootCallId: 'root', parentCallId: parent, subCallId: 'inner', name: child, arguments: { command } };
    h.append('tool/ptc-dispatch-start', data);
    h.append('tool/ptc-dispatch', { ...data, content: content(JSON.stringify({ ...actual, ...changes })), isError: false });
    h.toolResult(JSON.stringify(actual), 'root'); h.end();
    assert.equal((await h.snapshot()).runs[0].executionVerified, verified, JSON.stringify(changes) + ' ' + child + ' ' + parent);
  }
});

test('单个 shell 回执必须在任务轮内对上真实命令、调用、命名测试和进程终态', async () => {
  for (const [name, args, output, id, verified] of [
    ['bash', { command }, tap, 'c', true], ['bash', { command: command.replace('--test ', '--test --test-isolation=none ') }, tap, 'c', true], ['pwsh', { command }, tap, 'c', true], ['ops_bash', { command }, tap, 'c', false],
    ['ops_bash', { command }, tap + '[exit code: 0]', 'c', true], ['bash', { command }, tap + '[exit code: 1]', 'c', false],
    ['bash', { command }, tap + '[still running after 10ms; moved to background job j]', 'c', false],
    ['bash', { command }, tap + '[timed out after 20ms]', 'c', false], ['bash', { command }, tap.replace('# fail 0', '# fail 1'), 'c', false],
    ['bash', { command }, tap.replace(requestId, codingRequestId('other')), 'c', false], ['bash', { command }, tap, 'wrong-id', false],
    ['bash', { command: 'echo ' + tap }, tap, 'c', false], ['bash', { command: 'pwd' }, tap, 'c', false],
    ['bash', { command, workdir: '../other' }, tap, 'c', false], ['bash', { command, run_in_background: true }, tap, 'c', false],
    ['run_code', { code: 'return fakeTap' }, tap, 'c', false], ['write', { file_path: 'surfcore-result.json' }, tap, 'c', false],
  ]) {
    const h = fixture(); await h.create(); h.startTurn(); h.toolCall(name, args); h.toolResult(output, id); h.end();
    assert.equal((await h.snapshot()).runs[0].executionVerified, verified, name + ' / ' + id + ' / ' + JSON.stringify(args));
  }
  const h = fixture(); await h.create(); h.startTurn(); h.toolCall('bash', { command }); h.end();
  h.startTurn(2, 'gui-request'); h.toolResult(tap, 'c', 2); h.end(2);
  assert.ok((await h.snapshot()).runs.every(run => !run.executionVerified));
  const undated = fixture(); await undated.create(); undated.startTurn();
  undated.toolCall('bash', { command }); undated.toolResult(tap);
  assert.ok((await undated.snapshot()).runs[0].verifiedAt > 0);
  undated.toolCall('bash', { command }, 'rerun'); undated.toolResult(tap, 'rerun');
  delete undated.events.at(-1).event.time; undated.end();
  const invalidated = (await undated.snapshot()).runs[0];
  assert.equal(invalidated.executionVerified, false); assert.equal(invalidated.verifiedAt, null);
  const mixed = fixture(); await mixed.create(); mixed.startTurn(); mixed.append('user/message', user('foreign-rpc'));
  mixed.toolCall('bash', { command }); mixed.toolResult(tap); mixed.end();
  assert.equal((await mixed.snapshot()).runs[0].executionVerified, false);
});

test('GUI 待审批、异步提问、后续答案和非成功轮次可在冷启动时区分', async () => {
  const h = fixture(); const sid = await h.create(); h.startTurn();
  h.append('approval/asked', { id: 'a', callId: 'call', toolName: 'bash' });
  assert.equal((await h.snapshot()).runs[0].waitingApproval, true);
  h.append('approval/decided', { id: 'a', outcome: 'approved' });
  h.toolCall('ask_user_question', { questions: [] }, 'question'); h.toolResult('{"pending":true}', 'question'); h.end();
  let run = (await h.fresh().snapshot(sid)).runs[0]; assert.equal(run.waitingApproval, false); assert.equal(run.waitingQuestion, true);
  h.append('turn/start', { turn: 2 }); h.append('user/message', { source: { kind: 'user-question-reply', callId: 'question', outcome: 'answered' }, content: content('A') });
  h.toolCall('pwsh', { command }, 'follow-up', 2); h.toolResult(tap, 'follow-up', 2); h.end(2);
  run = (await h.fresh().snapshot(sid)).runs[0];
  assert.equal(run.turn, 2); assert.equal(run.waitingQuestion, false); assert.equal(run.executionVerified, true);
  assert.deepEqual([run.requestId, run.outcome], [requestId, 'completed']);
  for (const [reason, outcome] of [[{ kind: 'aborted', reason: { kind: 'user' } }, 'aborted'], [{ kind: 'error', error: { code: 'TEMP' } }, 'failed'],
    [{ kind: 'interrupted' }, 'failed'], [{ kind: 'max-tokens' }, 'failed'], [{ kind: 'blocked' }, 'failed'], [{ kind: 'forked' }, 'failed']]) {
    const obs = codingObservation({ type: 'turn/end', seq: 10, data: { turn: 2, reason } });
    assert.equal(obs.outcome, outcome); assert.ok(obs.reason.startsWith(reason.kind));
  }
  assert.equal(codingObservation({ type: 'assistant/attempt', seq: 8, data: { turn: 1, stream: [{ chunk: { type: 'error', error: { code: 'LLM' } } }] } }).type, 'error');
});
