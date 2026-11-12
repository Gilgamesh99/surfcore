# QQ 受控生图与新图发送（2026-11-12）

状态：功能、隔离测试和本机加载验收完成；已合并到现有生产目录并启用。分支 `feat/qq-generated-images`，基线 `0ce8580`，不改版本、不发布。

## 问题与目标

11 月 11 日 QQ 会话尝试 `mcp__magpie-image__generate_image`，在 QQ 工具白名单处被拒绝；原有 `qq_send_sticker` 只能发送收藏表情，不能交付刚生成的图片。模型设置页的“图片能力未知”是图片输入元数据提示，与这次生成权限拒绝无关。

补齐三步链路：`qq_generate_image` → `qq_image_result` → `qq_send_image`。只传当前会话的 key/token、画面描述或返回的 imageId。生成描述仅在有人请求画图时提交；pending 查询原任务；返回 ready 后再发送；只有 `sent:1` 才能说已经发送。

## 完整逻辑

1. **链路**：DSH 的 QQ MCP 子进程通过 [generated-image-mcp.js](../../src/generated-image-mcp.js) 注册三个工具，经现有 bridge 的 console/session 双层认证，进入 [generated-image-routes.js](../../src/generated-image-routes.js)。[generated-images.js](../../src/generated-images.js) 管理额度、所有权、状态和文件。[magpie-image-backend.js](../../src/magpie-image-backend.js) 启动管理员指定的 Magpie stdio 进程，固定 `mcp image` 参数、单张图片、宿主决定的输出目录；生成与轮询复用同一连接。发送复用 OneBot 与现有 sendChain、群聊保护、令牌预算和发送额度。设置由 bridge 与插件 store 两个入口归一化，界面在 QQ 的“工具与媒体 → 生图与新图发送”。
2. **机制**：原生 Magpie 工具没有 QQ 会话令牌/额度/图片所有权契约，直接白名单放行会把路径控制也交给模型。现在模型不能传任意路径、网址、引用图片或模型名。任务绑定 key 和当时的 token 哈希；图片编号为随机 48 位十六进制串。生成前先持久化额度，异步提交，连接发现结束后、付费调用前再次验证权限；完成和发送前也复查。所有结果只暴露编号与状态，不返回本地路径。PNG/JPEG/WebP 做结构、尺寸、字节上限、链接/目录身份与哈希验证。重启后 pending 变为中断，发送中变为结果未知；两者都不自动重放。
3. **爆炸半径**：涉及三个常驻读者（QQ MCP、桥接、SurfCore 配置/前端）和每任务一个短暂 Magpie 进程。生成可能消耗 Magpie 模型额度，发送会产生真实 QQ 消息，所以测试使用本地假后端/假 OneBot。本机协议检查仅 initialize/tools/list。出厂总闸关闭；默认每会话每天 3 次、全局 12 次，冷却 60 秒，并发全局最多 2、每会话 1，5 分钟超时。失败和中断也计入额度；本机日历日结算。文件最多 10 MiB，编号有效期最多 24 小时。默认保留账本最多 128 次尝试（硬上限 512），达到上限明确拒绝，不自动删除历史文件或清空额度。
4. **取舍**：方案 A 把全部 Magpie 工具放入 QQ 白名单，改动少但允许模型直接指定文件/模型，且仍缺少发送所有权验证；不采用。方案 B 通过宿主内部工具执行服务转发，需要新增跨进程接口、认证和 PTC 适配；本次不扩展这层。采用 QQ 专用薄工具 + 专用状态服务 + Magpie stdio，复用已有依赖与发送策略，兼容当前 Magpie 的文字状态协议和同 basename 的 JPEG/WebP 扩展名调整。
5. **生效与重启**：bridge 读取接口、额度和开关，需要重启 QQ 桥接；QQ MCP 在启动时注册工具，首次安装需重新加载 `mcp-snowluma`。工具始终注册，运行时按设置拒绝；后续开关不必重新安装工具。设置前端需重新加载插件页面/资源；旧会话的工具守卫仍保留执行期白名单，新会话还会隐藏原生 Magpie schema。只重启对应组件，不主动发送测试消息。
6. **验证**：`node --test scripts/test-generated-images.mjs`（68 个测试，67 通过，1 个 Windows 文件软链接权限跳过；junction/hardlink/替换竞态实际通过）；`node --test scripts/test-magpie-image-backend.mjs scripts/test-generated-image-flow.mjs`（适配器/MCP/守卫、真实桥接 HTTP 假后端链路）；`npm run test:regressions`（17 条通过）；`npm run test:audit`、`cd plugins/surfcore && npm test` 最终结果见下方验收。`node scripts/check-image-backend.mjs <Magpie绝对路径>` 只读检查已返回 compatible/outputPath/singleImage/resultPolling 全 true。断言覆盖无令牌、越会话、撤权、禁用、额度、并发、文件篡改/越界、重复发送、网关结果未知、重启恢复；错误均有 code/error/hint。
7. **回滚与残余**：先关闭 `socialV2.images.enabled`，恢复本次备份的改动文件和配置，重启桥接并重新加载 QQ MCP。保留图片账本、发送记录和历史文件；不要删除账本以重置当日额度。未实际调用付费生图、未向真实 QQ 发图；供应商登录/额度及最终 QQ 客户端展示需首次真实请求验证。文件结构校验不是完整图片解码器。128 条满后需管理员停桥接并按保留当天额度的方式归档；未提供自动清理。Windows 文件 symlink 用例因权限跳过，目录 junction、hardlink 与替换竞态均覆盖。

