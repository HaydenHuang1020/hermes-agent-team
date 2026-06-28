# Hermes Agent Team Reference

This document preserves the detailed local operating notes for Hermes Agent Team.
The repository homepage is intentionally shorter and points here for deeper setup,
runtime, validation, and data-location details.

Mac 本地桌面端 Hermes Agent Team MVP。

## 启动

优先使用已打包应用，当前已验证可直接打开窗口：

```bash
open "release/mac-arm64/Hermes Agent Team.app"
```

稳定构建并打开：

```bash
./script/build_and_run.sh
```

只验证当前打包应用是否能打开窗口：

```bash
./script/build_and_run.sh --verify
```

也可以双击，默认打开已打包应用：

```bash
Hermes Agent Team.command
```

## 手机端使用

桌面应用启动后，会自动开启一个带访问令牌的局域网手机端入口。左侧栏会显示 `手机端` 卡片，点击 `复制链接`，在同一网络下的手机浏览器打开即可使用 Hermes Agent Team。

手机端只是控制台，Hermes CLI、SQLite、profiles 和所有 Agent 运行仍在这台 Mac 本地执行。

原生 iOS App Store 工程位于：

```bash
ios/HermesAgentTeamMobile/HermesAgentTeamMobile.xcodeproj
```

App Store 提交准备说明见：

```bash
ios/HermesAgentTeamMobile/APP_STORE_READINESS.md
```

真机调试当前默认设备为已配对的 iPhone 16 Pro Max：

```bash
npm run ios:build:device
npm run ios:install:device
npm run ios:launch:device
```

换设备或团队时可覆盖：

```bash
IOS_DEVICE_ID=<device-id> IOS_DEVELOPMENT_TEAM=<team-id> npm run ios:build:device
IOS_DEVICE_ID=<device-id> npm run ios:install:device
IOS_DEVICE_ID=<device-id> npm run ios:launch:device
```

如果真机安装后启动提示开发者未信任，需要在 iPhone 上进入“设置 > 通用 > VPN 与设备管理”，信任对应开发者 App 后再启动。

可选环境变量：

```bash
HAT_MOBILE_PORT=18788
HAT_MOBILE_TOKEN=<自定义令牌>
HAT_MOBILE_SERVER=0
```

## 当前能力

