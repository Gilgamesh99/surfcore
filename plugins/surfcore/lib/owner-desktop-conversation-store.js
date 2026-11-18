import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_SESSIONS = 10000;
const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/;
const QQ = /^[1-9][0-9]{0,19}$/;
const IDENTITY_KEYS = ['conversationKey', 'ownerQQ', 'selfUserId', 'sourceSessionId'];
const RECORD_KEYS = [...IDENTITY_KEYS, 'sessionId'];
const ROW_KEYS = [...RECORD_KEYS, 'phase'];
const PREFIX = 'owner-desktop.conversation-store-';
const RECOVERY_HINT = '停止桌面任务并检查会话目录、权限或遗留锁；保留并恢复原身份记录，不要清空记录后重试。';

function failure(suffix, message, hint = RECOVERY_HINT) {
  return Object.assign(new Error(message), { ok: false, code: PREFIX + suffix, error: message, hint });
}
function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function positiveQQ(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === 'string' && QQ.test(value) ? value : null;
}
function sessionId(value) {
  if (typeof value !== 'string' || !SESSION_ID.test(value))
    throw failure('identity-invalid', '桌面会话缺少有效的宿主身份。', '重载 SurfCore 后，从当前主人 QQ 会话重新发送桌面命令。');
  return value;
}
function identity(value, keys = IDENTITY_KEYS) {
  if (!exactKeys(value, keys)) throw failure('identity-invalid', '桌面会话身份字段不完整或包含额外数据。', '仅传入会话、主人、机器人和来源会话身份；不要传入消息、令牌或人格内容。');
  const ownerQQ = positiveQQ(value.ownerQQ);
  const selfUserId = positiveQQ(value.selfUserId);
  if (!ownerQQ || !selfUserId || typeof value.conversationKey !== 'string'
      || !/^(private|group):[1-9][0-9]{0,19}$/.test(value.conversationKey))
    throw failure('identity-invalid', '桌面会话的 QQ 身份或会话标识无效。', '重新读取当前主人 QQ 会话身份后再试。');
  return { conversationKey: value.conversationKey, ownerQQ, selfUserId, sourceSessionId: sessionId(value.sourceSessionId) };
}
function record(value, keys = RECORD_KEYS) {
  const result = { ...identity(value, keys), sessionId: sessionId(value.sessionId) };
  if (result.sourceSessionId === result.sessionId)
    throw failure('identity-invalid', '独立桌面会话不能与来源 QQ 会话使用同一身份。', '为独立桌面会话生成新的宿主会话身份后重试。');
  return result;
}
const sameIdentity = (left, right) => IDENTITY_KEYS.every(key => left[key] === right[key]);
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino
  && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;

// On Windows Node cannot reliably open/fsync directories; file contents are still fsynced before rename.
function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/**
 * Continuity metadata and denial provenance only. No row grants Windows permission:
 * the caller must obtain a fresh owner lease before every new/resumed activation.
 * reserve MUST succeed before host creation; confirm follows the official creation receipt.
 * Reserved IDs are permanent deny-only entries. Array order defines the latest reservation.
 * All methods are synchronous; status returns structured errors, other methods throw them.
 */
