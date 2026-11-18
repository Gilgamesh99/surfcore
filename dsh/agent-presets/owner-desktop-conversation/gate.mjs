// Host-only handshake keyed by the exact live child Agent; never changes Computer Use.
const records = new WeakMap();
const original = value => value?.[Symbol.for('cordis.original')] ?? value;
const DENIED = 'owner-desktop.owner-task-required: 电脑会话当前没有有效主人消息授权。请从原 QQ 对话发送新指令。';
export function isOwnerDesktopTool(name) {
  return name === 'windows_desktop' || name === 'windows_mcp_doctor'
    || (typeof name === 'string' && name.startsWith('mcp__windows__'));
}

export function armOwnerDesktopConversation(agent, authorize, onLost) {
  const record = records.get(agent);
  if (!record?.current() || record.authorize || typeof authorize !== 'function') return null;
  record.authorize = authorize; record.onLost = onLost;
  return {
    isActive: () => record.current() && record.authorize === authorize,
    activate() {
      if (!record.current() || record.authorize !== authorize) return false;
      record.enabled = true; record.refresh();
      return record.current() && record.enabled;
    },
    desktopAvailable: () => record.current() && record.enabled && record.definitions().some(tool =>
      tool.name === 'windows_desktop' || tool.name.startsWith('mcp__windows__')),
    close() {
      if (record.authorize !== authorize) return;
      record.authorize = null; record.onLost = null; record.enabled = false; record.refresh();
    },
  };
}

export function ownerDesktopConversationDenial(exec) {
  if (!isOwnerDesktopTool(exec?.name)) return 'owner-desktop.tool-not-allowed: 独立电脑会话只允许原生 Windows 工具。';
  const record = records.get(exec?.agent);
  if (!record?.current() || !record.enabled || !record.authorize) return DENIED;
  try { return record.authorize(exec); } catch { return DENIED; }
}

/** Installed only by owner-desktop-conversation, never by either QQ preset.
 * The official native executor is selected by the preset. Masks are owned by
 * agent.ctx, while the synchronous execution guard denies every non-Windows tool.
 */
export function installOwnerDesktopConversationGate(ctx) {
  const live = new Set();
  let alive = true, refreshing = false;
  function install({ agent }) {
    if (!agent || records.has(agent)) return;
    const tools = agent.ctx?.get?.('tools') ?? agent.ctx?.tools;
    const record = { agent, enabled: false, authorize: null, onLost: null, mask: null, signature: '', ready: false,
      executor: null, current: () => false, definitions: () => ctx.tools.definitions(agent), refresh: () => {} };
    function lose() {
      const notify = record.onLost; record.enabled = false; record.authorize = null; record.onLost = null; notify?.();
    }
    record.refresh = () => {
      if (!alive || refreshing) return;
      refreshing = true;
      try {
        const allowed = [...ctx.tools.view(agent).restrictableNames].filter(name => record.enabled && isOwnerDesktopTool(name)).sort();
        const signature = JSON.stringify(allowed);
        if (record.ready && record.signature === signature) return;
        const remove = tools.restrict({ allow: allowed });
        const previous = record.mask;
        record.mask = remove; record.signature = signature; record.ready = true; previous?.();
      } catch { record.ready = false; lose(); }
      finally { refreshing = false; }
    };
    try { record.executor = original(ctx.tools.selectExecutor(agent)); } catch { /* fail closed */ }
    record.current = () => {
      try {
        const executor = ctx.tools.selectExecutor(agent);
        const definitions = record.definitions();
        const names = executor.describe(definitions)?.schemas?.map(schema => schema.name);
        return alive && record.ready && records.get(agent) === record && original(executor) === record.executor
          && Array.isArray(names) && names.length === definitions.length
          && names.every((name, index) => name === definitions[index]?.name && record.enabled && isOwnerDesktopTool(name));
      } catch { return false; }
    };
    record.dispose = () => {
      lose(); record.ready = false; live.delete(record); records.delete(agent);
      // Keep the deny mask until its Agent scope dies; unloading never opens tools.
    };
    records.set(agent, record); live.add(record); record.refresh();
  }
  ctx.tools.guard(ownerDesktopConversationDenial);
  ctx.on('agent/created', install);
  ctx.on('tools/change', () => {
    if (refreshing) return;
    for (const record of live) {
      record.refresh();
      if (record.authorize && !record.current()) {
        const notify = record.onLost;
        record.authorize = null; record.onLost = null; record.enabled = false; record.refresh(); notify?.();
      }
    }
  });
  ctx.on('agent/disposed', ({ agent }) => records.get(agent)?.dispose());
  ctx.on('dispose', () => {
    for (const record of [...live]) { record.enabled = false; record.refresh(); record.dispose(); }
    alive = false;
  });
}
