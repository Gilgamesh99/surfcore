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
const isCardBlock = block => /^(?:\r?\n|\\+(?:r\\+)?n)/.test(block.slice(PERSONA_START.length))
  && block.slice(PERSONA_START.length, -PERSONA_END.length).trim().length > 0;

/** Remove only the plugin's explicitly bounded prompt fragments. */
export function stripPersonaBlocks(text) {
  return String(text).replace(OWNED_BLOCK, block => isCardBlock(block) ? '' : block).replace(LEGACY_QQ, '$1').replace(LEGACY_BILI, '');
}

// Old purpose wakes sliced the whole prompt at 55% and kept a 35% tail.
// Recover only that generated envelope, never an isolated marker in conversation.
function stripClippedPurpose(text) {
  const start = text.indexOf(PERSONA_START);
  const notice = text.indexOf('\n…（素材过长，已省略中间部分）…\n', start);
  const purpose = text.indexOf('【主动找主人 · 目的回合】\n');
  const generated = purpose === 0 || purpose > 0 && purpose < 256 && text.startsWith('【当前时间】');
  const background = text.indexOf('\n【你的身份与记忆（背景）】\n');
  const tail = text.slice(notice);
  if (!generated || background <= purpose || start <= background || notice <= start
    || !tail.includes('\n【现在做】\n') || !tail.includes('\n【待续】')
    || text.split(PERSONA_START).length !== 2 || text.includes(PERSONA_END)
    || !text.slice(0, start).endsWith('【人格卡（你是这样的人）】\n')
    || !text.slice(start + PERSONA_START.length).startsWith('\n【身份底座】')) return text;
  return text.slice(0, start) + text.slice(notice);
}