- 架构图与后续路线见 `docs/ARCHITECTURE.md`
- 多 Agent 协作协议见 `docs/OPERATING_PROTOCOL.md`
- Blackboard 结构化状态规范见 `docs/BLACKBOARD_SCHEMA.md`
- 创建和删除工作空间
- 首次打开不会创建默认工作空间；只有用户主动创建空间后，才会创建空间内主 Agent
- 创建工作空间时自动生成任务项目经理 Agent 和讨论 Leader Agent
- 每个 Agent 自动创建全新独立 Hermes profile；同一空间的任务项目经理 Agent 和讨论 Leader Agent 也必须使用不同 profile
- 删除工作空间会先归档，再删除该空间下所有 Agent 记录和应用托管的 Hermes profile；已物理缺失的 profile 视为已删除，不阻断空间清理
- 人只能正式命令主 Agent
- Agent 只能向自己的直接下级委派、创建或删除 Agent
- 主 Agent 创建的辅助 Agent 可以携带核心底层命令和 Hermes provider/model 偏好
- 已有 Agent 卡片可直接编辑核心底层要求和模型；模型选项来自本机 Hermes `config.yaml` 和 provider 模型缓存，后续运行会把 provider/model 传给 Hermes
- 手机端通过带令牌的局域网 Web App 使用同一套工作空间、任务执行、多方讨论和审计能力；Mac 继续作为 Hermes 本地运行时
- 任务执行页会触发目标主 Agent
- 任务项目经理 Agent 会按“任务接收 -> 工作包拆解 -> 临时 Agent 组建 -> 委派契约 -> 监督整合 -> 最终交付 -> 人工确认清理”的协议组织任务
- 任务项目经理 Agent 短时间卡住时可用 `request_discussion_help` 请求讨论 Leader Agent 组织讨论模块提供思路；讨论 Decision Record 会回流到任务 Evidence Pack，任务再继续执行
- 任务中创建的临时 Agent 可在确认完成后一键清理
- 任务 Agent 与讨论 Agent 分开创建、分开选择，互不混用
- 任务和讨论都在同一个空间信息界面内，任务页不显示讨论内容
- 多方讨论页支持多个讨论 Agent 分别发言
- 同一轮讨论里多个讨论 Agent 会同时开始
- 讨论 Agent 默认全选，新建讨论 Agent 会自动加入讨论选择
- 任务 Agent 看不到讨论 Agent 的内容；讨论 Agent 可以看到任务 Agent 的内容
- 讨论 Agent 在后续轮次可以看到人和 Agent 的历史发言
- 任务页只显示任务 Agent；讨论页只显示讨论 Agent，两个 Agent 池完全独立
- 讨论页可以看到任务消息，用于让讨论 Agent 基于任务背景表达意见
- 讨论由空间固定讨论 Leader Agent 接管、控场、决定是否需要下一轮或阶段性询问人，并最终汇总结果
- 讨论 Leader Agent 会按“定题 -> 选框架 -> 分视角 -> 并发首轮 -> 观点矩阵 -> 续轮判断 -> Decision Record -> 清理临时观点 Agent”的协议组织讨论
- 讨论支持选择框架：平衡决策、DACI、RAPID、Delphi、六顶思考帽、Pre-mortem、Red Team、Double Diamond
- 协作基础设施第一版：SQLite Blackboard、任务 Evidence Pack、讨论 Decision Record
- Operating Protocol v0.1：默认最小 Team、讨论轮次上限、参与 Agent 上限和协作深度上限
- Blackboard schema v0.1：facts、assumptions、decisions、risks、open_questions、locks、outputs
- Agent Team Runtime Safety v0.2：运行时 locks 使用主进程 TTL/heartbeat/reap 强制管理，冲突进入 Blackboard risks
- Agent Team Execution Isolation v0.3：运行时 locks 先进入 suspect 宽限期再 stale，代码类任务生成 execution sandbox 协议和接管路径，强制收敛 Decision Record 带 Safe Log
- Task Discussion Bridge Reliability v0.4：任务求助讨论时保存 execution snapshot、等待 TTL、阻断指纹和求助次数；回流前做漂移校验，超时由 watchdog 转人工兜底
- Reliability Closure & Sandbox GC v0.5：限制锁 suspect 振荡，启动/周期性回收过期执行沙箱，execution snapshot 硬限 50KB，任务证据包提供沙箱接管快捷动作
- Data Governance v0.6：启动自检 DB/profile 一致性、外键异常、孤儿数据和锁堆积；支持生成报告、备份 SQLite、显式修复 DB 和归档孤儿 HAT profile
- Reliability Robustness v0.7：锁 suspect 计数按时间衰减；等待讨论/人工确认的沙箱豁免 GC；破坏性沙箱动作二次确认；提供复制接管命令
- Data Safety Hardening v0.8：SQLite 修复前备份必须可读且非空；DB 备份只保留最近 5 份；修复 IPC 有并发锁和 5 分钟冷却；UI 可打开 profile 归档目录
- Data Safety Deep Hardening v0.9：SQLite 修复备份必须通过 `PRAGMA quick_check`；备份轮转锁定 1 份黄金备份；修复冷却跨应用重启持久化；磁盘空间不足时给出明确排障提示
- 达到讨论轮次硬上限时，系统会强制 Leader 输出降级 Decision Record；达到协作深度临界时，任务 Agent 会收到收敛提示
- 右侧协作状态面板显示 `team_state.json` 导出状态、共享状态、任务证据和讨论决策
- Agent prompt 会读取压缩后的 Blackboard 与 Evidence Pack，减少只靠聊天流同步的噪音
- 任务 Agent 回复证据会记录 Hermes profile、模型、耗时、退出状态、脱敏命令、提示哈希和输出摘要
- 内容资产基础设施第一版：SQLite `content_assets`、空间级 `content_archive.json`、Content Assets Memory
- 人类任务需求、讨论主题、Agent 输出、任务最终交付和讨论决策会自动沉淀为可追溯内容资产
- 右侧协作状态面板显示 Content Assets 数量、最近资产和归档状态
- 任务运行记录可以打开任务详情，查看目标、项目经理、临时 Agent、最终输出、Evidence Pack 和沉淀资产
- 讨论状态记录可以打开讨论详情，查看框架、Leader、参与 Agent、Decision Record 和沉淀资产
- 右侧 Content Assets 可以打开内容资产详情，查看来源、摘要、全文和结构化元数据
- 任务和讨论输入框支持 `Command + Return` 发送
- Agent 输出可以用 `@Hayden` 或 `@Agent名称` 指向对象，界面会高亮显示
- 任务和讨论输入框左侧有 `/` 命令按钮，也支持直接输入：`/help`、`/status`、`/stop`、`/start <内容>`、`/round`、`/new`、`/model <模型名>`
- `/stop` 会停止当前空间内由应用触发的 Agent 运行，并把运行中的任务标记为已停止
- `/model` 当前只记录模型切换需求；实际运行模型在右侧 Agent 卡片从 Hermes 当前可用模型中选择
- 右侧不再手动创建模块主 Agent；已有 Agent 卡片可编辑底层要求和 Hermes provider/model，并同步到独立 profile 的 `AGENTS.md`
- 所有关键动作写入审计记录

## 重新打包

```bash
npm run pack:mac
```

产物位置：

```bash
release/mac-arm64/Hermes Agent Team.app
```

当前是本地无签名应用。如果 macOS 首次打开提示安全确认，需要在系统设置里允许打开。

## 审核命令

```bash
npm run verify
npm run build
npm run smoke
npm run smoke:mobile
npm run smoke:legacy-db
npm run smoke:packaged
npm run smoke:packaged:live
npm run ios:build
npm run ios:test
npm run ios:build:device
npm run ios:install:device
npm run ios:launch:device
npm run ios:archive:unsigned
npm run acceptance:dev
npm run acceptance:packaged
npm run release:check
```

