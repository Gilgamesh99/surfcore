# 整卡 10000 字预算与模型请求中的人格去重

日期：2026-11-13。基线：本机 main 1b50c65 / 0.8.9；隔离分支 fix/full-persona-10000。用户授权本机实现、设置和加载；不改角色原文，不发布版本。

## 现象与原因

当前角色使用长整卡，但 B 站 persona.compactChars=2200 且代码封顶6000，QQ role.maxInjectChars=6000。full 模式也走分层裁剪，QQ 二代还会用旧代词语正则删除整行；目的提示词有2200字额外切片，桌宠有两处4200字切片。只改设置无法保证全文进入各条人格对话路径。

每次唤醒把人格写进用户消息也不等于每次模型请求只有一张人格卡：工具续轮不会重新唤醒；历史唤醒、qq_get_prompt 和 in-history system 投影可能留下旧副本。宿主仅在 startsRequestSeries 且最新 system 文本不同的时候归一化，因此只比较人格哈希不足以清理历史重复，也不能忽略其他 system section 的变化。

## 两条路线与选择

1. 仅提高 QQ/B站设置并保留唤醒注入：改动小，但无法解决硬上限、工具续轮、历史副本和整卡行过滤。
2. 保留既有设置入口，整卡使用完整正文校验；QQ/B站注册 agent scoped 动态 section，每个模型步骤读当前角色，清理自己拥有的人格副本；桌宠每次直接调用重新构建唯一 system。选择此路线以满足完整性与去重，保留平台消息和权限规则。

## 行为与调用链

- QQ role.maxInjectChars 使用现有设置能力，目标值10000；B站 persona.compactChars 的代码最大值由6000提高到10000，目标设置10000。桌宠 full 使用10000。预算只计算整卡正文，身份底座另行注入。JavaScript 字符计数，不是 token 数或模型总上下文上限。
- full 源为当前角色 persona.full.md，缺失时沿用 persona.md 兼容回退；不走 selectRoleText、GEN1_ROLE_LINE_RE 或旧代示例改写。split 原有省 token 行为不变。
- 整卡超预算明确抛错，不静默截断。QQ 目的任务改用共享 roleHintForMode，桌宠目的与聊天移除二次切片；桌宠异常仍经 finally 清 inFlight。
- B站保留已有 QQ 隐私脱敏；私密标题按实际 heading depth 关闭，普通“称呼与语气”不会被当成QQ称呼表整段删除。数字脱敏策略不扩大修改。
- 当前人格包在每个 agent step 的 scoped system-prompt/assemble 中读取，literal section 使用 interpolate:false，保留卡片中的双花括号。工具后续步骤也重新读取；同一步网络重试沿用该步已接受的快照，变更在下一步生效。
- 标记为 <!-- surfcore-persona:start --> / <!-- surfcore-persona:end -->；删除历史自有副本、明确边界的旧QQ/B站卡片；qq_get_prompt 只清 role.hint 中的人格部分，保留管理员、记忆、语音、工具元数据与工具配对。
- 使用公开 session surface 的 append-only replace，不修改原始审计日志；有效模型上下文不累积旧人格。保留其他插件的 system 内容与用户消息。普通DSH、黑话学习/分类等辅助任务排除；支持QQ/B站派生会话，桌宠直连自行装配。
- 角色A→B→A、其他system变化、历史latest已等于当前system、compaction后的剩余副本都纳入测试。停止插件会卸载section和监听。

## 状态与失败呈现

GET /dsh-surfcore/api/persona/runtime 只返回 roleId、mode、正文长度、预算、fingerprint、注入状态与错误元数据，不返回卡片正文。角色编辑器“人格加载检查”显示当前预算和错误。配置/读取失败：PERSONA_LOAD_FAILED + 原因 + QQ/B站对应参数提示；错误方法：PERSONA_RUNTIME_METHOD + 使用GET提示。请求阶段错误阻止缺卡调用，不用无人格的默认行为兜底。

## 兼容与重载

本机 DSH NEXT 2.0.22-next / SDK 0.2.2-rc.1。插件声明 agents、systemPrompt 注入；跨插件目录的共享新模块使用 rev=20261113-full-persona，避免仅重载插件仍使用旧模块缓存。QQ bridge 独立进程需要受控重启；不修改DSH宿主。

