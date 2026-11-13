import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.env.SURFCORE_DM_CLI_FIXTURE === '1') {
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input)), method = init.method || 'GET';
    fs.appendFileSync(process.env.SURFCORE_DM_CLI_REQUESTS, JSON.stringify({ path: url.pathname, method }) + '\n');
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });
    const mode = process.env.SURFCORE_DM_CLI_RESULT;
    if (url.origin === 'https://api.bilibili.com' && method === 'GET') {
      if (url.pathname === '/x/web-interface/nav') return reply({ code: 0, data: { isLogin: true, mid: 900001, uname: 'fixture' } });
      if (url.pathname === '/x/relation') return reply({ code: 0, data: { attribute: mode === 'not-mutual' ? 2 : 6 } });
    }
    if (url.origin === 'https://api.vc.bilibili.com' && url.pathname === '/web_im/v1/web_im/send_msg' && method === 'POST') {
      const params = new URLSearchParams(init.body);
      assert.equal(params.get('msg[receiver_id]'), '900002');
      assert.equal(params.get('msg[msg_type]'), '1');
      assert.equal(params.get('csrf'), 'OFFLINE_CSRF');
      assert.equal(init.redirect, 'manual'); assert.ok(init.signal);
      if (mode === 'timeout') throw new Error('secret-cookie-must-not-print');
      if (mode === 'reject') return reply({ code: -101, message: 'login required' });
      if (mode === 'bad-json') return new Response('bad', { status: 200 });
      return reply({ code: 0, data: { msg_key: '90071992547409919' } });
    }
    if (url.origin === 'http://127.0.0.1:3100') {
      assert.equal(init.headers['x-console-token'], 'OFFLINE_CONSOLE');
      if (url.pathname === '/api/bili/dm-share/resolve' && method === 'POST') return reply({ ok: true, group: { id: '500001', name: '目标群' } });
      if (url.pathname === '/api/bili/dm-share/send' && method === 'POST') {
        const body = JSON.parse(init.body); assert.equal(body.groupId, '500001');
        assert.equal(body.sourceSeq, '90071992547409918');
        assert.deepEqual(Object.keys(body.video).sort(), ['bvid', 'title', 'url']);
        return reply({ ok: true, status: 'sent', receipt: { messageId: '-3001', groupId: '500001', groupName: '目标群', sentAt: '2026-11-13T10:00:00Z' } });
      }
    }
    throw new Error('OFFLINE unexpected request ' + method + ' ' + url.origin + url.pathname);
  };
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-dm-cli-'));
  const dsh = path.join(tmp, 'dsh'), stateDir = path.join(dsh, 'surfcore', 'bili'), qq = path.join(tmp, 'qq');
  const configFile = path.join(dsh, 'surfcore', 'bili.config.json');
  const log = path.join(tmp, 'requests.jsonl');
  const entry = fileURLToPath(new URL('../tools/bili.mjs', import.meta.url));
  const writeJson = (f, value) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(value)); };
  const config = { self: { mid: '900001', name: 'fixture' }, owner: { mid: '900002', name: 'owner' }, interact: { enabled: true }, listen: { dm: true } };
  const env = { ...process.env, DSH_HOME: dsh, USERPROFILE: tmp, HOME: tmp, SURFCORE_BILI_CONFIG: configFile,
    SURFCORE_ROOT: qq, SURFCORE_QQBOT_ROOT: qq, QQBILI_QQBOT_ROOT: qq, DSH_NODE: process.execPath,
    BILI_ME_MID: '900001', BILI_OWNER_MID: '900002', SURFCORE_DM_CLI_FIXTURE: '1', SURFCORE_DM_CLI_REQUESTS: log, NODE_OPTIONS: '--import=' + import.meta.url };
  function run(args, mode = '') {
    fs.writeFileSync(log, '');
    const outFile = path.join(tmp, 'stdout'), errFile = path.join(tmp, 'stderr');
    const out = fs.openSync(outFile, 'w'), err = fs.openSync(errFile, 'w');
    let run;
    try { run = spawnSync(process.execPath, [entry, ...args], { env: { ...env, SURFCORE_DM_CLI_RESULT: mode }, timeout: 30000, stdio: ['ignore', out, err] }); }
    finally { fs.closeSync(out); fs.closeSync(err); }
    assert.equal(run.error, undefined, String(run.error));
    const stdout = fs.readFileSync(outFile, 'utf8'), stderr = fs.readFileSync(errFile, 'utf8');
    const result = JSON.parse(stdout.trim().split('\n').at(-1));
    assert.doesNotMatch(stdout, /OFFLINE_CSRF|OFFLINE_DEVICE|OFFLINE_CONSOLE|OFFLINE_SESSION/);
    const requests = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((s) => JSON.parse(s));
    return { result, requests, status: run.status, stderr };
  }
  try {
    writeJson(configFile, config);
    writeJson(path.join(stateDir, 'credentials.json'), { sessdata: 'OFFLINE_SESSION', bili_jct: 'OFFLINE_CSRF', buvid3: 'OFFLINE_DEVICE' });
    writeJson(path.join(qq, 'config.json'), { consoleToken: 'OFFLINE_CONSOLE', console: { port: 3100 } });
    fs.mkdirSync(path.join(qq, 'src'), { recursive: true }); fs.writeFileSync(path.join(qq, 'src', 'bridge.js'), '// offline root sentinel');
    const senderArgs = ['dm', '--to', '900002', '--msg', '处理结果', '--go', '--json'];
    let sent = run(senderArgs);
    assert.equal(sent.status, 0, sent.stderr); assert.equal(sent.result.ok, true); assert.equal(sent.result.receipt.messageKey, '90071992547409919');
    assert.equal(sent.requests.filter((r) => r.method === 'POST').length, 1);
    for (const mode of ['reject', 'bad-json', 'timeout']) {
      const r = run(senderArgs, mode); assert.equal(r.result.ok, false);
      assert.equal(r.result.status, mode === 'reject' ? 'failed' : 'unknown');
      assert.equal(r.result.retryable, mode === 'reject'); assert.ok(r.result.hint);
      assert.equal(r.requests.filter((x) => x.method === 'POST').length, 1);
    }
    const blocked = run(senderArgs, 'not-mutual');
    assert.equal(blocked.result.status, 'failed'); assert.equal(blocked.requests.filter((r) => r.method === 'POST').length, 0);
    writeJson(configFile, { ...config, interact: { enabled: false } });
    assert.equal(run(senderArgs).requests.length, 0); writeJson(configFile, config);

    const { createDmTaskStore } = await import('../tools/lib/dm-tasks.mjs');
    const store = createDmTaskStore({ file: path.join(stateDir, 'dm-tasks.json') });
    const [job] = store.accept({ batchId: 'cli-batch', items: [{ mid: '900002', messages: [
      { seq: '90071992547409917', ts: 100, type: 7, text: '', video: { bvid: 'BV1xx411c7mD', title: '视频标题' } },
      { seq: '90071992547409918', ts: 101, type: 1, text: '把这个视频分享到群聊目标群' },
    ] }] }, '900002');
    assert.equal(run(['dm-task', 'list', '--json']).result.jobs[0].id, job.id);
    const missingStatus = run(['dm-task', 'status', 'a'.repeat(32), '--json']);
    assert.equal(missingStatus.result.ok, false); assert.equal(missingStatus.result.code, 'dm.task-missing');
    assert.ok(missingStatus.result.hint); assert.equal(missingStatus.status, 3); assert.equal(missingStatus.requests.length, 0);
    assert.equal(run(['dm-task', 'show', job.id, '--json']).result.job.sourceSeq, '90071992547409918');
    const noGo = run(['dm-task', 'send', job.id, '--text', '一点想法']);
    assert.equal(noGo.result.code, 'dm.explicit-go-required'); assert.equal(noGo.requests.length, 0);
    const dry = run(['dm-share', 'send', job.id, '--text', '一点想法', '--dry']);
    assert.equal(dry.result.dry, true); assert.equal(dry.requests.length, 0); assert.equal(store.get(job.id).status, 'pending');
    sent = run(['dm-task', 'send', job.id, '--text', '一点想法', '--go']);
    assert.equal(sent.result.status, 'sent', JSON.stringify(sent.result)); assert.equal(sent.result.receipt.messageId, '-3001');
    assert.equal(store.get(job.id).report.status, 'sent');
    assert.equal(sent.requests.filter((r) => r.path === '/api/bili/dm-share/send').length, 1);
    assert.equal(sent.requests.filter((r) => r.path === '/web_im/v1/web_im/send_msg').length, 1);
    const duplicate = run(['dm-task', 'send', job.id, '--text', '一点想法', '--go']);
    assert.equal(duplicate.result.duplicate, true); assert.equal(duplicate.requests.length, 0);
    console.log('PASS real CLI dispatch, dry/go boundary, guarded sender rejection, uncertain POST, receipt reporting and duplicate suppression (offline only).');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
