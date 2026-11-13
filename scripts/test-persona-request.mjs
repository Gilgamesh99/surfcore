import assert from 'node:assert/strict';
import { installPersonaRequestHooks, PERSONA_START, PERSONA_END, PERSONA_SECTION, stripPersonaBlocks } from '../src/persona-request.js';

const wrap = text => `${PERSONA_START}\n${text}\n${PERSONA_END}`;
let messageId = 0;
const message = (role, text, extra = {}) => ({ id: `m${++messageId}`, role, source: { kind: role }, content: [{ type: 'text', text }], ...extra });
const texts = messages => messages.flatMap(item => item.content.filter(block => block.type === 'text').map(block => block.text)).join('\n');
const occurrences = (text, fragment) => text.split(fragment).length - 1;
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function scope() {
  const listeners = new Map();
  const sections = new Map();
  return {
    listeners, sections,
    on(event, fn, options = {}) {
      const list = listeners.get(event) ?? [];
      options.prepend ? list.unshift(fn) : list.push(fn);
      listeners.set(event, list);
      return () => { const index = list.indexOf(fn); if (index >= 0) list.splice(index, 1); };
    },
    async invoke(event, args, terminal) {
      const list = [...(listeners.get(event) ?? [])];
      const run = index => index === list.length ? terminal() : list[index](...args, () => run(index + 1));
      return run(0);
    },
    async emit(event, data) { for (const fn of [...(listeners.get(event) ?? [])]) await fn(data); },
    systemPrompt: { section(definition) {
      assert.equal(sections.has(definition.name), false, 'no duplicate scoped registration');
      sections.set(definition.name, definition);
      return () => sections.delete(definition.name);
    } },
  };
}
function session() {
  const events = [];
  const surface = { nodes: [], contentGeneration: 0 };
  return { events, surface,
    eventAt: seq => events[seq],
    snapshotEvents: (from = 0) => events.slice(from),
    append(type, data, intent = { surfaceOp: 'append' }) {
      const event = freeze({ seq: events.length, type, data, ...intent });
      const op = intent.surfaceOp;
      if (op?.op === 'replace') {
        const index = surface.nodes.indexOf(op.startSeq);
        assert.ok(index >= 0);
        assert.equal(op.startSeq, op.endSeq);
        const previous = events[op.startSeq];
        if (type === 'tool/result') {
          assert.equal(previous.type, type);
          assert.deepEqual({ ...data, message: { ...data.message, content: null } },
            { ...previous.data, message: { ...previous.data.message, content: null } }, 'only tool result content can change');
        }
        surface.nodes[index] = event.seq;
        surface.contentGeneration++;
      } else if (intent.surfaceOp === 'append') surface.nodes.push(event.seq);
      events.push(event);
      return event;
    },
  };
}
function agent(id, platform = null) { return { id, platform, ctx: scope(), session: { ...session(), id } }; }
function stream(ctx, options, terminal) {
  const listeners = [...(ctx.listeners.get('llm/stream') ?? [])];
  const run = index => index === listeners.length ? terminal() : listeners[index](options, () => run(index + 1));
  return run(0);
}
function registry(existing) { const ctx = scope(); ctx.agents = { list: () => existing }; return ctx; }
function systemNodes(agent) {
  return agent.session.surface.nodes.map(seq => ({ seq, event: agent.session.eventAt(seq) })).filter(node => node.event.type === 'system/message');
}
function replaceSystem(agent, seq, text) {
  agent.session.append('system/message', { message: message('system', text) }, {
    surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
  });
}
// Model the public host projection verified in NEXT 0.2.2-rc.1. The critical
// branch is startsSeries && latest !== rendered, not startsSeries by itself.
function projectSystem(agent, rendered, startsSeries, inHistory = true) {
  const nodes = systemNodes(agent);
  if (!nodes.length) return agent.session.append('system/message', { message: message('system', rendered) });
  const text = node => texts([node.event.data.message]);
  const latest = nodes.findLast(node => text(node) !== '') ?? nodes[0];
  if (!inHistory || rendered.length === 0 || startsSeries && text(latest) !== rendered) {
    for (const node of nodes.slice(1)) if (text(node) !== '') replaceSystem(agent, node.seq, '');
    if (text(nodes[0]) !== rendered) replaceSystem(agent, nodes[0].seq, rendered);
  } else if (text(latest) !== rendered) agent.session.append('system/message', { message: message('system', rendered) });
}
async function request(agent, { pending = [], extraSections = [], variables = {}, kind = 'enter', startsRequestSeries, inHistory = true, completePrompt } = {}) {
  const context = { agent, scope: agent };
  const sections = [ { name: 'host-safety', text: 'KEEP SYSTEM SAFETY' }, ...extraSections,
    ...[...agent.ctx.sections.values()].map(item => ({ name: item.name, text: typeof item.text === 'function' ? item.text(context) : item.text, interpolate: item.interpolate })) ];
  const assembly = { sections, variables, contexts: [], tools: ['unchanged'] };
  const assembled = await agent.ctx.invoke('system-prompt/assemble', [assembly, context], () => assembly);
  if (completePrompt !== undefined) assembled.sections = [{ name: 'complete', text: completePrompt, interpolate: false }];
  const rendered = assembled.sections.map(section => section.interpolate === false ? section.text : section.text.replace(/{{(\w+)}}/g, (_, key) => {
    assert.ok(Object.hasOwn(variables, key), `unexpected template interpolation: ${key}`); return variables[key];
  })).filter(Boolean).join('\n\n');
  const decision = { kind, messages: pending, extraProviderField: 42, ...(startsRequestSeries === undefined ? {} : { startsRequestSeries }) };
  const next = await agent.ctx.invoke('agent/pre-step', [{ agent, messages: pending }], () => decision);
  if (next.kind !== 'enter') return { decision: next, originalDecision: decision };
  projectSystem(agent, rendered, next.startsRequestSeries === true, inHistory);
  for (const item of next.messages) agent.session.append('user/message', item);
  return { decision: next, rendered, assembled, messages: agent.session.surface.nodes.map(seq => (agent.session.eventAt(seq).type === 'user/message' ? agent.session.eventAt(seq).data : agent.session.eventAt(seq).data.message)).filter(Boolean) };
}
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

