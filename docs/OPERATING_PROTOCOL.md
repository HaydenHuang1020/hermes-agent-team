# Hermes Agent Team Operating Protocol v0.1 + Runtime Safety v0.2 + Reliability Closure v0.5

更新时间：2026-06-28

## 1. 目标

提升多 Agent 协作质量，同时控制成本、延迟、状态冲突和失控风险。

核心原则：

- 少 Agent、高约束、强验证。
- 先交付可验证结果，再考虑扩编 Team。
- Team 必须是并行执行 + 独立审查 + 证据收敛 + 主 Agent 负责制的工作系统，不是多人聊天。
- 讨论用于收敛判断，不用于无限延长上下文。
- 临时 Agent 默认用完即清理，保留输出、证据和决策记录。

## 2. 默认 Team 形态

任务执行：

- 默认单项目经理 Agent 推进。
- 只有能力缺口、并行验证、独立审查或长周期拆分时，才创建临时 Agent。
- 启动 Team 时必须记录 `team_work_graph`，包含工作包、并行组、证据要求和审查点。
- 多个互不依赖的 `delegate` 动作由主进程按 `parallel_group` 并行触发，并记录 `parallel_delegate_group`。
- 非简单 Team 任务必须有独立审查或 Red Team 工作包；缺失时 `quality_gate` 写入风险。
- Team 执行后必须触发主 Agent 证据收敛回合，并记录 `primary_synthesis_result` 作为最终输出来源。
- 最终结果只由主 Agent 对 Hayden 负责，副 Agent 原文只作为折叠证据和审查材料。
- 自动协作深度硬上限为 3 层。
- 任务项目经理短时间没有可靠推进思路时，可请求讨论 Leader 组织讨论模块支援；讨论输出必须回流到任务 Evidence Pack 后再继续执行。

多方讨论：

- 默认 1 个 Leader + 2 个观点 Agent。
- 参与观点 Agent 硬上限为 3 个。
- 默认 2 轮讨论：第 1 轮独立判断，第 2 轮交叉审辩。
- 自动续轮硬上限为 4 轮。
- 第 3 轮以后只在重大分歧、证据不足、风险未澄清、框架要求或 Hayden 明确要求时触发。

## 3. 预算、熔断与安全退出

每次任务或讨论必须有停止条件：

- 接近讨论轮次硬上限时，系统向 Leader 注入强制收敛提示。
- 达到轮次硬上限时，不再自动扩轮；Leader 必须输出降级 Decision Record。
- 达到 Agent 数量上限时，Leader 必须收敛已有观点，不继续扩编。
- 达到自动协作深度上限时，项目经理必须交付已有证据、风险和未完成项。
- Hermes 执行失败、超时或被 `/stop` 停止时，必须写入 Evidence Pack 或 Decision Record。

降级 Decision Record 至少包含：

- 当前阶段。
- 已知事实。
- 未验证假设。
- 已完成事项。
- 未完成事项。
- 脏现场路径。
- 相关锁状态。
- 回滚命令。
- 接管命令。
- 风险。
- 推荐下一步。
- 是否需要 Hayden 确认。
- Safe Log 纯文本兜底。

## 4. 输出协议

任务项目经理必须输出：

- 目标、约束、交付物、验收标准和风险边界。
- Team 启动判断：单 Agent 或临时 Team。
- 工作图：工作包、依赖、并行组、证据要求、独立审查点和最终负责人。
- 下级委派契约：背景、边界、输出格式、证据要求、停止条件。
- 证据收敛：执行输出、审查输出、风险和未验证假设必须进入 Evidence Pack 或 Blackboard。
- 卡点求助判断：若使用 `request_discussion_help`，必须说明卡点、已尝试路径、需要讨论模块输出什么。
- 桥接求助上下文：`request_discussion_help` 必须尽量提供 current_stage、failed_command、error_output、file_paths、subtask_id；系统会固化为 execution snapshot。
- 最终交付：最终结论、结果、关键证据、独立审查结果、风险、需要 Hayden 确认的事项。

