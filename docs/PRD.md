# Hermes Agent Team PRD

更新时间：2026-06-27

## 1. 产品目标

Hermes Agent Team 是运行在 Mac 本地的桌面端应用，用来创建、管理和协调一组本地 Hermes Agent。

产品第一性原理：

- 人不应该直接管理所有下级 Agent。
- 工作空间像公司，是用户可见的组织边界；第一版不再暴露频道概念。
- 系统首次打开必须是空工作台，不允许自动创建默认工作空间。
- 创建工作空间时，任务执行模块和多方讨论模块必须同时存在，并自动生成各自的主 Agent。
- Agent 可以看见同一工作空间中自己被允许看到的消息，但只能按层级响应。
- 桌面端创建的新 Agent，本质上必须是一个新的独立 Hermes profile。
- 创建成功的标准不是界面出现卡片，而是 Hermes profile 已创建、已隔离、已通过真实 chat 探针。
- 任务执行 Agent 与多方讨论 Agent 必须是两个独立池，不能混用。
- 任务和讨论在同一个空间信息界面内，但任务页不能显示讨论内容。
- 讨论页可以显示任务内容，作为多方讨论的背景。
- 任务 Agent 的上下文不能包含讨论 Agent 的内容。
- 讨论 Agent 的上下文可以包含任务 Agent 的内容。
- 讨论 Agent 在后续轮次必须能看到前面人和 Agent 的发言。
- 输入框必须支持 `Command + Return` 发送。
- 输出内容允许使用 `@Hayden` 或 `@Agent名称` 指向对象，并在界面高亮。
- 输入框左侧必须有 `/` 命令按钮，可直接调出常用命令。
- 主 Agent 创建辅助 Agent 时，可以指定辅助 Agent 的核心底层命令和 Hermes provider/model 偏好。
- 人可以随时修改已有 Agent 的核心底层要求和模型；模型选项必须来自本机 Hermes 配置与模型缓存，provider/model 必须进入后续 Hermes 调用参数。
- 复杂协作不能只靠聊天流同步，必须有共享状态、任务证据和讨论决策记录。
- 多 Agent 协作必须默认最小化：少 Agent、高约束、强验证，不能用扩编和加轮次替代判断质量。
- 每次任务/讨论必须有参与者数量、轮次、协作深度和停止条件。
- Blackboard 必须按固定 schema 维护 facts、assumptions、decisions、risks、open_questions、locks、outputs。
- 任务输出必须保留 Evidence Pack，临时 Agent 可以删除，但证据和输出不能丢。
- 多方讨论必须收敛成 Decision Record，否则讨论只是噪音。
- 对话内容和输出内容是长期资产，必须结构化保存、可追溯来源、可导出、可用于后续 Agent 和产品优化。
- 原始消息流用于完整追溯，内容资产层用于低噪音复用，二者不能混为一谈。
- 任务、讨论和内容资产不能只停留在聊天流里，必须能进入详情视图进行复盘和审检。
- 删除工作空间时，空间内 Agent 和对应 Hermes profile 必须删除；空间内任务、讨论、消息、证据、决策和内容资产必须先完整归档，不能随空间一起丢失。
- 数据健康不是单一问题：SQLite 孤儿行、外键残留、历史运行锁、缺失 profile、孤儿 HAT profile 必须拆开解释，并提供可验证的一键收敛路径。

### 1.1 版本回顾与 PRD 对齐

本次回顾以当前代码、README、`OPERATING_PROTOCOL.md`、`BLACKBOARD_SCHEMA.md`、验收脚本和 PRD 现状为真值源。PRD 不再只记录“本轮新增”，而是按能力版本追踪产品边界、数据结构和验收标准。

| 版本 | 产品定位 | 已补入 PRD 的位置 | 状态 |
| --- | --- | --- | --- |
| 2026-06-25 MVP | 本地桌面端、工作空间、任务/讨论双模块、独立 Hermes profile、真实验活、响应式 UI、`Command + Return`、`@` 高亮和 `/` 命令入口。 | 产品目标、用户角色、信息架构、独立 Hermes 创建规则、MVP 范围、基础验收。 | 已落地 |
| 2026-06-26 协作层 | 项目经理协议、讨论 Leader 协议、讨论参与协议、Blackboard v0.1、Evidence Pack、Decision Record、Content Assets、任务/讨论/资产详情。 | 任务项目经理协议、讨论 Leader 协议、内容资产、详情复盘、验收标准。 | 已落地 |
| v0.2 Runtime Safety | 运行时锁由主进程管理，具备 TTL、heartbeat、suspect、stale、released 和冲突审计。 | 斜杠命令、数据健康、运行时安全验收、验证记录。 | 已落地 |
| v0.3 Execution Isolation | 代码/配置/文件类任务生成 execution sandbox 协议、接管路径、回滚信息和降级 Decision Record Safe Log。 | 运行时安全验收、任务执行验收、后续设计。 | 已落地 |
| v0.4 Task Discussion Bridge | 任务项目经理可用 `request_discussion_help` 请求讨论 Leader 支援；桥接记录 snapshot、TTL、阻断指纹、求助次数、drift 校验和超时兜底。 | 任务执行协议、任务执行验收、验证记录。 | 已落地 |
| v0.5 Reliability Closure | 限制 lock suspect 振荡，瘦身 execution snapshot，启动/周期性 GC 过期沙箱，任务证据包提供接管快捷动作。 | 任务执行验收、运行时安全验收、验证记录。 | 已落地 |
| v0.6 Data Governance | 启动自检 SQLite/profile 一致性、外键异常、孤儿行、缺失 profile、孤儿 HAT profile 和旧锁堆积；支持报告、备份、DB 修复和 profile 归档。 | 数据健康与一键治理、数据健康验收。 | 已落地 |
| v0.7 Reliability Robustness | lock suspect 计数按时间衰减；等待讨论/人工确认现场豁免沙箱 GC；破坏性沙箱动作二次确认；复制接管命令降级路径。 | 运行时安全验收、验证记录。 | 已落地 |
| v0.8 Data Safety Hardening | 修复前备份必须可读且非空；DB 备份保留最近 5 份；修复 IPC 串行和 5 分钟冷却；可打开 profile 归档目录。 | 数据健康与一键治理、MVP 范围、数据健康验收。 | 已落地 |
| v0.9 Data Safety Deep Hardening | SQLite 备份通过 `PRAGMA quick_check` 和核心表校验；黄金备份不参与轮转；冷却跨重启持久化；磁盘满给出明确诊断。 | 数据健康与一键治理、MVP 范围、数据健康验收。 | 已落地 |
| v0.10 Missing Profile Recovery | DB 中 app 托管 Agent 引用的 Hermes profile 丢失时，可重建独立 profile、通过真实探针、更新 DB 引用和审计记录。 | 数据健康与一键治理、数据健康验收、验证记录。 | 已落地 |

## 2. 用户与角色

### 2.1 人类用户

当前 MVP 只支持单机单用户，即 Hayden。

人类用户权限：

- 创建/删除工作空间。
- 编辑空间内主 Agent 的底层要求和模型。
- 给任务项目经理 Agent 下达正式任务。
- 在任务执行页发起具体任务。
- 在多方讨论页发起由讨论 Leader Agent 控场的讨论。

限制：

- 人类用户不直接命令所有下级 Agent。
- 正式任务默认只给主 Agent。

### 2.2 任务项目经理 Agent

任务项目经理 Agent 是任务执行模块的内置主 Agent。创建工作空间时自动创建，不需要人手工创建。

任务项目经理 Agent 权限：

- 接收人的正式任务。
- 拆解任务。
- 创建下级 Agent。
- 删除下级 Agent。
- 向直接下级委派任务。
- 为下级 Agent 指定核心底层命令和 Hermes provider/model 偏好。

任务项目经理 Agent 只属于任务执行池，不参与多方讨论池。

任务项目经理工作协议：

