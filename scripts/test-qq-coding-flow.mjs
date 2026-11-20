import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createOwnerDesktopBroker } from '../src/owner-desktop-broker.js';
import { codingRequestId } from '../src/qq-coding-dsh.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const owner = 123;
const group = 456;
const secondGroup = 789;
const member = 321;
const self = 999;
const taskText = '做一个可下载的摄氏转华氏命令行工具';
const createText = '新建独立编程会话，' + taskText;
const filenames = ['temperature.mjs', '使用说明.txt'];
const checkArgs = ['--test', '--test-reporter=tap', 'surfcore-check.mjs'];
let messageId = 100;

function incoming(text, { kind = 'group', id = group, user = owner, ...extra } = {}) {
  return { post_type: 'message', message_type: kind, user_id: user, self_id: self,
    ...(kind === 'group' ? { group_id: id } : { target_id: self }),
    sender: { user_id: user, nickname: '测试成员' }, message_id: ++messageId,
    time: Math.ceil(Date.now() / 1000), message: [{ type: 'text', data: { text } }], ...extra };
}

// Keep the bridge and DSH adapter intact. Only the remote workspace/session RPC replies are fixtures.
function fixtureHost() {
  const workspaces = new Map();
  const sessions = new Map();
  const created = [];
  const prompts = [];
  function record(sessionId, type, data) {
    const rows = sessions.get(sessionId).records;
    const event = { type, seq: rows.length, time: Date.now(), data };
    rows.push({ type: 'event', event });
    return event;
  }
  function rpc(method, args) {
    switch (method) {
      case 'workspace/create': {
        const workspaceId = path.basename(args.path);
        if (!workspaces.has(workspaceId)) workspaces.set(workspaceId, { workspaceId, path: args.path, sessionIds: [] });
        return { workspace: workspaces.get(workspaceId) };
      }
      case 'session/create': {
        const workspace = workspaces.get(args.workspaceId);
        workspace.sessionIds.push(args.sessionId);
        sessions.set(args.sessionId, { workspace, agentPreset: args.agentPreset, title: null, records: [] });
        created.push({ workspace: workspace.path, sessionId: args.sessionId, agentPreset: args.agentPreset });
        record(args.sessionId, 'sandbox/mode', { mode: 'workspace-write' });
        record(args.sessionId, 'approval/policy', { policy: 'ask' });
        return { sessionId: args.sessionId, agentPreset: args.agentPreset };
      }
      case 'session/list':
        return { items: created.map(({ sessionId, workspace }) => ({ sessionId, cwd: workspace })) };
      case 'session/projections': {
        const session = sessions.get(args.sessionId);
        return session ? { kind: 'sequenced', values: { agentPreset: session.agentPreset, workingDirectory: session.workspace.path, title: session.title } } : null;
      }
      case 'session/rename': {
        const session = sessions.get(args.sessionId);
        session.title = args.title;
        record(args.sessionId, 'session/title', { title: args.title });
        return { title: session.title, seq: session.records.length - 1 };
      }
      case 'session/page': {
        const rows = sessions.get(args.address.sessionId).records;
        const cursor = args.throughSeq ?? rows.length - 1;
        const end = args.beforeSeq ?? cursor + 1;
        const first = Math.max(0, end - args.maxMessages);
        return { records: rows.slice(first, end), cursor, hasMore: first > 0 };
      }
      case 'session/prompt':
        prompts.push(args);
        record(args.sessionId, 'turn/start', { turn: 1 });
        record(args.sessionId, 'user/message', { turn: 1, source: { kind: 'user', rpcId: args.requestId } });
        return { accepted: true };
      default: throw new Error('Unexpected DSH RPC: ' + method);
    }
  }
  return { created, prompts, record, async callUnary(method, args) {
    return { result: { ok: true, value: rpc(method, args) } };
  } };
}

// Capture the full official OneBot envelope at the same request boundary as SnowLuma.
class FixtureGateway {
  requests = [];
  async request(action, params) {
    this.requests.push({ action, params });
    return this.reply?.(action, params) ?? { status: 'ok', retcode: 0, data: { file_id: 'fixture-file-' + this.requests.length } };
  }
}

