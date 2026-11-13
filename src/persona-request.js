import { createHash } from 'node:crypto';

export const PERSONA_SECTION = 'surfcore-current-persona';
export const PERSONA_START = '<!-- surfcore-persona:start -->';
export const PERSONA_END = '<!-- surfcore-persona:end -->';
const OWNED_BLOCK = /<!-- surfcore-persona:start -->[\s\S]*?<!-- surfcore-persona:end -->/g;
const LEGACY_QQ = /(^|\n)【当前角色】[^\r\n]*\r?\n[\s\S]*?（完整角色卡 \/ 场景语气 \/ 推荐值 \/ 可用工具：可调用 qq_get_prompt 查看）/g;
const LEGACY_BILI = /［统一人设卡 · QQ 和 B站是同一个人］[\s\S]*?（人设卡里的 QQ 称呼表不会带进 B站；认人只按身份对齐表，且不得公开对方 QQ 号\/群号。）/g;
const digest = value => createHash('sha256').update(value).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const textOf = message => (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('');
const isPromptTool = name => typeof name === 'string' && /(?:^|[._/:])qq_get_prompt$/.test(name);

/** Remove only the plugin's explicitly bounded prompt fragments. */
export function stripPersonaBlocks(text) {
  return String(text).replace(OWNED_BLOCK, '').replace(LEGACY_QQ, '$1').replace(LEGACY_BILI, '');
}

function cleanPromptJSON(text, clean) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return text; }
  let changed = false;
  function visit(value) {
    if (!record(value)) return value;
    let result = value;
    const set = (key, next) => {
      if (next === value[key]) return;
      if (result === value) result = { ...value };
      result[key] = next;
      changed = true;
    };
    if (record(value.role) && typeof value.role.hint === 'string') {
      const hint = clean(value.role.hint, 'role.hint');
      if (hint !== value.role.hint) set('role', { ...value.role, hint });
    }
    // MCP envelopes can be nested. Do not walk arbitrary memory/chat fields.
    for (const key of ['data', 'structuredContent']) if (record(value[key])) set(key, visit(value[key]));
    if (Array.isArray(value.content)) {
      const content = value.content.map(block => {
        if (block?.type !== 'text' || typeof block.text !== 'string') return block;
        const next = cleanPromptJSON(block.text, clean);
        return next === block.text ? block : { ...block, text: next };
      });
      if (content.some((block, index) => block !== value.content[index])) set('content', content);
    }
    return result;
  }
  const next = visit(parsed);
  return changed ? JSON.stringify(next) : text;
}

/**
 * Bind to agent scopes, never to the global system-prompt registry.
 * resolve(agent) is synchronous and returns { platform, text, fingerprint } or null.
 * text is the unmarked literal current persona; errors abort the model step.
 * stripLegacyText(text, { agent, role, toolName, persona, field }) may migrate
 * additional positively identified old fragments. onUpdate receives metadata only.
 *
 * NEXT 0.2.2-rc.1 assembles before agent/pre-step, then projects the system prompt.
 * Its pre-step decision has no rewrite field: append surface replacements using
 * session.append instead. Raw journal events and tool-call identities stay intact.
 * The final llm/stream guard only reads frozen requests: a complete prompt override
 * can happen after the assembly waterfall, so missing/duplicate cards stop dispatch.
 */
