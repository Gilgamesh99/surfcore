import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { desktopConfigError } from './owner-desktop-options.js';
// Keep the original entry point compatible while settings readers use the fresh module.
export * from './owner-desktop-options.js';

const SOURCE_SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/;
const SOURCE_LIMIT = 10000;
const SOURCE_DIRECTORY_LIMIT = 256;
const sourceError = (suffix, error) => desktopConfigError('owner-desktop.qq-source-' + suffix, error,
  '停止 QQ 桥接并检查会话来源记录和目录权限；保留旧身份记录，修复后重启桥接，不要清空记录。');

function parseQqSessionSources(file) {
  try {
    if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error('oversize');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || value.version !== 1 || !Array.isArray(value.sessions) || value.sessions.length > SOURCE_LIMIT
        || value.sessions.some(id => typeof id !== 'string' || !SOURCE_SESSION_ID.test(id))
        || !Array.isArray(value.directories) || value.directories.length > SOURCE_DIRECTORY_LIMIT
        || value.directories.some(dir => typeof dir !== 'string' || !dir || dir.length > 4096 || !path.isAbsolute(dir))) throw new Error('invalid source ledger');
    return { version: 1, sessions: [...new Set(value.sessions)], directories: [...new Set(value.directories)] };
  } catch {
    throw sourceError('unreadable', 'QQ 会话来源记录缺失或损坏，无法证明桌面授权来源。');
  }
}

/** Denial provenance only. Missing, corrupt or locked records never prove a human origin. */
export function readQqSessionSources(file) {
  const assertUnlocked = () => {
    if (fs.existsSync(file + '.lock')) throw sourceError('locked', 'QQ 会话来源记录正在写入或锁未释放，桌面通道已关闭。');
  };
  assertUnlocked();
  const value = parseQqSessionSources(file);
  assertUnlocked();
  return value;
}

/** Called by the bridge before use/removal. Old QQ identities are never evicted. */
export function recordQqSessionSources(file, ids, { initialize = false, cwd = '' } = {}) {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !SOURCE_SESSION_ID.test(id)))
    throw sourceError('invalid', 'QQ 会话缺少有效的宿主身份，已阻止使用或移除映射。');
  const directory = cwd ? path.resolve(String(cwd)) : '';
  if (directory.length > 4096) throw sourceError('invalid', 'QQ 会话目录无效，无法保存来源。');
  // A separate marker distinguishes the first migration from a later lost ledger.
  const marker = file + '.initialized';
  const lock = file + '.lock';
  let lockFd; let temp = '';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    lockFd = fs.openSync(lock, 'wx', 0o600);
    const canInitialize = initialize && !fs.existsSync(marker) && !fs.existsSync(file);
    const before = canInitialize ? { version: 1, sessions: [], directories: [] } : parseQqSessionSources(file);
    const sessions = [...new Set([...before.sessions, ...ids])];
    const directories = [...new Set([...before.directories, ...(directory ? [directory] : [])])];
    const serialized = JSON.stringify({ version: 1, sessions, directories }) + '\n';
    if (sessions.length > SOURCE_LIMIT || directories.length > SOURCE_DIRECTORY_LIMIT || Buffer.byteLength(serialized) > 2 * 1024 * 1024)
      throw sourceError('full', 'QQ 会话来源记录已满，已阻止新建或移除会话；旧身份不会自动淘汰。');
    if (!fs.existsSync(marker)) {
      const markerFd = fs.openSync(marker, 'wx', 0o600);
      try { fs.writeFileSync(markerFd, '1\n'); fs.fsyncSync(markerFd); } finally { fs.closeSync(markerFd); }
    }
    if (!canInitialize && sessions.length === before.sessions.length && directories.length === before.directories.length) return true;
    temp = file + '.' + randomUUID() + '.tmp';
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, serialized); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file); temp = ''; return true;
  } catch (error) {
    if (error?.code?.startsWith('owner-desktop.')) throw error;
    throw sourceError('write', 'QQ 会话来源记录写入失败，已阻止会话创建或映射移除。');
  } finally {
    if (temp) { try { fs.unlinkSync(temp); } catch {} }
    if (lockFd !== undefined) { fs.closeSync(lockFd); fs.unlinkSync(lock); }
  }
}