- 任务接收：把人的目标转成目标、约束、交付物、验收标准和风险边界。
- Team 启动判断：先判断单 Agent 是否足够；只有能力缺口、需要并行验证、需要独立审查或长周期拆分时才启动临时 Team。
- ROI 判断：创建临时 Agent 前必须考虑冷启动、Token、合并和写入冲突成本；简单任务默认单 Agent 推进。
- 工作图：复杂任务必须记录工作包、依赖、并行组、证据要求、独立审查点和最终负责人。
- 工作包拆解：把任务拆成可独立交付的工作包，每个工作包必须包含目的、输入、输出、能力要求和证据要求。
- 临时 Agent 组建：只在缺少能力、需要并行验证或需要专门审查时创建临时 Agent。
- 底层配置：创建下级 Agent 时可以指定核心底层命令和 Hermes provider/model 偏好。
- 委派契约：每次委派必须包含背景、边界、输出格式、验收标准、证据要求和停止条件。
- 并行执行：同一 `parallel_group` 的互不依赖工作包必须由系统并行触发。
- 独立审查：非简单 Team 任务必须有审查或 Red Team 工作包，审查输出必须进入证据包。
- 证据收敛：项目经理用 Evidence Pack 和 Blackboard 检查下级输出、审查输出、风险和缺口，合并为最终交付。
- 主 Agent 负责制：最终结论由主 Agent 负责，副 Agent 输出只作为可展开证据，不直接堆给 Hayden。
- 主 Agent 收敛回合：Team 执行后必须由主 Agent 基于 Evidence Pack 输出最终结论，记录为 `primary_synthesis_result`。
- 最终交付：向 Hayden 汇报最终结论、关键证据、审查结果、风险和需要确认的事项。
- 任务清理：人确认完成后，系统删除本次任务临时 Agent，只保留输出、证据和审计记录。

### 2.3 下级 Agent

下级 Agent 是由人或上级 Agent 创建的独立 Hermes Agent。

下级 Agent 权限：

- 可以看见所在工作空间中自己被允许看到的消息。
- 只能回复自己的直接上级。
- 只能执行上级委派的任务。

下级 Agent 只属于任务执行池。

### 2.4 讨论 Leader Agent

讨论 Leader Agent 是多方讨论模块的内置主 Agent。创建工作空间时自动创建，不作为普通讨论参与者。

讨论 Leader Agent 权限：

- 按用户选择的讨论框架组织讨论。
- 调动讨论参与 Agent 并控制轮次。
- 判断是否继续下一轮、是否需要向人阶段性提问，或是否可以最终汇总。
- 编辑后续使用的底层要求和模型。

讨论 Leader Agent 只属于多方讨论池，不参与任务执行池。

### 2.5 讨论参与 Agent

讨论 Agent 是独立于任务组织结构的 Agent，不能和任务 Agent 混用。

讨论 Agent 权限：

- 参与多方讨论。
- 按轮次表达观点。
- 不创建任务下级 Agent。
- 不删除任务 Agent。
- 不接收任务执行页的正式任务。

## 3. 信息架构

### 3.1 工作空间

工作空间代表一个公司、项目或业务组织。

能力：

- 创建工作空间。
- 首次打开无任何工作空间、无任何空间主 Agent；必须由用户主动创建第一个工作空间。
- 删除工作空间：从当前工作台移除该空间，并删除空间内 Agent；删除前必须生成删除归档，保留任务、讨论、消息、证据、决策、内容资产和审计。
- 工作空间内维护独立的 Agent、消息、任务、讨论和审计记录。

### 3.2 默认消息流

第一版不向用户暴露频道。每个工作空间内部保留一个默认消息流，用于兼容消息、任务、讨论和审计数据。

能力：

- 用户只创建和删除工作空间。
- 当前空间内进行群聊式消息流。
- 内部默认消息流不在 UI 中作为独立对象展示。

### 3.3 两种工作形态

当前产品不再让用户在输入区选择“聊天 / 通知 / 任务”。

人的发言就是发言。系统根据用户所在页面判断用途：

- 任务执行：人的发言被视为具体任务目标，只能交给主 Agent。
- 多方讨论：人的发言被视为讨论主题或补充意见，只能触发讨论 Agent 分别表达观点。

任务执行和多方讨论共享同一个空间信息界面，但页面展示按工作形态过滤：

- 任务执行页只显示任务内容、任务 Agent 回复和任务系统状态。
- 多方讨论页显示讨论内容，同时可以显示任务内容作为背景。
- 任务执行页和多方讨论页输入框均支持 `Command + Return` 发送。
- 消息内容中的 `@Hayden` 和 `@Agent名称` 作为指向对象展示。
- 右侧 Agent 卡片支持编辑核心底层要求和 Hermes provider/model，保存后更新数据库和独立 Hermes profile 标记。
- 右侧不再提供创建模块主 Agent 的入口；任务项目经理 Agent 和讨论 Leader Agent 随工作空间自动存在。

上下文可见性：

- 任务 Agent 看不到讨论主题、讨论 Agent 回复、讨论系统轮次消息。
- 讨论 Agent 可以看到任务目标、任务 Agent 回复、任务系统状态。
- 讨论 Agent 在第二轮及后续轮次可以看到前面讨论 Agent 的回复。
- 任务页右侧只显示任务 Agent。
- 讨论页右侧只显示讨论 Agent。
- 任意 Agent 只能属于任务执行池或多方讨论池之一，不能同时存在于两个页面。

消息仍保留内部类型，用于审计和展示：

- task：任务目标或任务委派。
- discussion：讨论主题、讨论发言和讨论轮次。
- reply：Agent 回复。
- system：系统状态反馈。

### 3.4 讨论 Leader Agent

讨论模式由空间固定的讨论 Leader Agent 接管，不再由人手工管理每个讨论 Agent 的轮次。

第一性原理：

- 人发起的是一个讨论目标，不应该手工管理每个讨论 Agent 的轮次。
- 讨论需要一个稳定负责人来控场、判断是否继续、压缩噪音、最终汇总。
- 讨论 Leader 需要可编辑的底层要求和 Hermes provider/model，以便人持续塑造它的组织方式。
- 临时观点 Agent 不需要长期常驻；除非是用户主动创建的稳定专家角色。

当前流程：

- 人发起讨论主题。
- 空间内置讨论 Leader Agent 接管讨论。
- 如果用户没有选择长期讨论 Agent，系统自动创建临时观点 Agent。
- 参与 Agent 同轮并发发言，并能看到人、讨论 Leader 和其他参与 Agent 的发言。
- 讨论 Leader Agent 判断是否继续下一轮、是否需要向人阶段性提问，或是否可以汇总结束。
- 普通参与 Agent 不直接决定继续轮次。
- 讨论 Leader Agent 只在需要人确认/补充时找人；否则在有阶段性结论或最终结论时汇报。
- 讨论最终结束后，系统清理本次讨论创建的临时观点 Agent，只保留讨论输出和审计记录；讨论 Leader Agent 保留在空间内。

讨论 Leader 工作协议：

- 定题：把用户话题转成核心问题、讨论边界、判断标准和需要产出的结论类型。
- 选框架：按用户选择的讨论框架组织讨论，不做无框架闲聊。
- 分视角：把参与 Agent 分配到不同专业视角或立场，讨论 Leader 不作为普通观点 Agent 发言。
- 并发首轮：同一轮内所有参与 Agent 同时发言，避免串行发言污染独立判断。
- 共享阅读：讨论 Agent 可以读取任务内容、任务证据和前面讨论发言。
- 最低审辩轮次：默认至少 2 轮；第 1 轮独立判断，第 2 轮必须交叉审辩并回应上一轮观点。
- 观点矩阵：每轮后整理立场、证据、风险、建议、共识和分歧。
- 续轮判断：第 3 轮以后只有重大分歧未解决、证据不足、风险未澄清或框架需要时才继续下一轮。
- 人工介入：需要 Hayden 选择方向、补充约束或批准继续时，只问一个清晰问题。
- 决策记录：最终必须形成 Decision Record，包含问题定义、事实证据、观点矩阵、推荐结论、风险、下一步行动和置信度。
- 清理：讨论结束后清理临时观点 Agent，长期专家和讨论 Leader 保留。