async function bridge(t, { host = fixtureHost(), gateway = new FixtureGateway(), files = {}, dshHome } = {}) {
  const globals = { createOwnerDesktopBroker, readOwnerDesktopSettings: () => ({ enabled: false }) };
  // Restart the bridge VM with a fresh journal reader while the fixture DSH keeps its workspace and file times.
  if (dshHome) globals.process = { pid: process.pid, platform: process.platform, env: { DSH_HOME: dshHome } };
  const h = await bridgeHarness({ files, globals, config: { sendDelayMs: 0, ownerQQ: owner,
    allow: { private: [String(owner), String(member)], groups: [String(group), String(secondGroup)] } } });
  t.after(() => h.close());
  h.api.callUnary = host.callUnary;
  h.setMode('reserved2');
  h.setSelfIdentity('测试助手', self);
  h.setReady(true);
  h.setSnowlumaHealth({ connected: true });
  const otherRequest = h.bot.request.bind(h.bot);
  h.bot.request = (action, params) => action.startsWith('upload_')
    ? gateway.request(action, params) : otherRequest(action, params);
  const journal = path.join(h.temp, 'state', 'qq-coding-tasks.json');
  dshHome ??= path.join(h.temp, 'dsh');
  const workspaces = path.join(dshHome, 'surfcore', 'coding-workspaces');
  const rows = () => fs.existsSync(journal) ? JSON.parse(fs.readFileSync(journal, 'utf8')).tasks : [];
  const live = event => h.receiveCodingLive(event.message_type, event.group_id ?? event.user_id, event);
  return { ...h, host, gateway, journal, dshHome, workspaces, rows, live };
}

function nodeIn(cwd, args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 15_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout;
}

// Model work for the fixture: write a usable CLI and run the same acceptance command the host asks for.
function makeProduct(h, task) {
  const workspace = path.join(h.workspaces, task.id);
  assert.deepEqual(fs.readdirSync(workspace), []);
  const out = path.join(workspace, 'deliverables');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, filenames[0]), [
    'const value = Number(process.argv[2]);',
    'if (!Number.isFinite(value)) process.exit(2);',
    'console.log(value * 9 / 5 + 32);', '',
  ].join('\n'));
  fs.writeFileSync(path.join(out, filenames[1]), '温度换算器\n运行 node temperature.mjs 100，结果为 212。\n');
  const label = 'surfcore-acceptance ' + codingRequestId(task.id);
  fs.writeFileSync(path.join(workspace, 'surfcore-check.mjs'), [
    "import { test } from 'node:test';", "import assert from 'node:assert/strict';",
    "import { spawnSync } from 'node:child_process';",
    'test(' + JSON.stringify(label) + ', () => {',
    "  const run = input => spawnSync(process.execPath, ['deliverables/temperature.mjs', input], { encoding: 'utf8' });",
    "  for (const [input, expected] of [['0', '32'], ['-40', '-40']]) {",
    '    const result = run(input);', '    assert.equal(result.status, 0);',
    '    assert.equal(result.stdout.trim(), expected);', '  }',
    "  assert.equal(run('invalid').status, 2);", '});', '',
  ].join('\n'));
  fs.writeFileSync(path.join(workspace, 'surfcore-result.json'), JSON.stringify({
    files: filenames, checks: ['0°C 和 -40°C 分别得到 32°F 和 -40°F，无效输入以状态码 2 退出。'],
  }));
  const command = ['node', ...checkArgs].join(' ');
  const callId = 'fixture-acceptance';
  h.host.record(task.sessionId, 'tool/call', { turn: 1, name: 'bash', callId, arguments: JSON.stringify({ command }) });
  const tap = nodeIn(workspace, checkArgs);
  assert.ok(tap.includes('ok 1 - ' + label), tap);
  assert.match(tap, /^# fail 0$/m);
  const receipt = h.host.record(task.sessionId, 'tool/result', { turn: 1,
    message: { source: { callId }, content: [{ type: 'text', text: tap }] } });
  return { workspace, verifiedAt: receipt.time };
}

