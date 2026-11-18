import { randomUUID } from 'node:crypto';
import { normalizeOwnerDesktopSettings, desktopConfigError } from '../../../src/owner-desktop-options.js';

const failure = (error) => ({ ok: false, code: error?.code || 'owner-desktop.settings-failed', error: String(error?.message || '桌面授权设置失败。'), hint: error?.hint || '重新读取设置和桥接状态后再试。' });

/** This controls SurfCore's owner task intake, never the Windows Computer Use switch. */
export function createOwnerDesktopSettings({ runtime, policy, getSettings, getOwnerQQ, bridge, saveSettings }) {
  let saving = false;
  async function status() {
    try {
      const settings = getSettings();
      const result = await bridge('/api/owner-desktop/status');
      const broker = result?.ok && result.data?.ok ? result.data : { ok: false, code: result?.data?.code || 'owner-desktop.bridge-unavailable', error: result?.data?.error || 'QQ 桥接的主人桌面通道不可用。', hint: result?.data?.hint || '启动或重启 QQ 桥接后刷新状态。' };
      return { ok: true, settings, runtime: runtime.status(), broker, parents: policy.parentSessions(), ownerConfigured: /^[1-9][0-9]*$/.test(String(getOwnerQQ())) };
    } catch (error) { return failure(error); }
  }
  async function configure(body = {}) {
    if (saving) return failure(desktopConfigError('owner-desktop.settings-busy', '另一项授权变更正在处理。', '等待当前保存完成后刷新页面。'));
    saving = true;
    try {
      if (Object.keys(body).some((key) => !['enabled','parentSessionId','timeoutMs','expectedEpoch'].includes(key))) throw desktopConfigError('owner-desktop.settings-fields', '桌面授权设置包含未知字段。', '刷新设置页面后重新保存。');
      const current = getSettings();
      if (body.expectedEpoch !== current.authorizationEpoch) throw desktopConfigError('owner-desktop.settings-stale', '桌面授权已被其他窗口更改。', '点击刷新，重新选择管理会话。');
      const next = normalizeOwnerDesktopSettings({ ...current, ...body, authorizationEpoch: randomUUID() });
      if (next.enabled) {
        if (!/^[1-9][0-9]*$/.test(String(getOwnerQQ()))) throw desktopConfigError('owner-desktop.owner-missing', '尚未配置唯一的主人 QQ。', '先在管理员卡片中配置主人 QQ 并重启桥接。');
        if (!policy.parentSessions().some((row) => row.id === next.parentSessionId)) throw desktopConfigError('owner-desktop.parent-unavailable', '所选管理会话未运行，或不是可授权的管理会话。', '打开已开启 Computer Use 的管理会话，然后刷新本页。');
      }
      await runtime.stop();
      const cancelled = await bridge('/api/owner-desktop/cancel', { method: 'POST', body: {} });
      if (next.enabled && (!cancelled?.ok || cancelled.data?.ok !== true)) throw desktopConfigError('owner-desktop.cancel-unconfirmed', '旧桌面任务未能确认撤销，本次未启用授权。', '启动或重启 QQ 桥接，确认旧任务结束后再启用。');
      await saveSettings(next, current.authorizationEpoch);
      runtime.start();
      return { ok: true, settings: next, note: next.enabled ? '仅接收主人私聊和主人群内明确 @ 的桌面命令；Windows 会话开关仍由你控制。' : '主人桌面任务已关闭，已有任务授权已撤销。' };
    } catch (error) { return failure(error); }
    finally { saving = false; }
  }
  return { status, configure };
}
