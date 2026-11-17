import fs from 'node:fs';
import yaml from 'js-yaml';

const SOURCE = new URL('../../../dsh/agent-presets/owner-desktop/', import.meta.url);
const issue = (code, error) => ({ ok: false, code: 'owner-desktop.' + code, error, hint: '重载 SurfCore 并查看专用桌面预设的加载状态；不要改用宽权限预设。' });

/** Registers a fixed, isolated composition through the official preset service. */
export function installOwnerDesktopPreset(ctx, { source = SOURCE } = {}) {
  let state = issue('preset-loading', '专用桌面预设尚未完成加载。');
  let disposed = false;
  let unregister;
  const ready = (async () => {
    try {
      if (typeof ctx?.agentPresets?.register !== 'function' || typeof ctx?.agentPresets?.resolve !== 'function')
        throw new Error('宿主缺少正式预设注册接口。');
      const meta = yaml.load(fs.readFileSync(new URL('preset.yml', source), 'utf8'));
      const rows = yaml.load(fs.readFileSync(new URL('agent.cordis.yml', source), 'utf8'));
      if (!meta || typeof meta.name !== 'string' || !Array.isArray(rows) || rows.length !== 3)
        throw new Error('专用桌面预设声明不完整。');
      const allowed = new Set(['@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-tool-executor-native', './owner-desktop-boundary.mjs']);
      if (rows.some(row => !row || row.group || !allowed.delete(row.name)) || allowed.size)
        throw new Error('专用桌面预设必须只包含人格、原生执行器和桌面边界。');
      const plugins = rows.map(row => row.name === './owner-desktop-boundary.mjs'
        ? { ...row, name: new URL('owner-desktop-boundary.mjs', source).href } : row);
      unregister = await ctx.agentPresets.register({ id: 'owner-desktop', name: meta.name,
        description: String(meta.description || ''), order: Number(meta.order || 900), plugins });
      if (typeof unregister !== 'function') throw new Error('专用预设注册未返回可撤销句柄。');
      if (disposed) { await unregister(); unregister = null; return; }
      const resolved = await ctx.agentPresets.resolve('owner-desktop');
      if (resolved?.id !== 'owner-desktop' || resolved.broken) throw new Error('专用桌面预设加载失败：' + String(resolved?.broken || '身份不匹配'));
      if (!disposed) state = { ok: true, id: 'owner-desktop' };
    } catch (error) {
      state = issue('preset-unavailable', String(error?.message || '专用桌面预设不可用。').slice(0, 600));
    }
  })();
  async function stop() {
    disposed = true;
    state = issue('preset-stopped', '专用桌面预设已停止。');
    await ready;
    if (unregister) { const off = unregister; unregister = null; await off(); }
  }
  return { ready, stop, status: () => ({ ...state }) };
}
