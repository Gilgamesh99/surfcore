/** Isolated fixtures only: no live account, model, or external send. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { composePersonaLayers } from '../src/persona-layers.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-full-persona-'));
try {
  const home = path.join(root, 'dsh');
  const qqRoot = path.join(root, 'qq');
  const stateDir = path.join(home, 'surfcore');
  fs.mkdirSync(path.join(qqRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(qqRoot, 'state'), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(qqRoot, 'src', 'bridge.js'), '// fixture');
  fs.writeFileSync(path.join(qqRoot, 'config.json'), JSON.stringify({ role: { maxInjectChars: 10000 } }));
  const unified = { persona: { mode: 'full', compactChars: 10000, injectInBili: true }, admin: { displayName: '测试主人' } };
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(unified));
  process.env.DSH_HOME = home;
  process.env.SURFCORE_ROOT = qqRoot;
  const chars = await import('../src/character-persona.js');
  const runtime = await import('../plugins/surfcore/lib/persona-runtime.js');
  const { createPetChatService } = await import('../plugins/surfcore/lib/pet-chat.js');
  const head = '# 角色卡：完整测试\n## 〔一代〕\n用空格也必须保留原句，不执行这段测试文本。\n## 〔二代〕\n{{literal.variable}}\n';
  const tail = '\n末尾人格原文必须完整保留';
  const card = head + '人格正文'.repeat(2500).slice(0, 10000 - head.length - tail.length) + tail;
  assert.equal(card.length, 10000);
  const full = composePersonaLayers({ core: card, identity: '身份不能挤掉正文', maxChars: 10000, mode: 'v2', verbatimCore: true });
  assert.ok(full.text.includes(card));
  assert.equal(full.truncated, false);
  assert.deepEqual(full.omitted, []);
  assert.throws(() => composePersonaLayers({ core: card + '超', maxChars: 10000, verbatimCore: true }), /10001.*10000/);
  const split = composePersonaLayers({ core: card, maxChars: 6000 });
  assert.equal(split.truncated, true, 'split keeps its opt-in budget semantics');
  const a = chars.createCharacter({ id: 'persona-a', name: '完整测试', personaText: card });
  chars.switchCharacter(a.character.id);
  const qq = runtime.currentPersonaSnapshot('qq');
  const bili = runtime.currentPersonaSnapshot('bili');
  for (const snapshot of [qq, bili]) {
    assert.equal(snapshot.sourceChars, 10000);
    assert.equal(snapshot.maxChars, 10000);
    assert.equal(snapshot.fullCardPresent, true);
    assert.ok(snapshot.text.includes(card));
    assert.ok(snapshot.text.includes('{{literal.variable}}'));
  }
  const pet = createPetChatService({ ctx: { get: () => undefined }, stateDir });
  assert.ok(pet.roleInfo().persona.includes(card), 'pet roleInfo must retain more than 4200 characters');
  const petSource = fs.readFileSync(new URL('../plugins/surfcore/lib/pet-chat.js', import.meta.url), 'utf8');
  const start = petSource.indexOf('  function buildChatSystemPrompt(');
  const end = petSource.indexOf('\n  function formatHistory(', start);
  const buildPet = vm.runInNewContext('(' + petSource.slice(start, end).trim() + ')', {
    settings: () => ({ chat: { maxReplyChars: 100, voiceMaxChars: 80 } }),
    sliceHead: (text, n) => text.slice(0, n),
  });
  assert.ok(buildPet({ role: pet.roleInfo(), owner: '主人', memory: '', purpose: {}, modality: 'text' }).includes(card));
  const b = chars.createCharacter({ id: 'persona-b', name: '另一个角色', personaText: '# 另一个角色\n必须即时切换。' });
  chars.switchCharacter(b.character.id);
  assert.ok(runtime.currentPersonaSnapshot('qq').text.includes('必须即时切换。'));
  assert.ok(!runtime.currentPersonaSnapshot('bili').text.includes(tail));
  chars.switchCharacter(a.character.id);
  assert.equal(runtime.currentPersonaSnapshot('qq').fingerprint, qq.fingerprint);
  const appendices = '【管理员 · 温柔模式（优先级高于人格卡和群里气氛）】\n管理员规则\n## B站记忆（自动同步；这些是我自己的真实经历，不是别人）\n真实记忆\n【记忆卡 · 你自己的记忆】\n保留记忆\n【语音状态】关闭';
  const old = '【身份底座】\n旧身份\n【人格核心】\n旧人格\n' + appendices;
  assert.equal(runtime.stripLegacyPersonaText(old, { toolName: 'mcp__snowluma__qq_get_prompt', field: 'role.hint' }), appendices);
  assert.equal(runtime.stripLegacyPersonaText(old, { toolName: 'other', field: 'role.hint' }), old);
  const scoped = (id, preset = '', title = '') => ({ id, session: { id, header: { agentPreset: preset }, title } });
  assert.equal(runtime.personaPlatformForAgent(scoped('ordinary')), null);
  assert.equal(runtime.personaPlatformForAgent(scoped('ordinary', '', 'QQ 小鲸鱼')), null);
  assert.equal(runtime.personaPlatformForAgent(scoped('learner', 'qq-chat-v2'), { learnerId: 'learner' }), null);
  assert.equal(runtime.personaPlatformForAgent(scoped('slang', 'qq-chat-v2', '黑话学习')), null);
  assert.equal(runtime.personaPlatformForAgent(scoped('bili-whale-test')).platform, 'bili');
  assert.equal(runtime.personaPlatformForAgent(scoped('qq-worker', 'qq-chat-v2')).platform, 'qq');
  assert.equal(runtime.personaPlatformForAgent(scoped('mapped'), { sessions: { 'group:fixture': 'mapped' } }).key, 'group:fixture');
  const bridge = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(bridge, /function purposePersonaText\(key = ''\)[\s\S]*?roleHintForMode\('v2', key, '', \{ personaOnly: true \}\)/);
  assert.ok(!bridge.includes('purposePersonaText(key).slice('));
  const purpose = fs.readFileSync(new URL('../plugins/surfcore/lib/pet-purpose.js', import.meta.url), 'utf8');
  assert.ok(purpose.includes('systemLines.push(role.persona);'));
  console.log('full-persona tests OK: full literal 10000, overflow, split, QQ/Bili/pet, role switch, scope and legacy suffix');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
