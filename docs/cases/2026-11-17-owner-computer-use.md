# 主人专用 Computer Use：保留仿真与独立桌面任务

## 现象与根因

QQ 二代仿真原有 qq-chat-v2 工具守卫拒绝所有 Windows 工具，主人身份没有例外。直接放宽共享群会话会把其他成员、引用和历史混入桌面授权；给整段 QQ/B站会话授予权限也无法对应到一次真实主人指令。Windows MCP 还保留独立的人类 Computer Use 开关，不能由模型或 SurfCore 修改。

基线：本机 dev / 6d25f3a，SurfCore 0.8.9；开发分支 feat/owner-computer-use。原始 Git 备份位于工作区 backups/surfcore-owner-computer-use-20261117/production.bundle；不改 origin/upstream 和保留本地更新策略。

## 完整逻辑

1. **链路**：bridge 的真实 OneBot 私聊/群聊入口 → owner-desktop-broker 的可信身份、明确指令、去重与租约 → 管理插件 owner-desktop-runtime 领取 → 正式 spawn 提供方创建独立本地子代理 → 每次 Windows 工具调用重验桥接身份 → 原来源会话收到结果。设置页只展示状态，不可提供任务正文来伪造主人消息。
2. **机制**：只认当前 ownerQQ、登录机器人 self_id、真实外层 message_id 和实时回调；群聊还必须有指向机器人的顶层 at 段。拒绝 @全体、文字伪造 CQ、引用、转发、补历史、旧消息、非主人和角色名自称。每次工具执行绑定实际 Agent 对象、首条消息、单轮 turn、不可复用调用票据和短期桥接租约。切换主人、配置代际、暂停、断线、重置、取消或超时均撤权。
3. **影响面**：QQ 桥接、DSH 插件/子代理、Windows 工具执行三个运行边界；收件、管理配置、工具执行、结果回报四类读取者，按显式报错估算 3×4×1=12。桌面操作会改变当前用户电脑并产生模型消耗；只有源于主人明确新消息的受限任务可进入。任务指令仅在内存，持久记录只保存已消费消息摘要和执行会话的拒绝名单。
4. **取舍**：拒绝“整个主人或群会话放行 Windows”的低成本方案，因为共享历史与后续轮次无法安全继承权限。使用新鲜 spawn 子代理、只读验证和正式原生工具呈现；不开启 shell、文件、代码执行、再次委派或 QQ 发送工具。Windows 自己的 Computer Use guard 仍生效；仅由正式父子关系继承人类授权，不伪造来源、不写 Windows 授权存储、不调用其授权 POST。
5. **生效**：集成代码后重载 SurfCore 插件、重启 QQ 桥接。设置页选择仍在运行、已由主人开启 Computer Use 的独立管理会话，再启用“主人桌面授权”。其他 QQ/B站会话、已结束桌面子代理和它们的后代仍不能调用 Windows。模型生成的文字、群成员的消息和过往聊天记录没有授权效力。
6. **验证**：离线 broker/真实 bridge 接线测试覆盖身份、明确 @、重放、租约、取消、权限 ABA 和结果发送前复核；runtime 测试覆盖实际初始消息/轮次、每次工具校验、停止/恢复/异常和 Windows 自身拒绝；policy/settings/API 覆盖冷恢复拒绝、记录损坏、配置 CAS、浏览器验证与失败提示。另跑全仓审计、协议回归和相关插件测试。
7. **回滚与残余**：先在设置页关闭并取消任务，等待执行子代理停止；关闭 Windows 的管理会话开关可独立阻止调用。备份配置与 owner-desktop 状态，回退本次代码后重载桥接/插件。不要清空旧执行会话拒绝记录或重放已消费消息。已经发出的鼠标键盘动作无法撤销；没有当前有效租约时不能继续发出新动作。

## 使用与边界