async function completeTurn(h, task) {
  h.host.record(task.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  await h.onCodingEvent(task.sessionId, 'turn/end');
  const final = h.rows().find(row => row.id === task.id);
  assert.equal(final.notice, false, 'The originating chat should receive the final status');
  return final;
}

test('主人群消息创建独立工作区，真实 CLI 验收和下载运行均通过，原群收到对应文件回执', async t => {
  const h = await bridge(t);
  const event = incoming(createText);
  await Promise.all([h.live(event), h.live(event)]);
  await h.live(event);
  const [task] = h.rows();
  assert.equal(h.rows().length, 1);
  assert.deepEqual(h.host.created, [{ workspace: path.join(h.workspaces, task.id), sessionId: task.sessionId, agentPreset: 'standard' }]);
  assert.equal(h.host.prompts.length, 1);
  const [prompt] = h.host.prompts;
  assert.equal(prompt.sessionId, task.sessionId);
  assert.equal(prompt.requestId, codingRequestId(task.id));
  assert.equal(prompt.mode, 'queue');
  assert.ok(prompt.content[0].text.endsWith(taskText));
  assert.ok(prompt.content[0].text.includes(['node', ...checkArgs].join(' ')));
  assert.ok(h.calls.follows.includes(task.sessionId));
  assert.equal(h.calls.prompts.length, 0);
  assert.equal(task.originKey, 'group:' + group);
  assert.equal(task.phase, 'running');
  assert.equal(h.gateway.requests.length, 0);
  const { workspace, verifiedAt } = makeProduct(h, task);
  const final = await completeTurn(h, task);
  assert.equal(final.phase, 'delivered');
  assert.equal(final.verifiedAt, verifiedAt);
  assert.equal(h.gateway.requests.length, 2);
  for (const [index, { action, params }] of h.gateway.requests.entries()) {
    const name = filenames[index];
    assert.equal(action, 'upload_group_file');
    assert.equal(params.group_id, group);
    assert.equal(params.upload_file, true);
    assert.equal(params.name, name);
    assert.match(params.file, /^base64:\/\//);
    const bytes = Buffer.from(params.file.slice('base64://'.length), 'base64');
    assert.deepEqual(bytes, fs.readFileSync(path.join(workspace, 'deliverables', name)));
    assert.deepEqual(final.files[index], { name, relativePath: name, originKey: task.originKey,
      size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), status: 'sent', fileId: 'fixture-file-' + (index + 1) });
    if (index === 0) {
      fs.writeFileSync(path.join(h.temp, 'download.mjs'), bytes);
      assert.equal(nodeIn(h.temp, ['download.mjs', '100']).trim(), '212');
    }
  }
  const last = h.calls.sent.at(-1);
  assert.equal(last.kind, 'group'); assert.equal(last.id, group);
  assert.ok(last.text.includes('已确认送达 2/2'), last.text);
});

async function reply(h, event) {
  const before = h.calls.sent.length;
  await h.live(event);
  assert.ok(h.calls.sent.length > before, 'Expected a reply to the original request');
  const last = h.calls.sent.at(-1);
  assert.equal(last.kind, event.message_type);
  assert.equal(last.id, event.group_id ?? event.user_id);
  return last.text;
}

async function restart(t, previous, journal = fs.readFileSync(previous.journal, 'utf8')) {
  const restored = await bridge(t, { host: previous.host, gateway: previous.gateway, dshHome: previous.dshHome,
    files: { 'state/qq-coding-tasks.json': journal } });
  await restored.tickCodingTasks();
  return restored;
}

test('普通制作、其他成员、非实时入口与历史消息均不创建独立会话', async t => {
  const h = await bridge(t);
  await h.live(incoming(taskText));
  await h.live(incoming(createText, { user: member, sender: { user_id: member, nickname: '主人', role: 'owner' } }));
  await h.live(incoming(createText, { kind: 'private', user: member }));
  await h.live(incoming(createText, { history: true }));
  await h.live(incoming(createText, { id: 111 }));
  await h.handleIncoming('group', group, incoming(createText), h.cfg);
  assert.deepEqual(h.rows(), []);
  assert.deepEqual(h.host.created, []);
  assert.deepEqual(h.host.prompts, []);
  assert.deepEqual(h.gateway.requests, []);
});

test('主人裸开后只接原会话的主人补充，同条任务重放只执行一次，私聊附件送回本人', async t => {
  const h = await bridge(t);
  const bare = incoming('开个新的 DSH 编程会话', { kind: 'private' });
  await h.live(bare);
  const [task] = h.rows();
  assert.equal(task.phase, 'waiting');
  assert.equal(task.originKey, 'private:' + owner);
  assert.ok(h.calls.sent.at(-1).text.includes(task.id));
  assert.equal(h.host.created.length, 1);
  assert.equal(h.host.prompts.length, 0);
  const supply = '任务 #' + task.id + '：' + taskText;
  await h.live(incoming('今天的天气不错', { kind: 'private' }));
  await h.live(incoming(supply));
  await h.live(incoming(supply, { kind: 'private', user: member }));
  await h.handleIncoming('private', owner, incoming(supply, { kind: 'private' }), h.cfg);
  assert.equal(h.rows()[0].phase, 'waiting');
  assert.equal(h.host.prompts.length, 0);
  const allowed = incoming(taskText, { kind: 'private' });
  await Promise.all([h.live(allowed), h.live(allowed)]);
  await h.live(allowed);
  assert.equal(h.rows().length, 1);
  assert.equal(h.rows()[0].phase, 'running');
  assert.equal(h.host.created.length, 1);
  assert.equal(h.host.prompts.length, 1);
  assert.equal(h.host.prompts[0].sessionId, task.sessionId);
  assert.ok(h.host.prompts[0].content[0].text.endsWith(taskText));
  makeProduct(h, task);
  assert.equal((await completeTurn(h, task)).phase, 'delivered');
  assert.deepEqual(h.gateway.requests.map(({ action, params }) => [action, params.user_id, params.name]),
    filenames.map(name => ['upload_private_file', owner, name]));
});

test('本群成员和主人私聊看到实际审批状态，其他群查列表或持编号均无结果', async t => {
  const h = await bridge(t);
  await h.live(incoming(createText));
  const [task] = h.rows();
  h.host.record(task.sessionId, 'approval/asked', { turn: 1, id: 'fixture-approval', toolName: 'write' });
  await h.onCodingEvent(task.sessionId, 'approval/asked');
  assert.equal(h.rows()[0].phase, 'approval');
  const query = '任务 #' + task.id + ' 进度';
  for (const event of [incoming(query, { user: member }), incoming('任务进度', { kind: 'private' })]) {
    const message = await reply(h, event);
    assert.ok(message.includes(task.id) && message.includes('审批'), message);
    assert.ok(!message.includes(taskText) && !message.includes(task.sessionId) && !message.includes(h.temp));
  }
  const byId = await reply(h, incoming(query, { id: secondGroup, user: member }));
  assert.match(byId, /没有符合条件/);
  assert.ok(!byId.includes(task.id));
  const byGroup = await reply(h, incoming('任务进度', { id: secondGroup }));
  assert.match(byGroup, /没有符合条件/);
  assert.ok(!byGroup.includes(task.id) && !byGroup.includes(taskText), byGroup);

  h.setReady(false);
  h.host.record(task.sessionId, 'approval/decided', { turn: 1, id: 'fixture-approval', outcome: 'approved' });
  const offline = await reply(h, incoming(query, { user: member }));
  assert.ok(offline.includes(task.id) && offline.includes('等待主人在 DSH 中审批'), offline);
  assert.match(offline, /连接 DSH 暂未成功，显示上次确认的进度/u);
  h.setReady(true);
  await h.onCodingEvent(task.sessionId, 'approval/decided');
  const online = await reply(h, incoming(query, { user: member }));
  assert.ok(online.includes(task.id) && online.includes('正在制作'), online);
  assert.ok(!online.includes('上次确认') && !online.includes('审批'), online);
  assert.equal(h.host.created.length, 1);
  assert.equal(h.host.prompts.length, 1);
  assert.equal(h.gateway.requests.length, 0);
});

test('按作品询问时只返回匹配的任务，同群询问任务总体情况可见两项', async t => {
  const h = await bridge(t);
  await h.live(incoming(createText));
  const [tool] = h.rows();
  await h.live(incoming('新建独立编程会话，做一个五子棋游戏'));
  const game = h.rows().find(row => row.id !== tool.id);
  assert.ok(game);
  const custom = await reply(h, incoming('那个工具做到哪了', { user: member }));
  assert.ok(custom.includes(tool.id) && !custom.includes(game.id), custom);
  const all = await reply(h, incoming('任务情况怎么样了', { user: member }));
  assert.ok(all.includes(tool.id) && all.includes(game.id), all);
  const elsewhere = await reply(h, incoming('那个工具做到哪了', { id: secondGroup, user: member }));
  assert.match(elsewhere, /没有符合条件/);
  assert.ok(!elsewhere.includes(tool.id) && !elsewhere.includes(game.id), elsewhere);
  assert.equal(h.host.prompts.length, 2);
});

test('桥接离线时宿主完成，重启从原会话记录恢复验收；再次启动沿用两份回执', async t => {
  const first = await bridge(t);
  await first.live(incoming(createText));
  const [task] = first.rows();
  makeProduct(first, task);
  first.host.record(task.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  assert.equal(first.rows()[0].phase, 'running');
  assert.equal(first.gateway.requests.length, 0);
  const recovered = await restart(t, first);
  const [final] = recovered.rows();
  assert.equal(final.phase, 'delivered');
  assert.equal(final.sessionId, task.sessionId);
  assert.deepEqual(final.files.map(file => file.fileId), ['fixture-file-1', 'fixture-file-2']);
  assert.equal(first.host.created.length, 1);
  assert.equal(first.host.prompts.length, 1);
  const rebooted = await restart(t, recovered);
  assert.deepEqual(rebooted.rows()[0].files, final.files);
  assert.equal(first.gateway.requests.length, 2);
});

test('成品和自报的检查清单齐备，宿主无验收命令回执时阻止上传并给出原因', async t => {
  const h = await bridge(t);
  await h.live(incoming(createText));
  const [task] = h.rows();
  const workspace = path.join(h.workspaces, task.id);
  fs.mkdirSync(path.join(workspace, 'deliverables'));
  fs.writeFileSync(path.join(workspace, 'deliverables', 'demo.mjs'), 'console.log(1)');
  fs.writeFileSync(path.join(workspace, 'surfcore-result.json'), JSON.stringify({ files: ['demo.mjs'], checks: ['已通过'] }));
  const final = await completeTurn(h, task);
  assert.equal(final.phase, 'failed');
  assert.equal(final.issue, 'NO_RUN');
  assert.equal(h.gateway.requests.length, 0);
  assert.match(h.calls.sent.at(-1).text, /未取得.*验收.*请在 DSH/u);
});

test('桥接重启后仍能识别同名测试在另一目录通过，原群不会收到未经该测试验收的成品', async t => {
  const first = await bridge(t);
  await first.live(incoming(createText));
  const [task] = first.rows();
  const workspace = path.join(first.workspaces, task.id);
  fs.mkdirSync(path.join(workspace, 'deliverables'));
  fs.writeFileSync(path.join(workspace, 'deliverables', 'answer.txt'), '41');
  fs.writeFileSync(path.join(workspace, 'surfcore-result.json'), JSON.stringify({ files: ['answer.txt'], checks: ['读取答案为 42'] }));

  const other = fs.mkdtempSync(path.join(first.temp, 'other-cwd-'));
  fs.writeFileSync(path.join(other, 'answer.txt'), '42');
  const label = 'surfcore-acceptance ' + codingRequestId(task.id);
  fs.writeFileSync(path.join(other, 'surfcore-check.mjs'), [
    "import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs';",
    "test(" + JSON.stringify(label) + ", () => assert.equal(fs.readFileSync('answer.txt', 'utf8'), '42'));",
  ].join('\n'));
  first.host.record(task.sessionId, 'working-directory/change', { cwd: other });
  const callId = 'other-directory-check';
  first.host.record(task.sessionId, 'tool/call', { turn: 1, callId, name: 'bash', arguments: JSON.stringify({ command: ['node', ...checkArgs].join(' ') }) });
  const text = nodeIn(other, checkArgs);
  assert.ok(text.includes('ok 1 - ' + label));
  first.host.record(task.sessionId, 'tool/result', { turn: 1, message: { source: { callId }, content: [{ type: 'text', text }] } });
  first.host.record(task.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } });

  const recovered = await restart(t, first);
  assert.equal(recovered.rows()[0].issue, 'NO_RUN');
  assert.equal(recovered.gateway.requests.length, 0);
});