await test('full 10000-character literal persona on first call and stable tool continuation', async () => {
  const prefix = 'BEGIN{{not_a_variable}}\n';
  const suffix = '\nEND-LITERAL';
  const card = prefix + '鲸'.repeat(10000 - prefix.length - suffix.length) + suffix;
  assert.equal(card.length, 10000);
  const qq = agent('qq-1', 'qq'); const ctx = registry([qq]);
  let resolves = 0;
  const api = installPersonaRequestHooks(ctx, { resolve: a => { resolves++; return { platform: a.platform, text: card, fingerprint: 'one' }; } });
  const wake = message('user', `WAKE\n${wrap(card)}\nKEEP RECENT CHAT`);
  const originalWake = structuredClone(wake);
  let result = await request(qq, { pending: [wake] });
  assert.equal(occurrences(texts(result.messages), card), 1);
  assert.ok(texts(result.messages).includes('KEEP RECENT CHAT'));
  assert.deepEqual(wake, originalWake);
  assert.equal(result.decision.extraProviderField, 42);
  assert.equal(result.decision.startsRequestSeries, true);
  result = await request(qq);
  assert.equal(occurrences(texts(result.messages), card), 1);
  assert.equal(result.decision.startsRequestSeries, false, 'stable continuation preserves the series');
  assert.equal(resolves, 2);
  assert.equal(qq.ctx.sections.get(PERSONA_SECTION).interpolate, false);
  api.dispose();
});
await test('role switch and other system changes normalize in-history providers', async () => {
  const qq = agent('qq-switch', 'qq'); let card = 'OLD FULL CARD';
  const api = installPersonaRequestHooks(registry([qq]), { resolve: () => ({ platform: 'qq', text: card, fingerprint: card }) });
  await request(qq);
  card = 'NEW FULL CARD';
  let result = await request(qq);
  assert.equal(occurrences(texts(result.messages), card), 1);
  assert.equal(occurrences(texts(result.messages), 'OLD FULL CARD'), 0);
  assert.ok(qq.session.events.some(event => texts([event.data.message]).includes('OLD FULL CARD')), 'raw journal retains the old events');
  result = await request(qq, { extraSections: [{ name: 'clock', text: 'TIME CHANGED' }] });
  assert.equal(result.decision.startsRequestSeries, true);
  assert.equal(occurrences(texts(result.messages), card), 1);
  assert.ok(result.rendered.includes('TIME CHANGED'));
  api.dispose();
});
await test('restart migration removes older duplicates when latest already matches', async () => {
  const qq = agent('qq-resume', 'qq'); const card = 'RESUMED CARD';
  const old = qq.session.append('system/message', { message: message('system', `OLD HOST GUIDANCE\n${wrap('OLD CARD')}`) });
  const latest = `KEEP SYSTEM SAFETY\n\n${wrap(card)}`;
  qq.session.append('system/message', { message: message('system', latest) });
  const api = installPersonaRequestHooks(registry([qq]), { resolve: () => ({ platform: 'qq', text: card }) });
  const result = await request(qq);
  assert.equal(occurrences(texts(result.messages), PERSONA_START), 1);
  assert.ok(texts(result.messages).includes('OLD HOST GUIDANCE'));
  assert.equal(qq.session.eventAt(old.seq), old);
  api.dispose();
});
await test('new purpose section and bounded legacy QQ/Bili wake copies disappear', async () => {
  const qq = agent('qq-migrate', 'qq'); const card = 'CURRENT CORE';
  const qqLegacy = '【当前角色】old\nOLD QQ CARD\n（完整角色卡 / 场景语气 / 推荐值 / 可用工具：可调用 qq_get_prompt 查看）\nKEEP WAKE';
  const biliLegacy = '［统一人设卡 · QQ 和 B站是同一个人］\nOLD BILI CARD\n以上人设对 QQ 与 B站两边同时生效；AGENTS.md 只写日子/流程，不另立人格。\n（人设卡里的 QQ 称呼表不会带进 B站；认人只按身份对齐表，且不得公开对方 QQ 号/群号。）\nKEEP BILI WAKE';
  qq.session.append('user/message', message('user', qqLegacy));
  qq.session.append('user/message', message('user', biliLegacy));
  const api = installPersonaRequestHooks(registry([qq]), { resolve: () => ({ platform: 'qq', text: card }) });
  const result = await request(qq, { extraSections: [{ name: 'purpose', text: `PURPOSE\n${wrap(card)}\nKEEP PURPOSE RULES` }] });
  assert.equal(occurrences(texts(result.messages), card), 1);
  assert.ok(!texts(result.messages).includes('OLD QQ CARD'));
  assert.ok(!texts(result.messages).includes('OLD BILI CARD'));
  for (const keep of ['KEEP WAKE', 'KEEP BILI WAKE', 'KEEP PURPOSE RULES']) assert.ok(texts(result.messages).includes(keep));
  api.dispose();
});
await test('qq_get_prompt JSON retains metadata, memory and exact tool-call pairing', async () => {
  const qq = agent('qq-json', 'qq'); const card = 'TOOL PERSONA';
  const call = message('assistant', 'KEEP ASSISTANT', { content: [{ type: 'tool-call', id: 'call-1', name: 'mcp__snowluma__qq_get_prompt', arguments: { key: 'group:test' } }] });
  qq.session.append('assistant/message', { message: call });
  const payload = { ok: true, role: { name: 'ROLE', mode: 'full', hint: `${wrap(card)}\nKEEP ADMIN` }, memory: { text: 'KEEP MEMORY' }, tools: ['qq_read'] };
  const tool = message('tool', JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false }), { toolCallId: 'call-1', source: { kind: 'tool', callId: 'call-1' }, isError: false });
  const event = qq.session.append('tool/result', { message: tool, duration: 123, custom: 'KEEP EVENT' });
  const api = installPersonaRequestHooks(registry([qq]), { resolve: () => ({ platform: 'qq', text: card }) });
  await request(qq);
  const rewritten = qq.session.surface.nodes.map(seq => qq.session.eventAt(seq)).find(item => item.type === 'tool/result');
  const parsed = JSON.parse(JSON.parse(texts([rewritten.data.message])).content[0].text);
  assert.deepEqual(parsed, { ...payload, role: { ...payload.role, hint: '\nKEEP ADMIN' } });
  assert.equal(rewritten.data.message.id, tool.id);
  assert.equal(rewritten.data.message.toolCallId, 'call-1');
  assert.equal(rewritten.data.custom, 'KEEP EVENT');
  assert.equal(qq.session.eventAt(event.seq), event);
  assert.equal(qq.session.eventAt(0).data.message, call);
  api.dispose();
});
await test('legacy role.hint callback sees exact field and preserves suffix', async () => {
  const qq = agent('qq-old-json', 'qq'); let seen = false;
  qq.session.append('assistant/message', { message: message('assistant', '', { content: [{ type: 'tool-call', id: 'call-old', name: 'qq_get_prompt', arguments: {} }] }) });
  qq.session.append('tool/result', { message: message('tool', JSON.stringify({ role: { name: 'OLD', hint: 'LEGACY CORE\nKEEP MEMORY' }, tools: ['keep'] }), { toolCallId: 'call-old' }) });
  const api = installPersonaRequestHooks(registry([qq]), { resolve: () => ({ platform: 'qq', text: 'CURRENT' }), stripLegacyText: (text, meta) => {
    if (meta.field !== 'role.hint') return text;
    assert.equal(meta.role, 'tool'); assert.equal(meta.toolName, 'qq_get_prompt'); assert.equal(meta.agent, qq); seen = true;
    return text.replace('LEGACY CORE\n', '');
  } });
  const result = await request(qq);
  assert.equal(seen, true);
  assert.ok(!texts(result.messages).includes('LEGACY CORE'));
  assert.ok(texts(result.messages).includes('KEEP MEMORY'));
  api.dispose();
});
await test('unrelated user text, images, assistant and other tool results are preserved', async () => {
  const qq = agent('qq-safe', 'qq'); const source = message('user', '真实消息 {{untouched}} 【当前角色】讨论', { content: [{ type: 'text', text: 'REAL MESSAGE' }, { type: 'image', url: 'test:unchanged' }] });
  qq.session.append('user/message', source);
  const other = message('tool', JSON.stringify({ role: { hint: wrap('NOT OUR TOOL') } }), { toolCallId: 'foreign' });
  qq.session.append('tool/result', { message: other });
  const api = installPersonaRequestHooks(registry([qq]), { resolve: () => ({ platform: 'qq', text: 'CURRENT SAFE' }) });
  const result = await request(qq);
  assert.ok(result.messages.includes(source)); assert.ok(result.messages.includes(other));
  assert.equal(stripPersonaBlocks('a <!-- surfcore-persona:start --> incomplete'), 'a <!-- surfcore-persona:start --> incomplete');
  api.dispose();
});
await test('existing and created agents are isolated; ordinary sessions remain untouched', async () => {
  const qq = agent('qq-scope', 'qq'); const plain = agent('ordinary'); const ctx = registry([qq, plain]);
  const cards = { qq: 'QQ ONLY', bili: 'BILI ONLY', pet: 'PET ONLY' };
  const api = installPersonaRequestHooks(ctx, { resolve: a => a.platform ? { platform: a.platform, text: cards[a.platform] } : null });
  const bili = agent('bili-scope', 'bili'); const pet = agent('pet-scope', 'pet');
  await ctx.emit('agent/created', { agent: bili }); await ctx.emit('agent/created', { agent: pet }); await ctx.emit('agent/created', { agent: qq });
  for (const target of [qq, bili, pet]) {
    const result = await request(target); assert.equal(occurrences(texts(result.messages), cards[target.platform]), 1);
    for (const [platform, card] of Object.entries(cards)) if (target.platform !== platform) assert.ok(!texts(result.messages).includes(card));
  }
  const normal = message('user', wrap('ORDINARY CONTENT'));
  const result = await request(plain, { pending: [normal] }); assert.equal(result.decision.messages[0], normal);
  assert.equal(api.getStatus().attachedAgents, 4);
  await ctx.emit('agent/disposed', { agent: bili }); assert.equal(bili.ctx.sections.size, 0);
  api.dispose(); api.dispose();
  for (const target of [qq, plain, bili, pet]) {
    assert.equal(target.ctx.sections.size, 0);
    assert.equal([...target.ctx.listeners.values()].flat().length, 0);
  }
  assert.equal([...ctx.listeners.values()].flat().length, 0);
  assert.equal(api.getStatus().active, false);
});
await test('decision fields and reject/abort decisions survive unchanged', async () => {
  const qq = agent('qq-decision', 'qq'); const api = installPersonaRequestHooks(registry([qq]), { resolve: () => ({ platform: 'qq', text: 'CARD' }) });
  for (const kind of ['reject', 'abort']) { const result = await request(qq, { kind }); assert.equal(result.decision, result.originalDecision); }
  await request(qq);
  const result = await request(qq, { startsRequestSeries: true });
  assert.equal(result.decision.startsRequestSeries, true); assert.equal(result.decision.extraProviderField, 42);
  api.dispose();
});
await test('disabled persona clears previous copies and incapable provider keeps one', async () => {
  const qq = agent('qq-disabled', 'qq'); let enabled = true;
  const api = installPersonaRequestHooks(registry([qq]), { resolve: () => enabled ? { platform: 'qq', text: 'REMOVABLE' } : null });
  await request(qq, { inHistory: false });
  let result = await request(qq, { inHistory: false }); assert.equal(occurrences(texts(result.messages), 'REMOVABLE'), 1);
  enabled = false; result = await request(qq); assert.equal(occurrences(texts(result.messages), 'REMOVABLE'), 0);
  assert.ok(result.rendered.includes('KEEP SYSTEM SAFETY'));
  api.dispose();
});
await test('resolver and surface failures stop the request and expose actionable metadata', async () => {
  const qq = agent('qq-error', 'qq'); let fail = true; const updates = [];
  const api = installPersonaRequestHooks(registry([qq]), { resolve: () => { if (fail) throw new RangeError('private persona rejected'); return { platform: 'qq', text: 'RECOVERED' }; }, onUpdate: value => updates.push(value) });
  await assert.rejects(request(qq), /private persona rejected/);
  assert.equal(api.getStatus().error.code, 'PERSONA_REQUEST_FAILED'); assert.ok(api.getStatus().error.hint);
  assert.ok(!JSON.stringify(updates).includes('private persona rejected'));
  fail = false; await request(qq); assert.equal(api.getStatus().error, null);
  qq.session.append('user/message', message('user', wrap('STALE')));
  const append = qq.session.append; qq.session.append = () => { throw new Error('surface denied'); };
  await assert.rejects(request(qq), /surface denied/); assert.ok(api.getStatus().error.hint);
  qq.session.append = append;
  api.dispose();
});
await test('invalid async resolver fails and partial installation disposes earlier registrations', async () => {
  const qq = agent('qq-async', 'qq'); const ctx = registry([qq]);
  const api = installPersonaRequestHooks(ctx, { resolve: async () => ({ platform: 'qq', text: 'BAD' }) });
  await assert.rejects(request(qq), /synchronous/); api.dispose();
  const empty = installPersonaRequestHooks(ctx, { resolve: () => ({ platform: 'qq', text: '' }) });
  await assert.rejects(request(qq), /persona resolve must return/); assert.ok(empty.getStatus().error.hint); empty.dispose();
  const valid = agent('valid'); const broken = { id: 'broken', ctx: {} }; const root = registry([valid, broken]);
  assert.throws(() => installPersonaRequestHooks(root, { resolve: () => null }), /agent-scoped/);
  assert.equal(valid.ctx.sections.size, 0); assert.equal([...root.listeners.values()].flat().length, 0);
});
await test('filtered or shadowed persona providers recover one current section without touching ordinary sessions', async () => {
  const qq = agent('qq-filter', 'qq'); const plain = agent('plain-filter'); const ctx = registry([qq, plain]);
  let card = 'FILTERED CURRENT'; let resolves = 0;
  const api = installPersonaRequestHooks(ctx, { resolve: target => { if (!target.platform) return null; resolves++; return { platform: target.platform, text: card }; } });
  const filter = async (assembly, context, next) => { const result = await next(); return { ...result, sections: result.sections.filter(section => section.name !== PERSONA_SECTION) }; };
  qq.ctx.on('system-prompt/assemble', filter); plain.ctx.on('system-prompt/assemble', filter);
  let result = await request(qq);
  assert.equal(occurrences(result.rendered, card), 1); assert.equal(result.assembled.sections.filter(section => section.name === PERSONA_SECTION).length, 1);
  qq.ctx.sections.delete(PERSONA_SECTION); // The scoped provider itself never runs again.
  card = 'SHADOWED CURRENT'; result = await request(qq);
  assert.equal(occurrences(result.rendered, card), 1); assert.equal(resolves, 2);
  card = 'SHADOWED CHANGED'; result = await request(qq);
  assert.equal(occurrences(result.rendered, card), 1); assert.equal(resolves, 3);
  const normal = await request(plain); assert.equal(normal.assembled.sections.some(section => section.name === PERSONA_SECTION), false);
  const fresh = agent('qq-never-resolved', 'qq'); await ctx.emit('agent/created', { agent: fresh });
  fresh.ctx.sections.delete(PERSONA_SECTION);
  const recovered = await request(fresh); assert.equal(occurrences(recovered.rendered, card), 1); assert.equal(resolves, 4);
  api.dispose();
});
await test('complete override and duplicate final cards stop before provider dispatch without mutating requests', async () => {
  const qq = agent('qq-integrity', 'qq'); const plain = agent('plain-integrity'); const ctx = registry([qq, plain]);
  const card = 'GUARDED{{literal}}';
  const api = installPersonaRequestHooks(ctx, { resolve: target => target.platform ? { platform: target.platform, text: card } : null });
  let dispatched = 0; const output = (async function* () {})(); const terminal = () => { dispatched++; return output; };
  const overridden = await request(qq, { completePrompt: 'COMPLETE REPLACED ALL SECTIONS' });
  const rejected = freeze({ sessionId: qq.session.id, messages: overridden.messages }); const before = JSON.stringify(rejected);
  assert.throws(() => stream(ctx, rejected, terminal), /exactly once/);
  assert.equal(dispatched, 0); assert.equal(JSON.stringify(rejected), before);
  assert.equal(api.getStatus().error.code, 'PERSONA_REQUEST_INTEGRITY'); assert.ok(api.getStatus().error.hint);
  const valid = await request(qq); const accepted = freeze({ sessionId: qq.session.id, messages: valid.messages });
  assert.equal(stream(ctx, accepted, terminal), output); assert.equal(dispatched, 1);
  const duplicate = freeze({ sessionId: qq.session.id, messages: [...valid.messages, message('user', wrap(card))] });
  assert.throws(() => stream(ctx, duplicate, terminal), /exactly once/); assert.equal(dispatched, 1);
  const truncated = freeze({ sessionId: qq.session.id, messages: [message('system', wrap('GUARDED'))] });
  assert.throws(() => stream(ctx, truncated, terminal), /exactly once/);
  assert.equal(stream(ctx, freeze({ sessionId: plain.session.id, messages: [] }), terminal), output);
  assert.equal(stream(ctx, freeze({ sessionId: qq.session.id, purpose: 'compaction', messages: [] }), terminal), output);
  assert.equal(stream(ctx, freeze({ sessionId: 'unrelated', messages: [] }), terminal), output);
  const fresh = agent('qq-before-assembly', 'qq'); await ctx.emit('agent/created', { agent: fresh });
  assert.throws(() => stream(ctx, freeze({ sessionId: fresh.session.id, messages: [] }), terminal), /exactly once/);
  api.dispose(); assert.equal((ctx.listeners.get('llm/stream') ?? []).length, 0);
});

