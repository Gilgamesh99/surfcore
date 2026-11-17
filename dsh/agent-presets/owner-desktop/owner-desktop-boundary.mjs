// Host-only handshake. This module never reads or writes a Computer Use grant.
const boundaries = new WeakMap();
const DENIED = 'owner-desktop.boundary-inactive: 当前隔离桌面任务没有有效执行租约。请由主人重新发送指令。';
export const name = 'surfcore-owner-desktop-boundary';
export const inject = ['tools'];
export function isOwnerDesktopTool(name) {
  return name === 'windows_desktop' || name === 'windows_mcp_doctor'
    || (typeof name === 'string' && name.startsWith('mcp__windows__'));
}

// Only the host runtime imports this capability; it is never registered as a tool.
export function armOwnerDesktopBoundary(agent, authorize) {
  const record = boundaries.get(agent);
  if (!record || !record.current() || record.authorize || typeof authorize !== 'function') return null;
  record.authorize = authorize;
  return {
    isActive: () => record.current() && record.authorize === authorize,
    close() { if (record.authorize === authorize) record.authorize = null; },
  };
}

export function apply(ctx) {
  let alive = true;
  let maskReady = false;
  let removeMask;
  let refreshing = false;
  let lastNames = '';
  const records = new Set();
  function refreshMask() {
    if (!alive || refreshing) return;
    refreshing = true;
    try {
      const names = [...new Set(ctx.tools.definitions().map(tool => tool.name).filter(isOwnerDesktopTool))].sort();
      const signature = JSON.stringify(names);
      if (maskReady && signature === lastNames) return;
      const next = ctx.tools.restrict({ allow: names });
      lastNames = signature;
      const previous = removeMask;
      removeMask = next;
      maskReady = true;
      previous?.();
    } catch { maskReady = false; }
    finally { refreshing = false; }
  }
  refreshMask();
  ctx.on('tools/change', refreshMask);
  ctx.on('agent/created', ({ agent }) => {
    const record = { authorize: null, executor: null, current: () => false };
    try {
      record.executor = ctx.tools.selectExecutor(agent);
      const definitions = ctx.tools.definitions(agent);
      const wire = record.executor.describe(definitions);
      const schemaNames = wire?.schemas?.map(schema => schema.name);
      const native = Array.isArray(schemaNames) && schemaNames.length > 0
        && schemaNames.every(isOwnerDesktopTool) && schemaNames.includes('windows_desktop');
      record.current = () => {
        try { return alive && maskReady && native && ctx.tools.selectExecutor(agent) === record.executor; }
        catch { return false; }
      };
    } catch { /* Absent or non-native executors never become eligible. */ }
    boundaries.set(agent, record);
    records.add(record);
  });
  ctx.tools.guard(exec => {
    const record = boundaries.get(exec.agent);
    if (!record?.current() || !record.authorize) return DENIED;
    if (!isOwnerDesktopTool(exec.name)) return 'owner-desktop.tool-denied: 隔离桌面任务仅允许 Windows 桌面工具。';
    try { return record.authorize(exec); } catch { return DENIED; }
  });
  ctx.on('agent/disposed', ({ agent }) => {
    const record = boundaries.get(agent);
    if (record) { record.authorize = null; records.delete(record); }
  });
  ctx.on('dispose', () => {
    alive = false;
    maskReady = false;
    for (const record of records) record.authorize = null;
    records.clear();
  });
}
