# 主人桌面使用独立连续会话

日期：2026-11-18。基线：dev a8e4f8226600bab4590dcadb82412aa23d245349。隔离分支：feat/owner-desktop-conversation。当前阶段：已集成本机dev并验收；运行代码2340d5e490f30adbd452268bad98c5ddfcc295cc，后续提交仅补验收文档和清单。

## 现象与证据

主人10:55发“你我的电脑，打开b站刷一会”，实际打开了Chrome和B站视频，但没有找到执行会话，11:06取消只回复“当前没有进行中的电脑任务”。最初要求接回原QQ；随后明确改为独立桌面会话，以便长期游戏、看电脑的上下文不占用主会话。最终目标是独立、可见、能续接的桌面历史，继承来源QQ的人格和当前模型，原QQ负责主人指令及短回执。

只通过获准的会话工具读取管理会话的子会话7cf2215f-d8be-45d5-b794-702d6dbd9dd9；未读取被工作区隔离拒绝的原QQ原始日志。用户提供的QQ历史副本止于09:27，不能证明10:55事件。

| 上海时间 | 证据 | 事实 |
| --- | --- | --- |
| 10:55:45.115 | 子会话元数据、seq1 | management parent下spawn continuable会话；不是原QQ会话 |
| 10:55:47.974 | seq6、10 | turn1开始，原句进入独立任务 |
| 10:58:12.743 | seq69 | Chrome地址栏输入B站网址成功 |
| 10:59:38.431 | seq89 | WaitFor匹配B站视频窗口；不据此推断播放时长 |
| 10:59:58.372 | seq94 | 最后成功的Screenshot |
| 11:00:38 | bridge.log | DSH不可用，桥接撤销桌面授权 |
| 11:00:38.884 → 41.529 | seq98、99 | Esc动作被OWNER_DESKTOP_FINISHED拒绝 |
| 11:00:41.538 | seq101 | turn1因hook/OWNER_DESKTOP_FINISHED中止，并非正常完成 |
| 11:00:42 | bridge.log | DSH恢复；授权不会自动恢复 |

旧broker撤权走end，清active和lease但没有终态回执；随后的complete发现已terminal直接拒绝，因而漏报。11:06取消看到空active只给泛化提示。只读状态保留同一task c54edfea-c2b9-48ce-a8de-9c54aa8dbdc2：status=cancelled，completedAt=1794970838921，timeoutMs=0，expiresAt=null，code=OWNER_DESKTOP_REVOKED，error=DSH连接已断开。notification.ok=true只代表旧接收ack，不能代表终态已送达。已确认不是时限到期；就绪探测失败不证明DSH进程真正重启。

旧任务其实可由管理会话顶部“子智能体”进入并“在侧边栏打开”。本次加入直接入口，避免依赖用户寻找隐藏在管理父会话下的旧记录。

## 完整逻辑

1. **链路**：真实OneBot回调→主人私聊或主人顶层群@→broker claim/prepare→bridge的ensureSession取得真实来源QQ并构造完整人格、有限记忆和当前指令→runtime从该QQ的正式subagents服务创建独立continuable child；后续通过官方sendMessage续接同一child ID与桌面历史。准备消息没有QQ令牌，也不复制主QQ的完整历史。
2. **机制**：许可绑定实时消息、owner/self、epoch、task/lease、prepare随机标识、来源QQ、目标child、宿主插入的确切消息对象和唯一turn。claimed在工具schema装配前同步建立边界，pre-step等待正式receipt与bind，每个Windows调用异步校验后消费同步票据。独立native预设仅Windows与loader，无QQ、代码、文件或委派工具；主QQ守卫保持原样。来源QQ的原Windows人类开关仍由Windows插件检查，绝不借用管理父会话或自行写grant。
3. **影响面**：桥接与宿主两个进程，broker/runtime、持久索引、原QQ短回执和设置界面共同读取状态。桌面索引仅存来源身份、QQ/child ID和reserved/ready，创建前留不可淘汰的deny记录；损坏、删除、锁定或容量满均关闭通道。按2进程×约4读者×可见错误1=8评估，需要身份、时序、停止和原QQ回归。配置与原会话不复制、不重置。
4. **取舍**：独立桌面历史符合用户最终要求，避免长时间视觉工具挤占聊天上下文；直接复用旧管理子会话会继承错误来源并混淆授权，所以仅复用按主人、bot、来源会话精确绑定的新索引。官方startActivation创建、sendMessage冷恢复保留历史；每次使用来源QQ当前模型与桥接当前人格。准确拦截已登记child→该QQ的宿主settlement通知，主QQ仅收桥接短回执。
5. **生效与重启**：桥接源码需重启桥接；宿主runtime、专用预设和客户端需正式插件重载并刷新既有GUI。注册并resolve新owner-desktop-conversation预设，不能只凭插件active判通过。稳定gate与boundary同放在外部预设目录，插件只重导出，避免宿主仅驱逐插件包缓存后出现两份WeakMap；今后修改外部gate实现必须完整重启DSH，或验证boundary与gate确实同时失效换代；单纯关开SurfCore不能宣称此实现已升级。原QQ守卫及QQ预设不改，不需更新QQ的旧预设代际。旧parentSessionId兼容保留但不再用作执行父级。
6. **验证**：真实回调模拟私聊/群@、伪造过期引用；prepare/bind来源与目标分离、映射变化；真实host消息对象/receipt/claimed/pre-step时序；当前模型、独立历史、冷恢复同ID；仅主人续接取消，真实停止证明；终态与接收ack分离、排队进度竞态；普通QQ不受busy或inbox影响；Computer Use关闭或native边界缺失可见失败；索引并发/删盘/写失败；UI只导航不发送。broker33、桥接接收22、最终runtime36组、索引23、专用预设8、设置10与实际API/客户端/宿主检查通过；完整插件测试通过后，停止恢复改动另跑最终runtime36组通过。最终全仓audit162/165；R11性能、语音包导入和更新结果三项单独复验全部通过，未修改对应实现或放宽断言。新增缓存外部boundary、两次重新导入插件模块的回归先复现失败，再由稳定gate修复；修后preset8/runtime36/settings10/API/隔离host复验通过。本机验收已通过，见下段。
7. **回滚与残余**：revert本批代码、按提交对象重生成安装清单并重载桥接/宿主；保留配置备份和历史索引，不删除会话。历史任务不重放，断连后需主人发新指令；不限时取消总时限，模型回合结束仍收尾，继续指令重用历史而不自动重启。真实游戏或直播不在本次自动验证中，不发送QQ测试消息。