### 3.5 讨论框架

人发起讨论前可以选择讨论框架。讨论 Leader Agent 必须按所选框架组织参与 Agent 发言、判断是否继续、以及生成阶段性或最终结论。

当前预设框架：

- 平衡决策：适合一般问题，收集事实、分歧、方案和行动。
- DACI 决策：适合项目决策，明确 Driver、Approver、Contributors、Informed。
- RAPID 决策：适合高责任协同，明确 Recommend、Agree、Perform、Input、Decide。
- Delphi 共识：适合不确定性高的问题，通过多轮专家意见收敛。
- 六顶思考帽：适合创意和复杂问题，从事实、直觉、风险、收益、创意、流程并行思考。
- Pre-mortem 风险：适合任务开工前，先假设失败，再倒推风险和预防动作。
- Red Team 审查：适合安全、架构、上线前审查，用对抗视角寻找漏洞和阻断风险。
- Double Diamond：适合产品和体验问题，按 Discover、Define、Develop、Deliver 发散再收敛。

硬规则：

- 框架选择写入讨论记录。
- 讨论 Leader prompt 必须包含框架目标、组织协议和产出格式。
- 参与 Agent prompt 必须包含框架下的发言协议。
- 讨论最终输出必须符合框架的收敛目标，而不是泛泛总结。

### 3.6 斜杠命令控制层

任务执行和多方讨论输入框都支持 `/` 斜杠命令，用于启动本地控制工具，而不是进入普通对话。

已支持命令：

- `/help`：显示可用命令。
- `/status`：查看当前空间任务 Agent、讨论 Agent、任务、讨论和本机 Agent 进程状态。
- `/stop`：停止当前空间内由应用触发的所有 Agent 运行，并把运行中的任务标记为已停止。
- `/start <内容>`：用当前选择启动任务或讨论。
- `/round`：在讨论模式中请求讨论 Leader Agent 进入下一轮判断；如果 Leader 正在等待人回复，可作为继续授权。
- `/new`：开启新的本地上下文标记；讨论模式下会关闭当前未关闭讨论。
- `/model <模型名>`：记录模型切换需求；实际运行模型在右侧 Agent 卡片从 Hermes 当前可用模型中选择。

边界：

- 命令执行结果以系统消息写入当前模式。
- 讨论模式执行的命令结果不会显示在任务执行页。
- `/stop` 只管理当前桌面应用启动的 Agent 运行，不管理应用外部独立启动的 Hermes 进程。
- Agent 卡片保存模型后，后续 Hermes 调用必须带入对应 `--provider` 和 `--model` 参数；空值表示跟随 Hermes 默认模型。

### 3.7 数据健康与一键治理

数据健康卡用于解释和收敛本地生产数据风险。它不只是报错提示，而是数据治理入口。

当前必须区分的风险类型：

- DB 残留：SQLite 外键异常、孤儿表行、已释放/失效 runtime lock 堆积。
- Profile 残留：`.hermes/profiles` 中由 Hermes Agent Team 创建，但当前 DB 不再引用的 HAT profile。
- DB/profile 不一致：DB 中 Agent 引用的 profile 物理目录已不存在。
- 备份风险：修复前备份为空、不可读、数量过多或修复入口被重复触发。

已实现能力：

- `检查`：生成数据健康报告，展示风险数量和报告路径。
- `修复DB`：先备份并校验 `team.sqlite`，再清理 DB 残留和非活跃旧锁。
- `修复profile`：对缺失 profile 的 app 托管 Agent 重建独立 Hermes profile；对孤儿 HAT profile 先复制到 `data_governance/profile_archive/` 再移走原 profile。
- `全部修复`：由主进程顺序执行 `修复DB -> 修复profile -> 检查`，完成后让数据健康归零或显示剩余风险类型。
- 备份轮转：`team.sqlite` 修复备份只保留最近 5 份。
- 黄金备份：5 份备份中必须锁定 1 份已通过 SQLite 深校验的黄金备份，避免连续坏备份覆盖所有健康备份。
- 修复保护：修复入口串行执行，成功后进入 5 分钟冷却。
- 冷却持久化：修复冷却时间戳写入本地数据安全状态，应用重启后仍生效。
- 磁盘满诊断：写盘失败且错误为 `ENOSPC` 时，UI 必须提示磁盘空间不足并要求先清理物理空间。
- `打开归档`：打开 profile 归档目录，方便人工核查和清理。

已实现保护：

- 分类职责：数据健康卡拆出 DB 修复、孤儿 profile 归档和全部修复，避免用户只点 `修复DB` 后误以为所有 profile 残留也会被处理。
- 缺失 profile 修复：只重建 `owned_by_app=1` 的 Hermes Agent Team 托管 Agent profile，不自动接管外部 profile。
- 结果校验：`全部修复` 执行后必须刷新健康报告；若仍有风险，继续显示剩余风险分类和报告路径。
- 安全边界：`全部修复` 不能绕过现有备份校验、备份轮转、修复冷却、SQLite quick_check、黄金备份和 profile 归档规则。

后续增强：

- 剩余对象清单：把 DB 残留、孤儿 profile、缺失 profile、旧锁和备份状态的对象级清单做成更易读的展开视图。
- 人工处置建议：当自动修复后仍有风险时，给出可复制的下一步命令或人工检查路径。

## 4. 层级权限规则

### 4.1 可见性

在同一个工作空间内：

- 人可以看到 Agent 消息。
- Agent 可以看到人和其他 Agent 消息。

### 4.2 响应权限

硬规则：

- 人只能正式命令主 Agent。
- Agent 只能回复自己的直接上级。
- Agent 只能创建、删除、委派自己的直接下级。
- 越权消息可以看见，但不触发回复。

## 5. 独立 Hermes 创建规则

这是当前最重要的产品规则。

### 5.1 定义

桌面端新建 Agent 等于新建一个全新的独立 Hermes profile。

不能：

- 复用已有 profile。
- 共享已有 profile 的会话历史。
- 共享已有 gateway 运行态。
- 共享 Telegram、Weixin、Feishu、Lark、Discord、Slack、iMessage 等通讯平台身份。

可以继承：

- 基础配置。
- 模型 provider 设置。
- SOUL.md。
- 已保存 skills。
- 必要的模型/API 能力。

### 5.2 当前实现

创建路径：

```bash
hermes profile create <profile> --clone-from default --no-alias --description ...
```

创建后自动执行：

- 写入 `.hermes-agent-team.json` 管理标记。
- 移除继承来的通讯/gateway 平台变量。
- 隔离可能继承的运行态文件。
- 执行真实 chat 探针。
- 探针失败则自动删除刚创建的 profile。

验活命令：

```bash
hermes --profile <profile> chat -Q --ignore-rules --source hermes-agent-team-probe --max-turns 1 -q "只回复 HERMES_AGENT_READY"
```

任务/讨论执行策略：

- 探活允许 `--max-turns 1`，只用于确认 profile 可用。
- 真实任务和讨论不得复用探活轮数；默认 `--max-turns 8`，可通过 `HAT_HERMES_CHAT_MAX_TURNS` 在 2-20 范围内调整。
- 如果 Hermes 返回 `Reached maximum iterations` / `iteration limit`，Runtime 必须自动用 `hermes-agent-team-retry` 来源扩大到至少 16 轮重试。
- 重试仍触发迭代上限时，只能展示精简错误，不能把 Hermes 的迭代上限 stdout 当作 Agent 最终结论展示。
- 复杂交付任务必须 Team 化：命中多端、多交付物、架构图、框架图或文件交付时，主 Agent 第一轮只能输出工作图和 actions JSON，不允许单 Agent 直接长时间实施。
- Hermes 执行超时时，Runtime 必须带着部分输出/错误摘要自动恢复重试一次；仍失败才记录失败证据。
- 图片交付必须进入消息附件：Agent 输出 PNG/JPEG/WebP/GIF 本机路径时，Mac 和 iOS 都必须在消息内直接展示图片；Agent 输出 HTML/SVG 源文件路径时，Mac Runtime 必须截图转换成 PNG 附件后展示，不能只显示描述、ASCII 图或文件路径。

