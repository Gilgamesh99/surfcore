// The task owns its workspace. Only the bridge holds the accepted bytes and the QQ destination.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';

const MIB = 1024 * 1024;
const MAX_MANIFEST = 64 * 1024;
const MAX_FILE = 32 * MIB;
const MAX_TOTAL = 64 * MIB;
const MAX_FILES = 32;
const accepted = new WeakMap();
const fixManifest = '请在任务工作区修正 surfcore-result.json 和 deliverables/，重新验收成品。';

function invalid(code, message, hint = fixManifest) {
  return Object.assign(new Error(message), { code, hint });
}

function destination(key) {
  const match = typeof key === 'string' && /^(group|private):([1-9][0-9]*)$/u.exec(key);
  const id = match && Number(match[2]);
  if (!Number.isSafeInteger(id) || id <= 0 || key !== match[1] + ':' + id) return null;
  return { kind: match[1], id };
}

function artifactPath(input) {
  if (typeof input !== 'string' || input.length > 1024) throw invalid('CODING_FILE_PATH', '成品相对路径无效。');
  const parts = input.replaceAll('\\', '/').split('/');
  // Windows aliases, alternate data streams, DOS devices and bidirectional controls can mask the actual name.
  const unsafe = (s) => !s || s === '.' || s === '..' || s !== s.trim() || s.endsWith('.') || !s.isWellFormed()
    || Buffer.byteLength(s) > 255 || /[<>:"|?*\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(s)
    || /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[0-9¹²³])(?:[.]|$)/iu.test(s);
  if (parts.length > 32 || parts.some(unsafe)) throw invalid('CODING_FILE_PATH', '成品路径含无效、保留或含糊的文件名。');
  return parts.join('/');
}

function parseManifest(bytes) {
  let manifest;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw invalid('CODING_MANIFEST_INVALID', '成品清单必须是有效的 UTF-8 JSON。'); }
  const files = manifest?.files;
  const checks = manifest?.checks;
  if (!Array.isArray(files) || !files.length || files.length > MAX_FILES || !Array.isArray(checks)
      || !checks.length || checks.length > 64 || Object.keys(manifest).some(k => k !== 'checks' && k !== 'files')
      || checks.some(s => typeof s !== 'string' || !s.trim() || s.length > 2048 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(s))) {
    throw invalid('CODING_MANIFEST_INVALID', '清单需列出 1–32 个成品和 1–64 条实际验收结果，每条结果最多 2048 字符。');
  }
  const paths = files.map(artifactPath);
  const names = paths.map(p => path.posix.basename(p).normalize('NFKC').toUpperCase());
  if (new Set(names).size !== names.length) throw invalid('CODING_FILE_DUPLICATE', '清单包含重复的成品或 QQ 中会重名的附件。');
  return { paths, checks: checks.map(s => s.trim()) };
}

function changed() { return invalid('CODING_FILE_CHANGED', '验收期间工作区内容发生变动。'); }

function sameVersion(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.nlink === b.nlink && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

async function checkedEntry(filePath, directory) {
  const st = await lstat(filePath, { bigint: true });
  if (!(directory ? st.isDirectory() : st.isFile() && st.nlink === 1n)
      || path.relative(filePath, await realpath(filePath)) !== '') {
    throw invalid('CODING_FILE_UNSAFE', '工作区、清单和成品路径必须对应实际目录或普通文件，不得经过链接。');
  }
  return st;
}

async function readBounded(filePath, limit, verifiedMs) {
  const st = await checkedEntry(filePath, false);
  function assertVersion(current) {
    if (verifiedMs !== undefined && (current.mtimeNs / 1_000_000n > verifiedMs || current.ctimeNs / 1_000_000n > verifiedMs)) {
      throw invalid('CODING_FILE_CHANGED_AFTER_CHECK', '成品在宿主 TAP 验收后发生了变更。', '请对当前成品重新运行验收测试，通过后更新成品清单。');
    }
    if (!sameVersion(st, current)) throw changed();
  }
  // Use the opened object throughout. O_NONBLOCK also avoids hanging if an entry becomes a FIFO.
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    assertVersion(await handle.stat({ bigint: true }));
    if (st.size < 1n || st.size > BigInt(limit)) {
      throw invalid('CODING_FILE_SIZE', '文件为空或超过读取预算。', '清单最多 64 KiB，成品每份最多 32 MiB、合计最多 64 MiB。请调整后重新验收。');
    }
    const bytes = Buffer.allocUnsafe(Number(st.size));
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw changed();
      offset += bytesRead;
    }
    assertVersion(await handle.stat({ bigint: true }));
    assertVersion(await checkedEntry(filePath, false));
    return bytes;
  } finally { await handle.close(); }
}

