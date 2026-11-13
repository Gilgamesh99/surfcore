import assert from 'node:assert/strict';
import { inspect } from 'node:util';
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
const roots = new WeakMap();
function registry(existing) {
  const ctx = scope(); existing.forEach(agent => roots.set(agent, ctx));
  ctx.agents = { list: () => existing };
  const emit = ctx.emit;
  ctx.emit = (event, data) => { if (event === 'agent/created') roots.set(data.agent, ctx); return emit(event, data); };
  return ctx;
}
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
async function request(agent, { pending = [], extraSections = [], variables = {}, kind = 'enter', startsRequestSeries, inHistory = true, completePrompt, verify = true } = {}) {
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
  const messages = agent.session.surface.nodes.map(seq => (agent.session.eventAt(seq).type === 'user/message' ? agent.session.eventAt(seq).data : agent.session.eventAt(seq).data.message)).filter(Boolean);
  if (verify) stream(roots.get(agent), freeze({ sessionId: agent.session.id, messages }), () => null);
  return { decision: next, rendered, assembled, messages };
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
  const overridden = await request(qq, { completePrompt: 'COMPLETE REPLACED ALL SECTIONS', verify: false });
  const rejected = freeze({ sessionId: qq.session.id, messages: overridden.messages }); const before = JSON.stringify(rejected);
  assert.throws(() => stream(ctx, rejected, terminal), /缺少当前人格卡/);
  assert.equal(api.getStatus().error.reason, 'missing');
  assert.equal(dispatched, 0); assert.equal(JSON.stringify(rejected), before);
  assert.equal(api.getStatus().error.code, 'PERSONA_REQUEST_INTEGRITY'); assert.ok(api.getStatus().error.hint);
  const valid = await request(qq); const accepted = freeze({ sessionId: qq.session.id, messages: valid.messages });
  assert.equal(stream(ctx, accepted, terminal), output); assert.equal(dispatched, 1);
  const duplicate = freeze({ sessionId: qq.session.id, messages: [...valid.messages, message('system', wrap(card))] });
  assert.throws(() => stream(ctx, duplicate, terminal), /多份人格卡/);
  assert.equal(api.getStatus().error.reason, 'duplicate'); assert.equal(dispatched, 1);
  const truncated = freeze({ sessionId: qq.session.id, messages: [message('system', wrap('GUARDED'))] });
  assert.throws(() => stream(ctx, truncated, terminal), /与当前角色不一致/);
  assert.equal(api.getStatus().error.reason, 'mismatch');
  const incomplete = freeze({ sessionId: qq.session.id, messages: [message('system', PERSONA_START + '\nCUT')] });
  assert.throws(() => stream(ctx, incomplete, terminal), /人格区块不完整/);
  assert.equal(api.getStatus().error.reason, 'incomplete');
  assert.deepEqual(api.getStatus().error.counts, { systemBlocks: 0, matchingSystemBlocks: 0, systemStarts: 1, systemEnds: 0, directToolCopies: 0, ptcToolCopies: 0 });
  assert.equal(stream(ctx, freeze({ sessionId: plain.session.id, messages: [] }), terminal), output);
  assert.equal(stream(ctx, freeze({ sessionId: qq.session.id, purpose: 'compaction', messages: [] }), terminal), output);
  assert.equal(stream(ctx, freeze({ sessionId: 'unrelated', messages: [] }), terminal), output);
  const fresh = agent('qq-before-assembly', 'qq'); await ctx.emit('agent/created', { agent: fresh });
  assert.throws(() => stream(ctx, freeze({ sessionId: fresh.session.id, messages: [] }), terminal), /缺少当前人格卡/);
  api.dispose(); assert.equal((ctx.listeners.get('llm/stream') ?? []).length, 0);
});

