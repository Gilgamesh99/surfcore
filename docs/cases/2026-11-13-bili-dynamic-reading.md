# B站@动态和转发原文阅读

日期：2026-11-13。状态：实现与只读实测完成，完整检查结果见下方；未部署、未发布。

## 现象与环境

用户转发官方动态并@鱼号后，机器人回复“转发的原文这边没展开，贴段文字给我看看？”。外层动态ID为1270031871116312601，原文ID为1262230883329376274。基线f3fff44，Node24.21.0，SurfCore0.8.9；在沙箱内独立clone的feat/bili-dynamic-reading分支实现，保留此前完整人格修复。

## 根因

旧收件箱摘要优先使用source/title，最多显示80字；@不会回读动态。两个动态查看入口虽请求detail，却只提取外层module_dynamic.desc。真实转发的外层只有@；原文在orig，且新版图文desc=null。带features=itemOpusStyle后，原文正文位于major.opus.summary.text，图片位于opus.pics。这不是B站接口完全不给原文。

## 完整逻辑

1. 链路：[监听器](../../plugins/surfcore/lib/scheduler.js)的fresh通知先交给[收件箱动态阅读](../../plugins/surfcore/tools/lib/inbox-dynamics.mjs)，再调用[共享读取器](../../plugins/surfcore/tools/lib/dynamic-reader.mjs)。结果直接附进promptBili的用户消息。[摘要命令](../../plugins/surfcore/tools/commands/comment-digest.mjs)、[新命令适配器](../../plugins/surfcore/tools/lib/read-dynamic-command.mjs)、[旧check入口](../../plugins/surfcore/tools/verify/dynamic-inspect.mjs)和[dynamic check](../../plugins/surfcore/tools/commands/dynamic.mjs)复用同一逻辑。
2. 机制：只向固定B站nav/detail接口发GET，WBI签名并指定itemOpusStyle。字符串ID不转Number；按层提取作者、外层文字、orig原文、富文本、Opus标题/摘要、图片链接及视频卡标题/简介。内联原文只有ID时补查；默认最多3层，防循环。只展示外层评论坐标，原作者的坐标不替代回复目标。
3. 影响面：2种执行环境（宿主监听器、CLI）×4类消费入口（监听、digest、read/check别名、dynamic check）×显式报错系数1=8，用于审查范围估算；没有改发送、配置、额度、水位规则或人格。新增网络读取会增加延迟；单动态整条读取默认8秒，监听最多4条，摘要默认最多8条；每实例缓存并去重。读取结果增加有限提示词长度，监听总上限10000字符，摘要16000字符。图片仅提取链接，不下载、不假装已看图。
4. 取舍：只改提示词成本低，却依赖模型主动找工具且旧工具仍漏orig；各入口分别补解析易分叉。选择共享读取器加监听器直接注入，集中兼容现代响应和失败路径，旧命令也立即受益；回滚为撤回单个功能提交。
5. 生效：CLI执行时加载新文件；宿主中的scheduler需要集成后重载SurfCore宿主插件，若宿主不支持可靠重载则重启DSH。仅刷新网页不会替换已加载的宿主模块。本轮没有改当前GUI或重启生产。
6. 验证：下面列出精确命令和结果。实测只运行read-dynamic读取用户指定动态，没有发送评论、补发旧@、调整监听游标或调用模型。
7. 回滚与残余：未集成时切回原基线即可；集成后用git revert撤回本功能提交并重载宿主，不删除用户数据。生产真实新@唤醒和模型最终回复尚未实测；图片视觉理解和视频内容观看不属于本次文本阅读。远端内容不可访问时只能报告真实原因；上游返回截断摘要时需打开原动态，增加本地字符预算不保证补齐。

## 命令与兼容

从插件目录执行：

~~~bash
node tools/bili.mjs read-dynamic 1270031871116312601
node tools/bili.mjs read-dynamic https://www.bilibili.com/opus/1262230883329376274 --json
node tools/bili.mjs check-dynamic 1270031871116312601
node tools/bili.mjs dynamic check --id 1270031871116312601
node tools/bili.mjs comment-digest --hours 24 --max-dynamics 8
~~~

旧命令参数保留，输出变为有作者、分层正文和可行动错误的统一格式；read-dynamic的--json是新增结构化接口。成功返回ok/item/warnings，失败返回ok:false/code/error/hint。未保存登录时保留公开匿名读取；凭据文件损坏时明确报错，不输出凭据。退出码0成功、2输入错误、3已有凭据不可读、4读取失败。digest的--raw不增加详情请求。type11通知没有URI时不把评论对象oid猜为动态ID；type11/17无法恢复精确链接时，在摘要和唤醒中显示“原文未读取”。

