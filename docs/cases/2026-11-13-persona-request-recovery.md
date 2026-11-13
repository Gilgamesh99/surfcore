# QQ 人格请求校验回归：目的提示词裁剪与工具副本

日期：2026-11-13。生产基线 f3fff44 / 0.8.9；隔离分支 fix/persona-request-regression。本机修复，不改人格原文、预算、更新策略或版本。

## 现象与现场证据

QQ 主动私聊返回 “current persona must appear exactly once in the final model request”。此错误来自此前新增的人格完整性守卫，属于本地修改引入的回归。

只读检查实际会话的完整206条事件：17:14的 system 已含一张完整当前人格；19:15及19:31两次目的唤醒的 user 消息均为14460字符，start=1、end=0，随后立即失败。此前直接 qq_get_prompt 的历史副本已正确清理；现场没有 PTC 调用，不能把另行复现的包装工具问题当作本次直接原因。

src/purpose-engine.js 的 buildPurposePrompt 在整段超过 promptMaxChars=16000 时，取头55%（8800字）和尾35%（5600字）。长整卡在头部被切断，固定省略告示之前只剩 start。旧最终守卫对所有消息机械统计起止标记，因此完整 system 也被这个残片阻断。

## 两条路线与选择

1. 删除守卫、只增大目的提示词总预算：能绕过当前报错，但会隐藏缺卡/重复，也会在素材再次增长时重现截断。
2. 修复裁剪源头，并在请求前准确恢复已有残片；最终继续验证完整当前 system。选择此路线，保持完整人格与每步去重。

## 改动与调用链

- buildPurposePrompt 将开头、完整带标记的人格、可裁背景/素材、目标归属/风险提示与发送备忘规约分开。超长只裁背景；保留完整人格和必要规则。默认16000预算内可容纳10000字人格。若用户将素材预算降到不足容纳必要内容，完整人格与规则优先，允许这部分超过素材预算；人格本身仍受既有10000注入预算限制。裁剪不切开UTF-16代理对。
- persona-request 在旧生成标题、身份底座、单个start且无end、固定省略告示和完整尾部动作/备忘共同匹配时，去掉 start 到省略告示之前的残片。历史和待处理消息都可恢复；保留消息ID、尾部规约、原始审计日志，仅追加surface replacement。
- qq_get_prompt 副本按原始日志归属：直接调用或成功的 tool/ptc-dispatch，并沿parent/root追溯。处理MCP双份包装、数组、嵌套JSON字符串、混合日志；保留图片、工具配对和无关字段。只有start记录、失败子调用、无归属工具都不据此删除数据。
- 最终守卫继续要求system有且仅有一份完整当前人格，并检查已归属工具中的残留副本。普通聊天引用标记、不相关工具结果是数据，不再误拦。
- 失败仍在模型派发前停止，PERSONA_REQUEST_INTEGRITY 的reason区分 missing/incomplete/mismatch/duplicate/history-copy；中文error/hint和system/direct/PTC计数不含人格原文。
- runtime.revision=20261113-persona-recovery；插件persona-request与桌宠purpose-engine共享模块均更新查询revision，避免热重载命中旧缓存。QQ独立桥接需重启以加载目的构造器。

## 验证

- test-purpose-engine.mjs：21/21，包括8656/10000整卡、16000背景预算、极低4000素材预算、完整发送令牌/备忘/风险/归属、emoji边界。
- test-persona-request.mjs --sdk-root 指向本机已安装SDK提取件：21/21。完整deriveMessages冻结后进入真实 LlmRuntime.streamWithRegistration，假adapter验证正常续轮/工具包装/旧残片，完整覆盖仍因missing阻止派发。
- 实际206事件在内存中用 Session.create 重放：生产基线复现完全相同英文错误，假adapter派发0次；候选清理2条旧残片、system保留1份完整卡，派发1次且无错误。发送/备忘尾部逐字保留，原206条日志哈希不变。没有调用真实模型或向平台发送消息；私聊原文和令牌没有写入测试文件。
- test:regressions：17/17通过，包括此前易受负载影响的R11；共享模块revision一致性通过。
- 插件全套40条命令链通过。根audit为160/161；唯一失败为既有R11性能阈值（721ms，要求<500ms），独立17项回归运行时该项通过。未修改其转换代码或放宽阈值。
- 生产重载与GUI状态按下一节检查并另存本机验收记录；不把离线测试等同于真实平台已发送。

## 部署、范围与回滚

只将已测试提交快进到既有生产main，保留本地提交及preserve-local远端更新机制。先备份这次覆盖的运行文件并记录main/card/config哈希。官方PluginManager重载 include:surfcore 后必须确认runtime.revision及active，不能只依据全profile的restart-required提示。用既有桥接restart API受控重启，确认DSH/SnowLuma恢复；刷新原GUI。没有新GUI服务器、版本发布或平台测试消息。

现有失败记录保持为历史记录；下一次正常请求按新逻辑恢复对应有效上下文，不删除聊天，也不主动重放已计划发送的私聊。回滚应revert本次代码提交并重新加载；无需恢复人格或预算配置。回滚到有本回归的基线会重新触发该错误。

## 发布交接块

- 文件：src/purpose-engine.js、src/persona-request.js、两个对应测试、插件index/pet-purpose共享模块revision、case/索引/handoff/pitfalls/coordination及生成安装清单。
- 建议：patch；本次仍0.8.9，本机修复，无tag/push/release。
- 层级与兼容：插件+QQ目的构造；依赖当前NEXT公开Session surface/事件接口，不改DSH宿主。
- 逻辑/错误/UI/hint/断言：见上文；人格加载检查沿用现有界面并读取新中文错误与revision。
- 未验证：真实模型生成质量、真实QQ/B站发送不属于本次离线验证；不声称已经实发成功。
