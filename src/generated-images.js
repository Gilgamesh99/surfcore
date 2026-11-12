// One bridge-owned service per dedicated root. No prompt/token/path is returned or persisted.
// Expired assets stay inert: the finite ledger refuses new work when full; it never deletes assets.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const DAY = 86_400_000;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ENTRIES = 512;
const STATE_BYTES = 1024 * 1024;
const ID = /^[a-f0-9]{48}$/;
const HASH = /^[a-f0-9]{64}$/;
const SIZES = new Set(['1024x1024', '1536x1024', '1024x1536']);
const ERRORS = {
  IMAGE_DISABLED: [403, 'QQ 图片生成尚未启用。', '请在设置页开启 QQ 图片生成功能后再试。'],
  IMAGE_BAD_REQUEST: [400, '图片请求参数无效。', '请提供不超过 2000 字的非空描述、允许的图片尺寸，以及有效的图片或消息编号。'],
  IMAGE_NOT_ALLOWED: [403, '当前图片会话已失去授权。', '请回到仍获授权的会话，使用该会话当前的令牌重新操作。'],
  IMAGE_NOT_FOUND: [404, '当前会话无法使用这张图片。', '请使用本会话生成的图片编号和生成时的会话令牌。'],
  IMAGE_EXPIRED: [410, '这张生成图片已过期。', '请重新请求生成图片；过期文件不能继续读取或发送。'],
  IMAGE_BUSY: [429, '图片生成并发名额已占用。', '请等待当前生成任务结束后再试。'],
  IMAGE_COOLDOWN: [429, '当前会话生成图片过于频繁。', '请等待设置中的图片生成冷却时间结束后再试。'],
  IMAGE_DAILY_LIMIT: [429, '今日图片生成额度已用完。', '请等待本机时间的次日，或请管理员检查图片额度设置。'],
  IMAGE_STORAGE_FULL: [507, '生成图片存储条目已达到上限。', '请管理员停止桥接后归档专用图片目录，并保留当天额度记录。'],
  IMAGE_STORAGE: [503, '图片状态无法安全读取或保存。', '请管理员检查专用图片目录的权限和可用空间后重启桥接。'],
  IMAGE_STORAGE_BUSY: [503, '已有其他图片服务占用此目录。', '同一个图片目录只能运行一个桥接实例；请先停止之前的实例。'],
  IMAGE_STATE_INVALID: [503, '图片生成账本损坏或不完整。', '请管理员检查并归档账本；不要清空账本来绕过生成额度。'],
  IMAGE_UNSAFE_PATH: [400, '图片存储路径不安全。', '请使用不包含符号链接或目录联接的专用真实目录。'],
  IMAGE_UNSAFE_FILE: [400, '生成结果不是安全的普通文件。', '请管理员检查图片目录是否存在链接文件或被替换的目录。'],
  IMAGE_OUTPUT_MISSING: [502, '图片服务未生成约定的输出文件。', '请先检查图片适配器配置，再决定是否发起另一次生成。'],
  IMAGE_TOO_LARGE: [413, '生成图片超过允许的文件大小。', '请选择更小的图片，或在设置页检查图片字节上限。'],
  IMAGE_INVALID_CONTENT: [422, '生成结果不是支持的图片格式。', '请将图片服务配置为每次生成一张 PNG、JPEG 或 WebP 图片。'],
  IMAGE_TAMPERED: [409, '生成图片在校验后发生了变化。', '请勿发送此文件，并请管理员检查专用图片目录。'],
  IMAGE_GENERATION_FAILED: [502, '图片服务未能完成生成。', '请检查图片服务配置及可用性；重新生成可能再次计费。'],
  IMAGE_BACKEND_UNAVAILABLE: [503, '无法连接图片生成后端。', '请检查 Magpie 图片服务是否安装、已启用且能够连接。'],
  IMAGE_BACKEND_FAILED: [502, '图片生成后端报告失败。', '请检查 Magpie 的图片模型和凭据配置；确认后再决定是否重新生成。'],
  IMAGE_BACKEND_INCOMPATIBLE: [502, '图片生成后端接口不兼容。', '请更新 Magpie 图片插件，并检查生成工具及结果查询工具是否可用。'],
  IMAGE_TIMEOUT: [504, '图片生成超过等待时限。', '请检查图片服务是否可用；此次尝试仍计入今日额度。'],
  IMAGE_INTERRUPTED: [409, '图片生成被服务重启或停止中断。', '系统没有自动重试；只有接受再次计费时才重新请求生成。'],
  IMAGE_CLOSED: [503, '图片服务已停止。', '请等待桥接重启后再请求图片。'],
  IMAGE_NOT_READY: [409, '生成图片尚未就绪。', '请先查询生成结果，待图片就绪后再读取或发送。'],
  IMAGE_CONFIG: [503, '无法读取图片生成设置。', '请管理员检查图片生成配置后再试。'],
};
class ImageError extends Error {
  constructor(code) {
    const [statusCode, error, hint] = ERRORS[code] || ERRORS.IMAGE_STORAGE;
    super(error);
    Object.assign(this, { code: ERRORS[code] ? code : 'IMAGE_STORAGE', error, hint, statusCode });
  }
}
const fail = code => { throw new ImageError(code); };
const BACKEND_CODES = new Set(['IMAGE_BACKEND_UNAVAILABLE', 'IMAGE_BACKEND_FAILED', 'IMAGE_BACKEND_INCOMPATIBLE']);
const hash = value => createHash('sha256').update(value).digest('hex');
const sameHash = (a, b) => HASH.test(a || '') && HASH.test(b || '') && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
const clamp = (value, fallback, min, max) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const identity = stat => `${stat.dev}:${stat.ino}`;
const unchanged = (a, b) => identity(a) === identity(b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;
const regular = stat => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
const validTime = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000 - DAY;
const validMessageId = value => (typeof value === 'string' && /^-?[1-9]\d{0,19}$/.test(value)) || (Number.isSafeInteger(value) && value !== 0);
const localDay = stamp => { const date = new Date(stamp); return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`; };

export function normalizeGeneratedImageConfig(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  return {
    enabled: value.enabled === true,
    dailyPerKey: clamp(value.dailyPerKey, 3, 0, 100), dailyGlobal: clamp(value.dailyGlobal, 12, 0, 1000),
    cooldownMs: clamp(value.cooldownMs, 60_000, 0, DAY), concurrencyGlobal: clamp(value.concurrencyGlobal, 2, 1, 2),
    concurrencyPerKey: 1, retentionMs: clamp(value.retentionMs, DAY, 1, DAY), maxBytes: clamp(value.maxBytes, MAX_BYTES, 1, MAX_BYTES),
    maxEntries: clamp(value.maxEntries, 128, 1, MAX_ENTRIES), generationTimeoutMs: clamp(value.generationTimeoutMs, 300_000, 10, 600_000),
  };
}

// Structural signature checks, not a general image decoder. All reads remain byte bounded.
function imageMime(buffer) {
  const dimensions = (width, height) => width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 16_777_216;
  if (buffer.length >= 45 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let offset = 8, data = false, header = false;
    while (offset + 12 <= buffer.length) {
      const length = buffer.readUInt32BE(offset), type = buffer.toString('ascii', offset + 4, offset + 8);
      if (length > buffer.length - offset - 12) break;
      if (!header) {
        if (type !== 'IHDR' || length !== 13 || !dimensions(buffer.readUInt32BE(offset + 8), buffer.readUInt32BE(offset + 12))) break;
        header = true;
      } else if (type === 'IHDR') break;
      if (type === 'IDAT' && length > 0) data = true;
      offset += length + 12;
      if (type === 'IEND') return data && length === 0 && offset === buffer.length ? 'image/png' : null;
    }
  }
  if (buffer.length >= 16 && buffer[0] === 255 && buffer[1] === 216 && buffer.at(-2) === 255 && buffer.at(-1) === 217) {
    let offset = 2, frame = false;
    while (offset + 4 < buffer.length && buffer[offset] === 255) {
      while (buffer[offset] === 255) offset++;
      const marker = buffer[offset++];
      if (marker === 0 || marker === 216 || marker === 217 || marker === 1 || (marker >= 208 && marker <= 215)) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length - 2) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (length < 8 || !dimensions(buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3))) break;
        frame = true;
      }
      if (marker === 218) return frame && length >= 6 && offset + length < buffer.length - 2 ? 'image/jpeg' : null;
      offset += length;
    }
  }
  if (buffer.length >= 20 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' && buffer.readUInt32LE(4) === buffer.length - 8) {
    let offset = 12, image = false;
    while (offset + 8 <= buffer.length) {
      const type = buffer.toString('ascii', offset, offset + 4), length = buffer.readUInt32LE(offset + 4), start = offset + 8;
      if (length > buffer.length - start) break;
      if (type === 'VP8 ' && length >= 10 && buffer.subarray(start + 3, start + 6).equals(Buffer.from([157, 1, 42]))) {
        image = dimensions(buffer.readUInt16LE(start + 6) & 16383, buffer.readUInt16LE(start + 8) & 16383);
      } else if (type === 'VP8L' && length >= 5 && buffer[start] === 47) {
        const bits = buffer.readUInt32LE(start + 1);
        image = dimensions((bits & 16383) + 1, ((bits >>> 14) & 16383) + 1);
      }
      offset = start + length + (length & 1);
      if (offset === buffer.length) return image ? 'image/webp' : null;
    }
  }
  return null;
}

/**
 * getConfig returns socialV2.images. assertAllowed is mandatory on start/result and
 * may be async: throw, false, or {ok:false} denies; a void return allows.
 * generate({prompt,size,path},{signal,assertAllowed}) must write exactly path, one
 * image, and settle only after the file is complete. It must honor abort, never
 * follow links, and await assertAllowed() immediately before a paid provider call.
 * That guard also rechecks pinned directories and rejects existing fixed outputs.
 * Defaults: disabled; dailyPerKey 3 / dailyGlobal 12 (local day), cooldownMs 60000,
 * concurrencyGlobal 2 / concurrencyPerKey 1, retentionMs 24h, maxBytes 10MiB,
 * maxEntries 128 (all attempts, including expired), generationTimeoutMs 300000.
 * Numeric configuration is clamped; concurrency cannot exceed 2/1, retention 24h,
 * maxBytes 10MiB, maxEntries 512, timeout 10min, daily limits 100/1000.
 * recordSending atomically claims delivery; only claimed:true permits transport.
 * Uncertain sends remain unknown, including sending markers found after restart.
 */
export function createGeneratedImageService({ root, getConfig, generate, now = Date.now } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0') || root.split(/[\\/]/).includes('..') || path.resolve(root) === path.parse(root).root) fail('IMAGE_UNSAFE_PATH');
  if (typeof getConfig !== 'function' || typeof generate !== 'function' || typeof now !== 'function') fail('IMAGE_CONFIG');
  root = path.resolve(root);
  const ledgerPath = path.join(root, 'ledger.json'), nextPath = path.join(root, 'ledger.next'), lockPath = path.join(root, 'service.lock');
  const nonce = randomBytes(24).toString('hex'), entries = new Map(), jobs = new Map();
  let chain = Promise.resolve(), initialized = false, closed = false, lockHeld = false, rootIdentity, clock = 0, fatal;
  const serial = work => {
    const promise = chain.then(work);
    chain = promise.catch(() => {});
    return promise;
  };
  const guarded = async work => {
    try { return await work(); } catch (error) { throw error instanceof ImageError ? error : new ImageError('IMAGE_STORAGE'); }
  };
  const time = () => {
    const value = now();
    if (!validTime(value)) fail('IMAGE_CONFIG');
    return (clock = Math.max(clock, value));
  };
  const config = () => {
    let value;
    try { value = getConfig() || {}; } catch { fail('IMAGE_CONFIG'); }
    if (typeof value !== 'object' || typeof value.then === 'function') fail('IMAGE_CONFIG');
    return normalizeGeneratedImageConfig(value);
  };
  const enabled = () => { const cfg = config(); if (!cfg.enabled) fail('IMAGE_DISABLED'); return cfg; };
  const authorize = async callback => {
    if (typeof callback !== 'function') fail('IMAGE_NOT_ALLOWED');
    try { const result = await callback(); if (result === false || result?.ok === false) fail('IMAGE_NOT_ALLOWED'); }
    catch { fail('IMAGE_NOT_ALLOWED'); }
  };
  const owner = input => {
    if (!input || typeof input.key !== 'string' || !/^(group|private):[1-9]\d{0,19}$/.test(input.key) || typeof input.token !== 'string' || !input.token.trim() || input.token.length > 4096) fail('IMAGE_NOT_ALLOWED');
    return { keyHash: hash(input.key), tokenHash: hash(input.token) };
  };
  async function directory(target, create = false) {
    const base = path.parse(target).root;
    let current = base, stat = await fs.lstat(base);
    for (const part of target.slice(base.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try { stat = await fs.lstat(current); }
      catch (error) {
        if (!create || error.code !== 'ENOENT') throw error;
        try { await fs.mkdir(current, { mode: 0o700 }); } catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
        stat = await fs.lstat(current);
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail('IMAGE_UNSAFE_PATH');
    }
    if (!samePath(await fs.realpath(target), target)) fail('IMAGE_UNSAFE_PATH');
    return stat;
  }
  async function checkRoot() {
    const stat = await directory(root);
    if (identity(stat) !== rootIdentity) fail('IMAGE_UNSAFE_PATH');
  }
  async function safeRead(file, limit) {
    await checkRoot();
    await directory(path.dirname(file));
    const before = await fs.lstat(file);
    if (!regular(before) || !samePath(await fs.realpath(file), file)) fail('IMAGE_UNSAFE_FILE');
    if (before.size > limit) fail('IMAGE_TOO_LARGE');
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const opened = await handle.stat();
      if (!regular(opened)) fail('IMAGE_UNSAFE_FILE');
      if (!unchanged(before, opened)) fail('IMAGE_TAMPERED');
      const buffer = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const part = await handle.read(buffer, length, buffer.length - length, length);
        if (!part.bytesRead) break;
        length += part.bytesRead;
      }
      const after = await handle.stat(), named = await fs.lstat(file);
      await checkRoot();
      await directory(path.dirname(file));
      if (!regular(named) || !unchanged(opened, after) || !unchanged(after, named) || length !== before.size) fail('IMAGE_TAMPERED');
      return { buffer: buffer.subarray(0, length), stat: after };
    } finally { await handle.close(); }
  }
  async function acquireLock() {
    for (let attempt = 0; attempt < 2; attempt++) {
      let handle;
      try { handle = await fs.open(lockPath, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = await safeRead(lockPath, 512);
        let old;
        try { old = JSON.parse(existing.buffer.toString('utf8')); } catch { fail('IMAGE_STORAGE_BUSY'); }
        if (!Number.isSafeInteger(old.pid) || old.pid < 1 || !ID.test(old.nonce || '')) fail('IMAGE_STORAGE_BUSY');
        try { process.kill(old.pid, 0); fail('IMAGE_STORAGE_BUSY'); }
        catch (probe) { if (probe.code !== 'ESRCH') fail('IMAGE_STORAGE_BUSY'); }
        if (!unchanged(existing.stat, await fs.lstat(lockPath))) fail('IMAGE_STORAGE_BUSY');
        await fs.unlink(lockPath); // Only the verified stale service lock, never an asset.
        continue;
      }
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, nonce })); await handle.sync(); lockHeld = true; }
      finally { await handle.close(); }
      return;
    }
    fail('IMAGE_STORAGE_BUSY');
  }
  async function releaseLock() {
    if (!lockHeld) return;
    const existing = await safeRead(lockPath, 512);
    if (JSON.parse(existing.buffer.toString('utf8')).nonce !== nonce) fail('IMAGE_STORAGE_BUSY');
    if (!unchanged(existing.stat, await fs.lstat(lockPath))) fail('IMAGE_STORAGE_BUSY');
    await fs.unlink(lockPath);
    lockHeld = false;
  }
  async function persist() {
    try {
      await checkRoot();
      try { if (!regular(await fs.lstat(ledgerPath))) fail('IMAGE_UNSAFE_FILE'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const payload = JSON.stringify({ version: 1, clockMs: clock, entries: [...entries.values()] });
      if (Buffer.byteLength(payload) > STATE_BYTES) fail('IMAGE_STORAGE_FULL');
      const handle = await fs.open(nextPath, 'wx', 0o600);
      try {
        await handle.writeFile(payload);
        await handle.sync();
        if (!unchanged(await handle.stat(), await fs.lstat(nextPath))) fail('IMAGE_UNSAFE_FILE');
        await checkRoot();
        await fs.rename(nextPath, ledgerPath);
      } finally { await handle.close(); }
      if (process.platform !== 'win32') {
        const dir = await fs.open(root, constants.O_RDONLY);
        try { await dir.sync(); } finally { await dir.close(); }
      }
    } catch (error) { fatal = error instanceof ImageError ? error : new ImageError('IMAGE_STORAGE'); throw fatal; }
  }
  function validEntry(entry) {
    return entry && ID.test(entry.imageId || '') && HASH.test(entry.keyHash || '') && HASH.test(entry.tokenHash || '') && HASH.test(entry.requestHash || '')
      && ['pending', 'ready', 'failed'].includes(entry.status) && SIZES.has(entry.size) && validTime(entry.createdAt) && validTime(entry.expiresAt)
      && entry.expiresAt > entry.createdAt && entry.expiresAt - entry.createdAt <= DAY && typeof entry.directoryIdentity === 'string'
      && Number.isSafeInteger(entry.maxBytes) && entry.maxBytes > 0 && entry.maxBytes <= MAX_BYTES
      && (entry.status !== 'failed' || Object.hasOwn(ERRORS, entry.code))
      && (entry.status !== 'ready' || (HASH.test(entry.contentHash || '') && ['image/png', 'image/jpeg', 'image/webp'].includes(entry.mimeType) && Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= entry.maxBytes))
      && (!entry.delivery || (entry.status === 'ready' && ['sending', 'unknown', 'sent'].includes(entry.delivery.status) && (entry.delivery.status !== 'sent' || validMessageId(entry.delivery.messageId))));
  }
  async function initialize() {
    if (closed) fail('IMAGE_CLOSED');
    if (fatal) throw fatal;
    if (initialized) return;
    try {
      rootIdentity = identity(await directory(root, true));
      await acquireLock();
      let stored;
      try { stored = (await safeRead(ledgerPath, STATE_BYTES)).buffer; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stored) {
        let state;
        try { state = JSON.parse(stored.toString('utf8')); } catch { fail('IMAGE_STATE_INVALID'); }
        if (state.version !== 1 || !validTime(state.clockMs) || !Array.isArray(state.entries) || state.entries.length > MAX_ENTRIES) fail('IMAGE_STATE_INVALID');
        clock = state.clockMs;
        for (const entry of state.entries) {
          if (!validEntry(entry) || entries.has(entry.imageId) || entry.createdAt > clock) fail('IMAGE_STATE_INVALID');
          if (entry.status === 'pending') Object.assign(entry, { status: 'failed', code: 'IMAGE_INTERRUPTED' });
          if (entry.delivery?.status === 'sending') entry.delivery = { status: 'unknown' };
          entries.set(entry.imageId, entry);
        }
      } else if ((await fs.readdir(root)).some(name => name !== 'service.lock')) fail('IMAGE_STATE_INVALID');
      await persist(); // Recovery is durable before any new paid call.
      initialized = true;
    } catch (error) {
      fatal = error instanceof ImageError ? error : new ImageError('IMAGE_STORAGE');
      try { await releaseLock(); } catch { /* Preserve the original safe failure; stale locks are fail-closed. */ }
      throw fatal;
    }
  }
  function lookup(input) {
    const binding = owner(input);
    if (!ID.test(input.imageId || '')) fail('IMAGE_NOT_FOUND');
    const entry = entries.get(input.imageId);
    if (!entry || !sameHash(entry.keyHash, binding.keyHash) || !sameHash(entry.tokenHash, binding.tokenHash)) fail('IMAGE_NOT_FOUND');
    if (time() >= entry.expiresAt) fail('IMAGE_EXPIRED');
    return entry;
  }
  const output = entry => {
    const base = { ok: entry.status !== 'failed', status: entry.status, imageId: entry.imageId };
    if (entry.status === 'failed') {
      const error = new ImageError(entry.code);
      return { ...base, code: error.code, error: error.error, hint: error.hint, statusCode: error.statusCode };
    }
    if (entry.status === 'ready') {
      Object.assign(base, { bytes: entry.bytes, mimeType: entry.mimeType });
      if (entry.delivery) base.delivery = { status: entry.delivery.status };
      if (entry.delivery?.status === 'sent') {
        base.delivery.messageId = entry.delivery.messageId;
        base.sent = { messageId: entry.delivery.messageId };
      }
    }
    return base;
  };
  async function entryDirectory(entry) {
    await checkRoot();
    const target = path.join(root, entry.imageId);
    if (identity(await directory(target)) !== entry.directoryIdentity) fail('IMAGE_UNSAFE_PATH');
    return target;
  }
  async function assertUnwrittenOutput(entry) {
    const directory = await entryDirectory(entry);
    // Magpie may select a raster extension after generation. None of these fixed
    // destinations may already exist when the adapter is about to spend money.
    for (const name of ['image.png', 'image.jpg', 'image.jpeg', 'image.webp']) {
      try { await fs.lstat(path.join(directory, name)); fail('IMAGE_UNSAFE_FILE'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await entryDirectory(entry); // Detect a directory swap during the file checks.
  }
  async function readImage(entry, limit) {
    const target = path.join(await entryDirectory(entry), 'image.png');
    let result;
    try { result = await safeRead(target, Math.min(entry.maxBytes, limit)); }
    catch (error) { if (error.code === 'ENOENT') fail('IMAGE_OUTPUT_MISSING'); throw error; }
    await entryDirectory(entry);
    const mimeType = imageMime(result.buffer);
    if (!mimeType) fail('IMAGE_INVALID_CONTENT');
    const contentHash = hash(result.buffer);
    if (entry.contentHash && (!sameHash(contentHash, entry.contentHash) || mimeType !== entry.mimeType)) fail('IMAGE_TAMPERED');
    return { buffer: result.buffer, mimeType, contentHash };
  }
  async function finishFailure(entry, code, job) {
    await serial(async () => {
      if (entry.status !== 'pending') return;
      Object.assign(entry, { status: 'failed', code });
      try { await persist(); } finally { job.resolve(); }
    });
  }
  async function run(entry, prompt, callback, job, timeoutMs) {
    try {
      if (closed) fail('IMAGE_CLOSED');
      enabled();
      await authorize(callback);
      if (time() >= entry.expiresAt) fail('IMAGE_EXPIRED');
      const target = path.join(root, entry.imageId, 'image.png');
      job.timer = setTimeout(() => {
        job.controller.abort();
        void finishFailure(entry, 'IMAGE_TIMEOUT', job).catch(() => {});
      }, timeoutMs);
      job.timer.unref?.();
      const checkActive = () => {
        if (closed) fail('IMAGE_CLOSED');
        if (job.controller.signal.aborted || entry.status !== 'pending') fail('IMAGE_INTERRUPTED');
        if (fatal) throw fatal;
        enabled();
        if (time() >= entry.expiresAt) fail('IMAGE_EXPIRED');
      };
      const assertAllowed = async () => {
        checkActive();
        await authorize(callback);
        checkActive();
        await assertUnwrittenOutput(entry);
        checkActive();
      };
      await assertAllowed();
      let response;
      try { response = await generate({ prompt, size: entry.size, path: target }, { signal: job.controller.signal, assertAllowed }); }
      catch (error) {
        if (error instanceof ImageError) throw error;
        fail(BACKEND_CODES.has(error?.code) ? error.code : 'IMAGE_GENERATION_FAILED');
      }
      if (response?.ok === false) fail(BACKEND_CODES.has(response.code) ? response.code : 'IMAGE_GENERATION_FAILED');
      await authorize(callback);
      const cfg = enabled();
      if (closed) fail('IMAGE_CLOSED');
      if (entry.status !== 'pending') return;
      if (time() >= entry.expiresAt) fail('IMAGE_EXPIRED');
      const image = await readImage(entry, cfg.maxBytes);
      await serial(async () => {
        await authorize(callback);
        enabled();
        if (entry.status !== 'pending') return;
        if (time() >= entry.expiresAt) fail('IMAGE_EXPIRED');
        Object.assign(entry, { status: 'ready', bytes: image.buffer.length, mimeType: image.mimeType, contentHash: image.contentHash });
        await persist();
        job.resolve();
      });
    } catch (error) {
      await finishFailure(entry, error instanceof ImageError ? error.code : 'IMAGE_STORAGE', job).catch(() => {});
    } finally {
      clearTimeout(job.timer);
      job.resolve();
      jobs.delete(entry.imageId); // A timed-out but unsettled backend still occupies its slot.
      if (closed && !jobs.size) await serial(releaseLock).catch(() => {});
    }
  }
  const start = (input, { assertAllowed } = {}) => guarded(() => serial(async () => {
    const cfg = enabled(), binding = owner(input);
    if (typeof input.prompt !== 'string' || input.prompt.length > 4000 || !input.prompt.trim() || [...input.prompt.trim()].length > 2000) fail('IMAGE_BAD_REQUEST');
    const prompt = input.prompt.trim(), size = input.size === undefined ? '1024x1024' : input.size;
    if (!SIZES.has(size)) fail('IMAGE_BAD_REQUEST');
    await authorize(assertAllowed);
    await initialize();
    const stamp = time(), requestHash = hash(JSON.stringify([binding.keyHash, binding.tokenHash, prompt, size]));
    for (const entry of entries.values()) {
      if (entry.requestHash === requestHash && entry.expiresAt > stamp && ['pending', 'ready'].includes(entry.status)) return { ...output(entry), deduplicated: true };
    }
    const active = [...jobs.values()];
    if (active.length >= cfg.concurrencyGlobal || active.filter(job => job.keyHash === binding.keyHash).length >= cfg.concurrencyPerKey) fail('IMAGE_BUSY');
    const day = localDay(stamp), today = [...entries.values()].filter(entry => localDay(entry.createdAt) === day);
    if (today.length >= cfg.dailyGlobal || today.filter(entry => entry.keyHash === binding.keyHash).length >= cfg.dailyPerKey) fail('IMAGE_DAILY_LIMIT');
    const previous = [...entries.values()].filter(entry => entry.keyHash === binding.keyHash);
    if (previous.some(entry => stamp - entry.createdAt < cfg.cooldownMs)) fail('IMAGE_COOLDOWN');
    if (entries.size >= cfg.maxEntries || (await fs.readdir(root)).length > entries.size + 2) fail('IMAGE_STORAGE_FULL');
    await checkRoot();
    const imageId = randomBytes(24).toString('hex'), dir = path.join(root, imageId);
    await fs.mkdir(dir, { mode: 0o700 });
    const entry = { imageId, ...binding, requestHash, size, status: 'pending', createdAt: stamp, expiresAt: stamp + cfg.retentionMs, maxBytes: cfg.maxBytes, directoryIdentity: identity(await directory(dir)) };
    entries.set(imageId, entry);
    await persist(); // Reserve quota durably BEFORE calling a provider, including failed attempts.
    const job = { keyHash: binding.keyHash, controller: new AbortController() };
    job.done = new Promise(resolve => { job.resolve = resolve; });
    jobs.set(imageId, job);
    setImmediate(() => { void run(entry, prompt, assertAllowed, job, cfg.generationTimeoutMs); });
    return output(entry);
  }));
  const result = (input, { waitMs = 0, assertAllowed } = {}) => guarded(async () => {
    const inspect = () => serial(async () => { enabled(); await authorize(assertAllowed); await initialize(); return lookup(input); });
    let entry = await inspect();
    const job = jobs.get(entry.imageId), wait = clamp(waitMs, 0, 0, 30_000);
    if (entry.status === 'pending' && job && wait) {
      let timer;
      try { await Promise.race([job.done, new Promise(resolve => { timer = setTimeout(resolve, wait); })]); }
      finally { clearTimeout(timer); }
    }
    entry = await inspect(); // Authorization and expiry must be rechecked after the wait.
    return output(entry);
  });
  const readReady = input => guarded(() => serial(async () => {
    const cfg = enabled();
    await initialize();
    const entry = lookup(input);
    if (entry.status !== 'ready') fail('IMAGE_NOT_READY');
    const { buffer, mimeType } = await readImage(entry, cfg.maxBytes);
    lookup(input);
    enabled();
    return { buffer, mimeType };
  }));
  const delivery = (input, change) => guarded(() => serial(async () => {
    enabled();
    await initialize();
    const entry = lookup(input);
    if (entry.status !== 'ready') fail('IMAGE_NOT_READY');
    const extra = change(entry);
    await persist();
    return { ...output(entry), ...extra };
  }));
  const recordSending = input => delivery(input, entry => {
    if (entry.delivery) return { claimed: false };
    entry.delivery = { status: 'sending' };
    return { claimed: true };
  });
  const recordSendFailed = input => delivery(input, entry => {
    if (entry.delivery?.status !== 'sent') entry.delivery = { status: 'unknown' };
    return {};
  });
  const recordSent = (input, messageId) => delivery(input, entry => {
    if (!validMessageId(messageId)) fail('IMAGE_BAD_REQUEST');
    if (entry.delivery?.status === 'sent') return { alreadySent: true };
    entry.delivery = { status: 'sent', messageId };
    return {};
  });
  const close = () => guarded(() => serial(async () => {
    closed = true;
    if (!initialized) return;
    let changed = false;
    for (const [id, job] of jobs) {
      job.controller.abort();
      clearTimeout(job.timer);
      const entry = entries.get(id);
      if (entry.status === 'pending') { Object.assign(entry, { status: 'failed', code: 'IMAGE_INTERRUPTED' }); changed = true; }
      job.resolve();
    }
    if (changed) await persist();
    if (!jobs.size) await releaseLock();
  }));
  return { start, result, readReady, recordSending, recordSendFailed, recordSent, close };
}