## 用户可见行为

- 主人私聊发送“电脑：打开B站”；群里必须主人真实@机器人。普通群友、引用、转发、网页或历史文字不能下达桌面指令。
- 原QQ发“继续电脑任务：看下一条”或新的明确桌面指令，先确认旧执行停止，再在同一桌面历史续接。主QQ仍可正常聊天。
- “取消电脑任务”停止后续动作；已经结束时说明该来源最近任务的状态和原因，不把收到取消等同于已停止。超过10秒尚未确认排空时显示等待停止确认并拒绝新任务；只接受原dispatch结束及原Agent.whenIdle的迟到证明。回传失败保留原证明重试，重载丢失证明必须先完全停止旧宿主和工具再重启，不能靠重新启用假装解除。
- 接收、开始、简短进度、完成、失败或撤权回到原QQ；接收ack与终态分别记账。无法发送时在卡片显示原因，不进入outbox自动补发。
- QQ设置的“打开桌面会话”通过官方uiWorkspace打开精确QQ/child地址；只查看历史，不发模型消息。第一条新任务后显示，未创建时明确提示。
- 授权与不限时0保留；来源QQ的Computer Use需人工开启，普通QQ本身始终不能执行Windows工具。

## 本机验收

2026-11-18 13:31（Asia/Shanghai）正式插件关开、生产ff-only至2340d5e后，桥接PID19848→28876，reserved2、DSH与SnowLuma均在线。既有GUI http://127.0.0.1:51360 的主人桌面卡片已刷新：独立历史/来源QQ人格模型/第一条新任务创建提示均可见，不限时0仍选中。专用预设正式注册就绪，executionMode=desktop-conversation，runtime与broker均ok、idle、lastError=null；新索引尚无任务，未为验收伪造桌面历史或发送QQ指令。六份配置SHA逐字节一致，双远程/跟踪origin/dev保留；实际fetch upstream/main结果preserve-local、ahead39/behind0/dirty0（文档追加后ahead增加）。

验收JSON：[本机运行证据](<D:/ProgramData/DSH NEXT/Soul/surfcore-owner-desktop-conversation-verification-20261118.json>)；界面：[主人桌面卡片](<D:/ProgramData/DSH NEXT/Soul/surfcore-owner-desktop-conversation-ui.png>)；备份位于工作区backups/surfcore-owner-desktop-conversation-20261118/activation。版本仍0.8.9，未推送或发布；新链路完整QQ桌面实操及长期游戏没有实发验证。

## 发布交接块

> 类型：QQ桌面连续性与回执修复；版本仍0.8.9，不在本编辑会话发布。
> 问题：旧独立任务不可直达且不能复用，未继承QQ来源，连接就绪瞬断撤权后漏终态。
> 行为：独立可见桌面历史、当前QQ人格模型、主人续接取消、原处短回执；保留人类Windows开关、真实主人与群@边界、不限时。
> 验证：最终测试与本机加载证据见本case验收段；发布会话现读HEAD重跑门禁。
> 生效：桥接重启、宿主/新专用预设正式更新、既有GUI刷新；不重放任务。
> 回滚：revert本批代码+重生成清单+同样生命周期加载；保留会话、索引及配置。
