// 唤醒人格卡注入（2026-11-01，方案 A1）静态 + 引擎回归。
//
// 背景：二代唤醒提示词以前只有一句「完整角色卡请调用 qq_get_prompt 查看」。
// 实测模型几乎不调这个工具（state/tool-calls.jsonl：1830 次工具调用里 10 次，
// 2026-11-01 当天 0 次），于是「她不知道自己是谁」成了常态。
// 现在唤醒侧直接注入人格卡正文，并与 qq_get_prompt 同源（都经 composePersonaLayers）。
//
// 这里钉四件事：
//   ① 两个唤醒入口（正常唤醒 / 「还没收尾」提醒）都走 personaWakeBlockV2；
//   ② roleHintForMode 的 personaOnly 不重复拼管理员规则 / B站简报 / 记忆卡；
//   ③ 分层引擎在 tone 模式仍然保留「我是谁 / 主人是谁」的身份底座（B 的设计承诺），
//      只有「真的写了语气层」时才省掉核心；
//   ④ 普通群聊唤醒给出首答查证、日常闲聊和互相玩梗各自的条件。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composePersonaLayers } from '../src/persona-layers.js';
import { buildPersonaIdentity } from '../src/persona-identity.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const bridge = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');

// ① 唤醒侧接线：两个入口都必须注入人格卡，不能再退回「只给指针」。
assert.match(bridge, /function personaWakeBlockV2\(key, includeToolHint = true\) \{/, '缺少 personaWakeBlockV2（唤醒侧随身身份证）');
assert.match(
  bridge,
  /roleHintForMode\('v2', key, '', \{ personaOnly: true \}\)/,
  '唤醒人格卡没有走统一的组装函数（会和 qq_get_prompt 分成两份手抄）',
);
assert.match(
  bridge,
  /function buildWakePromptV2\(key, reason[^)]*\) \{\s*const roleState = readRoleState\(\);\s*const roleLine = personaWakeBlockV2\(key, reason !== 'ownerDesktop'\);/,
  '唤醒提示词没有注入人格卡（又退回只给指针？）',
);
assert.match(
  bridge,
  /function buildWakeReminderPromptV2\(key\) \{\s*const roleLine = personaWakeBlockV2\(key\);/,
  '「你还没完成回合收尾」提醒没有注入人格卡',
);
const injectionPoints = (bridge.match(/personaWakeBlockV2\(key(?:, reason !== 'ownerDesktop')?\)/g) || []).length;
assert.ok(injectionPoints >= 2, `人格卡注入点数量异常：${injectionPoints}`);

// ② personaOnly 短路：只出人格卡正文，避免管理员规则/B站简报/记忆卡在一张纸上出现两次。
assert.match(bridge, /if \(opts\.personaOnly\) return base;/, 'roleHintForMode 缺少 personaOnly 短路');

// ③ 引擎契约。fixture 不用 # 标题，避免被 role-card 的小节解析改变形状。
const identity = buildPersonaIdentity({ name: '小测', owner: '主人' });
assert.match(identity, /你是小测/, '身份底座没有角色名');
assert.match(identity, /你的主人是主人/, '身份底座没有主人（B 依赖的锚点）');

const core = '测试用核心：喜欢下雨天，说话软。';
const toneLayer = '测试用语气：句子短、爱用波浪号。';
const daily = '测试用日常：今天在整理房间。';

const full = composePersonaLayers({ core, daily, identity, personaMode: 'full', mode: 'v2', maxChars: 6000 });
assert.match(full.text, /喜欢下雨天/, 'full 模式没有注入核心');
assert.match(full.text, /你是小测/, 'full 模式没有注入身份底座');

// 没写语气层（旧角色只拆了日常/场景）：tone 模式必须回退核心，否则人设正文全丢。
const toneFallback = composePersonaLayers({ core, daily, identity, personaMode: 'tone', mode: 'v2', maxChars: 6000 });
assert.match(toneFallback.text, /喜欢下雨天/, '没写语气层时 tone 模式丢了核心（兜底失效）');

// 真写了语气层：tone 模式省核心（省 token），但身份底座必须在。
const toneOnly = composePersonaLayers({ core, daily, tone: toneLayer, identity, personaMode: 'tone', mode: 'v2', maxChars: 6000 });
assert.equal(toneOnly.text.includes('喜欢下雨天'), false, '写了语气层后 tone 模式不该再带核心');
assert.match(toneOnly.text, /你是小测/, 'tone 模式省核心后必须保留身份底座');
assert.match(toneOnly.text, /句子短、爱用波浪号/, 'tone 模式没有带语气层');

const harness = await bridgeHarness();
try {
  harness.setMode('reserved2');
  const wake = harness.buildWakePromptV2('group:456', 'question');
  const rule = wake.split('\n').find(line => line.startsWith('【反AI味】'));
  assert.ok(rule, '普通群聊唤醒缺少反 AI 味规则');
  assert.match(rule, /模型比较.*首答前主动查证/, '模型比较应在第一条答复前查证');
  assert.match(rule, /日常闲聊.*卖萌/, '日常聊天可以保留可爱的语气');
  assert.match(rule, /玩梗时才.*装傻/, '装傻应限于彼此玩梗');
  assert.doesNotMatch(rule, /可以装傻、已读乱回/);
} finally {
  await harness.close();
}

console.log('✅ 唤醒人格卡注入（A1）通过');