讨论 Leader 必须输出：

- 问题定义。
- 观点矩阵。
- 共识和分歧。
- 风险与待验证假设。
- Decision Record。

## 5. 执行安全线

代码、配置或文件修改类任务必须遵守：

- 涉及同一任务执行或讨论资源时，必须先取得主进程运行时锁。
- active lock 必须有 owner、session、resource、heartbeat 和 TTL。
- 锁冲突必须进入 Blackboard `risks` 和审计记录，不能静默覆盖。
- TTL 到期后先进入 `suspect` 宽限期；宽限期内有 heartbeat 必须恢复为 `active`。
- stale lock 只能在 suspect 宽限期结束且仍无 heartbeat 后由主进程回收，Agent 不能只靠自然语言声明释放。
- suspect/stale/reap 事件必须进入 Blackboard `risks` 或审计记录，不能静默处理。
- 同一把运行时锁单生命周期最多允许 3 次进入 `suspect`；超过后主进程强制转 `stale`，防止僵尸锁振荡。
- 子 Agent 的输出未验证前不能直接作为最终结果。
- 代码、配置或文件修改类任务必须准备 execution sandbox 协议，记录 sandbox 路径、建议 worktree 路径、回滚命令和接管命令。
- execution sandbox 超过 24 小时未活动且无活跃任务/锁时，主进程可自动 GC；回收必须写入 Evidence Pack 或审计。
- `execution_snapshot` 必须控制在 50KB 内，排除 `node_modules`、`.git`、`release` 和大文件，避免高频快照造成 IO 抖动。
- 沙箱接管只允许使用主进程白名单动作：接管协议、移除推荐 worktree、清理应用沙箱。
- 启动时必须执行数据健康自检：SQLite 外键、孤儿行、DB/profile 一致性和历史锁堆积。
- 数据修复必须先生成报告并备份 SQLite；profile 清理必须先归档，不能静默删除。
- 数据修复开始清理前必须校验 SQLite 备份可读且非空；校验失败必须阻断修复。
- SQLite 备份还必须通过头部校验、`PRAGMA quick_check` 和核心表存在性校验，避免损坏备份进入可回滚链路。
- `team.sqlite` 修复备份只保留最近 5 份，防止长期高频修复导致磁盘通胀。
- 5 份备份中必须保留 1 份黄金备份，不参与高频轮转，防止连续异常覆盖所有健康备份。
- 数据修复 IPC 必须串行执行，并在成功修复后进入 5 分钟冷却；UI 在修复中或冷却中必须禁用修复入口。
- 数据修复冷却时间戳必须落盘，应用重启后仍然生效。
- 写盘出现 `ENOSPC` 时必须给出“磁盘空间不足”的明确诊断，不能静默失败或继续清理。
- UI 必须提供 profile 归档目录打开入口，方便 Hayden 直接检查和手动清理物理归档。
- 数据健康 UI 必须提供三个清晰动作：`修复DB`、`归档孤儿profile`、`全部修复`。`全部修复` 必须由主进程顺序执行 DB 修复、孤儿 profile 归档和健康刷新。
- 代码任务优先测试先行或至少补最小验证。
- 合并前必须有 Evidence Pack：命令、退出状态、输出摘要、文件影响。

## 5.1 任务-讨论桥接可靠性

任务项目经理请求讨论模块支援时，主进程必须记录：

- `execution_snapshot`：任务 ID、子任务 ID、当前阶段、失败命令、错误输出摘要、涉及文件、Git HEAD/branch/dirty status、已尝试方案和阻断描述。
- `wait_started_at` / `expires_at`：等待讨论结果的生命周期。
- `block_fingerprint`：由文件路径、失败命令、错误摘要、子任务和已尝试方案生成。
- `discuss_count`：单任务累计求助次数。

运行规则：

