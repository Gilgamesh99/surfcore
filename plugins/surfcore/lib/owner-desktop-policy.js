import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { desktopConfigError, readQqSessionSources } from '../../../src/owner-desktop-config.js';

const normalizedPath = (value) => path.resolve(String(value || '.')).replaceAll('\\', '/').replace(/[/]$/, '').toLowerCase();
const inside = (value, root) => Boolean(value && root) && (normalizedPath(value) === normalizedPath(root) || normalizedPath(value).startsWith(normalizedPath(root) + '/'));
const idOf = (agent) => String(agent?.session?.id || agent?.id || '');

/** Exact worker IDs only deny permission; they can never authorize a restored task. */
export function createOwnerDesktopPolicy({ ledgerFile, qqStateDir, biliWorkspace, agents, maxWorkers = 10000 }) {
  let ledgerStamp = '';
  let observedLedger = false;
  let workerIds = new Set();
  function loadWorkers() {
    try {
      const stat = fs.statSync(ledgerFile);
      const stamp = stat.mtimeMs + ':' + stat.size;
      if (stamp === ledgerStamp) return;
      if (stat.size > 2 * 1024 * 1024) throw new Error('oversize');
      const data = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.sessions) || data.sessions.length > maxWorkers || data.sessions.some((id) => typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(id))) throw new Error('invalid ledger');
      workerIds = new Set(data.sessions); ledgerStamp = stamp; observedLedger = true;
    } catch (error) {
      if (error?.code === 'ENOENT' && !observedLedger) return;
      throw desktopConfigError('owner-desktop.worker-ledger-unreadable', '桌面任务身份记录无法读取，桌面通道已关闭。', '停止桌面任务并检查权限记录；不要清空旧任务身份，否则恢复的旧会话可能失去限制。');
    }
  }
  function isWorkerSession(id) { loadWorkers(); return workerIds.has(String(id)); }
  function registerWorkerSession(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(id)) throw desktopConfigError('owner-desktop.worker-id-invalid', '新桌面任务没有有效的宿主会话身份。', '重载 SurfCore 后重新发送命令。');
    loadWorkers(); if (workerIds.has(id)) return true;
    if (workerIds.size >= maxWorkers) throw desktopConfigError('owner-desktop.worker-ledger-full', '桌面任务身份记录已达到容量上限。', '请由管理员迁移身份记录后再开启；旧记录不能自动淘汰。');
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    const lock = ledgerFile + '.lock'; let lockFd; let temp = '';
    try {
      lockFd = fs.openSync(lock, 'wx');
      ledgerStamp = ''; loadWorkers();
      if (workerIds.has(id)) return true;
      if (workerIds.size >= maxWorkers) throw desktopConfigError('owner-desktop.worker-ledger-full', '桌面任务身份记录已满。', '请管理员迁移记录后重试，不能自动淘汰旧身份。');
      const next = [...workerIds, id];
      temp = ledgerFile + '.' + randomUUID() + '.tmp';
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ version: 1, sessions: next }) + String.fromCharCode(10)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, ledgerFile); temp = ''; ledgerStamp = ''; loadWorkers(); return true;
    } catch (error) {
      if (error?.code?.startsWith('owner-desktop.')) throw error;
      throw desktopConfigError('owner-desktop.worker-ledger-write', '无法保存新桌面任务的身份，已阻止执行。', '检查身份记录目录权限或旧锁；确认没有其他宿主正在写入后再处理。');
    } finally { if (temp) { try { fs.unlinkSync(temp); } catch {} } if (lockFd !== undefined) { fs.closeSync(lockFd); fs.unlinkSync(lock); } }
  }
  function ordinaryManaged(agent, sessions, sources) {
    const session = agent?.session; const header = session?.header || {}; const id = idOf(agent);
    if (/^bili-whale(?:-|$)/.test(id) || Object.values(sessions).includes(id) || sources.sessions.includes(id)) return true;
    if (String(header.agentPreset || '').startsWith('qq-chat')) return true;
    return inside(header.cwd, path.join(qqStateDir, 'agents')) || inside(header.cwd, biliWorkspace)
      || sources.directories.some(directory => inside(header.cwd, directory));
  }
  function isManagedAgent(agent) {
    // Separate from worker IDs: normal QQ tools remain available, only desktop authority is denied.
    const sources = readQqSessionSources(path.join(qqStateDir, 'qq-session-sources.json'));
    let sessions = {};
    try { sessions = JSON.parse(fs.readFileSync(path.join(qqStateDir, 'sessions.json'), 'utf8')).sessions || {}; }
    catch (error) { if (error?.code !== 'ENOENT') return true; }
    let current = agent; const seen = new Set();
    for (let depth = 0; current && depth < 32; depth++) {
      const id = idOf(current);
      if (seen.has(id)) return true; seen.add(id);
      if (isWorkerSession(id) || ordinaryManaged(current, sessions, sources)) return true;
      const parent = current.session?.header?.parentSession;
      if (!parent) return false;
      current = agents?.get?.(parent);
      // A missing ancestor cannot prove that this is an ordinary human session.
      if (!current) return true;
    }
    return Boolean(current);
  }
  function parentSessions() {
    return (agents?.list?.() || []).filter((agent) => !agent?.session?.header?.parentSession && !isManagedAgent(agent)).map((agent) => ({ id: idOf(agent), title: String(agent.session?.title || agent.session?.header?.title || '管理会话').slice(0,120) })).filter((row) => row.id);
  }
  return { isManagedAgent, isWorkerSession, registerWorkerSession, parentSessions };
}
