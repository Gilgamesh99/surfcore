# 2026-11-17：Fork dev 与原作者更新分离

## 现象与目标

用户授权将 D:/Project/surfcore 的 origin 改为 Gilgamesh99/surfcore，默认工作及推送分支为 dev；原作者 Mieksido/surfcore 保留为 upstream。已有本机功能与修复必须推送到 fork/dev，内置更新继续检测原作者并保留双方提交。

迁移基线为 main/f80a5a2684e7418de6982b40ace48806f7d3ed6a。Fork dev 与 main 起点均为 383f171feef706fe69392947ffc5e5645ec9c2e2：本机独有14提交，fork独有1个 sync-fork 工作流提交。以正常合并保留两边祖先，不强制推送；fork/main 不是本次推送目标。

## 完整逻辑

1. **链路**：设置页更新请求进入 plugins/surfcore/lib/index.js 的动态组件清单，再由 lib/updates.js 检查 Git 目标；排队后 scripts/apply-update.mjs 在宿主退出时应用固定 SHA。Git origin/dev 的追踪和推送与此读取链路分开。
2. **机制**：旧清单固定本地 branch=main，检查器写死 origin/<本地分支>；只换 remote 会误查 fork，直接切 dev 则分支不匹配。增加独立 remote/remoteBranch，branch 继续保护本地分支；本机 updates.surfcore 使用 {branch:dev,remote:upstream,remoteBranch:main}，versionRepo 仍为原作者。
3. **影响面**：2个进程（插件与延迟助手）×3个读者（状态、排队、执行）×报错权重1=6。只调整来源选择与本地 Git/更新配置；现有 QQ/B站/人格和发送路径不变。原作者来源不存在或拉取失败时必须可见地失败，不能退回 fork 或缓存冒充最新。
4. **取舍**：选择显式来源配置，默认仍为 origin 和原本分支，旧安装兼容。自动“有 upstream 就用它”虽更短，却会改变其他用户的默认来源，且丢失 upstream 时可能回落 fork。执行器继续使用已验证的 preserve-local，不新增另一套合并逻辑。
5. **生效**：在隔离工作树合并和验证后，暂停本机 SurfCore 插件，切生产 dev、配置双远程和更新源，再通过宿主 PluginManager 重新启用；不需要重启 QQ 桥接或另起 Web 服务。以现有 GUI http://127.0.0.1:51360 的新检查结果验收。
6. **验证**：新增真实临时 Git 仓库测试覆盖 fork/dev 与 upstream/main 分离、失败来源、固定目标及 dev 执行；执行仓库审计、相应插件检查和 Git 清单校验。最终远端 dev SHA、双历史祖先、内置 checkedWithFetch 与 preserve-local 都必须回读核对。
7. **回滚与残余**：迁移前完整 Git bundle、Git 配置及统一配置保留在 D:/ProgramData/DSH NEXT/Soul/backups/surfcore-fork-dev-20261117。回滚前停插件并检查是否已有新提交/配置；保留新 dev，按备份恢复 remote/updates.surfcore 并切原 main，不能重置或强推 fork。未来同一位置有冲突时更新会停止并恢复原 HEAD，需人工解决；保留双方不等于自动选择冲突内容。

## 配置与维护

- origin： https://github.com/Gilgamesh99/surfcore.git；本地 dev 追踪 origin/dev。
- upstream： https://github.com/Mieksido/surfcore.git；内置更新读取 upstream/main。
- 本机统一配置仅增加 updates.surfcore 的 branch、remote、remoteBranch；已有更新通道及其余设置保持。
- 现有延迟更新任务继续固定 expectedBranch/fromHead/targetSha；执行时不重新按 remote 解析目标。
- Fork 原有 sync-fork 工作流继续针对 main，本次不改其 schedule/目标，也不发布版本或标签。
- 后续内置更新合并到本地 dev 后，如需同步到 fork，正常执行 git push origin dev；本功能不添加自动推送。

## 验证记录

专项已通过：test-updates.mjs 的双远端选择、明确失败、固定 SHA 排队；test-update-git-apply.mjs 全部22个实际助手离线用例；另7个版本/待执行任务/语音更新/UI/宿主/API/客户端兼容脚本通过。4个改动源文件语法与 diff --check 通过。Windows 实际 helper 专项约425.6秒，完整审计原有240秒限制可能触发环境超时，结果须区分记录。全仓审计正在执行；生产 main、原始远程和运行配置尚未调整，推送和运行时证据将在交付前补齐。

## 可转发发布交接块

- 改动：为 Git 更新检查提供与本地工作分支独立的 remote/remoteBranch；本机使用 fork/dev 工作、原作者 main 更新，默认安装行为保留。
- 核心文件：plugins/surfcore/lib/index.js、plugins/surfcore/lib/updates.js、对应更新测试；保留 fork 自带的 .github/workflows/sync-fork.yml。
- 兼容：不改变版本号、公共发送接口和延迟执行器；缺省配置沿用 origin，原作者 ZIP 版本源保持。
- 推荐版本：后续发布可作为 patch 兼容修复；本次只按用户授权推送其 fork/dev，不创建 Release 或 tag。
- 测试与未验证项：见上方最终验证记录；真实远端更新存在冲突时仍需人工解决。