## 6. MVP 范围

已实现：

- Electron + React 桌面端。
- 本地 SQLite 持久化。
- 工作空间创建/删除。
- 用户可见层取消频道，仅保留工作空间。
- 创建工作空间时自动创建任务项目经理 Agent 和讨论 Leader Agent。
- Agent 创建/删除。
- Agent profile 自动创建、隔离、验活、失败回滚。
- 任务执行与多方讨论分离为两个页面。
- 任务 Agent 和讨论 Agent 数据层隔离。
- 后台触发 Agent 回复，不阻塞界面。
- Agent 运行状态可见：空闲、运行中、失败。
- Agent 卡片显示当前任务、最近完成时间、最近失败原因。
- 任务临时 Agent 标记和确认清理。
- 多方讨论由固定讨论 Leader Agent 控场、判断下一轮、阶段性询问人和最终汇总。
- 多方讨论支持选择讨论框架，讨论 Leader Agent 按框架组织讨论和汇总结论。
- 自适应桌面布局：宽屏四列，中等窗口三列，窄窗口自动纵向重排，避免横向裁切。
- 长消息保护：长内容在消息卡片内部滚动，不撑坏输入区和下半部分布局。
- 旧失败记录清洗：历史 `Command failed` 提示词泄露内容自动替换为简短失败说明。
- 协作状态基础设施：SQLite Blackboard、Evidence Pack、Decision Record。
- `team_state.json` 只读快照导出，供 Agent prompt 和人侧检查使用。
- 内容资产基础设施：SQLite `content_assets`、空间级 `content_archive.json`、Content Assets Memory。
- 右侧“协作状态”面板展示共享状态、任务证据和讨论决策。
- 审计记录。
- 任务详情、讨论详情和内容资产详情第一版。
- macOS `.app` 本地打包。

近期已补能力：

- 任务执行页支持“启动任务 -> 主 Agent 动态创建临时 Agent -> 产出结果 -> 人确认完成 -> 清理临时 Agent”。
- 任务中创建的 Agent 默认标记为临时 Agent，只保留工作输出，不保留临时 Agent 本体。
- 多方讨论页支持多个讨论 Agent 参与。
- 多方讨论页支持选择讨论框架：平衡决策、DACI、RAPID、Delphi、六顶思考帽、Pre-mortem、Red Team、Double Diamond。
- 多方讨论页只显示并选择讨论 Agent，不能显示或选择任务 Agent。
- 讨论 Agent 默认全选；新建的讨论 Agent 自动加入当前讨论选择。
- 讨论型 Agent 默认每轮只发言一次，是否继续由讨论 Leader Agent 判断。
- 同一轮讨论内，所有参与讨论的 Agent 同时开始运行。
- 当讨论 Leader Agent 需要阶段性确认时暂停，等待人的回复。
- 本次讨论临时创建的观点 Agent 会在结束后清理；讨论 Leader Agent 和用户长期讨论 Agent 会保留。
- 任务启动、Agent 回复、创建下级、委派、任务结果、停止、确认清理写入 Evidence Pack。
- 项目经理每次任务启动后必须写入 Team 启动判断，记录本次是单 Agent 处理还是启动临时 Team。
- Agent 回复证据记录 Hermes profile、provider/model、耗时、退出状态、脱敏命令、提示哈希和输出摘要。
- Blackboard 记录当前任务、Team 启动判断、最新任务结果、当前讨论和最新讨论决策。
- 讨论 Leader Agent 每轮组织输出会写入 Decision Record，记录框架、状态、摘要和是否需要人确认。
- 人类任务需求、讨论主题、Agent 任务输出、Agent 讨论输出、任务最终交付和讨论决策都会自动沉淀为 Content Assets。
- 每个 Content Asset 记录来源、类型、作用域、标题、摘要、全文、作者和重要性。
- 每个工作空间会导出 `content_archive.json`，用于后续复盘、Agent 优化和产品改进。
- 任务 Agent 只读取任务/非讨论内容资产；讨论 Agent 可以读取任务和讨论内容资产。
- 任务详情页可查看任务目标、项目经理、临时 Agent、最终输出、Evidence Pack 和任务沉淀资产。
- 讨论详情页可查看讨论主题、框架、组织 Agent、参与 Agent、Decision Record 和讨论沉淀资产。
- 内容资产详情页可查看资产来源、范围、作者、摘要、全文和结构化元数据。
- 数据健康卡显示 DB/profile 风险、修复状态、备份保留状态和 profile 归档目录入口。
- Runtime Safety v0.2：主进程管理 runtime locks，支持 TTL、heartbeat、suspect 宽限、stale 回收、released 状态、冲突审计和 Blackboard `risks` 同步。
- Execution Isolation v0.3：代码/配置/文件类任务生成 execution sandbox 协议，包含 sandbox 路径、建议 worktree、回滚命令、接管命令和降级 Decision Record Safe Log。
- Task Discussion Bridge Reliability v0.4：任务项目经理卡住时可请求讨论 Leader 支援；系统记录 `task_discussion_links`、execution snapshot、等待 TTL、阻断指纹、求助次数、drift 校验和超时兜底。
- Reliability Closure & Sandbox GC v0.5：限制 lock suspect 振荡；execution snapshot 硬限 50KB 并排除大目录；启动和周期性刷新会回收过期沙箱；任务证据包提供接管快捷动作。
- Data Governance v0.6：启动自检 SQLite/profile 一致性、外键异常、孤儿 DB 行、缺失 profile、孤儿 HAT profile 和旧锁堆积；支持报告、备份、DB 修复和孤儿 profile 归档。
- Reliability Robustness v0.7：lock suspect 计数按时间衰减；`running`、`waiting_discussion`、`awaiting_confirmation` 现场豁免沙箱 GC；破坏性沙箱动作二次确认；提供复制接管命令。
- 数据治理 v0.8：修复前备份校验、备份轮转、修复冷却、归档目录打开。
- 数据治理 v0.9：修复备份必须通过 SQLite 头部、`PRAGMA quick_check` 和核心表校验；备份轮转锁定黄金备份；冷却跨重启持久化；磁盘满给出明确用户诊断。
- Missing Profile Recovery v0.10：当 DB 中 app 托管 Agent 的 Hermes profile 物理目录缺失时，`修复profile` 可重建新独立 profile、更新 DB 引用，并写入审计。
- 删除工作空间归档：删除空间前生成 `deleted_workspace_archive`，保留工作空间、Agent、消息、任务、讨论、证据、决策、内容资产和 `content_archive.json` 路径，再清理当前 DB 行和 app 管理的 profile。
- 发布验收链路：`acceptance:dev`、`acceptance:packaged` 分层；`release:check` 必须先重新打包，再跑 packaged 验收。

暂不包含：

- 多真人账号。
- 远程同步。
- 正式代码签名。
- 可视化组织架构图。
- 长任务队列。
- Agent 文件共享。
- 完整日志查看器。

## 7. 当前验收标准

工作空间和模块主 Agent 的验收标准：

- 创建工作空间后，任务执行模块和多方讨论模块同时存在。
- 未创建工作空间时，不显示任何默认空间、主 Agent、任务输入或协作状态。
- 新工作空间自动创建任务项目经理 Agent 和讨论 Leader Agent。
- 两个主 Agent 都是新的独立 Hermes profile。
- 新 profile 有 `.hermes-agent-team.json` 标记和 `AGENTS.md` 底层要求文件。
- 新 profile 通过真实 chat 探针。
- 任一主 Agent 创建失败时，工作空间创建自动回滚。
- 右侧 Agent 卡片可编辑底层要求和 Hermes provider/model，保存后同步数据库、`.hermes-agent-team.json` 和 `AGENTS.md`。