export function createOwnerDesktopConversationStore({ file, maxSessions = MAX_SESSIONS } = {}) {
  if (typeof file !== 'string' || !file.trim() || file.includes('\0')
      || !Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > MAX_SESSIONS)
    throw failure('options-invalid', '桌面会话目录路径或容量无效。', '指定有效的目录文件路径和 1 到 10000 的整数容量。');
  file = path.resolve(file);
  const directory = path.dirname(file);
  const marker = file + '.initialized';
  const lock = file + '.lock';
  let observed = false;

  function statOrMissing(target) {
    try { return fs.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  function assertUnlocked() {
    if (statOrMissing(lock)) throw failure('locked', '桌面会话目录正在写入或锁未释放，已停止桌面操作。');
  }
  function readRegular(target, limit) {
    const stat = statOrMissing(target);
    if (!stat) return null;
    observed = true;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw failure('unreadable', '桌面会话目录不是有效文件或超过大小限制。');
    const fd = fs.openSync(target, 'r');
    try {
      const opened = fs.fstatSync(fd);
      if (!sameFile(stat, opened)) throw failure('changed', '读取桌面会话目录时文件发生变化，已停止操作。');
      const bytes = Buffer.alloc(opened.size + 1);
      let count = 0;
      while (count < bytes.length) {
        const read = fs.readSync(fd, bytes, count, bytes.length - count, null);
        if (!read) break;
        count += read;
      }
      if (count !== opened.size || !sameFile(opened, fs.fstatSync(fd))) throw failure('changed', '读取桌面会话目录时文件发生变化，已停止操作。');
      const current = statOrMissing(target);
      if (!current || !sameFile(opened, current)) throw failure('changed', '读取桌面会话目录时文件发生变化，已停止操作。');
      return bytes.subarray(0, count).toString('utf8');
    } finally { fs.closeSync(fd); }
  }
  function load(ownLock = false) {
    try {
      if (!ownLock) assertUnlocked();
      const markerText = readRegular(marker, 16);
      const raw = readRegular(file, MAX_BYTES);
      if (!ownLock) assertUnlocked();
      if (markerText === null && raw === null && !observed) return { initialized: false, rows: [], raw: null };
      observed = true;
      if (markerText !== '1\n' || raw === null) throw failure('unreadable', '桌面会话目录或初始化标记缺失、损坏，桌面通道已关闭。');
      const data = JSON.parse(raw);
      if (!exactKeys(data, ['version', 'sessions']) || data.version !== 1 || !Array.isArray(data.sessions) || data.sessions.length > maxSessions)
        throw failure('unreadable', '桌面会话目录格式或记录数量无效，桌面通道已关闭。');
      const ids = new Set();
      const rows = data.sessions.map(value => {
        const row = record(value, ROW_KEYS);
        if (value.ownerQQ !== row.ownerQQ || value.selfUserId !== row.selfUserId
            || !['reserved', 'ready'].includes(value.phase) || ids.has(row.sessionId))
          throw failure('unreadable', '桌面会话目录包含无效阶段或重复身份，桌面通道已关闭。');
        ids.add(row.sessionId);
        return { ...row, phase: value.phase };
      });
      if (rows.some(row => ids.has(row.sourceSessionId))) throw failure('unreadable', '桌面会话与来源会话身份冲突，桌面通道已关闭。');
      return { initialized: true, rows, raw };
    } catch (error) {
      if (error?.code?.startsWith(PREFIX) && error.code !== PREFIX + 'identity-invalid') throw error;
      throw failure('unreadable', '桌面会话目录无法完整读取，桌面通道已关闭。');
    }
  }

  function mutate(update) {
    let lockFd; let temp = ''; let error;
    try {
      fs.mkdirSync(directory, { recursive: true });
      try { lockFd = fs.openSync(lock, 'wx', 0o600); } catch (cause) {
        if (cause.code === 'EEXIST') throw failure('locked', '桌面会话目录正在写入或锁未释放，已阻止保存。');
        throw cause;
      }
      const before = load(true);
      const next = update(before.rows);
      if (next !== null) {
        const serialized = JSON.stringify({ version: 1, sessions: next }) + '\n';
        if (next.length > maxSessions || Buffer.byteLength(serialized) > MAX_BYTES)
          throw failure('full', '桌面会话目录已满，旧身份不会自动淘汰。', '请管理员完整迁移并保留旧身份记录后再开启桌面任务。');
        temp = file + '.' + randomUUID() + '.tmp';
        const fd = fs.openSync(temp, 'wx', 0o600);
        try { fs.writeFileSync(fd, serialized); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        const current = load(true);
        if (before.raw !== current.raw || before.initialized !== current.initialized)
          throw failure('changed', '桌面会话目录被其他写入者修改，已阻止覆盖。');
        if (!before.initialized) {
          const markerFd = fs.openSync(marker, 'wx', 0o600);
          try { fs.writeFileSync(markerFd, '1\n'); fs.fsyncSync(markerFd); } finally { fs.closeSync(markerFd); }
          observed = true;
          syncDirectory(directory);
        }
        fs.renameSync(temp, file); temp = '';
        syncDirectory(directory);
        load(true);
      }
    } catch (cause) {
      error = cause?.code?.startsWith(PREFIX) ? cause : failure('write', '桌面会话身份保存失败，已阻止创建或恢复任务。');
    } finally {
      if (temp) { try { fs.unlinkSync(temp); } catch {} }
      if (lockFd !== undefined) {
        try { fs.closeSync(lockFd); } catch { error ||= failure('write', '桌面会话目录锁无法关闭，已停止操作。'); }
        try { fs.unlinkSync(lock); } catch { error ||= failure('write', '桌面会话目录锁无法释放，已停止操作。'); }
      }
    }
    if (error) throw error;
    return true;
  }

  function reserve(value) {
    const row = record(value);
    return mutate(rows => {
      const existing = rows.find(item => item.sessionId === row.sessionId);
      if (existing) {
        if (sameIdentity(existing, row)) return null;
        throw failure('conflict', '桌面会话身份已绑定其他来源，已阻止覆盖。', '生成新的独立会话身份后重试，不要复用其他主人、机器人或 QQ 会话的身份。');
      }
      if (rows.some(item => item.sessionId === row.sourceSessionId || item.sourceSessionId === row.sessionId))
        throw failure('conflict', '独立桌面会话与已登记的来源会话身份冲突。', '保留来源 QQ 会话身份，为桌面会话生成新的独立身份。');
      return [...rows, { ...row, phase: 'reserved' }];
    });
  }
  function confirm(id) {
    id = sessionId(id);
    return mutate(rows => {
      const index = rows.findIndex(row => row.sessionId === id);
      if (index < 0) throw failure('not-found', '桌面会话没有预留身份，不能确认创建。', '先保存新会话预留记录，再根据宿主正式创建回执确认。');
      if (rows[index].phase === 'ready') return null;
      return rows.map((row, position) => position === index ? { ...row, phase: 'ready' } : row);
    });
  }
  function find(value) {
    const wanted = identity(value);
    const { rows } = load();
    for (let index = rows.length - 1; index >= 0; index--)
      if (rows[index].phase === 'ready' && sameIdentity(rows[index], wanted)) return { ...rows[index] };
    return null;
  }
  function isSession(id) {
    id = sessionId(id);
    return load().rows.some(row => row.sessionId === id);
  }
  function list() { return load().rows.map(row => ({ ...row })); }
  function status() {
    try {
      const { initialized, rows } = load();
      const ready = rows.filter(row => row.phase === 'ready').length;
      return { ok: true, initialized, count: rows.length, reserved: rows.length - ready, ready, maxSessions };
    } catch (error) { return { ok: false, code: error.code, error: error.message, hint: error.hint }; }
  }
  return { find, reserve, confirm, isSession, list, status };
}
