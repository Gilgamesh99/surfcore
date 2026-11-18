import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const OWNER_DESKTOP_DEFAULT_TIMEOUT_MS = 600_000;
export const OWNER_DESKTOP_MAX_TIMEOUT_MS = 86_400_000;
export const OWNER_DESKTOP_PENDING_TTL_MS = 300_000;
export const OWNER_DESKTOP_DEFAULTS = Object.freeze({ enabled: false, parentSessionId: '', authorizationEpoch: '', timeoutMs: OWNER_DESKTOP_DEFAULT_TIMEOUT_MS });
export function desktopConfigError(code, error, hint) { return Object.assign(new Error(error), { code, hint }); }
export function normalizeOwnerDesktopTimeout(value) {
  const timeoutMs = value === undefined ? OWNER_DESKTOP_DEFAULT_TIMEOUT_MS : value;
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs)
      || (timeoutMs !== 0 && (timeoutMs < 30_000 || timeoutMs > OWNER_DESKTOP_MAX_TIMEOUT_MS)))
    throw desktopConfigError('owner-desktop.timeout-invalid', '桌面任务时限必须为 0（不限时），或 30 秒到 24 小时的整数毫秒数。', '选择“不限时”或有效的有限时限后保存；空值不能表示不限时。');
  return timeoutMs;
}
export function normalizeOwnerDesktopSettings(value = {}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const parentSessionId = String(input.parentSessionId ?? '').trim();
  const authorizationEpoch = String(input.authorizationEpoch ?? '').trim();
  const timeoutMs = normalizeOwnerDesktopTimeout(input.timeoutMs);
  if ((parentSessionId && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(parentSessionId)) || (authorizationEpoch && !/^[a-zA-Z0-9-]{1,80}$/.test(authorizationEpoch)))
    throw desktopConfigError('owner-desktop.settings-invalid', '桌面授权会话或授权版本无效。', '在 QQ 设置的主人桌面授权卡片中重新选择管理会话并保存。');

  const enabled = input.enabled === true;
  if (enabled && (!parentSessionId || !authorizationEpoch))
    throw desktopConfigError('owner-desktop.authorization-missing', '主人桌面授权尚未绑定管理会话。', '选择已由你开启 Computer Use 的管理会话，再启用主人桌面授权。');
  return { enabled, parentSessionId, authorizationEpoch, timeoutMs };
}
export function readOwnerDesktopSettings(file = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'surfcore', 'config.json')) {
  try { return normalizeOwnerDesktopSettings(JSON.parse(fs.readFileSync(file, 'utf8')).ownerDesktop); }
  catch (error) {
    if (error?.code === 'ENOENT') return { ...OWNER_DESKTOP_DEFAULTS };
    if (error?.code?.startsWith('owner-desktop.')) throw error;
    throw desktopConfigError('owner-desktop.config-unreadable', '无法读取主人桌面授权配置，已停止接收桌面任务。', '检查 SurfCore 配置文件是否为有效 JSON；修复后在设置页重新读取。');
  }
}
