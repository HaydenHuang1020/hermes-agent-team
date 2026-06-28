# Blackboard Schema v0.1 + Runtime Locks v0.2 + Bridge Reliability v0.4 + Reliability Closure v0.5

更新时间：2026-06-27

## 1. 目的

Blackboard 是 Agent Team 的低噪音共享状态层。它不能只是聊天摘要，必须区分事实、假设、决策、风险、问题、锁和产出。

## 2. 固定字段

```json
{
  "version": "0.1",
  "facts": [],
  "assumptions": [],
  "decisions": [],
  "risks": [],
  "open_questions": [],
  "locks": [],
  "outputs": []
}
```

字段定义：

- `facts`：已验证事实，必须来自命令结果、用户输入、Hermes 执行记录或明确证据。
- `assumptions`：未验证假设，不能当作事实交付。
- `decisions`：Leader、项目经理或系统已经收敛的判断。
- `risks`：失败路径、冲突、超时、权限、成本或质量风险。
- `open_questions`：仍需 Hayden 或指定 Agent 回答的问题。
- `locks`：主进程运行时锁的只读镜像，用于暴露正在被任务或讨论占用的资源。
- `outputs`：已验证交付物、结论、文件路径或可复用结果。

## 3. 写入规则

- 新事实必须能追溯来源。
- 冲突结论不能静默覆盖，必须进入 `risks` 或 Decision Record。
- 假设升级为事实前，必须有证据。
- 决策必须优先沉淀为 Decision Record，再同步摘要到 Blackboard。
- 锁必须包含 `resource`、`owner/session_id`、`status`、`heartbeat_at`、`expires_at` 和释放状态。
- 输出必须包含证据指针，例如 Evidence Pack kind、task run ID 或 decision record ID。

## 4. 冲突检测

冲突处理分两层：

- 同一字段出现相反结论时，Leader 必须标记为分歧。
- 涉及执行安全的冲突进入 `risks`。
- 涉及最终判断的冲突进入 Decision Record。
- 不允许用新的自由文本摘要覆盖旧结论来掩盖冲突。
- 运行时锁冲突由主进程阻断，并同步为 `risks` 和审计记录，不能静默覆盖。

## 5. Runtime Locks v0.2

`locks` 字段不再由 Agent 自行声明和释放，而是由主进程从 `runtime_locks` 表同步。

锁记录固定字段：

```json
{
  "resource": "channel:<channel_id>:discussion",
  "owner_type": "discussion_run",
  "owner_id": "<discussion_id>",
  "session_id": "discussion:<discussion_id>",
  "status": "active",
  "suspect_count": 0,
  "heartbeat_at": "2026-06-26T00:00:00.000Z",
  "expires_at": "2026-06-26T00:05:00.000Z"
}
```

运行规则：

- 获取锁前先回收过期锁。
- 同一资源同一时间只允许一个 active lock。
- Agent 运行时由主进程按心跳刷新 `heartbeat_at` 和 `expires_at`。
- 任务、讨论完成、失败、停止或进入人工审批时，主进程释放对应锁。
- TTL 过期后先标记为 `suspect` 并进入宽限期，写入 `risks` 与审计记录；宽限期内 heartbeat 会恢复为 `active`。
- suspect 宽限期结束仍无 heartbeat 时才标记为 `stale`，并写入 `risks` 与审计记录。
- 单锁生命周期内 `suspect_count` 超过 3 次时，主进程强制转 `stale`，避免 active/suspect 僵尸摆动。

## 6. Task Discussion Links v0.4

任务模块向讨论模块求助时，主进程会在 `task_discussion_links` 保存桥接状态：

- `execution_snapshot`：挂起前任务现场，包括 task/subtask、阶段、失败命令、错误摘要、涉及文件、Git 状态、已尝试方案和阻断描述。
- `wait_started_at` / `expires_at`：等待讨论结果的开始与超时点。
- `block_fingerprint`：用于识别相似阻断，防止语义变体绕过防循环。
- `discuss_count`：单任务累计求助次数。
- `status`：`active`、`needs_human`、`resolved`、`timeout`、`stopped`。

回流规则：

- 超时进入 Blackboard `risks`，任务转为人工确认兜底。
- Decision Record 回流前执行 drift validator，发现 Git/文件漂移时写入 Evidence Pack 和 Blackboard `risks`。
- 回流恢复任务时会把 execution snapshot 和 drift 结果注入任务上下文。

## 7. Reliability Closure v0.5

执行类任务的可靠性收尾规则：

- `execution_snapshot` 写入前会做体积控制，最大 50KB。
- 快照路径排除 `node_modules`、`.git`、`release`，文件 hash 只读取小文件。
- 阻断指纹会结合错误首尾、用户代码堆栈、文件路径、失败命令和已尝试方案，降低相似 Traceback 误判。
- 主进程启动和周期性状态刷新会扫描 `task_sandboxes`，回收超过 24 小时未活动且无活跃任务/锁的沙箱。
- `running`、`waiting_discussion`、`awaiting_confirmation` 任务现场默认豁免沙箱 GC，避免等待讨论或等待人工时被物理清理。
- Runtime lock 的 `suspect_count` 会记录 `last_suspect_at`，超过衰减窗口后重新计算，避免长周期任务被偶发抖动累积误杀。
- `execution_sandbox_protocol` evidence metadata 包含 `quickActions`，前端只允许调用主进程白名单动作：`takeover`、`copy_command`、`remove_worktree`、`cleanup_sandbox`。
- `remove_worktree` 和 `cleanup_sandbox` 属于破坏性动作，前端必须二次确认；`copy_command` 用于非标准权限环境下复制接管命令。
- 沙箱 GC、接管和清理动作必须写入 Evidence Pack 或审计记录。

## 8. 当前实现状态

已落地：

- `blackboard_schema` 保存 schema 和写入规则。
- `blackboard:v0.1` 保存结构化状态。
- 任务启动写入 `facts`，并获取主进程任务执行锁。
- 任务结果写入 `outputs`，失败写入 `risks`。
- 讨论启动写入 `open_questions`，并获取主进程讨论锁。
- 讨论决策写入 `decisions` 或 `open_questions`。
- `runtime_locks` 负责 TTL、heartbeat、suspect grace、reap 和冲突阻断。
- active/suspect lock 会同步到 Blackboard `locks`。
- `task_discussion_links` 负责任务-讨论桥接的 snapshot、TTL、drift 和防循环状态。
- v0.5 负责锁振荡上限、沙箱 GC、快照瘦身和沙箱白名单接管动作。
- Agent prompt 会注入 schema 说明。

未完全落地：

- 冲突检测还没有自动 diff 和阻断规则。
- 字段检索、标签、过期和合并策略仍需后续版本补强。
