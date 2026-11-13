/** Live personality selection for model steps. Ordinary DSH sessions are excluded. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { QQ_STATE_DIR } from './paths.js';
import { readUnified, readQqConfig } from './store.js';
import { resolvePersonaFile } from './persona.js';
import { readCurrentCharacter, readPersonaLayerText } from '../../../src/character-persona.js';
import { composePersonaLayers, personaSceneFromKey } from '../../../src/persona-layers.js?rev=20261113-full-persona';
import { buildPersonaIdentity, personaNameFromCard } from '../../../src/persona-identity.js';
import { personaCardBlock } from './scheduler.js';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

/** Pure ownership predicate; names in ordinary conversation text never grant scope. */
export function personaPlatformForAgent(agent, { sessions = {}, learnerId = '' } = {}) {
  const session = agent?.session;
  const id = String(session?.id || agent?.id || '');
  if (!id || id === learnerId) return null;
  if (/^bili-whale(?:-|$)/.test(id)) return { platform: 'bili', key: '' };
  const entry = Object.entries(sessions).find(([, value]) => value === id);
  if (entry) return { platform: 'qq', key: entry[0] };
  const preset = String(session?.header?.agentPreset || '');
  if (preset.startsWith('qq-chat') && !/黑话/.test(String(session?.title || ''))) return { platform: 'qq', key: '' };
  return null;
}

/** Read afresh on every model step, including tool continuations and role changes. */
export function currentPersonaSnapshot(platform, { key = '' } = {}) {
  const unified = readUnified().config;
  const cur = readCurrentCharacter();
  const split = unified.persona?.mode === 'split';
  const file = resolvePersonaFile();
  const core = file ? fs.readFileSync(file, 'utf8') : '';
  const card = (split ? core : (readPersonaLayerText('full') || core)).trim();
  if (!card) throw new Error('当前角色没有可读的人格卡，无法提供完整人格。');
  let text;
  let maxChars;
  if (platform === 'bili') {
    if (unified.persona?.injectInBili === false) return null;
    maxChars = Math.max(600, Math.min(10000, Number(unified.persona?.compactChars) || 2200));
    text = personaCardBlock();
  } else if (platform === 'qq') {
    const configured = Number(readQqConfig().config?.role?.maxInjectChars ?? 6000);
    maxChars = Number.isFinite(configured) ? Math.min(20000, Math.max(1000, Math.round(configured))) : 6000;
    const sceneId = personaSceneFromKey(key);
    text = composePersonaLayers({
      core: card,
      verbatimCore: !split,
      identity: buildPersonaIdentity({ name: personaNameFromCard(card, cur?.name), owner: String(unified.admin?.displayName || '').trim() || '主人' }),
      tone: split ? readPersonaLayerText('tone') : '',
      scene: split && sceneId ? readPersonaLayerText('scene', sceneId) : '',
      daily: split ? readPersonaLayerText('daily') : '',
      personaMode: split ? 'tone' : 'full', mode: 'v2', maxChars, sceneId,
    }).text;
  } else {
    return null;
  }
  const fingerprint = createHash('sha256').update(String(cur?.id || '') + String.fromCharCode(10) + text).digest('hex');
  return { platform, text, fingerprint, roleId: cur?.id || '', mode: split ? 'split' : 'full', sourceChars: card.length, maxChars, fullCardPresent: text.includes(card) };
}

/** Older qq_get_prompt results have no markers: strip the known leading role,
 * preserving the generated admin, Bilibili memory, memory-card and voice suffix. */
export function stripLegacyPersonaText(text, meta = {}) {
  if (!/(?:^|[._/:])qq_get_prompt$/.test(String(meta.toolName || '')) || meta.field !== 'role.hint' || !/^【身份底座】\r?\n/.test(text)) return text;
  const suffix = /^(?:【管理员 · 温柔模式（优先级高于人格卡和群里气氛）】|## B站记忆（自动同步；这些是我自己的真实经历，不是别人）|【记忆卡 · 你自己的记忆】|【语音状态】)/m.exec(text);
  return suffix ? text.slice(suffix.index) : text;
}

export function createPersonaResolver(ctx) {
  return function resolve(agent) {
    const sessions = readJson(path.join(QQ_STATE_DIR, 'sessions.json')).sessions || {};
    const learnerId = readJson(path.join(QQ_STATE_DIR, 'slang-session.json')).sessionId || '';
    let scope = personaPlatformForAgent(agent, { sessions, learnerId });
    const seen = new Set();
    let current = agent;
    while (!scope && current?.session?.header?.parentSession && seen.size < 16) {
      const id = current.session.header.parentSession;
      if (seen.has(id)) break;
      seen.add(id);
      try { current = ctx.agents?.get?.(id); } catch { break; }
      if (!current) break;
      scope = personaPlatformForAgent(current, { sessions, learnerId });
    }
    return scope ? currentPersonaSnapshot(scope.platform, scope) : null;
  };
}