任务执行验收标准：

- 任务执行页不再出现“聊天 / 通知 / 任务”三个切换。
- 任务只能选择主 Agent。
- 人发送任务后，界面立即恢复，并出现任务运行记录。
- 系统消息显示主 Agent 正在后台处理。
- Agent 卡片必须立即显示“运行中”和当前任务。
- 主 Agent 可以在任务过程中创建临时下级 Agent、委派任务、收集输出。
- 主 Agent prompt 必须包含任务执行系统协议、工作图、工作包拆解、临时 Agent 组建、并行执行、独立审查、委派契约、证据收敛、主 Agent 负责制、最终交付和清理边界。
- 任务中的临时 Agent 必须显示“临时”标记。
- 任务完成后出现“确认完成并清理临时 Agent”按钮。
- 人点击确认后，任务创建的临时 Agent 被删除，消息与输出保留。
- 成功后 Agent 卡片回到“空闲”，并显示最近完成时间。
- 失败后 Agent 卡片显示“失败”和最近错误原因。
- 任务启动后必须写入 Evidence Pack 的 `task_start`。
- 主 Agent 创建/委派/回复必须进入 Evidence Pack。
- Team 启动时必须写入 `team_work_graph`，记录工作包、并行组、证据要求和审查点。
- 多个互不依赖委派必须写入 `parallel_delegate_group`，证明系统并行触发。
- Team 执行后必须写入 `primary_synthesis_result`，任务最终输出不得停留在主 Agent 的过程性计划。
- 任务完成前必须写入 `quality_gate`，检查工作图、并行委派、独立审查和主 Agent 输出。
- 缺少独立审查时不能静默通过，必须进入 Evidence Pack 和 Blackboard `risks`。
- 任务确认清理后必须写入 `task_cleanup`，Blackboard 的当前任务状态变为 `cleaned`。
- 应用必须导出当前工作空间的只读 `team_state.json` 快照。
- 人的任务需求必须写入 Content Assets 的 `human_task_request`。
- 任务 Agent 输出必须写入 Content Assets 的 `task_agent_output`。
- 任务最终交付必须写入 Content Assets 的 `task_final_output` 或失败时写入 `task_failure`。
- 项目经理短时间卡住时可以发起 `request_discussion_help`，但必须提供问题、已尝试路径、需要讨论模块输出什么，以及尽量提供 current_stage、failed_command、error_output、file_paths、subtask_id。
- 任务求助讨论必须写入 `task_discussion_links`，保留 execution snapshot、`expires_at`、`block_fingerprint` 和 `discuss_count`。
- 讨论 Decision Record 回流任务前必须执行 drift 校验；Git/文件现场变化时必须写入 Evidence Pack 和 Blackboard `risks`。
- 同一阻断指纹不能重复立即求助；单任务求助次数超过上限后必须转人工确认或降级执行。
- 任务求助超时后 watchdog 必须写入 Evidence Pack，把任务转为 `awaiting_confirmation`，并给 Hayden 明确兜底选择。
- 讨论求助成功回流后，Evidence Pack 必须包含 `discussion_help_request`、`discussion_help_result` 和 `discussion_help_resume`。

多方讨论验收标准：

- 多方讨论页与任务执行页分开。
- 讨论页可以选择多个讨论 Agent 参与。
- 讨论页只显示并选择讨论 Agent。
- 任务 Agent 不能进入讨论。
- 启动讨论后，讨论 Leader Agent 接管并组织参与 Agent 发言。
- 讨论 Leader prompt 必须包含讨论 Leader 组织协议、并发首轮、观点矩阵、续轮条件、人工介入、Decision Record 和临时观点 Agent 清理边界。
- 讨论参与 Agent prompt 必须包含讨论参与系统协议，明确独立视角、引用证据、可 @ 指向对象、不能抢 Leader 职责。
- 启动讨论后，所选讨论框架写入讨论记录，并进入讨论 Leader 和参与 Agent prompt。
- 默认情况下，空间内所有用户创建的讨论 Agent 都被选中并参与讨论。
- 如果没有可选讨论 Agent，系统可为本次讨论创建临时观点 Agent。
- 同一轮讨论必须并发触发，不允许一个 Agent 完成后再启动下一个 Agent。
- 第二轮必须作为交叉审辩轮，讨论 Agent 必须回应上一轮至少一个其他观点，并能看到前面人和 Agent 的发言。
- 讨论 Leader Agent 判断是否继续下一轮、是否需要人阶段性回复，或是否汇总结束。
- 讨论 Leader Agent 的最终汇总必须符合所选框架的产出格式。
- 讨论 Leader Agent 的组织结论必须写入 Decision Record。
- Decision Record 必须保留讨论框架、状态、摘要、决策和是否需要人确认。
- 普通讨论 Agent 不能自行申请无限发言。
- 讨论结束后，本次讨论临时创建的观点 Agent 被清理，只保留输出；讨论 Leader Agent 保留。
- 输入框支持 `Command + Return` 发送。
- 输入框左侧 `/` 按钮可以调出常用命令。
- Agent 输出中的 `@Hayden` 或 `@Agent名称` 在界面高亮。
- 人的讨论主题必须写入 Content Assets 的 `human_discussion_topic`。
- 讨论 Agent 输出必须写入 Content Assets 的 `discussion_agent_output`。
- 讨论 Leader 的决策记录必须写入 Content Assets 的 `discussion_decision`。

内容资产验收标准：

- `content_assets` 必须保存 source_type、source_id、asset_type、scope、title、summary、content、created_by_type、created_by_id、importance。
- 每个工作空间必须导出 `content_archive.json`。
- 右侧协作状态面板必须显示 Content Assets 数量和最近资产。
- Agent prompt 必须包含 Content Assets Memory。
- 任务 Agent 不能读取 discussion scope 的内容资产。
- 讨论 Agent 可以读取任务资产和讨论资产。

详情复盘验收标准：

- 任务运行记录可以打开任务详情。
- 任务详情必须显示任务状态、项目经理、临时 Agent 数量、最终输出、证据包和任务沉淀资产。
- 讨论状态记录可以打开讨论详情。
- 讨论详情必须显示讨论状态、讨论框架、讨论 Leader、参与 Agent、决策记录和讨论沉淀资产。
- 右侧 Content Assets 可以打开内容资产详情。
- 内容资产详情必须显示来源、作用域、创建者、重要性、摘要、全文和元数据。
- 详情视图必须在小窗口中可滚动，不遮挡主界面输入区。

数据健康验收标准：

- 数据健康卡必须区分 DB 残留和 profile 残留，不能只显示一个笼统风险数字。
- `修复DB` 必须只负责 SQLite 外键异常、孤儿行和非活跃旧锁。
- `修复profile` 必须只处理 Hermes Agent Team 托管 profile：缺失 profile 走重建和真实探针，孤儿 HAT profile 走先归档再移走原目录。
- 修复前必须生成可读、非空的 `team.sqlite` 备份；备份校验失败时必须阻断清理。
- 修复前备份必须通过 SQLite 头部、`PRAGMA quick_check` 和核心表存在性校验。
- DB 备份目录必须自动轮转，只保留最近 5 份修复备份。
- DB 备份轮转必须保留 1 份黄金备份，且该备份必须存在于磁盘上。
- 修复入口必须有主进程并发锁和冷却机制，防止重复点击导致写冲突。
- 修复冷却必须持久化，应用重启后不能绕过冷却。
- 磁盘空间不足必须显示明确诊断，不允许静默失败或继续执行物理清理。
- `打开归档` 必须只打开 `data_governance/profile_archive/` 受控目录。
- `全部修复` 必须按 `修复DB -> 修复profile -> 检查` 顺序执行；执行后若仍不健康，必须显示剩余风险分类和可追溯报告路径。
- 生产库健康收敛的完成标准是：`PRAGMA foreign_key_check` 无结果，孤儿行计数为 0，缺失 profile 为 0，孤儿 HAT profile 为 0，非活跃旧锁无异常堆积。

