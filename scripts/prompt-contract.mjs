import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();

const checks = [
  {
    file: "electron/main.cjs",
    label: "Hermes execution iteration guard",
    fragments: [
      "const HERMES_CHAT_MAX_TURNS = clampIntegerEnv(\"HAT_HERMES_CHAT_MAX_TURNS\", 8, 2, 20);",
      "const HERMES_CHAT_RETRY_MAX_TURNS = clampIntegerEnv(",
      "const HERMES_CHAT_TIMEOUT_MS = clampIntegerEnv(\"HAT_HERMES_CHAT_TIMEOUT_MS\", 300000, 60000, 900000);",
      "const HERMES_CHAT_RETRY_TIMEOUT_MS = clampIntegerEnv(\"HAT_HERMES_CHAT_RETRY_TIMEOUT_MS\", 600000, HERMES_CHAT_TIMEOUT_MS, 1200000);",
      "const HERMES_PROBE_MAX_TURNS = 1;",
      "function isHermesIterationLimitOutput",
      "function buildHermesChatArgs",
      "function retryPromptAfterIterationLimit",
      "function retryPromptAfterTimeout",
      "source: \"hermes-agent-team-retry\"",
      "attempts.push",
      "Hermes 达到最大迭代轮数"
    ]
  },
  {
    file: "electron/main.cjs",
    label: "mandatory team execution for complex deliverables",
    fragments: [
      "function taskRequiresTeamExecution",
      "function mandatoryTeamExecutionBlock",
      "系统强制 Team 执行",
      "多端/多交付物/架构图/文件交付规则",
      "第一轮只允许输出工作图、拆分方案和 actions JSON",
      "actions 必须创建并委派至少 2 个互不依赖的工作包",
      "主 Agent 必须等下级输出和审查证据进入 Evidence Pack"
    ]
  },
  {
    file: "electron/main.cjs",
    label: "agent generated image attachments",
    fragments: [
      "const MAX_GENERATED_MESSAGE_ATTACHMENT_BYTES",
      "function extractGeneratedVisualArtifactPaths",
      "function stripGeneratedVisualReferences",
      "function renderVisualArtifactToPng",
      "function attachGeneratedImagesForMessage",
      "function agentGeneratedArtifactSources",
      "generated_image_attachment",
      "AGENT_IMAGE_ATTACHMENT_CHECK",
      "图片交付：凡是图、架构图、框架图、截图、视觉方案或图片类任务"
    ]
  },
  {
    file: "electron/main.cjs",
    label: "dual backend agent runtime",
    fragments: [
      "runtime_backend TEXT NOT NULL DEFAULT 'hermes'",
      "function normalizeAgentBackend",
      "function buildCodexExecArgs",
      "async function askCodex",
      "async function invokeAgentRuntime",
      "CODEX_AGENT_READY",
      "runtimeBackend: action.runtime_backend || action.runtimeBackend || action.backend || \"hermes\""
    ]
  },
  {
    file: "scripts/smoke-electron.mjs",
    label: "Codex backend smoke coverage",
    fragments: [
      "runtimeBackend: \"codex\"",
      "includes(\"\\\"engine\\\":\\\"codex\\\"\")",
      "codex_backend_agent_created_and_executed"
    ]
  },
  {
    file: "src/styles.css",
    label: "desktop message image display",
    fragments: [
      ".image-preview-backdrop",
      ".message-attachment img",
      "object-fit: contain"
    ]
  },
  {
    file: "ios/HermesAgentTeamMobile/HermesAgentTeamMobile/ContentView.swift",
    label: "iOS message image display",
    fragments: [
      "MessageAttachmentStrip",
      "ImagePreviewSheet",
      ".scaledToFit()"
    ]
  },
  {
    file: "scripts/smoke-electron.mjs",
    label: "agent generated image smoke coverage",
    fragments: [
      "AGENT_IMAGE_ATTACHMENT_CHECK",
      "agent generated visual artifact was not attached as a message image",
      ".message-attachment img"
    ]
  },
  {
    file: "electron/main.cjs",
    label: "task execution prompt protocol",
    fragments: [
      "任务执行系统协议",
      "Team 启动策略",
      "ROI 判断",
      "工作图",
      "工作包拆解",
      "临时 Agent 组建",
      "并行执行",
      "独立审查",
      "委派契约",
      "证据收敛",
      "主 Agent 负责制",
      "卡点求助",
      "request_discussion_help",
      "Safe Log",
      "最终交付",
      "清理边界"
    ]
  },
  {
    file: "electron/main.cjs",
    label: "discussion leader prompt protocol",
    fragments: [
      "讨论 Leader 组织协议",
      "并发首轮",
      "观点矩阵",
      "续轮条件",
      "人工介入",
      "Decision Record",
      "Safe Log",
      "清理本次临时观点 Agent"
    ]
  },
  {
    file: "electron/main.cjs",
    label: "discussion participant prompt protocol",
    fragments: [
      "讨论参与系统协议",
      "独立视角",
      "参考任务 Evidence Pack",
      "不抢讨论 Leader 职责",
      "观点矩阵"
    ]
  },
  {
    file: "docs/ARCHITECTURE.md",
    label: "task architecture framework",
    fragments: [
      "任务项目经理组织临时 Agent 的系统框架",
      "任务 Intake",
      "Team 启动判断",
      "工作图",
      "临时 Agent 团队",
      "独立审查",
      "质量闸门",
      "人工确认清理"
    ]
  },
  {
    file: "docs/ARCHITECTURE.md",
    label: "discussion architecture framework",
    fragments: [
      "讨论 Leader 组织 Agent 讨论的系统框架",
      "并发首轮",
      "观点矩阵",
      "Decision Record",
      "清理临时观点 Agent"
    ]
  },
  {
    file: "docs/PRD.md",
    label: "Hermes execution iteration PRD coverage",
    fragments: [
      "任务/讨论执行策略",
      "探活允许 `--max-turns 1`",
      "真实任务和讨论不得复用探活轮数",
      "默认 `--max-turns 8`",
      "HAT_HERMES_CHAT_MAX_TURNS",
      "hermes-agent-team-retry",
      "不能把 Hermes 的迭代上限 stdout 当作 Agent 最终结论展示",
      "复杂交付任务必须 Team 化",
      "图片交付必须进入消息附件"
    ]
  },
  {
    file: "docs/ARCHITECTURE.md",
    label: "Hermes execution iteration architecture coverage",
    fragments: [
      "hermes chat with task prompt (8 turns, retry on iteration limit)",
      "hermes chat with discussion prompt (8 turns, retry on iteration limit)",
      "hermes chat with organizer prompt (8 turns, retry on iteration limit)"
    ]
  },
  {
    file: "docs/PRD.md",
    label: "PRD acceptance coverage",
    fragments: [
      "任务项目经理工作协议",
      "Team 启动判断",
      "主 Agent 负责制",
      "primary_synthesis_result",
      "quality_gate",
      "讨论 Leader 工作协议",
      "主 Agent prompt 必须包含任务执行系统协议",
      "讨论 Leader prompt 必须包含讨论 Leader 组织协议"
    ]
  },
  {
    file: "electron/main.cjs",
    label: "content assets persistence",
    fragments: [
      "CREATE TABLE IF NOT EXISTS content_assets",
      "content_archive",
      "Content Assets Memory",
      "human_task_request",
      "task_final_output",
      "discussion_decision"
    ]
  },
  {
    file: "docs/ARCHITECTURE.md",
    label: "content assets architecture",
    fragments: [
      "内容资产沉淀层",
      "content_assets",
      "content_archive.json",
      "Content Assets Memory"
    ]
  },
  {
    file: "docs/PRD.md",
    label: "content assets PRD coverage",
    fragments: [
      "内容资产验收标准",
      "content_assets",
      "content_archive.json",
      "任务 Agent 不能读取 discussion scope 的内容资产"
    ]
  },
  {
    file: "docs/OPERATING_PROTOCOL.md",
    label: "operating protocol v0.1",
    fragments: [
      "少 Agent、高约束、强验证",
      "默认 1 个 Leader + 2 个观点 Agent",
      "参与观点 Agent 硬上限为 3 个",
      "默认 2 轮讨论",
      "低于 2 轮不得直接最终收敛",
      "自动续轮硬上限为 4 轮",
      "自动协作深度硬上限为 3 层"
    ]
  },
  {
    file: "docs/BLACKBOARD_SCHEMA.md",
    label: "blackboard schema v0.1",
    fragments: [
      "\"facts\"",
      "\"assumptions\"",
      "\"decisions\"",
      "\"risks\"",
      "\"open_questions\"",
      "\"locks\"",
      "\"outputs\"",
      "冲突结论不能静默覆盖"
    ]
  },
  {
    file: "src/App.tsx",
    label: "detail review UI",
    fragments: [
      "任务详情",
      "讨论详情",
      "内容资产详情",
      "selectedTaskEvidence",
      "selectedDiscussionDecisions",
      "selectedContentAssetMetadata"
    ]
  },
  {
    file: "docs/ARCHITECTURE.md",
    label: "detail review architecture",
    fragments: [
      "详情复盘视图",
      "任务详情",
      "讨论详情",
      "内容资产详情"
    ]
  },
  {
    file: "docs/PRD.md",
    label: "detail review PRD coverage",
    fragments: [
      "详情复盘验收标准",
      "任务详情",
      "讨论详情",
      "内容资产详情"
    ]
  }
];