test('原生验收通过后、回合结束前改动第二个成品，批次中的文件均不上传', async t => {
  const h = await bridge(t);
  await h.live(incoming(createText));
  const [task] = h.rows();
  const { workspace, verifiedAt } = makeProduct(h, task);
  const changed = path.join(workspace, 'deliverables', filenames[1]);
  await delay(40); // Move the write past the millisecond TAP receipt and filesystem timestamp resolution.
  fs.appendFileSync(changed, '验收后的新内容\n');
  assert.ok(Math.floor(fs.statSync(changed).mtimeMs) > verifiedAt);
  const final = await completeTurn(h, task);
  assert.equal(final.phase, 'failed');
  assert.equal(final.issue, 'CHANGED');
  assert.equal(h.gateway.requests.length, 0);
  assert.match(h.calls.sent.at(-1).text, /验收.*变化.*重新/u);
});

test('首件已送达、次件被拒后重启，主人私聊重试只补次件到原群', async t => {
  const h = await bridge(t);
  await h.live(incoming(createText));
  const [task] = h.rows();
  makeProduct(h, task);
  h.gateway.reply = (_action, params) => params.name === filenames[1]
    ? { status: 'failed', retcode: 403, data: null } : { status: 'ok', retcode: 0, data: { file_id: 'first-receipt' } };
  const failed = await completeTurn(h, task);
  assert.equal(failed.phase, 'rejected');
  assert.deepEqual(failed.files.map(file => [file.status, file.fileId]), [['sent', 'first-receipt'], ['rejected', undefined]]);
  assert.ok(h.calls.sent.at(-1).text.includes('1/2') && h.calls.sent.at(-1).text.includes('重试交付 #' + task.id));
  const restored = await restart(t, h);
  const retry = '重试交付 #' + task.id;
  await restored.live(incoming(retry, { id: secondGroup }));
  await restored.live(incoming(retry, { user: member }));
  assert.equal(restored.rows()[0].phase, 'rejected');
  assert.equal(h.gateway.requests.length, 2);
  h.gateway.reply = () => ({ status: 'ok', retcode: 0, data: { file_id: 'second-receipt' } });
  const command = incoming(retry, { kind: 'private' });
  await Promise.all([restored.live(command), restored.live(command)]);
  await restored.tickCodingTasks();
  const [final] = restored.rows();
  assert.equal(final.phase, 'delivered');
  assert.deepEqual(final.files.map(file => [file.status, file.fileId]), [['sent', 'first-receipt'], ['sent', 'second-receipt']]);
  assert.deepEqual(h.gateway.requests.map(({ action, params }) => [action, params.group_id, params.name]),
    [filenames[0], filenames[1], filenames[1]].map(name => ['upload_group_file', group, name]));
  assert.equal(h.host.prompts.length, 1);
});