运行时安全和沙箱验收标准：

- 任务、讨论和高风险执行资源必须先取得主进程 runtime lock；同一资源不能同时存在多个 active lock。
- runtime lock 必须记录 owner、session、resource、status、heartbeat、TTL、suspect_count 和释放时间。
- TTL 到期后必须先进入 `suspect` 宽限期；宽限期内 heartbeat 恢复时回到 `active`，否则进入 `stale`。
- suspect、stale、reap、conflict 和 release 事件必须写入 Blackboard `risks` 或审计记录，不能静默处理。
- 同一锁生命周期内 suspect 振荡超过上限后必须强制转 `stale`；长间隔 suspect 计数必须按衰减窗口重新计算。
- `/stop` 必须停止当前空间由应用触发的 Agent 运行，释放相关 runtime lock，并把运行中的任务/讨论标记为停止。
- 代码、配置或文件修改类任务必须生成 `execution_sandbox_protocol` Evidence，包含 sandbox 路径、协议文件、建议 worktree、回滚命令和接管命令。
- execution snapshot 必须控制在 50KB 内，并排除 `node_modules`、`.git`、`release` 和大文件路径。
- 沙箱快捷动作只能使用主进程白名单：`takeover`、`copy_command`、`remove_worktree`、`cleanup_sandbox`。
- `remove_worktree` 和 `cleanup_sandbox` 必须二次确认；接管、复制命令、清理和 GC 动作必须写入 Evidence Pack 或审计记录。
- 沙箱 GC 只能回收超过 24 小时未活动且无活跃任务/锁的沙箱；`running`、`waiting_discussion`、`awaiting_confirmation` 现场必须豁免。

删除归档和发布验收标准：

- 删除工作空间前必须先生成 `deleted_workspace_archive/<workspace_id>-<deleted_at>.json`。
- 删除归档必须包含 workspace、agents、messages、audits、task_runs、evidence_items、discussion_runs、discussion_agents、decision_records、content_assets 和 `content_archive.json` 路径。
- 删除完成后，当前 SQLite 中该 workspace 和其 agents 行必须被清理；由应用托管的 Hermes profile 必须删除。
- 如果某个托管 profile 在删除空间前已经物理缺失，系统必须把它视为已删除并继续清理该空间；如果 profile 目录仍存在但删除失败，则不能静默清 DB。
- 删除归档烟测必须能证明任务、讨论和内容资产先归档再删除当前工作台数据。
- `acceptance:dev` 必须使用当前 `dist` 和 Electron 开发入口，适合日常反馈。
- `acceptance:packaged` 必须使用 `release/mac-arm64/Hermes Agent Team.app`，适合发布前验收。
- `release:check` 必须先执行 `pack:mac`，再执行 `acceptance:packaged`；改 Electron 主进程、打包配置或 runtime 行为后必须走该卡点。

隔离验收标准：

- 新 Agent 不复用已有 profile。
- 不继承历史会话。
- 不继承 gateway 运行态。
- 不继承通讯平台身份。
- 删除 Agent 时删除对应 app 管理的 Hermes profile。

## 8. 验证记录

2026-06-26：

- `npm run prompt:contract` 通过，确认任务项目经理协议、讨论 Leader 协议和讨论参与协议已进入底层 prompt 与文档。
- `node --check electron/main.cjs` 通过。
- `node --check scripts/prompt-contract.mjs` 通过。
- `node --check scripts/smoke-electron.mjs` 通过。
- `node --check scripts/acceptance.mjs` 通过。
- `npm run verify` 通过。
- `npm run smoke:legacy-db` 通过，确认旧数据库孤儿历史消息不会阻断应用启动。
- `npm run build` 通过。
- `npm run smoke` 通过。
- `npm run smoke:responsive` 通过。
- `npm run smoke:long-content` 通过。
- `npm run pack:mac` 通过。
- `npm run acceptance` 通过。
- `npm run smoke:packaged` 通过。
- `npm run smoke:packaged:live` 通过。
- Blackboard / Evidence Pack / Decision Record 验收通过：任务证据、讨论决策、`team_state.json` 快照都被完整验收覆盖。
- Content Assets 验收通过：任务需求、任务输出、任务最终交付、讨论主题、讨论输出、讨论决策、`content_archive.json` 归档均被完整验收覆盖。
- 任务详情、讨论详情和内容资产详情第一版通过 `npm run verify` 的类型和契约检查。
- 修复讨论 Agent 读取 Evidence Pack 时 SQL 字段歧义导致讨论失败的问题，烟测已覆盖。
- 修复真实旧数据库启动失败：历史消息引用已删除工作空间时，Content Assets 回填会跳过无效记录，不再阻断主窗口创建。
- 新增 `script/build_and_run.sh` 和 Codex Run 入口，提供“停止旧实例 -> 打包 -> 打开 -> 验证窗口”的稳定启动路径。

2026-06-27：

- `Runtime Safety v0.2` 验收覆盖：runtime lock 生命周期必须出现 `active -> suspect -> active -> suspect -> stale`，suspect/reap 事件必须进入风险或审计。
- `Execution Isolation v0.3` 验收覆盖：代码类任务必须生成 `task_sandboxes` 路径、协议文件、建议 worktree 和接管命令。
- `Task Discussion Bridge Reliability v0.4` 验收覆盖：watchdog 超时、Evidence Pack 记录、任务兜底确认、drift validator、阻断指纹防重复和求助次数上限均可观测。
- `Reliability Closure v0.5` 验收覆盖：lock suspect 振荡强制 stale、execution snapshot 50KB 限制、`node_modules` 排除、沙箱接管快捷动作和过期沙箱 GC。
- `Data Governance v0.6` 落地：数据健康扫描覆盖 SQLite 外键、孤儿行、DB/profile 不一致、孤儿 HAT profile 和旧锁堆积。
- `Reliability Robustness v0.7` 落地：suspect 计数衰减、等待讨论/人工确认沙箱豁免、破坏性沙箱动作二次确认、复制接管命令兜底。
- `Data Safety Hardening v0.8` 落地：修复前备份必须可读且非空；DB 备份只保留最近 5 份；修复 IPC 有并发锁和 5 分钟冷却；UI 可打开 profile 归档目录。
- `Data Safety Deep Hardening v0.9` 落地：修复前备份必须通过 SQLite quick_check；备份轮转锁定黄金备份；修复冷却跨应用重启持久化；磁盘满写盘错误会转成明确用户诊断。
- `Missing Profile Recovery v0.10` 落地：数据健康修复可为缺失 profile 的 app 托管 Agent 重建独立 Hermes profile，并更新 DB 引用、profile 标记和审计记录。
- 明确当前产品缺口：数据健康卡需要把 `修复DB` 和 `修复profile` 的职责解释得更清楚，并增加 `全部修复` 入口，避免用户只处理 DB 残留而遗漏 profile 风险。
- 数据健康 UI 增加三按钮：`修复DB`、`修复profile`、`全部修复`。其中 `全部修复` 走显式 `repairMode=all`，自动执行 DB 修复、profile 重建/归档和健康刷新。
- `smoke:delete-archive` 验收删除工作空间前的完整归档，并确认当前 DB 中 workspace/agent 行已清理。
- `acceptance:dev` 与 `acceptance:packaged` 分层；`release:check` 绑定 `pack:mac` 和 packaged 验收，避免发布时使用旧打包产物。

2026-06-25：