- 主人私聊：电脑：打开浏览器并访问 B 站。
- 群聊由主人明确 @ 机器人：电脑：查看当前桌面。
- 停止：取消电脑任务。群内停止也需要主人明确 @。
- 不认识的自然表达继续走普通仿真；明确前缀“电脑：”最稳定。单次最多 10 分钟，不并行、不自动恢复旧指令。
- 新任务入场允许消息最多旧 5 分钟，并拒绝桥接/重连前消息；OneBot 时间精度为秒，启动/重连的边界秒保守拒绝，下一秒的新消息正常进入。持久消息摘要去重保留到此窗口之后。配置/主人/会话变化后必须发送新消息。
- QQ 来源记录在启动、新建、退役和重置前保存全部已知会话 ID、已用工作目录及黑话学习会话；即使后续删去映射或更改预设也继续拒绝桌面授权。来源记录上限 10,000 ID / 256 目录 / 2 MiB，缺失、损坏、锁冲突或已满时关闭通道；保留独立 initialized 标记，不自动清空或淘汰。此前已退役、映射已删、非 QQ 预设且目录未知的旧会话无法凭当前数据追溯，不能把它们作为管理父会话。
- 管理端更换主人先关闭桌面入口、取消旧租约并更换授权代际；即使主人 A→B→A 发生在两次心跳之间，也必须重新启用。
- 设置页可见具体 code/error/hint 和运行状态；权限不足、无法创建独立本地子代理、记录损坏或 Windows 开关关闭时失败，不能降级到普通 shell 或共享群代理执行。
- 不改变仿真模式、原 QQ 工具白名单、B站收件及分享功能、人格、双远程和 preserve-local 更新来源。

## 宿主兼容

实际安装的 DSH 使用 startActivation 与独立 agentPreset，不支持开发依赖里旧式 start/toolFilter/persona 接口。插件通过正式 agentPresets 服务注册 owner-desktop（人格、native executor、默认拒绝的 boundary 三项）；先持久记录预留 childId，再创建真实父子关系，以返回的 messageId 绑定首条消息。默认拒绝的边界只接受当前宿主租约握手，冷恢复、额外输入、卸载和任何非 Windows 工具均不能获得权限。注册后还检查预设没有 broken 状态，无法加载时不降级。宿主服务通过正式 ctx.get 访问；验证精确的独立管理父会话后，才用 agentPresets.serviceFor(parent, "subagents") 获取其隔离服务。每次调用与心跳都复核服务和提供方的稳定身份，实际执行仍经过官方代理，替换或卸载立即撤权。

## 验证记录

- 主人收件 broker 17项、真实桥接接线14项、来源/权限分类10项、正式预设注册7项、设置控制器7项均通过；真实管理 API 覆盖权限修改拒绝、配置代际和主人 A→B→A 撤权。
- 适配当前宿主后的 runtime / native boundary 50组通过（原42组及8组真实宿主服务作用域回归），包括实际 Session 的 snapshotEvents/isSeeded/inheritedEventCount、activation 首条消息编号、最终处置时序、冷恢复、卸载和额外消息拒绝。
- 全仓审计单轮162/165；三项旧测试分别因 R11 936ms阈值和两个 Windows 子进程超时失败。随后协议回归17项、更新结果夹具、Git更新22项单独重跑全部通过，未放宽断言或改动旧实现。
- 加入实际宿主预设后的完整插件49脚本全部通过；服务绑定修复后重新执行运行时50组、预设7项、真实管理API与隔离宿主启动测试，均通过。
- 本机现场验收通过：生产 dev 已加载宿主兼容修复，SurfCore enabled/active，owner-desktop 预设无 broken；主人入口 enabled=true，runtime=idle、lastError=null，并绑定当前已由主人开启 Computer Use 的独立管理会话。QQ 桥接 PID30368 保持 reserved2，DSH/SnowLuma 在线。现有 GUI 已刷新并显示勾选的“主人桌面授权”卡片。配置对照只允许 ownerDesktop 改变，其余六份备份中的配置均保留。当前管理会话的 Windows 截图工具此前已成功；完整真实 QQ 主人指令到桌面动作与回执尚未实发验证。
- 更新检查实际 fetch 成功：仍为 dev / origin/dev，读取 upstream/main 并使用 preserve-local，工作区干净、behind=0。没有推送此次功能、修改版本或发布 Release。最终提交与现场证据记录在工作区 surfcore-owner-computer-use-verification-20261117.json；界面截图为 surfcore-owner-computer-use-ui.png。

## 发布交接

- 文件：src/owner-desktop-{broker,config}.js，src/bridge.js，插件 owner-desktop-{runtime,policy,settings,preset}.js，独立 dsh/agent-presets/owner-desktop 三项声明与边界，index.js/client.js，专项测试及测试登记、文档。
- 层级：新增向后兼容的管理 API、默认关闭配置和严格受限执行路径；旧 QQ/B站权限保持。建议 minor，不改当前 0.8.9 版本、不打标签、不创建 Release。
- 失败路径：管理卡片与原会话给出阶段、原因、下一步；在途结果不明时不重放任务；密钥和会话令牌不进入回执。完整逻辑、预算与撤权边界见上文。
- 尚未验证：完整真实 QQ 输入到桌面动作与回执。实际宿主接口、预设加载、启用状态、原仿真连接与更新来源已现场确认；关闭管理会话或其 Windows Computer Use 开关后，需要重新选择有效授权来源才能继续。