// PTC returns arbitrary JSON wrappers/arrays, JSON inside strings, or console
// logs. Decode before rewriting so escaped quotes and other JSON fields survive.
// Called only for results positively attributed to qq_get_prompt by the journal.
function transformPromptOutput(text, transform) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return transform(text, ''); }
  function visit(value, field = '') {
    if (typeof value === 'string') return field === 'role.hint'
      ? transform(value, field) : transformPromptOutput(value, transform);
    if (!record(value) && !Array.isArray(value)) return value;
    let next = value;
    for (const [key, child] of Object.entries(value)) {
      const updated = visit(child, field === 'role' && key === 'hint' ? 'role.hint' : key);
      if (updated === child) continue;
      if (next === value) next = Array.isArray(value) ? [...value] : { ...value };
      // Define an own property even for a JSON key named __proto__.
      Object.defineProperty(next, key, { value: updated, enumerable: true, writable: true, configurable: true });
    }
    return next;
  }
  const next = visit(parsed);
  return next === parsed ? text : JSON.stringify(next);
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
  const status = { revision: '20261113-persona-recovery', active: true, attachedAgents: 0, requests: 0, rewrites: 0, lastUpdate: null, error: null };
  function getStatus() {
    return { ...status, lastUpdate: status.lastUpdate && { ...status.lastUpdate },
      error: status.error && { ...status.error, ...(status.error.counts ? { counts: { ...status.error.counts } } : {}) } };
  }
  function report() {
    try { onUpdate?.(getStatus()); } catch { /* A status observer cannot alter a request. */ }
  }
  function failed(agent, error, integrity = null) {
    status.error = {
      ok: false, code: integrity ? 'PERSONA_REQUEST_INTEGRITY' : 'PERSONA_REQUEST_FAILED',
      error: '当前人格无法安全加入模型请求，本次请求已停止。',
      hint: '请检查人格卡长度和平台设置；修正后重试本轮。',
      agentId: String(agent.id ?? ''),
      ...integrity,
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
    const state = { persona: null, owned: false, resolved: false, sectionResolved: false, assembled: false, assemblyKey: null, lastKey: null, calls: new Map(), parents: new Map(), cursor: 0, disposers: [] };
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
      let next = stripPersonaBlocks(role === 'user' ? stripClippedPurpose(text) : text);
      if (stripLegacyText) {
        next = stripLegacyText(next, { agent, role, toolName, persona: state.persona, field });
        if (typeof next !== 'string') throw new TypeError('stripLegacyText must return a string');
      }
      return next;
    };
    const rewriteMessage = (message, source = state.calls.get(message?.toolCallId ?? message?.source?.callId)) => {
      if (!message || !Array.isArray(message.content)) return message;
      if (!['system', 'user', 'tool'].includes(message.role)) return message;
      if (message.role === 'tool' && !source) return message;
      let changed = false;
      const content = message.content.map(block => {
        if (block.type !== 'text' || typeof block.text !== 'string') return block;
        const text = message.role === 'tool'
          ? transformPromptOutput(block.text, (text, field) => field === 'role.hint'
            ? clean(text, 'tool', source.name, field) : stripPersonaBlocks(text))
          : clean(block.text, message.role);
        if (text === block.text) return block;
        changed = true;
        return { ...block, text };
      });
      return changed ? { ...message, content } : message;
    };
    const rememberCalls = event => {
      const data = event?.data;
      if (event?.type === 'tool/ptc-dispatch' || event?.type === 'tool/ptc-dispatch-start') {
        if (typeof data?.subCallId !== 'string') return;
        state.parents.set(data.subCallId, [data.parentCallId, data.rootCallId].filter(id => typeof id === 'string' && id !== data.subCallId));
        // A start or failed dispatch proves no returned persona. Successful nested
        // output can survive even when a later statement makes its parent fail.
        if (event.type === 'tool/ptc-dispatch' && data.isError === false && isPromptTool(data.name)) {
          state.calls.set(data.subCallId, { name: data.name, kind: 'ptc' });
        }
      }
      const message = data?.message;
      if (message?.role !== 'assistant') return;
      for (const block of message.content ?? []) {
        if (block.type === 'tool-call' && typeof block.id === 'string' && isPromptTool(block.name)) {
          state.calls.set(block.id, { name: block.name, kind: 'direct' });
        }
      }
    };
    function refreshCalls(nodes = []) {
      // Raw events retain provenance even when compaction hides the assistant call.
      if (typeof agent.session?.snapshotEvents === 'function') {
        for (const event of agent.session.snapshotEvents(state.cursor)) {
          rememberCalls(event);
          if (Number.isInteger(event.seq)) state.cursor = Math.max(state.cursor, event.seq + 1);
        }
      } else nodes.forEach(({ event }) => rememberCalls(event));
      // Map iteration visits inserted ancestors; has() also terminates cycles.
      for (const [id, source] of state.calls) for (const parent of state.parents.get(id) ?? []) {
        if (!state.calls.has(parent)) state.calls.set(parent, { ...source, kind: 'ptc' });
      }
    }
    state.refreshCalls = refreshCalls;
    function cleanHistory() {
      const session = agent.session;
      if (typeof session?.eventAt !== 'function' || typeof session?.append !== 'function' || !Array.isArray(session?.surface?.nodes)) {
        throw new TypeError('persona hooks require the public session surface replacement API');
      }
      const nodes = session.surface.nodes.map(seq => ({ seq, event: session.eventAt(seq) }));
      refreshCalls(nodes);
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
        const next = rewriteMessage(message);
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
    state.refreshCalls();
    const messages = options.messages ?? [];
    const system = [options.system ?? '', ...messages.filter(message => message.role === 'system').map(textOf)].join('\n');
    const blocks = system.match(OWNED_BLOCK) ?? [];
    const counts = { systemBlocks: blocks.length, matchingSystemBlocks: blocks.filter(block => block === state.persona.wrapped).length,
      systemStarts: system.split(PERSONA_START).length - 1, systemEnds: system.split(PERSONA_END).length - 1, directToolCopies: 0, ptcToolCopies: 0 };
    for (const message of messages) {
      const source = state.calls.get(message.toolCallId ?? message.source?.callId);
      if (message.role !== 'tool' || !source) continue;
      for (const block of message.content ?? []) if (block.type === 'text') {
        transformPromptOutput(block.text, text => {
          counts[source.kind === 'ptc' ? 'ptcToolCopies' : 'directToolCopies'] += (text.match(OWNED_BLOCK) ?? []).filter(isCardBlock).length;
          return text;
        });
      }
    }
    // Conversation quotations and unowned tools are data, not prompt injections.
    const reason = counts.systemBlocks > 1 ? 'duplicate'
      : counts.systemStarts !== counts.systemBlocks || counts.systemEnds !== counts.systemBlocks ? 'incomplete'
      : counts.systemBlocks === 0 ? 'missing'
      : counts.matchingSystemBlocks !== 1 ? 'mismatch'
      : counts.directToolCopies + counts.ptcToolCopies > 0 ? 'history-copy' : null;
    if (reason) {
      const [error, hint] = {
        missing: ['模型请求缺少当前人格卡，本次请求已停止。', '请检查人格注入是否被完整提示词覆盖；恢复后重试本轮。'],
        incomplete: ['模型请求中的人格区块不完整，本次请求已停止。', '请检查系统提示词的裁剪与拼接；恢复完整人格后重试本轮。'],
        mismatch: ['模型请求中的人格卡与当前角色不一致，本次请求已停止。', '请刷新当前角色的人格注入后重试本轮。'],
        duplicate: ['模型请求的系统提示词含多份人格卡，本次请求已停止。', '请清除重复的人格注入后重试本轮。'],
        'history-copy': ['工具历史仍含重复人格卡，本次请求已停止。', '请检查工具结果的人格去重是否生效，再重试本轮。'],
      }[reason];
      return failed(agent, new Error(`${error} ${hint}`), { reason, counts, error, hint });
    }
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
