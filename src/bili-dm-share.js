// Narrow, admin-authorized Bili DM -> QQ handoff. No network or config reads here.
// Once sending.json exists it is NEVER removed: ambiguity must not cause a second send.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PREFIX = '/api/bili/dm-share/';
const ID = /^[1-9][0-9]*$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const BV = /^BV[0-9A-Za-z]{10}$/;
const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const unknown = () => failure('DM_SHARE_UNKNOWN', 'QQ 发送结果不确定。', '先核对目标群和请求状态；不要自动重发或换请求编号。', false, 'unknown');
function failure(code, error, hint, retryable = false, status = 'failed') {
  return { ok: false, status, code, error, hint, retryable };
}
export function dmShareError(code, error, hint, retryable = true) {
  return Object.assign(new Error(error), { dmShareFailure: failure(code, error, hint, retryable) });
}
function blocked(error) {
  return error?.dmShareFailure || failure('DM_SHARE_PRE_SEND_BLOCKED', '发送前检查未完成，本次没有发送。', '检查 QQ 桥接设置后，用同一请求编号重试。', true);
}
function storageFailure() {
  return failure('DM_SHARE_STORE_UNAVAILABLE', '发送记录无法可靠读写。', '修复发送记录存储后查询原请求；请勿删除记录或更换请求编号重发。', false, 'unknown');
}
function validRequestId(value) {
  if (typeof value !== 'string' || !REQUEST_ID.test(value)) throw dmShareError('DM_SHARE_REQUEST_INVALID', '请求编号无效。', '提供 1–160 位字母、数字或 _ . : - 组成的稳定请求编号。', false);
  return value;
}
function positiveId(value, field) {
  const text = typeof value === 'string' ? value.trim() : Number.isSafeInteger(value) ? String(value) : '';
  if (!ID.test(text)) throw dmShareError('DM_SHARE_REQUEST_INVALID', field + ' 必须是正整数字符串。', '使用原始标识符；不要用不安全的大整数或空值。', false);
  return text;
}
function keysOnly(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key));
}
function boundedText(value, max, label, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw dmShareError('DM_SHARE_TEXT_INVALID', label + ' 为空或超过长度上限。', '标题最多 160 字，感想最多 600 字；保持单条简短文本。', false);
  // Text-only API: disallow other links, CQ segments, controls and local paths.
  if (/[\u0000-\u0009\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(value)
      || /(?:[a-z][a-z0-9+.-]*:\/\/|www\.|b23\.|bilibili\.(?:com|tv)|\[CQ:|[a-z]:[\\/]|\\\\|(?:^|\s)(?:\/|~\/|\.\.\/))/iu.test(value)) {
    throw dmShareError('DM_SHARE_TEXT_INVALID', label + ' 含链接、路径、消息段或控制字符。', '只提交视频标题与简短感想；视频链接由 BV 号生成。', false);
  }
  return value.trim();
}
function normalizeRequest(body) {
  if (!keysOnly(body, ['requestId', 'ownerMid', 'sourceSeq', 'groupId', 'video', 'commentary'])
      || !keysOnly(body.video, ['bvid', 'title', 'url'])) throw dmShareError('DM_SHARE_REQUEST_INVALID', '请求字段无效。', '只提交请求编号、主人 MID、私信序号、单个群号、视频和感想。', false);
  const requestId = validRequestId(body.requestId);
  const ownerMid = positiveId(body.ownerMid, 'ownerMid');
  const sourceSeq = positiveId(body.sourceSeq, 'sourceSeq');
  const groupId = positiveId(body.groupId, 'groupId');
  if (!Number.isSafeInteger(Number(groupId))) throw dmShareError('DM_SHARE_REQUEST_INVALID', 'QQ 群号超出安全整数范围。', '使用有效 QQ 群号。', false);
  const bvid = body.video.bvid;
  if (typeof bvid !== 'string' || !BV.test(bvid) || body.video.url !== 'https://www.bilibili.com/video/' + bvid) throw dmShareError('DM_SHARE_VIDEO_INVALID', '视频必须提供有效 BV 号与对应的标准 B 站链接。', '链接格式：https://www.bilibili.com/video/BVxxxxxxxxxx，不带查询参数。', false);
  const title = boundedText(body.video.title, 160, '标题');
  const commentary = boundedText(body.commentary, 600, '感想', true);
  const video = { bvid, title, url: body.video.url };
  const text = [title, video.url, commentary].filter(Boolean).join('\n');
  if (text.length > 800) throw dmShareError('DM_SHARE_TEXT_INVALID', '合并消息超过 800 字。', '缩短标题和感想后提交；不会拆成多条消息。', false);
  return { payload: { requestId, ownerMid, sourceSeq, groupId, video, commentary }, text };
}
function allowedIds(getAllowedGroups) {
  const values = getAllowedGroups();
  return [...new Set((Array.isArray(values) ? values : []).map((v) => String(v).trim())
    .filter((v) => ID.test(v) && Number.isSafeInteger(Number(v))))];
}
const normalizeName = (value) => String(value).normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
const validMessageId = (value) => (typeof value === 'string' || Number.isSafeInteger(value)) && /^-?[1-9][0-9]*$/.test(String(value));

/** Sync persistence boundary: exclusive files avoid process-local-only dedupe.
 * Partial/corrupt files fail closed. No latch expiry, cleanup, auto-retry or raw DM log.
 * io is injectable for disk failure tests. On Windows directory fsync is unavailable.
 */
export function createBiliDmShareStore({ root, io = fs, now = () => new Date().toISOString() }) {
  const dirFor = (requestId) => path.join(root, hash(validRequestId(requestId)));
  function readJson(file) {
    try {
      const value = JSON.parse(io.readFileSync(file, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid stored object');
      return value;
    }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  function syncDir(dir) {
    let fd;
    try { fd = io.openSync(dir, 'r'); io.fsyncSync(fd); }
    catch (error) { if (!['EPERM', 'EACCES', 'EISDIR', 'EINVAL', 'ENOTSUP'].includes(error.code)) throw error; }
    finally { if (fd !== undefined) io.closeSync(fd); }
  }
  function writeOnce(dir, name, value) {
    io.mkdirSync(dir, { recursive: true });
    let fd;
    try { fd = io.openSync(path.join(dir, name), 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
    try { io.writeFileSync(fd, JSON.stringify(value) + '\n'); io.fsyncSync(fd); }
    finally { io.closeSync(fd); }
    syncDir(dir);
    syncDir(root);
    return true;
  }
  function read(requestId) {
    const dir = dirFor(requestId);
    const binding = readJson(path.join(dir, 'request.json'));
    if (!binding) return null;
    if (binding.requestId !== requestId || !/^[a-f0-9]{64}$/.test(binding.fingerprint)) throw new Error('Invalid request binding');
    const receipt = readJson(path.join(dir, 'sent.json'));
    if (receipt && (!validMessageId(receipt.messageId) || !ID.test(receipt.groupId) || typeof receipt.groupName !== 'string' || !Number.isFinite(Date.parse(receipt.sentAt)))) throw new Error('Invalid send receipt');
    const sending = readJson(path.join(dir, 'sending.json'));
    if (sending && sending.requestId !== requestId) throw new Error('Invalid sending latch');
    const lastFailure = !receipt && !sending ? readJson(path.join(dir, 'blocked.json')) : null;
    if (lastFailure && (lastFailure.ok !== false || !lastFailure.code || !lastFailure.error || !lastFailure.hint || lastFailure.status !== 'failed')) throw new Error('Invalid blocked result');
    return { ...binding, receipt, sending: Boolean(sending), lastFailure };
  }
  return {
    read,
    bind(requestId, fingerprint) {
      writeOnce(dirFor(requestId), 'request.json', { requestId, fingerprint, createdAt: now() });
      const record = read(requestId);
      if (!record) throw new Error('Missing request binding');
      return record;
    },
    begin(requestId) { return writeOnce(dirFor(requestId), 'sending.json', { requestId, startedAt: now() }); },
    sent(requestId, receipt) {
      if (!writeOnce(dirFor(requestId), 'sent.json', receipt)) throw new Error('Receipt already exists');
    },
    blocked(requestId, result) {
      const dir = dirFor(requestId);
      const temp = path.join(dir, 'blocked-' + crypto.randomUUID() + '.tmp');
      let fd;
      try { fd = io.openSync(temp, 'wx', 0o600); io.writeFileSync(fd, JSON.stringify(result)); io.fsyncSync(fd); }
      finally { if (fd !== undefined) io.closeSync(fd); }
      io.renameSync(temp, path.join(dir, 'blocked.json'));
      syncDir(dir);
    },
  };
}
function recordResult(record) {
  if (record?.receipt) return { ok: true, status: 'sent', receipt: clone(record.receipt) };
  if (record?.sending) return unknown();
  return null;
}

/** authorize returns a synchronous guard captured before async work; reserveSend may
 * return a rollback used ONLY if sending was never claimed. Transport errors are unknown.
 */
export function createBiliDmShareService({ store, getOwnerMid, getAllowedGroups, getGroup, authorize,
  enqueue = (task) => task(), reserveSend = () => () => {}, transport, recordSent = () => {},
  now = () => new Date().toISOString() }) {
  function assertCurrent(payload) {
    const owner = String(getOwnerMid() ?? '').trim();
    if (!ID.test(owner) || owner !== payload.ownerMid) throw dmShareError('DM_SHARE_OWNER_MISMATCH', '私信发送者不是当前配置的 B 站主人。', '核对 B 站主人 MID；旧主人请求不能继续发送。', false);
    if (!allowedIds(getAllowedGroups).includes(payload.groupId)) throw dmShareError('DM_SHARE_GROUP_NOT_ALLOWED', '指定 QQ 群不在明确的群白名单中。', '请管理员确认 QQ 白名单，再用原请求重试。');
  }
  async function groupInfo(id) {
    let info;
    try { info = await getGroup(id); } catch { /* Metadata failures cannot pick a target. */ }
    if (!info || typeof info.name !== 'string' || !info.name.trim()) throw dmShareError('DM_SHARE_GROUPS_UNAVAILABLE', '无法完整确认白名单群信息。', '检查 QQ 网关连接后重新解析目标；不要猜测群名或改发其他群。');
    return { id, name: info.name.trim().slice(0, 160) };
  }
  async function resolve(target) {
    try {
      if (typeof target !== 'string' || !target.trim() || target.length > 160) throw dmShareError('DM_SHARE_TARGET_INVALID', '目标群名称或群号无效。', '提供一个完整群名或 QQ 群号。', false);
      const ids = allowedIds(getAllowedGroups);
      const name = normalizeName(target);
      if (ID.test(name)) {
        if (!ids.includes(name)) throw dmShareError('DM_SHARE_GROUP_NOT_ALLOWED', '指定 QQ 群不在明确的群白名单中。', '请先在 QQ 设置里添加目标群白名单。');
        const group = await groupInfo(name);
        if (!allowedIds(getAllowedGroups).includes(group.id)) throw dmShareError('DM_SHARE_GROUP_NOT_ALLOWED', '解析期间群白名单已变化。', '重新确认白名单后解析。');
        return { ok: true, group };
      }
      const groups = await Promise.all(ids.map(groupInfo));
      const current = allowedIds(getAllowedGroups);
      if (JSON.stringify(ids) !== JSON.stringify(current)) throw dmShareError('DM_SHARE_GROUPS_UNAVAILABLE', '解析期间群白名单已变化。', '重新解析目标群。');
      const matches = groups.filter((group) => normalizeName(group.name) === name);
      if (matches.length === 1) return { ok: true, group: matches[0] };
      if (matches.length > 1) return { ...failure('DM_SHARE_GROUP_AMBIGUOUS', '白名单中有多个同名群。', '请用明确的 QQ 群号选择一个群。'), candidates: matches };
      return { ...failure('DM_SHARE_GROUP_NOT_FOUND', '没有找到完全匹配的白名单群。', '核对完整群名或使用白名单里的 QQ 群号。'), candidates: groups };
    } catch (error) { return blocked(error); }
  }
  function status(requestId) {
    try {
      validRequestId(requestId);
      const record = store.read(requestId);
      return recordResult(record) || record?.lastFailure || failure(record ? 'DM_SHARE_NOT_STARTED' : 'DM_SHARE_NOT_FOUND', '此请求尚未提交 QQ 发送。', '确认原请求内容后，用同一请求编号提交。', true);
    } catch (error) { return error?.dmShareFailure || storageFailure(); }
  }
  async function send(body) {
    let payload, text, fingerprint;
    try {
      ({ payload, text } = normalizeRequest(body));
      // Include exact supplied fields: whitespace/type/target changes are NOT a retry.
      fingerprint = hash(JSON.stringify([body.requestId, body.ownerMid, body.sourceSeq, body.groupId,
        body.video.bvid, body.video.title, body.video.url, body.commentary]));
    } catch (error) { return blocked(error); }
    let record;
    try { record = store.bind(payload.requestId, fingerprint); } catch { return storageFailure(); }
    if (record.fingerprint !== fingerprint) return failure('DM_SHARE_REQUEST_CONFLICT', '此请求编号已绑定另一份发送内容或目标群。', '保持原请求不变并查询其状态；需要新操作时请由主人明确发起。');
    const previous = recordResult(record);
    if (previous) return previous;
    const failBeforeSend = (error) => {
      try {
        const latest = recordResult(store.read(payload.requestId));
        if (latest) return latest;
        const result = blocked(error);
        store.blocked(payload.requestId, result);
        return result;
      } catch { return storageFailure(); }
    };
    try {
      assertCurrent(payload);
      const guard = authorize(payload, text);
      const group = await groupInfo(payload.groupId);
      return await enqueue(async () => {
        let rollback;
        try {
          const latest = recordResult(store.read(payload.requestId));
          if (latest) return latest;
          assertCurrent(payload);
          guard();
          rollback = reserveSend(payload, text);
        } catch (error) { return failBeforeSend(error); }
        try {
          if (!store.begin(payload.requestId)) { rollback?.(); return recordResult(store.read(payload.requestId)) || unknown(); }
        } catch { rollback?.(); return storageFailure(); }
        // No await between final guards and durable begin. From here on, NEVER retry.
        try {
          const result = await transport(payload.groupId, text);
          if (!validMessageId(result?.message_id)) return unknown();
          const receipt = { messageId: String(result.message_id), groupId: group.id, groupName: group.name, sentAt: now() };
          try { store.sent(payload.requestId, receipt); } catch { return storageFailure(); }
          // Receipt is authoritative even if updating optional local chat history fails.
          try { await recordSent(payload, text, receipt); } catch {}
          return { ok: true, status: 'sent', receipt };
        } catch { return unknown(); }
      });
    } catch (error) { return failBeforeSend(error); }
  }
  return { resolve, send, status };
}

// Invoked only after the bridge's existing console authentication / CSRF checks.
export async function handleBiliDmShareRoute(service, req, url, { readBody, sendJson }) {
  if (!url.pathname.startsWith(PREFIX)) return false;
  if (req.headers['x-agent-token'] !== undefined || req.headers['x-agent-call'] !== undefined) {
    sendJson(failure('DM_SHARE_CONSOLE_ONLY', '此交接接口仅控制台管理员可用。', '通过已认证的 B 站私信交接流程操作；QQ 会话令牌无权调用。'), 403);
    return true;
  }
  try {
    let result;
    if (req.method === 'POST' && url.pathname === PREFIX + 'resolve') result = await service.resolve((await readBody()).target);
    else if (req.method === 'POST' && url.pathname === PREFIX + 'send') result = await service.send(await readBody());
    else if (req.method === 'GET' && url.pathname === PREFIX + 'status') result = service.status(url.searchParams.get('requestId'));
    else { sendJson(failure('DM_SHARE_ROUTE_INVALID', '交接接口或方法无效。', '使用 resolve/send POST 或 status GET。'), 404); return true; }
    sendJson(result, result.ok ? 200 : result.status === 'unknown' ? 409 : result.retryable ? 503 : 400);
  } catch { sendJson(failure('DM_SHARE_REQUEST_INVALID', '无法读取交接请求。', '检查 JSON 请求内容后查询原请求状态。'), 400); }
  return true;
}
