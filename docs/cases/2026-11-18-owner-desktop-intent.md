# 主人私聊自然桌面指令漏识别（2026-11-18）

## 现象与根因

主人已启用不限时桌面授权，私聊“你使用Windows-MCP控制我的电脑，打开b站刷一会”仍收到普通会话不能操作电脑的回复，并被错误引导到群聊 @。旧 ownerDesktopIntent 只认识电脑/桌面前导或冒号快捷格式；原句含工具前导语，纯函数实际返回 null。真实接收入口因此继续普通 QQ 流程，普通代理的 Windows 拒绝是设计中的边界，不能靠放宽普通代理权限解决。提供的历史副本只证明文字及回复，不是可重放的实时授权。

## 完整逻辑

1. **链路**：OneBot 真正私聊/群消息回调 → src/bridge.js 的主人桌面分流 → src/owner-desktop-broker.js 的文本识别和独立授权 → 插件 owner-desktop-runtime.js 的受控子代理。此次只改识别器和普通会话的可行动提示；原消息/身份/群顶层 @/五分钟新鲜度/防重放/每次工具租约全部保留。
2. **机制**：新增 Windows-MCP、Windows MCP、Computer Use 明确工具前导语，支持控制/操作电脑的连接语，再要求具体动作；保存完整原文。快捷语法和自然语法共用保守的首部否定/条件/引用、疑问及后置“的话”过滤。只是谈论工具或“看看要不要登陆”不自动变成桌面命令。
3. **影响面**：QQ 桥接和宿主插件两个进程，各一个线上调用链，失败有用户可见提示，估算 2×2×1=4。配置、用户消息和历史不迁移，不新增模型调用；明确命令仍只发起原来已有的受控任务。
4. **取舍**：仅告诉用户必须输入“电脑：”改动最小，却继续漏掉明确的原句；让普通聊天直接用 Windows 会破坏隔离；选择受限自然语法加可复制快捷格式，改动集中，能用原句与拒绝边界共同验证并单独回滚。不是通用自然语言分类器，歧义说法仍可使用明确动作的“电脑：”格式。
5. **生效**：提交后从 Git 对象重建安装清单，本机 dev 快进；正式 PluginManager 重载 SurfCore 以刷新提示，随后串行重启 QQ 桥接以刷新接收器。保留主人授权启用、timeoutMs=0、管理父会话、仿真模式、双远程及 upstream/main preserve-local 更新。
6. **验证**：原句先在旧版报 expected command / actual null；修复后 broker23、实际接收回调15、运行时56组通过。回调用例验证私聊及真 @ 群聊原句进入独立任务、共享 QQ unread/prompt 为0、全文保留、0时限的 expiresAt=null。失败分支验证假身份、引用/转发、非真正 @、历史/重放、取消/撤权仍拒绝。完整 `npm run test:audit` 165/165 脚本通过（含桥接回归、R11 和 Git 更新事务）；受影响的设置10组、实际管理API和隔离宿主冒烟也通过。本机插件、桥接、授权状态及实际上游更新检查通过，详见下节。
7. **回滚与残余**：生产基线 cd36c1cb282cde3dcc0017814b2187b6e07c99a0；备份在 Soul/backups/surfcore-owner-desktop-intent-20261118。回滚使用 revert 本次业务提交、重建清单、重载插件与桥接；不删除防重放记录，不恢复旧任务。没有发送真实 QQ 测试消息或执行实际打开 B站动作；需要主人重新发出新指令才能进行真实任务。

## 本机验证

已集成本机 dev：业务提交103cca8，运行代码及清单fc24ef1；正式 PluginManager 重载成功，QQ 桥接 PID20496→27372，reserved2、DSH 与 SnowLuma 在线。2026-11-18 10:26（Asia/Shanghai）回读 enabled=true、timeoutMs=0、管理父会话匹配、runtime.ok=true/idle/lastError=null、broker.ok=true；六份运行配置逐字节哈希保持。实际更新检查 checkedWithFetch=true、upstream/main、preserve-local、ahead33/behind0/dirty0。

桥接重启期间产生的一次 fetch failed 被旧运行时状态保留，首次验收因此失败；确认桥接在线后再次正式重载插件，状态恢复并通过完整回读。未修改授权开关或 Windows 授权。最终文档/清单提交不改变运行代码，最终 HEAD 与更新回读保存在 Soul/surfcore-owner-desktop-intent-verification-20261118.json。接收/执行定向测试使用隔离传输和宿主，没有真实 QQ 测试消息或桌面操作。

## 可转发发布交接

- 问题/行为：明确 Windows-MCP 主人私聊请求此前落入普通聊天，现在按独立桌面任务识别；提示给出主人私聊“电脑：打开B站”，不要求先去群聊。
- 文件：src/owner-desktop-broker.js，plugins/surfcore/lib/owner-desktop-runtime.js，对应 broker/wiring/runtime 回归，README/路线/交接/案例。
- 验证：原句红转绿，23+15+56 定向行为通过；全审计/生产结果见上文最终记录。
- 接口/兼容：无接口和状态格式变化；保留不限时与旧快捷语法，否定/疑问/条件/引述不自动执行。
- 失败：普通聊天仍拒绝桌面工具，提示可复制正确私聊格式；原设置卡片继续显示接收/任务失败。
- 发布：建议 patch，由发布会话决定版本；本次不改版本、不推送、不打标签、不发 Release。