test('次件上传中断时保存 sending，丢失回执和发送中重启均提示核对且阻止重传', async t => {
  const h = await bridge(t);
  await h.live(incoming(createText));
  const [task] = h.rows();
  makeProduct(h, task);
  let inFlightJournal;
  h.gateway.reply = (_action, params) => {
    if (params.name === filenames[0]) return { status: 'ok', retcode: 0, data: { file_id: 'confirmed-first' } };
    inFlightJournal = fs.readFileSync(h.journal, 'utf8');
    throw new Error('fixture connection closed before acknowledgement');
  };
  const failed = await completeTurn(h, task);
  assert.deepEqual(JSON.parse(inFlightJournal).tasks[0].files.map(file => file.status), ['sent', 'sending']);
  assert.equal(failed.phase, 'unknown');
  assert.deepEqual(failed.files.map(file => file.status), ['sent', 'unknown']);
  assert.ok(h.calls.sent.at(-1).text.includes('核对') && h.calls.sent.at(-1).text.includes('1/2'));
  const restored = await restart(t, h, inFlightJournal);
  const [recovered] = restored.rows();
  assert.equal(recovered.phase, 'unknown');
  assert.deepEqual(recovered.files.map(file => [file.status, file.fileId]), [['sent', 'confirmed-first'], ['unknown', undefined]]);
  for (const instance of [h, restored]) {
    const message = await reply(instance, incoming('重试交付 #' + task.id));
    assert.match(message, /只可重试.*已确认遭拒/);
    await instance.tickCodingTasks();
  }
  assert.equal(h.gateway.requests.length, 2);
  assert.equal(h.host.prompts.length, 1);
});