## 设置与失败处理

- `socialV2.images.enabled`：总开关；`magpieCommand`：本机 Magpie 可执行文件绝对路径；`model`：空白沿用 Magpie 设置。
- `tools.generateImage/imageResult/sendImage`：三个独立工具开关；同时受总开关约束。
- `IMAGE_DISABLED`：到上述 QQ 设置开启；`IMAGE_BACKEND_UNAVAILABLE/FAILED/INCOMPATIBLE`：检查 Magpie 安装、模型、登录/额度或接口版本。
- `IMAGE_BUSY/COOLDOWN/DAILY_LIMIT`：等待任务/间隔/次日，不能用换令牌绕过额度。
- `IMAGE_DELIVERY_UNKNOWN`：确认 QQ 是否已经收到，避免重复发送；不能自动重发。
- `IMAGE_STORAGE_FULL`：停桥接后归档专用生成目录，保留当日额度。任何路径、状态、图片被替换或损坏都停止读取，不返回原始系统/供应商异常。

## 验收记录

- 审计 156/156 脚本通过；regressions 17 条通过；插件测试通过。复核修正后，三个图片测试文件合计 83 个测试、82 通过、1 个 Windows 文件 symlink 权限跳过（包含 9 条真实 bridge HTTP 隔离集成测试）。生产目录三方合并后再次执行图片 83 项与 regressions 17 条，最终同样通过；生产 VM 夹具补载已有续聊模块，修复的是测试遗漏，未改续聊产品代码。
- 12:13 完成 24 文件的备份合并与 QQ 桥接重启；PID 92792，root 为 D:/Project/surfcore，reserved2、dshReady、SnowLuma connected 均正确；总闸与三工具开关 true。六个无关既存文件哈希保持不变。三个真实路由无令牌请求均 403 IMAGE_ACCESS_DENIED，真实 QQ MCP 的 image_result 同样拒绝无效令牌，说明已注册并连接新桥接。
- 已刷新现有 DSH GUI（http://127.0.0.1:64871），在 SurfCore → QQ → 高级设置 → 工具与媒体看见“生图与新图发送”，打开后显示 Magpie 路径、配额 3/12、间隔 60000、并发 2、10MiB、24h、容量 128、超时 300000；未通过 UI 改写配置。当前协议与页面均已加载，未声称 plugin_manager 的 unmanaged 插件支持热重启。
- 部署备份、三方输入/输出与哈希清单：D:/ProgramData/DSH NEXT/Soul/backups/qq-images-deploy-20261112-v3；首次尝试遇到桥接端口先监听、模式尚未刷新，已自动恢复并增加 dshReady+mode 就绪等待后重试成功。原始 v2 回滚基线保留。测试夹具追加备份位于 qq-images-harness-20261112，最终文档追加备份位于 qq-images-docs-20261112。
- Windows 含空格工作树暴露 release-manifest URL 解码问题，改用 fileURLToPath；MCP VM/隔离拷贝夹具补入新注册模块。测试工作树的本地配置仅从 example 创建，所有远端地址指向不可用回环端口；没有复制生产密钥。Windows start.bat 只规范 CRLF。

## 可转发的发布交接块

改动：QQ 三个受控生图/查询/发图工具，独立任务文件服务与 Magpie stdio 适配器，桥接接线、配置归一化、设置 UI、原生 Magpie schema 隐藏；测试夹具与 Windows 路径兼容修正。
测试：服务 67 通过/1 权限跳过；图片链路合计 82 通过/1 跳过；audit 156/156、regressions 17、插件测试通过；协议只读兼容检查通过。本机加载结果见验收记录。
版本建议：minor（新增向后兼容能力，出厂关闭）；本次未 bump/tag/push/release。
接口层级：新增 QQ MCP 与桥接路由，现有工具与表情通道保持兼容；完整逻辑与影响见本 case。
失败路径：工具结构化返回 code/error/hint，查询保留同一 imageId，结果未知不重发；失败分支有隔离测试。
未验证：真实付费生图、真实 QQ 发图及图片显示；Windows 文件 symlink 权限用例。
