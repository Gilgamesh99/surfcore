import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { biliState, currentCharacter } from '../lib/state-paths.mjs';
import { config } from '../lib/config.mjs';
import { createDmTaskStore } from '../lib/dm-tasks.mjs';
import { createDmTaskService, taskFailure } from '../lib/dm-task-service.mjs';
import { callBridge } from '../../lib/bridge.js';
import { findNodeExe } from '../../lib/paths.js';

const exec = promisify(execFile);
const argv = process.argv.slice(2), [action = 'list', id = ''] = argv;
const option = (name) => { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : ''; };
const store = createDmTaskStore({ file: biliState('dm-tasks.json') });
const runBili = async (args) => {
  try { const r = await exec(findNodeExe(), [fileURLToPath(new URL('../bili.mjs', import.meta.url)), ...args], { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 }); return { ok: true, out: r.stdout, err: r.stderr }; }
  catch (e) { return { ok: false, out: String(e.stdout ?? ''), err: '' }; }
};
const roleKey = () => { const c = currentCharacter(); return JSON.stringify([c?.id || '', c?.epoch || 0, biliState('dm-tasks.json')]); };
const startedRole = roleKey();
const service = createDmTaskService({ store, bridge: callBridge, runBili, getConfig: config, isCurrent: () => roleKey() === startedRole });
let result;
try {
  if (action === 'list') result = { ok: true, jobs: store.list().map(({ id, kind, status, video, target, error, report, receipt }) => ({ id, kind, status, video, target, error, report, receipt })) };
  else if (action === 'show') { const job = store.get(id); result = job ? { ok: true, job } : taskFailure('dm.task-missing', '没有找到任务。', '先运行 dm-task list。'); }
  else if (!/^[a-f0-9]{32}$/.test(id)) result = taskFailure('dm.task-id-invalid', '任务编号不正确。', '请使用 dm-task list 中的完整任务编号。');
  else if (['send', 'reply', 'report', 'retry'].includes(action) && !argv.includes('--go')) result = argv.includes('--dry') ? { ok: true, dry: true, job: store.get(id), text: option('text') } : taskFailure('dm.explicit-go-required', '此操作需要明确 --go。', '先用 show 或 --dry 检查，再带 --go 执行。');
  else if (action === 'send') result = await service.send(id, option('text'));
  else if (action === 'reply') result = await service.reply(id, option('text'));
  else if (action === 'report') result = await service.report(id);
  else if (action === 'retry') result = service.retry(id);
  else if (action === 'status') { const checked = await service.reconcile(id); result = { ...checked, job: store.get(id) }; }
  else result = taskFailure('dm.command-invalid', '未知的私信任务命令。', '使用 list / show / status / send / reply / report / retry。');
} catch (e) { result = taskFailure(e.code || 'dm.task-failed', e.error || '私信任务操作失败。', e.hint || '检查任务记录与桥接状态后重试。'); }
console.log(JSON.stringify(result));
process.exitCode = result.ok ? 0 : 3;