export function installPersonaRequestHooks(ctx, { resolve, stripLegacyText, onUpdate } = {}) {
  if (typeof resolve !== 'function') throw new TypeError('persona resolve(agent) is required');
  if (typeof ctx?.on !== 'function' || typeof ctx?.agents?.list !== 'function') {
    throw new TypeError('persona hooks require the agents registry and context events');
  }
  const agents = new Map();
  const disposers = [];
  let disposed = false;
  const status = { active: true, attachedAgents: 0, requests: 0, rewrites: 0, lastUpdate: null, error: null };
  function getStatus() {
    return { ...status, lastUpdate: status.lastUpdate && { ...status.lastUpdate }, error: status.error && { ...status.error } };
  }
  function report() {
    try { onUpdate?.(getStatus()); } catch { /* A status observer cannot alter a request. */ }
  }
  function failed(agent, error, integrity = false) {
    status.error = {
      ok: false, code: integrity ? 'PERSONA_REQUEST_INTEGRITY' : 'PERSONA_REQUEST_FAILED',
      error: '当前人格无法安全加入模型请求，本次请求已停止。',
      hint: integrity ? '请检查会话的完整提示词（complete）与 section 过滤设置，恢复单份人格后重试。' : '请检查人格卡长度和平台设置；修正后重试本轮。',
      agentId: String(agent.id ?? ''),
    };
    report();
    throw error;
  }
  function attach(agent) {
    if (disposed || !agent || agents.has(agent)) return;
    const scope = agent.ctx;
    if (typeof scope?.systemPrompt?.section !== 'function' || typeof scope?.on !== 'function') {
      failed(agent, new TypeError('agent-scoped systemPrompt.section and context events are required'));
    }
    const state = { persona: null, owned: false, resolved: false, sectionResolved: false, assembled: false, assemblyKey: null, lastKey: null, calls: new Map(), cursor: 0, disposers: [] };
    function resolvePersona() {
      try {
        const persona = resolve(agent);
        if (persona?.then) throw new TypeError('persona resolve must be synchronous');
        if (persona != null && (typeof persona.text !== 'string' || !persona.text.trim() || typeof persona.platform !== 'string')) {
          throw new TypeError('persona resolve must return { platform, text, fingerprint } or null');
        }
        state.persona = persona ? {
          ...persona, wrapped: `${PERSONA_START}\n${persona.text}\n${PERSONA_END}`,
          fingerprint: digest(`${persona.platform}\0${String(persona.fingerprint ?? '')}\0${persona.text}`),
        } : null;
        state.owned ||= state.persona !== null;
        state.resolved = true;
        state.assembled = false;
        return state.persona?.wrapped ?? '';
      } catch (error) { return failed(agent, error); }
    }
    state.resolvePersona = resolvePersona;
    const clean = (text, role, toolName = '', field = '') => {
      let next = stripPersonaBlocks(text);
      if (stripLegacyText) {
        next = stripLegacyText(next, { agent, role, toolName, persona: state.persona, field });
        if (typeof next !== 'string') throw new TypeError('stripLegacyText must return a string');
      }
      return next;
    };
    const rewriteMessage = (message, toolName = '') => {
      if (!message || !Array.isArray(message.content)) return message;
      if (!['system', 'user', 'tool'].includes(message.role)) return message;
      if (message.role === 'tool' && !isPromptTool(toolName)) return message;
      let changed = false;
      const content = message.content.map(block => {
        if (block.type !== 'text' || typeof block.text !== 'string') return block;
        const text = message.role === 'tool'
          ? cleanPromptJSON(block.text, (hint, field) => clean(hint, 'tool', toolName, field))
          : clean(block.text, message.role);
        if (text === block.text) return block;
        changed = true;
        return { ...block, text };
      });
      return changed ? { ...message, content } : message;
    };
    const rememberCalls = event => {
      const message = event?.data?.message;
      if (message?.role !== 'assistant') return;
      for (const block of message.content ?? []) {
        if (block.type === 'tool-call' && typeof block.id === 'string' && isPromptTool(block.name)) state.calls.set(block.id, block.name);
      }
    };
    function cleanHistory() {
      const session = agent.session;
      if (typeof session?.eventAt !== 'function' || typeof session?.append !== 'function' || !Array.isArray(session?.surface?.nodes)) {
        throw new TypeError('persona hooks require the public session surface replacement API');
      }
      const nodes = session.surface.nodes.map(seq => ({ seq, event: session.eventAt(seq) }));
      // A call can have moved out of the visible surface; its append-only event
      // still identifies the exact qq_get_prompt result without guessing by JSON.
      if (typeof session.snapshotEvents === 'function') {
        for (const event of session.snapshotEvents(state.cursor)) {
          rememberCalls(event);
          if (Number.isInteger(event.seq)) state.cursor = Math.max(state.cursor, event.seq + 1);
        }
      } else nodes.forEach(({ event }) => rememberCalls(event));
      const systems = nodes.filter(({ event }) => event?.type === 'system/message');
      const latestSystem = systems.findLast(({ event }) => textOf(event.data.message) !== '')?.seq;
      let rewritten = 0;
      for (const { seq, event } of nodes) {
        if (!event || !['system/message', 'user/message', 'tool/result'].includes(event.type)) continue;
        const message = event.type === 'user/message' ? event.data : event.data.message;
        if (event.type === 'system/message' && seq === latestSystem && state.persona) {
          const blocks = textOf(message).match(OWNED_BLOCK) ?? [];
          if (blocks.length === 1 && blocks[0] === state.persona.wrapped) continue;
        }
        const callId = message?.toolCallId ?? message?.source?.callId;
        const next = rewriteMessage(message, state.calls.get(callId) ?? '');
        if (next === message) continue;
        const data = event.type === 'user/message' ? next : { ...event.data, message: next };
        session.append(event.type, data, {
          surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
        });
        rewritten++;
      }
      return rewritten;
    }
    try {
      state.disposers.push(scope.systemPrompt.section({
        name: PERSONA_SECTION, order: 10150, interpolate: false,
        text: context => {
          if (context?.agent && context.agent !== agent) return '';
          const text = resolvePersona();
          state.sectionResolved = true;
          return text;
        },
      }));
      state.disposers.push(scope.on('system-prompt/assemble', async (assembly, context, next) => {
        if (context?.agent && context.agent !== agent) return next();
        // A scoped override may prevent our dynamic section provider from running.
        // Resolve independently in that case instead of mistaking it for a non-owned agent.
        if (!state.sectionResolved) resolvePersona();
        state.sectionResolved = false;
        const result = await next();
        if (!state.owned) return result;
        try {
          let included = false;
          const current = { name: PERSONA_SECTION, text: state.persona?.wrapped ?? '', interpolate: false };
          const sections = result.sections.flatMap(section => {
            if (section.name === PERSONA_SECTION) {
              if (included) return [];
              included = true;
              return [{ ...section, ...current }];
            }
            if (typeof section.text !== 'string') return [section];
            const text = clean(section.text, 'system');
            return [text === section.text ? section : { ...section, text }];
          });
          if (!included && state.persona) sections.push(current);
          const transformed = { ...result, sections };
          // Include other sections: in-history providers otherwise append another
          // whole system snapshot even when only runtime guidance changed.
          state.assemblyKey = digest(JSON.stringify([sections, result.variables, state.persona?.fingerprint ?? null]));
          state.assembled = true;
          return transformed;
        } catch (error) { return failed(agent, error); }
      }, { prepend: true }));
      state.disposers.push(scope.on('agent/pre-step', async (input, next) => {
        const decision = await next();
        if (input.agent !== agent || decision.kind !== 'enter' || !state.owned) return decision;
        try {
          const rewritten = cleanHistory();
          const messages = decision.messages.map(message => rewriteMessage(message));
          const pendingChanged = messages.some((message, index) => message !== decision.messages[index]);
          const startsRequestSeries = decision.startsRequestSeries === true || !state.assembled || state.assemblyKey !== state.lastKey || rewritten > 0;
          state.lastKey = state.assemblyKey;
          status.requests++;
          status.rewrites += rewritten + (pendingChanged ? 1 : 0);
          status.error = null;
          status.lastUpdate = { agentId: String(agent.id ?? ''), platform: state.persona?.platform ?? null,
            fingerprint: state.persona?.fingerprint ?? null, chars: state.persona?.text.length ?? 0,
            startsRequestSeries, rewrittenMessages: rewritten };
          report();
          return { ...decision, messages: pendingChanged ? messages : decision.messages, startsRequestSeries };
        } catch (error) { return failed(agent, error); }
      }, { prepend: true }));
      agents.set(agent, state);
      status.attachedAgents = agents.size;
    } catch (error) {
      for (const dispose of state.disposers.reverse()) dispose?.();
      throw error;
    }
  }
  function detach(agent) {
    const state = agents.get(agent);
    if (!state) return;
    agents.delete(agent);
    for (const dispose of state.disposers.reverse()) dispose?.();
    status.attachedAgents = agents.size;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const agent of agents.keys()) detach(agent);
    for (const off of disposers.splice(0).reverse()) off?.();
    status.active = false;
    report();
  }
  function verifyRequest(options, next) {
    // AgentLoop dispatches through its global llm service. Restrict this read-only
    // guard by the exact owned session, leaving auxiliary purpose calls alone.
    if (!options.sessionId || options.purpose !== undefined) return next();
    const entry = [...agents].find(([agent]) => agent.session?.id === options.sessionId);
    if (!entry) return next();
    const [agent, state] = entry;
    if (!state.resolved) state.resolvePersona();
    if (!state.persona) return next();
    try {
      const messages = options.messages ?? [];
      const system = [options.system ?? '', ...messages.filter(message => message.role === 'system').map(textOf)];
      const blocks = system.flatMap(text => text.match(OWNED_BLOCK) ?? []);
      const allText = [options.system ?? '', ...messages.map(textOf)].join('\n');
      if (blocks.length !== 1 || blocks[0] !== state.persona.wrapped
        || allText.split(PERSONA_START).length !== 2 || allText.split(PERSONA_END).length !== 2) {
        throw new Error('current persona must appear exactly once in the final model request');
      }
    } catch (error) { return failed(agent, error, true); }
    return next();
  }
  try {
    disposers.push(ctx.on('llm/stream', verifyRequest, { prepend: true }));
    disposers.push(ctx.on('agent/created', ({ agent }) => attach(agent)));
    disposers.push(ctx.on('agent/disposed', ({ agent }) => detach(agent)));
    disposers.push(ctx.on('dispose', dispose));
    for (const agent of ctx.agents.list()) attach(agent);
  } catch (error) { dispose(); throw error; }
  report();
  return { dispose, getStatus };
}