先备份QQ与统一配置、记录当前角色和人格哈希；仅改两个预算，不整页保存统一配置，以免重置B站监听水位。部署到既有 D:/Project/surfcore，重载 include:surfcore 并刷新现有 GUI，再重启桥接并验证 DSH/SnowLuma 恢复。无另外启动替代GUI服务器，不向QQ/B站发送测试消息。

## 验证记录

- 新增 test-full-persona.mjs：10000边界、10001拒绝、整卡字面量/旧代标签、平台/桌宠真实构造器、角色切换、作用域、旧工具角色保留附录。
- 新增 test-persona-request.mjs：模拟请求投影与真实已安装SDK的 scoped assembly、Session surface 更新、user/tool真实信封。宿主升级需重验目前标记 deprecated 的 eventAt/snapshotEvents 读接口。
- 扩展插件人格脱敏和角色API成功/失败断言；旧host mock补齐实际必需服务。公共示例配置用于隔离测试，不复制生产凭据。
- 修正两项测试夹具：pet安装测试等待终态，不用固定2.5秒；core rev 检查按模块核对单一实例，不要求无关模块共用一个版本字符串。
- 首轮 audit 155/161：缺隔离配置、过度严格的rev检查、旧HEAD发布清单及两项Git测试超时。已分别修正夹具/环境，后续结果与加载证据写入本节。
- 桥接回归16/17：R11旧Markdown恶意输入性能断言<500ms失败。相同未改源文件在生产基线849ms，候选1553ms；单独回归820ms，证明基线也失败。未放宽阈值或修改无关转换实现。其他16项通过。
- 最终人格专项与真实SDK测试15/15通过，插件完整40脚本链通过，安装清单777文件校验通过。复跑audit为157/161：旧R11性能断言失败，图片/两项Git夹具触发外层时限。图片夹具单独复跑67通过、1跳过、0失败；update-apply-result单独复跑通过；git-apply单独复跑21/21通过。最终剩余失败仅基线也失败的R11性能断言。
- 生产 main 已快进到功能提交8584f1b和清单提交908fcdc。两个配置只变更role.maxInjectChars / persona.compactChars到10000；独立原始备份在 D:/ProgramData/DSH NEXT/Soul/backups/surfcore-full-persona-20261113。
- 2026-11-13 16:26（Asia/Shanghai）真实GUI http://127.0.0.1:57328 的新/persona/runtime接口200，active=true/error=null；QQ/B站同为proplus/full/sourceChars=8656/maxChars=10000/fullCardPresent=true。QQ实际prompt包含整卡且仅一个拥有标记；生产B站构造器保留整卡，本卡未触发隐私脱敏。人格文件SHA256仍为617862b69be6ccb6045659034febee8ead673fa6e45c7fcafcff0d380e26357a。
- 正规PluginManager disable/enable仍返回全profile restart-required/unmanaged-plugin及旧Workbuddy未激活依赖警告；SurfCore自身fiber=active、新路由存在且新钩子生效，故无宿主重启/其它插件改动。全局返回不是目标插件失败证据。
- QQ桥接经既有restart API从PID26800切到28536，reserved2/dshReady=true/SnowLuma connected=true。当前GUI刷新后“角色→人格加载检查”实际显示QQ与B站各8656字、预算10000字；验收截图 D:/ProgramData/DSH NEXT/Soul/surfcore-full-persona-ui.png。首次UI检查早于配置加载完成；改为等待真实角色标签出现后通过，不改产品等待时间。
- 未执行真实付费LLM、生图、QQ/B站发送；实时requests/rewrites计数在验收时为0，实际每次请求的投影/去重由15项真实SDK及离线模型边界用例验证。测试不代表主观自然程度已被实测。

## 回滚

保留部署前main提交和两个配置的独立备份。需回滚时停止插件，使用 git revert 撤销本次本地提交，恢复备份中两个预算值（不要覆盖后来新增的配置/角色/水位），重载插件与桥接并核验连接。用户人格原文及角色不在修改范围。

## 发布交接块

- 改动：persona-layers / persona-request / persona-runtime，QQ桥接目的与角色构造，B站调度，桌宠聊天/目的，插件注册/API/UI，以及对应测试和本文档。
- 版本建议：patch；本次保持0.8.9，本机定制，无tag/push/release。
- 层级：插件与桥接，不改DSH。依赖当前公开事件/section/session surface能力；宿主升级须跑真实SDK兼容用例。
- 逻辑/范围/失败/UI/hint/断言：见以上章节；实际加载、页面证据及最终门禁残余已记录。