## 失败路径

接口要求登录时提示在B站设置重新登录；风控提示暂停重试并检查网页；删除/权限问题给出原链接；网络、非JSON、超时、ID不符均有明确code/error/hint。转发原文缺失、循环、层数限制、字段/图片/显示预算截断作为warnings随成功外层显示。上游summary.has_more=true带dynamic.content-incomplete和原文URL，明确增大字数不能补齐上游内容。错误在CLI正文和监听实际投递的消息中可见，不仅写日志。外部正文被标为引用内容；图片链接附“未视觉查看”提示。唤醒中的必做digest使用--max-dynamics 0只补收件箱/回复坐标，避免立刻重复请求已附动态或风控失败；手动digest默认仍展开动态。唤醒提示只在本地显示/批量预算不足时建议增加字数补读，风控或上游不完整须依具体hint处理，不能立即重复请求。

## 验证记录

- 共享读取器：20/20离线用例通过，含现代图文、富文本、视频卡、嵌套原文、删除、ID精度、WBI向量、缓存、重定向、风控、HTTP/JSON失败、整个读取时限、卡住的响应正文、超长多行格式、上游摘要截断及Unicode完整性。Emoji边界回归在修复前失败，修复后通过。
- 阅读链路：真实统一CLI派发器在严格GET夹具下，read/check/dynamic check/digest均输出原文；--raw无额外请求，通知评论坐标保持，预算与失败输出已验证。最终复验包含无登录公开读取、登录受限/损坏凭据、缺少可靠ID的明确通知以及总输出预算。
- 倾听监听器：15/15通过，包括实际queued prompt包含原文、风控错误与上游不完整的正确建议、type11/17缺少可靠ID的可见提醒，以及原有峰时/预算/水位行为。
- 真实只读命令：在功能分支执行read-dynamic 1270031871116312601 --json，exit0、ok:true、原作者蓝色星原旅谣、原文包含“公测正式定档 11月26日”、预约及活动全文、1张图片、warnings=[]；外层comment仍是type17及精确1270031871116312601。
- 完整插件：npm test的42个脚本链退出0；之后Unicode及最终审查修复的20项reader、CLI flow、15项listener全部复验通过。首次沙箱运行在旧更新测试创建Git子进程时报spawnSync git EPERM，放宽测试进程权限后该环境限制消除；新增CLI测试使用普通文件描述符采集输出。
- 仓库audit：沙箱内149/161；允许夹具子进程后完整运行159/161。剩余两项均复验通过：隔离npm ci --ignore-scripts跳过现有SnowLuma补丁，执行已有patch-snowluma-sdk后健康测试9/9；R11 Markdown耗时首次1092ms超500ms阈值，不再并行运行套件后test:regressions 17/17通过。md-to-plain及回归脚本与基线逐字相同，未放宽阈值。未宣称完整audit在一次运行中161/161；最终无未处理测试失败。本改动不涉及QQ桥接/协议。
- 独立只读审查提出的3项边界问题（错误重试建议、免登录兼容、缺ID静默）已全部修复，新增行为断言通过。git diff --check通过；无版本、锁文件、运行状态或凭据改动。

复验命令：

~~~bash
node plugins/surfcore/scripts/test-bili-dynamic-reader.mjs
node plugins/surfcore/scripts/test-bili-dynamic-flow.mjs
node plugins/surfcore/scripts/test-bili-all-day-listener.mjs
npm --prefix plugins/surfcore test
npm run test:audit
npm run test:regressions
node scripts/test-snowluma-upstream-health.mjs
~~~

## 可转发的发布交接

改动文件：共享读取器、收件箱集成、CLI适配器和新入口；scheduler、comment-digest、bili派发、两个旧查看入口；两份新专项测试、监听测试及插件测试脚本；README、ROADMAP、HANDOFF、COORDINATION和本case/索引。
测试及结果：见上方验证记录；实际截图动态的只读读取成功。建议patch（修复原有阅读缺口；不在本编辑会话定版本）。改动层级：实现层+新增CLI；旧CLI参数向后兼容、输出格式更丰富，失败退出码更严格。完整逻辑和影响面：见本case七步。失败路径：统一结构化code/error/hint及原文warnings，CLI和模型输入可见，有失败断言。未验证：生产热加载、新@触发后真实模型回复、图片视觉读取。集成时先核对目标分支和他人改动，保留现有完整人格功能；从合并后HEAD重新生成安装清单。本轮未bump/tag/push/发布，也没有向外发送消息。