- `waiting_discussion` 超过 TTL 后由 watchdog 标记 `timeout`，写入 Evidence Pack 和 Blackboard `risks`，并把任务转为人工确认兜底。
- 讨论 Decision Record 回流前必须对比 execution snapshot 和当前现场；Git HEAD、dirty status 或关键文件 hash 变化时，必须写入 drift 风险并把漂移信息注入任务恢复上下文。
- 同一阻断指纹不能重复立即求助。
- 单任务讨论求助默认最多 2 次，超限后转人工确认或降级执行。

## 6. 验证分层

日常开发和发布前验收分开：

- `acceptance:dev`：先 build，再用当前 `dist` 和 Electron 开发入口跑验收，适合快速反馈。
- `acceptance:packaged`：跑 `release/mac-arm64/Hermes Agent Team.app`，用于发布前验收。
- 改 Electron 主进程、打包配置或 runtime 行为后，发布前必须重新 `pack:mac`，再跑 packaged 验收。
- 发布前卡点命令为 `npm run release:check`，它会重新打包并跑 packaged 验收。

## 7. 当前实现状态

已落地：

- 讨论默认 2 轮。
- 讨论低于 2 轮不得直接最终收敛；系统会把提前 `final` 改为继续交叉审辩。
- 自动续轮硬上限 4 轮。
- 默认 2 个观点 Agent。
- 观点 Agent 选择硬上限 3 个。
- 任务自动协作深度硬上限 3 层。
- Blackboard schema v0.1 会进入 Agent prompt。
- Runtime locks v0.2：主进程级 TTL、heartbeat、stale reap、冲突阻断和 UI 只读展示。
- Execution Isolation v0.3：runtime locks 增加 `suspect -> grace -> stale` 防误杀状态机；代码类任务生成 execution sandbox 协议；强制收敛 Decision Record 带 Safe Log、回滚和接管信息。
- Bridge Reliability v0.4：`task_discussion_links` 增加 execution snapshot、wait TTL、block fingerprint、discuss count；watchdog 防永久等待，回流前做 drift validator。
- Reliability Closure v0.5：runtime locks 增加 suspect 振荡上限；执行沙箱启动/周期性 GC；execution snapshot 50KB 上限和路径排除；任务详情证据包提供沙箱接管快捷动作。
- Data Governance v0.6：启动自检数据层，前端显示数据健康状态，支持报告、备份、DB 修复和托管 profile 归档。
- Reliability Robustness v0.7：runtime lock suspect 计数按时间衰减；沙箱 GC 豁免 `running`、`waiting_discussion`、`awaiting_confirmation` 现场；破坏性沙箱动作必须二次确认；接管动作提供复制命令降级路径。
- Data Safety Hardening v0.8：SQLite 修复前备份增加非空可读校验；DB 备份滚动保留最近 5 份；修复 IPC 增加并发锁和 5 分钟冷却；数据健康卡可打开 profile 归档目录。
- Data Safety Deep Hardening v0.9：SQLite 备份增加 quick_check 连接性校验；备份轮转保留黄金备份；修复冷却状态持久化；磁盘满错误转换为明确诊断。
- Team Work System v1.0：任务 Team 从多人聊天升级为工作图、并行委派、独立审查、证据收敛和主 Agent 负责制；新增 `team_work_graph`、`parallel_delegate_group`、`primary_synthesis_result`、`quality_gate` 证据。
- 讨论轮次达到硬上限时，Leader 会被强制收敛为降级 Decision Record。
- 验收链路已拆为 `acceptance:dev` 和 `acceptance:packaged`。
- 发布卡点脚本 `release:check` 已绑定 `pack:mac` 和 `acceptance:packaged`。
- 任务-讨论求助桥接：任务项目经理可发起 `request_discussion_help`，系统记录 `task_discussion_links`，讨论结果回写 Evidence Pack 和 Blackboard 后唤醒任务继续执行。

未完全落地：

- Token/成本预算仍以 Agent 数、轮次和 Hermes max-turns 控制，还没有真实计费统计。
- 子 Agent worktree 已有 sandbox 协议和建议路径，但自动创建、合并和冲突解决仍未完全自动化。