- `npm run verify` 通过。
- `npm run smoke` 通过。
- `npm run pack:mac` 通过。
- `npm run smoke:packaged:live` 通过。
- `npm run acceptance` 通过。
- 创建工作空间自动生成任务项目经理 Agent 和讨论 Leader Agent 验收通过。
- 右侧不再显示模块主 Agent 创建入口，改为只编辑已有 Agent 配置。
- Agent 状态流转检查通过：正式任务触发后显示“运行中”，回复完成后回到“空闲”。
- 窗口自适应检查通过：1440、1120、860、740 四种窗口宽度均无横向溢出。
- 中等宽偏矮窗口检查通过：1120x560 下输入区完整可见，不被消息区挤出窗口。
- 长内容布局检查通过：长消息内部滚动，输入区保持可见，审计长内容不撑开侧栏。
- 真实自动创建空间主 Agent 独立 Hermes profile 通过。
- `AGENTS.md` 底层要求文件写入和配置更新同步通过。
- 隔离标记 `.hermes-agent-team.json` 检查通过。
- 真实 chat 回复检查通过。
- 临时测试 profile 删除后无残留。
- 完整验收覆盖：多工作空间、默认消息流、空间自动任务项目经理 Agent 和讨论 Leader Agent、人越权给下级 Agent 下任务被拦截、主 Agent 自动创建/委派任务临时 Agent、辅助 Agent 底层命令/Hermes provider/model 偏好、确认后清理临时 Agent、讨论 Leader Agent 控场和汇总、真实独立 Hermes 创建/回复/删除。
- 任务/讨论隔离验收覆盖：任务 Agent 不能进入讨论，讨论 Agent 不出现在任务主 Agent 选择里，任务页不显示讨论内容，讨论页可显示任务内容。
- 上下文隔离验收覆盖：任务 Agent 看不到讨论内容，讨论 Agent 可以看到任务内容。
- 讨论上下文验收覆盖：讨论 Agent 可以看到前一轮 Agent 回复。
- 页面 Agent 池隔离验收覆盖：任务页只显示任务 Agent，讨论页只显示讨论 Agent，不能有同一个 Agent 同时出现在两个页面。
- 讨论并发验收覆盖：同一轮讨论里多个讨论 Agent 同时进入运行中。
- 讨论框架验收覆盖：选择 Pre-mortem 后，讨论记录、系统消息和讨论 Leader prompt 使用对应框架。
- 讨论 Leader 保留验收覆盖：讨论结束后固定 Leader 不删除，只清理临时观点 Agent。
- Agent 配置修改验收覆盖：已有 Agent 可编辑底层要求和 Hermes provider/model，数据库、界面和 profile 标记同步更新。
- 输入验收覆盖：任务与讨论输入框支持 `Command + Return` 发送。
- @ 指向验收覆盖：Agent 输出中的 `@Hayden` 或 `@Agent名称` 高亮显示。

## 9. 开发记录

2026-06-27：

- 补齐 Runtime Safety v0.2：runtime locks 由主进程管理 TTL、heartbeat、suspect、stale、released、冲突阻断和审计同步。
- 补齐 Execution Isolation v0.3：代码类任务生成 execution sandbox 协议，记录 sandbox、建议 worktree、回滚、接管和 Safe Log。
- 补齐 Task Discussion Bridge Reliability v0.4：项目经理可通过 `request_discussion_help` 请求讨论模块支援；桥接状态记录 snapshot、TTL、阻断指纹、求助次数、drift 校验和超时兜底。
- 补齐 Reliability Closure v0.5：限制 lock suspect 振荡；execution snapshot 控制在 50KB；排除 `node_modules`、`.git`、`release`；沙箱支持接管快捷动作和过期 GC。
- 补齐 Data Governance v0.6：启动自检 SQLite/profile 一致性、外键异常、孤儿行、缺失 profile、孤儿 HAT profile 和旧锁堆积；提供报告、备份、DB 修复和孤儿 profile 归档。
- 补齐 Reliability Robustness v0.7：suspect 计数衰减、等待讨论/人工确认沙箱豁免、破坏性动作二次确认和复制接管命令兜底。
- 补齐 Data Safety Hardening v0.8：修复前备份非空可读校验、DB 备份保留 5 份、修复 IPC 串行冷却、profile 归档目录打开。
- 补齐 Data Safety Deep Hardening v0.9：SQLite quick_check、核心表校验、黄金备份、冷却持久化和磁盘满诊断。
- 补齐 Missing Profile Recovery v0.10：缺失 profile 的 app 托管 Agent 可以重建独立 Hermes profile，完成后更新 DB 引用、profile 标记和审计记录。
- 新增数据健康 UI 三动作：`修复DB`、`修复profile`、`全部修复`，并把 `全部修复` 绑定为 DB 修复、profile 重建/归档和健康刷新顺序执行。
- 新增删除工作空间归档验收：删除前归档任务、讨论、消息、证据、决策、内容资产和 `content_archive.json` 路径，再清理当前工作台数据。
- 新增发布验收分层：`acceptance:dev` 面向日常反馈，`acceptance:packaged` 面向发布前检查，`release:check` 强制重新打包后再验收。

2026-06-26：

- 新增任务项目经理系统协议：任务接收、工作包拆解、临时 Agent 组建、委派契约、监督整合、最终交付和人工确认清理。
- 新增讨论 Leader 系统协议：定题、选框架、分视角、并发首轮、观点矩阵、续轮判断、人工介入、Decision Record 和临时观点 Agent 清理。
- 新增讨论参与 Agent 系统协议：独立视角、引用 Evidence Pack/Blackboard/历史发言、可 @ 指向对象、不抢 Leader 职责。
- 新增 `scripts/prompt-contract.mjs`，把上述协议作为验证契约接入 `npm run verify`。
- 新增协作状态基础设施第一版：SQLite Blackboard、Evidence Pack、Decision Record。
- 新增只读 `team_state.json` 快照导出，用于 Agent prompt 和人侧检查。
- 新增右侧“协作状态”面板，按任务/讨论模式展示共享状态、任务证据或讨论决策。
- 任务启动、Agent 回复、创建下级、委派、任务结果、停止、确认清理写入 Evidence Pack。
- 讨论 Leader Agent 每轮组织输出写入 Decision Record，并同步最新决策到 Blackboard。
- 新增内容资产沉淀层：SQLite `content_assets` 保存人类任务/讨论主题、Agent 输出、任务最终交付和讨论决策。
- 新增空间级 `content_archive.json` 导出，用于长期复盘、Agent 优化和产品改进。
- 新增 Content Assets Memory，任务 Agent 只读取任务/非讨论资产，讨论 Agent 可读取任务和讨论资产。
- 新增右侧 Content Assets 预览和归档状态展示。
- 新增任务详情、讨论详情和内容资产详情第一版，把任务证据、讨论决策和内容资产从右侧预览提升为可复盘视图。
- PRD 和架构图同步调整：共享状态、任务证据、讨论决策、内容资产从未来项改为已实现第一版；下一步优先增强证据细节、内容检索和动态专家库。

2026-06-25：