/** Metadata can be persisted. On recovery re-read, match relativePath/name/size/sha256/originKey, then upload the fresh file object. */
export async function readCodingDelivery(workspace, { originKey = null, verifiedAt } = {}) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || workspace.includes('\0')) {
    throw invalid('CODING_WORKSPACE_INVALID', '任务工作区必须是绝对路径。');
  }
  if (originKey !== null && !destination(originKey)) throw invalid('CODING_ORIGIN_INVALID', '任务来源会话无效。', '请检查创建任务时保存的群号或私聊账号。');
  if (verifiedAt !== undefined && (!Number.isSafeInteger(verifiedAt) || verifiedAt <= 0)) {
    throw invalid('CODING_VERIFIED_AT_INVALID', '宿主 TAP 验收时间无效。', '请从宿主成功验收事件取得正整数 Unix 毫秒时间，再读取成品。');
  }
  const verifiedMs = verifiedAt === undefined ? undefined : BigInt(verifiedAt);
  const root = path.resolve(workspace);
  try {
    const workspaceStat = await checkedEntry(root, true);
    const manifestPath = path.join(root, 'surfcore-result.json');
    const { paths, checks } = parseManifest(await readBounded(manifestPath, MAX_MANIFEST));
    const wanted = new Set(paths);
    const dirs = new Set();
    for (const relative of paths) {
      for (let dir = path.posix.dirname(relative); dir !== '.'; dir = path.posix.dirname(dir)) dirs.add(dir);
    }
    if (paths.some(p => dirs.has(p))) throw invalid('CODING_FILE_PATH', '同一路径被同时列为目录和成品。');

    const batch = { originKey };
    const files = new Map();
    let budget = MAX_TOTAL;
    async function visit(directory, prefix) {
      const before = await checkedEntry(directory, true);
      // Iterate rather than materializing a directory of unbounded size. Unexpected entries fail immediately.
      for await (const entry of await opendir(directory)) {
        const relative = prefix + entry.name;
        const absolute = path.join(directory, entry.name);
        if (dirs.has(relative)) { await visit(absolute, relative + '/'); continue; }
        if (!wanted.has(relative)) throw invalid('CODING_FILE_UNEXPECTED', 'deliverables/ 中存在清单以外的文件或目录。');
        const bytes = await readBounded(absolute, Math.min(budget, MAX_FILE), verifiedMs);
        budget -= bytes.length;
        const file = Object.freeze({ name: entry.name, path: absolute, relativePath: relative, size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'), originKey });
        // SnowLuma stageSourceToDisk accepts inline bytes for both upload actions; no mutable path crosses the gateway.
        accepted.set(file, { source: 'base64://' + bytes.toString('base64'), batch, attempt: null });
        files.set(relative, file);
      }
      if (!sameVersion(before, await checkedEntry(directory, true))) throw changed();
    }
    await visit(path.join(root, 'deliverables'), '');
    if (files.size !== paths.length) throw invalid('CODING_FILE_MISSING', '清单中的成品未全部找到。');
    if (!sameVersion(workspaceStat, await checkedEntry(root, true))) throw changed();
    return { checks, files: paths.map(p => files.get(p)) };
  } catch (error) {
    if (error?.hint) throw error;
    throw invalid('CODING_DELIVERY_UNREADABLE', '无法读取任务清单或成品目录（' + (error?.code || 'I/O') + '）。');
  }
}

function rejected(code, error, hint) { return { ok: false, status: 'rejected', code, error, hint }; }
function unknown() {
  return { ok: false, status: 'unknown', code: 'CODING_UPLOAD_UNKNOWN', error: '未能确认 QQ 附件是否已经发布。',
    hint: '请到任务发起的 QQ 会话核对附件，保留现有发送记录，避免重复上传。' };
}

function uploadFailure(response, kind) {
  // Action-failed 100 also covers exceptions *after* upload/publication. Only known ingress or QQ refusal is definite.
  const wording = typeof response?.wording === 'string' ? response.wording : '';
  const schemaRejected = response?.retcode === 1400 && /^(?:group_id|user_id|file|name|folder|folder_id|upload_file):/u.test(wording);
  const uploadRefused = wording.startsWith(kind + ' file upload failed: code=') && / failed: code=-?[1-9][0-9]* msg=/u.test(wording);
  if (response?.status === 'failed' && ([401, 403, 1401, 1404].includes(response.retcode) || schemaRejected
      || (response.retcode === 100 && (wording === 'OneBot instance is shutting down' || uploadRefused)))) {
    return rejected('CODING_UPLOAD_REJECTED', 'QQ 网关拒绝了附件上传（' + response.retcode + '）。', '请检查原会话附件权限、网关认证与版本后重新确认交付。');
  }
  return unknown();
}

/** Dispatch one official SDK action to the task's original conversation. Persist sending before calling this function. */
export async function uploadCodingFile({ onebot, originKey, file, assertCurrent } = {}) {
  const target = destination(originKey);
  const seal = accepted.get(file);
  if (!target || !seal || (seal.batch.originKey !== null && seal.batch.originKey !== originKey)) {
    return rejected('CODING_UPLOAD_BINDING', '来源会话或已验收文件不匹配。', '请使用该任务保存的原会话和重新核验过的文件描述。');
  }
  seal.batch.originKey = originKey;
  if (seal.attempt) return seal.attempt;
  // Reserve synchronously before invoking even an injected async authorization check.
  seal.attempt = Promise.resolve().then(async () => {
    if (typeof onebot?.request !== 'function') return rejected('CODING_UPLOAD_UNAVAILABLE', 'QQ 网关缺少正式附件接口。', '请检查 SnowLuma SDK 版本和桥接连接。');
    try {
      if (assertCurrent !== undefined) {
        const decision = await assertCurrent({ originKey, file });
        if (decision !== undefined && decision !== true && decision?.ok !== true) throw new Error('revoked');
      }
    } catch { return rejected('CODING_UPLOAD_AUTH', '发送前任务授权检查未通过。', '请检查原会话授权、白名单和任务状态。'); }
    if (onebot.isConnected === false) return rejected('CODING_UPLOAD_OFFLINE', 'QQ 网关当前未连接。', '请等待桥接连通后检查原任务。');
    try {
      const recipient = target.kind === 'group' ? { group_id: target.id } : { user_id: target.id };
      const action = target.kind === 'group' ? 'upload_group_file' : 'upload_private_file';
      const response = await onebot.request(action, { ...recipient, file: seal.source, name: file.name, upload_file: true });
      if (response?.status !== 'ok' || response.retcode !== 0) return uploadFailure(response, target.kind);
      const id = response.data?.file_id;
      if (typeof id !== 'string' || !id.trim() || id.length > 1024 || /[\u0000-\u001f\u007f]/u.test(id)) return unknown();
      return { ok: true, status: 'sent', fileId: id };
    } catch (error) { return uploadFailure(error?.response, target.kind); }
  });
  const result = await seal.attempt;
  if (result.status === 'rejected') seal.attempt = null;
  else seal.source = null;
  return result;
}