const sdkArg = process.argv.indexOf('--sdk-root');
if (sdkArg >= 0) await test('installed SDK scoped assembly and append-only surface replacement', async () => {
  const { resolve: resolvePath } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const sdkRoot = resolvePath(process.argv[sdkArg + 1]);
  const load = name => import(pathToFileURL(resolvePath(sdkRoot, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href);
  const [{ Context }, { createScope, scopeTarget }, { SystemPrompt, renderPrompt }, { Session }, llm] = await Promise.all([
    load('cordis'), load('dsh-scope'), load('dsh-system-prompt'), load('dsh-session'), load('dsh-llm'),
  ]);
  const root = new Context();
  const promptFiber = root.plugin(SystemPrompt, { includeHarnessIdentity: false });
  await promptFiber.await();
  const owned = [];
  root.provide('agents', { list: () => owned });
  const target = { id: 'detached-persona-smoke', session: Session.create('detached-persona-smoke') };
  let binding, api, pluginCtx;
  let card = 'SDK-LITERAL{{not_registered}}';
  const hookFiber = root.inject(['agents', 'systemPrompt'], ctx => {
    pluginCtx = ctx; binding = createScope(ctx, target);
    target.ctx = binding.ctx; owned.push(target);
    api = installPersonaRequestHooks(ctx, { resolve: () => ({ platform: 'qq', text: card }) });
  });
  await hookFiber.await();
  assert.ok(api, 'injected persona hook starts');
  try {
    target.session.append('system/message', { message: llm.createSystemMessage(`OLD RULES\n${wrap('OLD SDK CARD')}`) }, { surfaceOp: 'append' });
    const raw = llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `WAKE\n${wrap('OLD SDK CARD')}\nKEEP SDK CHAT` }] });
    target.session.append('user/message', raw, { surfaceOp: 'append' });
    const call = llm.createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'tool-call', id: 'sdk-call', name: 'qq_get_prompt', arguments: {} }] });
    target.session.append('assistant/message', { message: call }, { surfaceOp: 'append' });
    const result = llm.createToolResultMessage({ callId: 'sdk-call', content: [{ type: 'text', text: JSON.stringify({ role: { name: 'KEEP ROLE', hint: `${wrap('OLD SDK CARD')}\nKEEP MEMORY` }, tools: ['keep'] }) }], isError: false });
    target.session.append('tool/result', { message: result, durationMs: 10 }, { surfaceOp: 'append' });
    const assemble = () => target.ctx.systemPrompt.assemble({ agent: target, scope: target });
    const step = () => root.waterfall(scopeTarget(target, target), 'agent/pre-step', { agent: target, messages: [] }, () => Promise.resolve({ kind: 'enter', messages: [], keep: true }));
    const assembled = await assemble();
    const rendered = renderPrompt(assembled);
    assert.equal(occurrences(rendered, card), 1);
    assert.equal(assembled.sections.find(section => section.name === PERSONA_SECTION).interpolate, false);
    let decision = await step(); assert.equal(decision.keep, true); assert.equal(decision.startsRequestSeries, true);
    assert.ok(!texts(target.session.deriveMessages()).includes('OLD SDK CARD'));
    assert.ok(texts(target.session.deriveMessages()).includes('KEEP SDK CHAT'));
    const cleanedTool = target.session.deriveMessages().find(item => item.role === 'tool');
    assert.equal(cleanedTool.toolCallId, 'sdk-call');
    assert.equal(cleanedTool.id, result.id);
    assert.deepEqual(JSON.parse(texts([cleanedTool])), { role: { name: 'KEEP ROLE', hint: '\nKEEP MEMORY' }, tools: ['keep'] });
    const head = target.session.surface.nodes[0];
    target.session.append('system/message', { message: llm.createSystemMessage(rendered) }, { surfaceOp: { op: 'replace', startSeq: head, endSeq: head }, sourceEventSeqs: [head] });
    await assemble(); decision = await step(); assert.equal(decision.startsRequestSeries, false);
    card = 'SDK-CHANGED'; await assemble(); decision = await step(); assert.equal(decision.startsRequestSeries, true);
    assert.ok(!texts(target.session.deriveMessages()).includes('SDK-LITERAL'));
    const global = await pluginCtx.systemPrompt.assemble({}); assert.ok(!renderPrompt(global).includes(card));
    let dispatched = 0; const output = (async function* () {})();
    const runtime = { ctx: root, adapterStream: () => { dispatched++; return output; } };
    const send = text => llm.LlmRuntime.prototype.streamWithRegistration.call(runtime, freeze({ sessionId: target.session.id, messages: [llm.createSystemMessage(text)] }));
    const removeComplete = target.ctx.systemPrompt.section({ name: 'complete-test', order: 0, complete: true, text: 'COMPLETE OVERRIDE' });
    try {
      const overridden = renderPrompt(await assemble()); assert.equal(overridden, 'COMPLETE OVERRIDE');
      assert.throws(() => send(overridden), /exactly once/); assert.equal(dispatched, 0);
      assert.equal(api.getStatus().error.code, 'PERSONA_REQUEST_INTEGRITY');
    } finally { removeComplete(); }
    assert.equal(send(renderPrompt(await assemble())), output); assert.equal(dispatched, 1);
    api.dispose();
    assert.ok(!(await assemble()).sections.some(section => section.name === PERSONA_SECTION));
  } finally { api.dispose(); await binding.dispose(); await hookFiber.dispose(); await promptFiber.dispose(); }
});
console.log(`persona-request: ${passed} tests passed (no network or live sessions)`);