// Reproduce the old builder with synthetic data; no live card, token or session.
const clipNotice = '\n…（素材过长，已省略中间部分）…\n';
const clippedWake = () => {
  const prefix = '【主动找主人 · 目的回合】\n现在是测试时间。\n\n【你的身份与记忆（背景）】\nKEEP ROLE\n【人格卡（你是这样的人）】\n';
  const full = prefix + wrap('【身份底座】\nOLD-CLIPPED-CARD\n' + '旧'.repeat(10000))
    + '\n【记忆卡】\n' + 'KEEP MATERIAL\n'.repeat(1300) + '\n【现在做】\nKEEP SEND RULES AND MEMO\n【待续】无';
  return '【当前时间】2026-11-13 19:15 +08:00\n\n' + full.slice(0, 8800) + clipNotice + full.slice(-5600);
};
function appendCall(target, id, name) {
  return target.session.append('assistant/message', { message: message('assistant', '', { content: [{ type: 'tool-call', id, name, arguments: {} }] }) });
}
function appendDispatch(target, { id = 'inner', parent = 'outer', root = parent, name = 'mcp__snowluma__qq_get_prompt', isError = false, startOnly = false } = {}) {
  const data = { rootCallId: root, parentCallId: parent, subCallId: id, name, arguments: {} };
  target.session.append('tool/ptc-dispatch-start', data, {});
  if (!startOnly) target.session.append('tool/ptc-dispatch', { ...data, isError, content: [] }, {});
}
await test('clipped old purpose wakes recover historical and pending messages without losing the tail', async () => {
  const qq = agent('qq-clipped-wake', 'qq'); const ctx = registry([qq]);
  const api = installPersonaRequestHooks(ctx, { resolve: () => ({ platform: 'qq', text: 'CURRENT INTACT CARD' }) });
  await request(qq);
  const clipped = clippedWake();
  assert.equal(occurrences(clipped, PERSONA_START), 1); assert.equal(occurrences(clipped, PERSONA_END), 0);
  const original = message('user', clipped); const raw = qq.session.append('user/message', original);
  const pending = message('user', clipped);
  const result = await request(qq, { pending: [pending] });
  const repaired = result.messages.filter(item => item.role === 'user');
  assert.equal(repaired.length, 2);
  const expected = clipped.slice(0, clipped.indexOf(PERSONA_START)) + clipped.slice(clipped.indexOf(clipNotice));
  for (const item of repaired) assert.equal(texts([item]), expected);
  assert.ok(texts(repaired).includes('KEEP SEND RULES AND MEMO'));
  assert.equal(occurrences(texts(result.messages), 'CURRENT INTACT CARD'), 1);
  assert.equal(qq.session.eventAt(raw.seq).data, original); assert.equal(texts([pending]), clipped);
  assert.equal(result.decision.startsRequestSeries, true);
  assert.equal(api.getStatus().revision, '20261113-persona-recovery'); assert.equal(api.getStatus().error, null);
  api.dispose();
});
await test('marker discussion, unrelated tools and lookalike truncation notices remain data', async () => {
  const qq = agent('qq-marker-discussion', 'qq'); const ctx = registry([qq]);
  const api = installPersonaRequestHooks(ctx, { resolve: () => ({ platform: 'qq', text: 'CURRENT QUOTE SAFE' }) });
  const quoted = [
    message('user', 'Discuss ' + PERSONA_START + ' and ' + PERSONA_END + ' as delimiters.'),
    message('user', 'Empty delimiter example:\n' + PERSONA_START + '\n' + PERSONA_END),
    message('user', 'Not a generated wake ' + PERSONA_START + '\nquoted fragment' + clipNotice + 'KEEP TAIL'),
    message('assistant', 'Example start marker: ' + PERSONA_START),
    message('assistant', 'Example delimiters: ' + PERSONA_START + ' ... ' + PERSONA_END),
    message('tool', JSON.stringify({ role: { hint: wrap('FOREIGN DATA') } }), { toolCallId: 'unknown' }),
  ];
  for (const item of quoted) qq.session.append(item.role === 'user' ? 'user/message' : item.role === 'tool' ? 'tool/result' : 'assistant/message', item.role === 'user' ? item : { message: item });
  const result = await request(qq);
  for (const item of quoted) assert.ok(result.messages.includes(item), 'quotations retain object identity');
  api.dispose();
});
await test('code-mode output wrappers, escaped JSON and console logs clean before the final frozen request', async () => {
  const old = 'OLD TOOL CARD\nEND';
  const payload = { ok: true, role: { name: 'KEEP ROLE', hint: wrap(old) + '\nKEEP ADMIN' }, memory: { text: 'KEEP MEMORY' }, keep: [1, false, null], tools: ['qq_read'] };
  const mcp = { content: [{ type: 'text', text: JSON.stringify(payload) }, { type: 'image', data: 'KEEP IMAGE BYTES' }], structuredContent: payload };
  const variants = [
    JSON.stringify(payload), JSON.stringify(mcp), JSON.stringify([{ result: { deeply: [payload] } }]),
    JSON.stringify({ result: JSON.stringify(mcp) }), JSON.stringify(wrap(old) + '\nKEEP ADMIN'),
    JSON.stringify(mcp).replaceAll('<', '\\u003c'),
    inspect(mcp, { depth: 8, maxStringLength: 10000, colors: false }),
    'KEEP LOG PREFIX\n' + JSON.stringify(payload) + '\nKEEP LOG SUFFIX\n' + JSON.stringify(mcp),
  ];
  for (const [index, text] of variants.entries()) {
    const qq = agent('qq-code-' + index, 'qq'); const ctx = registry([qq]);
    const api = installPersonaRequestHooks(ctx, { resolve: () => ({ platform: 'qq', text: 'CURRENT CODE CARD' }) });
    await request(qq);
    // Only the nested journal record is needed; the assistant call may be absent.
    appendDispatch(qq);
    const image = { type: 'image', data: 'KEEP BINARY', mimeType: 'image/png' };
    const tool = message('tool', text, { toolCallId: 'outer', source: { kind: 'tool', callId: 'outer' }, content: [{ type: 'text', text }, image] });
    const raw = qq.session.append('tool/result', { message: tool, durationMs: 17, custom: 'KEEP EVENT' });
    const result = await request(qq); const rewritten = result.messages.find(item => item.role === 'tool');
    assert.equal(occurrences(texts([rewritten]), PERSONA_START), 0, 'variant ' + index);
    assert.ok(texts([rewritten]).includes('KEEP ADMIN'));
    assert.equal(rewritten.id, tool.id); assert.equal(rewritten.toolCallId, 'outer'); assert.equal(rewritten.content[1], image);
    assert.equal(qq.session.eventAt(raw.seq).data.message, tool);
    if (index < 6) {
      const normalized = value => {
        if (typeof value === 'string') { try { return normalized(JSON.parse(value)); } catch { return stripPersonaBlocks(value); } }
        if (Array.isArray(value)) return value.map(normalized);
        return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalized(child)])) : value;
      };
      assert.deepEqual(normalized(JSON.parse(texts([rewritten]))), normalized(JSON.parse(text)), 'JSON values and non-persona fields survive');
    }
    assert.equal(result.decision.startsRequestSeries, true);
    assert.equal(api.getStatus().lastUpdate.rewrittenMessages, 1);
    const stable = await request(qq); assert.equal(stable.decision.startsRequestSeries, false);
    api.dispose();
  }
});
await test('raw journal provenance survives compaction and propagates to parent and root results', async () => {
  const qq = agent('qq-ancestry', 'qq'); const ctx = registry([qq]);
  const direct = appendCall(qq, 'direct', 'qq_get_prompt');
  const outer = appendCall(qq, 'root', 'run_code');
  appendDispatch(qq, { id: 'parent', parent: 'root', root: 'root', name: 'run_code', isError: true });
  appendDispatch(qq, { id: 'leaf', parent: 'parent', root: 'root' });
  for (const id of ['direct', 'parent', 'root']) qq.session.append('tool/result', { message: message('tool', JSON.stringify({ role: { hint: wrap('OLD ANCESTRY') }, keep: id }), { toolCallId: id }) });
  qq.session.surface.nodes = qq.session.surface.nodes.filter(seq => seq !== direct.seq && seq !== outer.seq);
  const api = installPersonaRequestHooks(ctx, { resolve: () => ({ platform: 'qq', text: 'ANCESTRY CURRENT' }) });
  const result = await request(qq);
  assert.ok(!texts(result.messages).includes('OLD ANCESTRY'));
  assert.equal(api.getStatus().lastUpdate.rewrittenMessages, 3);
  assert.equal(qq.session.eventAt(direct.seq).data.message.content[0].name, 'qq_get_prompt');
  api.dispose();
});
await test('start-only, failed and unrelated child dispatches do not claim other tool data', async () => {
  const qq = agent('qq-failed-dispatch', 'qq'); const ctx = registry([qq]);
  const api = installPersonaRequestHooks(ctx, { resolve: () => ({ platform: 'qq', text: 'FAILED DISPATCH CURRENT' }) });
  appendDispatch(qq, { id: 'start-child', parent: 'start', startOnly: true });
  appendDispatch(qq, { id: 'error-child', parent: 'error', isError: true });
  appendDispatch(qq, { id: 'other-child', parent: 'other', name: 'qq_read' });
  const originals = ['start', 'error', 'other', 'no-provenance'].map(id => message('tool', JSON.stringify({ role: { hint: wrap('KEEP FOREIGN CARD') } }), { toolCallId: id }));
  for (const original of originals) qq.session.append('tool/result', { message: original });
  const result = await request(qq); for (const original of originals) assert.ok(result.messages.includes(original));
  assert.equal(api.getStatus().lastUpdate.rewrittenMessages, 0); api.dispose();
});
await test('unrepaired known copies report direct or PTC counts without leaking persona text', async () => {
  const qq = agent('qq-late-copy', 'qq'); const ctx = registry([qq]); const card = 'PRIVATE CARD SENTINEL';
  const api = installPersonaRequestHooks(ctx, { resolve: () => ({ platform: 'qq', text: card }) });
  const valid = await request(qq); appendCall(qq, 'late-direct', 'qq_get_prompt'); appendDispatch(qq, { parent: 'late-ptc' });
  for (const [id, field] of [['late-direct', 'directToolCopies'], ['late-ptc', 'ptcToolCopies']]) {
    const options = freeze({ sessionId: qq.session.id, messages: [...valid.messages, message('tool', JSON.stringify({ result: [{ role: { hint: wrap(card) } }] }), { toolCallId: id })] });
    const before = JSON.stringify(options); let dispatched = false;
    assert.throws(() => stream(ctx, options, () => { dispatched = true; }), /工具历史仍含重复人格卡/);
    assert.equal(dispatched, false); assert.equal(JSON.stringify(options), before);
    const error = api.getStatus().error; assert.equal(error.reason, 'history-copy'); assert.equal(error.counts[field], 1);
    assert.equal(error.counts.matchingSystemBlocks, 1); assert.ok(error.hint);
    assert.ok(!JSON.stringify(error).includes(card)); error.counts[field] = 99; assert.equal(api.getStatus().error.counts[field], 1);
  }
  api.dispose();
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
    let dispatched = 0; const output = (async function* () {})();
    const runtime = { ctx: root, adapterStream: () => { dispatched++; return output; } };
    const send = (messages = target.session.deriveMessages()) => llm.LlmRuntime.prototype.streamWithRegistration.call(runtime, freeze({ sessionId: target.session.id, messages }));
    assert.equal(send(), output); assert.equal(dispatched, 1);
    const ptcCall = llm.createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'tool-call', id: 'sdk-outer', name: 'run_code', arguments: {} }] });
    target.session.append('assistant/message', { message: ptcCall }, { surfaceOp: 'append' });
    appendDispatch(target, { id: 'sdk-inner', parent: 'sdk-outer' });
    const payload = { role: { name: 'KEEP SDK ROLE', hint: wrap(card) + '\nKEEP SDK ADMIN' }, keep: { number: 42 } };
    const envelope = { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
    const wrapped = llm.createToolResultMessage({ callId: 'sdk-outer', isError: false, content: [
      { type: 'text', text: JSON.stringify([{ result: envelope }]) },
      { type: 'text', text: 'KEEP LOG\n' + inspect(envelope, { depth: 8 }) + '\nKEEP LOG TAIL' },
    ] });
    const wrappedRaw = target.session.append('tool/result', { message: wrapped, durationMs: 21 }, { surfaceOp: 'append' });
    const clipped = llm.createUserMessage({ source: { kind: 'user', rpcId: 'offline-rpc' }, content: [{ type: 'text', text: clippedWake() }] });
    const clippedRaw = target.session.append('user/message', clipped, { surfaceOp: 'append' });
    await assemble(); decision = await step(); assert.equal(decision.startsRequestSeries, true);
    assert.equal(api.getStatus().lastUpdate.rewrittenMessages, 2);
    const actualMessages = target.session.deriveMessages();
    assert.ok(!texts(actualMessages).includes('OLD-CLIPPED-CARD'));
    assert.ok(texts(actualMessages).includes('KEEP SEND RULES AND MEMO'));
    assert.equal(occurrences(texts(actualMessages), PERSONA_START), 1);
    const actualTool = actualMessages.find(item => item.toolCallId === 'sdk-outer');
    assert.equal(actualTool.id, wrapped.id);
    assert.equal(JSON.parse(actualTool.content[0].text)[0].result.structuredContent.role.hint, '\nKEEP SDK ADMIN');
    assert.deepEqual(target.session.eventAt(wrappedRaw.seq).data.message, wrapped);
    assert.deepEqual(target.session.eventAt(clippedRaw.seq).data, clipped);
    assert.equal(send(), output); assert.equal(dispatched, 2);
    await assemble(); decision = await step(); assert.equal(decision.startsRequestSeries, false);
    assert.equal(send(), output); assert.equal(dispatched, 3);
    card = 'SDK-CHANGED'; const changed = renderPrompt(await assemble()); decision = await step(); assert.equal(decision.startsRequestSeries, true);
    assert.ok(!texts(target.session.deriveMessages()).includes('SDK-LITERAL'));
    const currentHead = target.session.surface.nodes[0];
    target.session.append('system/message', { message: llm.createSystemMessage(changed) }, { surfaceOp: { op: 'replace', startSeq: currentHead, endSeq: currentHead }, sourceEventSeqs: [currentHead] });
    const global = await pluginCtx.systemPrompt.assemble({}); assert.ok(!renderPrompt(global).includes(card));
    assert.equal(send(), output); assert.equal(dispatched, 4);
    const removeComplete = target.ctx.systemPrompt.section({ name: 'complete-test', order: 0, complete: true, text: 'COMPLETE OVERRIDE' });
    try {
      const overridden = renderPrompt(await assemble()); assert.equal(overridden, 'COMPLETE OVERRIDE');
      const badMessages = [llm.createSystemMessage(overridden), ...target.session.deriveMessages().filter(item => item.role !== 'system')];
      assert.throws(() => send(badMessages), /缺少当前人格卡/); assert.equal(dispatched, 4);
      assert.equal(api.getStatus().error.reason, 'missing');
    } finally { removeComplete(); }
    await assemble(); assert.equal(send(), output); assert.equal(dispatched, 5);
    api.dispose();
    assert.ok(!(await assemble()).sections.some(section => section.name === PERSONA_SECTION));
  } finally { api.dispose(); await binding.dispose(); await hookFiber.dispose(); await promptFiber.dispose(); }
});
console.log(`persona-request: ${passed} tests passed (no network or live sessions)`);