- 明确产品方向：Mac 本地 Hermes Agent Team 桌面端。
- 明确组织模型：工作空间、任务项目经理 Agent、下级 Agent、讨论 Leader Agent。
- 明确层级规则：看见不等于可响应。
- 初版实现 Electron 桌面应用。
- 修复 macOS 桌面环境找不到 `hermes` 的问题。
- 修复任务发送卡住问题，改为后台执行和轮询刷新。
- 修复动作 JSON 误解析问题。
- 曾新增一键创建独立主 Agent；当前已改为创建工作空间时自动生成模块主 Agent。
- 改为创建工作空间时自动创建任务项目经理 Agent 和讨论 Leader Agent，右侧不再提供模块主 Agent 创建入口。
- 新增 profile 隔离加固和真实验活。
- 新增完整端到端验收脚本 `npm run acceptance`。
- 修复聊天模式无反馈造成的误解：有主 Agent 时默认进入任务模式，聊天/通知发送后显示“不触发 Agent”的系统提示。
- 新增 Agent 运行状态系统：运行中、空闲、失败、当前任务、最近完成时间和最近错误原因。
- 新增状态流转自动检查：发送正式任务后必须可见“运行中”，回复后必须回到“空闲”。
- 优化窗口自适应布局，取消硬性最小页面宽度，新增宽屏/中等/窄屏响应式断点。
- 新增自适应验收脚本 `npm run smoke:responsive`。
- 修复下半部分长错误消息撑开布局的问题，新增 `npm run smoke:long-content`。
- 增加启动时旧错误记录清洗，避免历史 `Command failed` 和完整提示词继续显示在消息流/审计区。
- 修复中等宽偏矮窗口下输入区被裁切的问题：聊天区改为稳定 flex 布局，并增加低高度紧凑模式。
- 取消输入区“聊天 / 通知 / 任务”三模式设计，改为任务执行页和多方讨论页。
- 新增任务运行记录、讨论运行记录、讨论 Agent 轮次记录。
- 新增任务临时 Agent 标记和确认清理流程。
- 新增讨论 Leader Agent 控场机制，由 Leader 判断继续、阶段性询问人或最终汇总。
- 新增任务 Agent / 讨论 Agent 独立池，右侧 Agent 面板随当前页面显示对应 Agent。
- 调整顶部模式切换为独立工具条，避免消息滚动时视觉遮盖。
- 新增讨论 Agent 并发触发和上下文可见性过滤。
- 新增 `Command + Return` 发送、讨论 Agent 默认全选、@ 指向高亮和讨论 Agent 互看历史发言验收。
- 新增输入框左侧 `/` 常用命令入口。
- 取消用户可见频道，仅保留工作空间和内部默认消息流。
- 新增主 Agent 创建辅助 Agent 时可下发核心底层命令和 Hermes provider/model 偏好。
- 新增讨论结束后自动清理临时观点 Agent；讨论 Leader Agent 保留在空间内。
- 新增讨论框架选择：平衡决策、DACI、RAPID、Delphi、六顶思考帽、Pre-mortem、Red Team、Double Diamond。
- 新增已有 Agent 配置编辑：右侧卡片可修改核心底层要求和 Hermes provider/model；真实运行时通过 Hermes `--provider` 和 `--model` 参数传入，空值继承 Hermes 默认。
- 新增独立 profile 的 `AGENTS.md` 写入和更新；Agent 卡片保存底层要求和模型时同步到底层文件。
- 调整讨论组织方式：讨论 Leader Agent 由工作空间固定持有，讨论结束只清理临时观点 Agent。

## 10. 批判性接纳的后续设计

以下改进来自外部评审，但不直接照搬原方案。接纳标准是：是否能降低人的协调成本、提高交付可验证性、减少上下文噪音、避免 Agent 越权或无限讨论。

### 10.1 共享状态空间

接纳方向：需要共享状态，但不应只做一个任意读写的 `team_state.json`。

原因：

- 复杂任务不能只靠聊天同步；聊天适合表达，状态适合协作。
- 纯 JSON 容易出现并发覆盖、旧状态污染、权限边界不清和难审计问题。

第一版实现：

- 以当前 SQLite 为权威状态源，新增 `blackboard_entries`。
- 每次读取状态时导出只读 `team_state.json` 快照，给 Agent 和人侧检查使用。
- 状态项已有 key、scope、作者、时间和内容。

仍需增强：

- 增加置信度、过期策略、来源证据引用和更细权限。
- 增加可视化状态编辑/归档，而不是只看最近条目。

### 10.2 执行证据层

接纳方向：讨论 Agent 不能只听主 Agent 汇报，但也不能无边界读取全部工作区。

第一版实现：

- 任务启动、Agent 回复、创建下级、删除下级、委派、任务结果、停止和确认清理写入 Evidence Pack。
- Agent 回复证据记录 Hermes profile、provider/model、耗时、退出状态、脱敏命令、提示哈希和输出摘要。
- 任务 Agent 和讨论 Agent prompt 都能读取压缩后的 Evidence Pack。
- 人侧右栏可以看到最近 Evidence Pack。

仍需增强：

- 继续记录 Hermes 以外的真实工具命令、文件改动、测试结果和错误片段。
- 增加敏感信息过滤与长日志摘要。

### 10.3 讨论收敛与决策协议

接纳方向：讨论必须产出决策记录，而不是只产出聊天。

第一版实现：

- 讨论 Leader Agent 每轮组织输出会写入 Decision Record。
- Decision Record 记录讨论框架、状态、摘要、决策文本、下一步动作和是否需要人确认。
- 最新 Decision Record 进入 Blackboard，供后续讨论和人侧查看。

仍需增强：

- 把问题定义、备选方案、支持证据、风险、反对意见、置信度拆成结构化字段。
- 增加“只把 Decision Record 转给任务主 Agent”的明确转交动作。

### 10.4 安全熔断与审批介入

接纳方向：需要风险阻断，但不应给讨论 Agent 无条件“一票否决权”。

原因：

- 无条件否决会让系统被讨论 Agent 卡死。
- 真正要阻断的是高风险操作，不是不同观点。

建议实现：

- 建立 Risk Gate：破坏性命令、批量删除、权限修改、依赖写入、外部网络发布等动作先进入审批。
- 讨论 Agent 可以提出 `risk_block` 建议；系统根据规则触发强制暂停或人工确认。
- 高风险动作必须记录触发原因、证据和最终批准人。

### 10.5 动态专家库

接纳方向：需要动态专家，但专家不能常驻膨胀团队。

建议实现：

- 建立专家 Profile 模板库：Security Auditor、QA Engine、Lead Architect、Performance Reviewer、Product Strategist 等。
- 根据任务类型临时挂载专家讨论 Agent。
- 专家 Agent 结束后默认清理，只保留其输出、证据引用和决策贡献。

### 10.6 上下文压缩与记忆净化

接纳方向：必须做上下文剪枝，否则多 Agent 会快速污染主 Agent。

建议实现：

- 原始聊天只作为审计历史。
- 主 Agent 默认只读取：
  - 当前目标
  - 最新 Decision Record
  - 最新 Evidence Pack
  - 未关闭风险
  - 待执行动作
- 长讨论定期生成共识快照，旧讨论内容归档，不继续进入 Agent prompt。

### 10.7 当前交互修正

已实现：

- 创建工作空间时显示进行中状态，明确正在创建空间、任务项目经理 Agent 和讨论 Leader Agent。
- 创建工作空间缺少名称时，必须在输入位置和空状态区明确提示原因，并把焦点放回名称输入框。
- 任务发送顺序固定为：先写入人的任务内容，再交给项目经理 Agent，由项目经理判断是否创建或委派临时 Agent。
- 讨论发送顺序固定为：先写入人的讨论主题，再交给讨论 Leader Agent，由 Leader 根据讨论框架组织临时讨论 Agent。
- 长 Agent 输出卡片保留小范围滚动，同时支持点击“展开全文”进入大窗口查看完整内容。

## 11. 下一步

优先级从高到低：

1. 数据健康对象级治理：在现有分类和三动作基础上，补剩余对象清单、人工处置建议和可复制检查路径。
2. 增强 Evidence Pack：记录真实命令、退出码、文件改动、测试结果、错误片段和敏感信息过滤。
3. 增强任务详情：补委派链路、真实证据链、输出文件引用和清理结果。
4. 增强 Decision Record：结构化方案、分歧、证据、风险、反对意见、置信度和人类确认项。
5. 增强讨论详情：按轮次展开每个 Agent 的观点、证据引用、分歧和阶段性问题。
6. 增加内容资产检索与治理：搜索、标签、收藏、评分、废弃、合并和人工修正。
7. 增加 Risk Gate：高风险动作暂停并要求人工确认。
8. 增加动态专家库：按任务类型临时生成安全、测试、架构、性能等专家 Agent。
9. 增加上下文压缩：共识快照、旧讨论归档、主 Agent 只读取高信噪比输入。
10. 增加 Agent 详情页，展示 profile 路径、隔离状态、最近一次验活结果。
11. 增加失败诊断页，一键复制错误报告。
12. 增加组织架构视图。
13. 增加长任务队列：待处理、处理中、已回复、失败的历史列表。
14. 增加正式 macOS 签名和 ASAR 打包合规。