const failures = [];

for (const check of checks) {
  const absolutePath = path.join(root, check.file);
  const text = fs.readFileSync(absolutePath, "utf8");
  for (const fragment of check.fragments) {
    if (!text.includes(fragment)) {
      failures.push(`${check.label}: missing "${fragment}" in ${check.file}`);
    }
  }
}

const mainSource = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
const probeMatch = mainSource.match(/async function probeHermesProfile[\s\S]*?\n}\n\nasync function createAgentInternal/);
if (/const\s+HERMES_CHAT_MAX_TURNS\s*=\s*1\s*;/.test(mainSource)) {
  failures.push("Hermes execution iteration guard: task chat max turns must not be hard-coded to 1");
}
if (!/const shouldRetry[\s\S]*?attempts\[0\]\?\.iterationLimit[\s\S]*?retryPromptAfterIterationLimit[\s\S]*?hermes-agent-team-retry/.test(mainSource)) {
  failures.push("Hermes execution iteration guard: iteration-limit retry path is missing");
}
if (!/firstError[\s\S]*?attempts\[0\]\?\.timedOut[\s\S]*?retryPromptAfterTimeout[\s\S]*?hermes-agent-team-retry/.test(mainSource)) {
  failures.push("Hermes execution timeout guard: timeout recovery retry path is missing");
}
if (!/if\s*\(isHermesIterationLimitOutput\(`\$\{result\.stdout\}\\n\$\{result\.stderr\}`\)\)\s*{[\s\S]*?throw error;/.test(mainSource)) {
  failures.push("Hermes execution iteration guard: retry exhaustion must throw instead of displaying raw output");
}
if (!/function taskRequiresTeamExecution[\s\S]*?hasMultiPlatform[\s\S]*?hasArchitectureDeliverable[\s\S]*?function mandatoryTeamExecutionBlock/.test(mainSource)) {
  failures.push("Mandatory team execution: complex deliverable classifier is missing");
}
if (!probeMatch) {
  failures.push("Hermes execution iteration guard: probeHermesProfile function not found");
} else if (!probeMatch[0].includes("HERMES_PROBE_MAX_TURNS") || probeMatch[0].includes("HERMES_CHAT_MAX_TURNS")) {
  failures.push("Hermes execution iteration guard: health probe must keep its own 1-turn limit and not reuse task chat turns");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("Prompt and architecture contracts passed.");