`npm run smoke` 使用 mock Hermes 模式，不会创建真实 profile。
`npm run smoke:mobile` 会验证手机端服务启动、令牌校验、HTTP API bootstrap、无 preload 浏览器模式和窄屏发送按钮可见性。
`npm run ios:build` 会编译原生 iOS App；`npm run ios:test` 会跑 iOS 单元测试；`ios:build:device`、`ios:install:device`、`ios:launch:device` 会构建、安装、启动真机 Debug 包；`npm run ios:archive:unsigned` 会做未签名 Release archive 编译检查。
`npm run smoke:legacy-db` 会模拟旧数据库孤儿历史消息，确保历史脏数据不会阻断应用启动。
`npm run smoke:delete-archive` 会验证删除工作空间前已归档任务、讨论和内容资产，确认两个主 Agent profile 相互独立，并确认对应 Agent 数据被清理。
`npm run smoke:packaged:live` 会创建临时真实 Hermes profile，触发一次真实回复，然后删除对应工作空间和 profile。
`npm run acceptance:dev` 会先 build，再用当前 `dist` 和 Electron 开发入口跑验收，适合日常快速反馈。
`npm run acceptance:packaged` 会跑 `release/mac-arm64/Hermes Agent Team.app`，适合发布前验收。
`npm run acceptance` 等同于 `npm run acceptance:packaged`。
`npm run release:check` 会先重新 `pack:mac`，再跑 `acceptance:packaged`，作为发布前卡点命令。
改 Electron 主进程、打包配置或 runtime 行为后，发布前必须先执行 `npm run pack:mac`，再执行 `npm run acceptance:packaged`，避免当前 build 与旧打包产物不一致。
两档 acceptance 都会同时跑 mock 组织权限验收和真实 Hermes 独立 profile 验收，覆盖任务项目经理 Agent、讨论 Leader Agent、Evidence Pack、Decision Record、runtime locks、任务-讨论桥接 watchdog/snapshot/drift/fingerprint、v0.5 沙箱 GC/快照瘦身/接管动作、v0.6 数据健康检测/备份/修复、v0.7 锁衰减/GC 豁免/防误触接管、v0.8 备份轮转/校验/修复冷却/归档目录打开、v0.9 SQLite quick_check/黄金备份/持久冷却/磁盘满诊断和 `team_state.json`。

## 数据位置

应用使用本机 SQLite 持久化。实际路径会显示在应用状态里；打包应用通常位于：

```bash
~/Library/Application Support/hermes-agent-team/data/team.sqlite
```

每个工作空间还会导出只读协作快照：

```bash
~/Library/Application Support/hermes-agent-team/data/team_state/<workspace_id>.json
```

每个工作空间也会导出内容资产归档：

```bash
~/Library/Application Support/hermes-agent-team/data/content_archive/<workspace_id>.json
```

删除工作空间时，会先生成完整删除归档，再删除空间和 Agent：

```bash
~/Library/Application Support/hermes-agent-team/data/deleted_workspace_archive/<workspace_id>-<deleted_at>.json
```

数据治理报告和修复前备份位于：

```bash
~/Library/Application Support/hermes-agent-team/data/data_governance/
```

`修复DB` 会先复制 `team.sqlite` 到 `data_governance/backups/`，且必须通过 SQLite 头部、`PRAGMA quick_check` 和核心表校验后才会清理孤儿行和已释放/失效运行锁。备份目录只保留最近 5 份 `team.sqlite` 历史备份，其中 1 份黄金备份不参与高频轮转；修复入口有主进程并发锁和跨重启 5 分钟冷却。`归档孤儿profile` 只处理 Hermes Agent Team 托管的孤儿 HAT profile，并先复制到 `data_governance/profile_archive/`；`全部修复` 会自动执行 DB 修复、孤儿 profile 归档和健康刷新。

## Hermes 行为

正常运行时，应用会调用本机 `hermes` 命令：

- 创建 Agent：`hermes profile create ... --clone-from default`
- 删除 Agent：`hermes profile delete ... -y`
- 触发回复：`hermes --profile <profile> chat ...`

应用只删除自己创建并绑定的 profile。

新 Agent 的隔离规则：

- 新建独立 Hermes profile，不复用已有 profile
- 继承基础配置、模型 provider 设置、SOUL.md 和 skills；不手写应用内模型列表
- 不继承历史会话、运行态、gateway 状态
- 自动移除继承来的 Telegram/Weixin/Feishu/Lark/Discord/Slack/iMessage 等通讯身份，避免多个 Agent 抢同一个外部机器人身份
- 创建后立即跑一次真实 `chat` 探针；探针失败会自动删除刚创建的 profile

## 桌面环境

macOS 直接打开 `.app` 时不会继承终端 PATH。应用会自动查找：

```bash
~/.local/bin/hermes
~/.hermes/hermes-agent/venv/bin/hermes
/opt/homebrew/bin/hermes
/usr/local/bin/hermes
```

界面左侧会显示 Hermes 是否已定位。

## License

MIT
