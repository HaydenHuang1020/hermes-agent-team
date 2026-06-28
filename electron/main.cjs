const { app, BrowserWindow, ipcMain, nativeImage, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const http = require("node:http");
const { execFile, execFileSync, spawn } = require("node:child_process");
const initSqlJs = require("sql.js");

let mainWindow;
let SQL;
let db;
let dbFilePath;
let mobileServer;
let mobileServerWarning = "";
let mobileBonjourProcess;
let mobileBonjourStopping = false;
let mobileBonjourWarning = "";
let mobileLastTeamRequest = null;

const HUMAN_NAME = "Hayden";
const MAX_AGENT_DEPTH = 3;
const MIN_PARALLEL_DELEGATES_FOR_TEAM = 2;
const DEFAULT_DISCUSSION_ROUNDS = 2;
const MIN_DISCUSSION_ROUNDS_BEFORE_FINAL = 2;
const MAX_DISCUSSION_ROUNDS = 4;
const DEFAULT_DISCUSSION_PARTICIPANTS = 2;
const MAX_DISCUSSION_PARTICIPANTS = 3;
const HERMES_CHAT_MAX_TURNS = clampIntegerEnv("HAT_HERMES_CHAT_MAX_TURNS", 8, 2, 20);
const HERMES_CHAT_RETRY_MAX_TURNS = clampIntegerEnv(
  "HAT_HERMES_CHAT_RETRY_MAX_TURNS",
  Math.max(16, HERMES_CHAT_MAX_TURNS + 4),
  HERMES_CHAT_MAX_TURNS + 1,
  30
);
const HERMES_CHAT_TIMEOUT_MS = clampIntegerEnv("HAT_HERMES_CHAT_TIMEOUT_MS", 300000, 60000, 900000);
const HERMES_CHAT_RETRY_TIMEOUT_MS = clampIntegerEnv("HAT_HERMES_CHAT_RETRY_TIMEOUT_MS", 600000, HERMES_CHAT_TIMEOUT_MS, 1200000);
const HERMES_PROBE_MAX_TURNS = 1;
const CODEX_EXEC_TIMEOUT_MS = clampIntegerEnv("HAT_CODEX_EXEC_TIMEOUT_MS", 300000, 60000, 900000);
const CODEX_PROBE_TIMEOUT_MS = clampIntegerEnv("HAT_CODEX_PROBE_TIMEOUT_MS", 90000, 30000, 180000);
const SUPPORTED_AGENT_BACKENDS = new Set(["hermes", "codex"]);
const BLACKBOARD_SCHEMA_VERSION = "0.1";
const BLACKBOARD_SCHEMA_KEY = "blackboard_schema";
const BLACKBOARD_STATE_KEY = "blackboard:v0.1";
const BLACKBOARD_SCHEMA_FIELDS = ["facts", "assumptions", "decisions", "risks", "open_questions", "locks", "outputs"];
const DEFAULT_RUNTIME_LOCK_TTL_MS = 5 * 60 * 1000;
const DEFAULT_RUNTIME_LOCK_GRACE_MS = 60 * 1000;
const DEFAULT_TASK_DISCUSSION_WAIT_MS = 10 * 60 * 1000;
const MAX_TASK_DISCUSSION_HELP_COUNT = 2;
const MAX_RUNTIME_LOCK_SUSPECT_COUNT = 3;
const RUNTIME_LOCK_SUSPECT_DECAY_MS = 30 * 60 * 1000;
const TASK_SANDBOX_PRUNE_AGE_MS = 24 * 60 * 60 * 1000;
const TASK_SANDBOX_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const SANDBOX_GC_EXEMPT_TASK_STATUSES = new Set(["running", "waiting_discussion", "awaiting_confirmation"]);
const MAX_EXECUTION_SNAPSHOT_BYTES = 50 * 1024;
const MAX_SNAPSHOT_FILE_BYTES = 512 * 1024;
const SNAPSHOT_EXCLUDED_PATH_SEGMENTS = new Set(["node_modules", ".git", "release"]);
const DATA_HEALTH_REPORT_VERSION = "0.1";
const DATA_HEALTH_CACHE_MS = 30 * 1000;
const DATA_BACKUP_RETENTION_COUNT = 5;
const DATA_REPAIR_COOLDOWN_MS = 5 * 60 * 1000;
const DATA_SAFETY_STATE_VERSION = "0.1";
const MOBILE_SERVER_DEFAULT_PORT = 18788;
const MOBILE_BONJOUR_TYPE = "_hat-team._tcp";
const MAX_MOBILE_JSON_BYTES = 24 * 1024 * 1024;
const MAX_MESSAGE_ATTACHMENTS = 4;
const MAX_MESSAGE_ATTACHMENT_BYTES = 6 * 1024 * 1024;
const MAX_GENERATED_MESSAGE_ATTACHMENT_BYTES = 16 * 1024 * 1024;
const IMAGE_ATTACHMENT_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const IMAGE_ATTACHMENT_EXTENSIONS = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif"
};
const GENERATED_VISUAL_ARTIFACT_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".html", ".htm"]);
const activeAgentRuns = new Map();
let lastSandboxPruneAt = 0;
let dataHealthCache = { at: 0, report: null };
let dataRepairInFlight = false;
let lastDataRepairAt = 0;

function clampIntegerEnv(name, fallback, min, max) {
  const parsed = Number(process.env[name] || fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mobileAccessTokenPath() {
  try {
    return path.join(app.getPath("userData"), "mobile-access-token");
  } catch {
    return path.join(os.homedir(), ".hermes-agent-team-mobile-token");
  }
}

function readOrCreateMobileAccessToken() {
  const envToken = String(process.env.HAT_MOBILE_TOKEN || "").trim();
  if (envToken) return envToken;

  const tokenPath = mobileAccessTokenPath();
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (/^[A-Za-z0-9_-]{16,}$/.test(existing)) return existing;
  } catch {
    // First run or inaccessible token file; create a fresh local token below.
  }

  const token = crypto.randomBytes(18).toString("base64url");
  try {
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  } catch (error) {
    console.warn(`Mobile access token could not be persisted: ${String(error.message || error)}`);
  }
  return token;
}

const MOBILE_ACCESS_TOKEN = readOrCreateMobileAccessToken();

const DISCUSSION_FRAMEWORKS = {
  balanced_decision: {
    name: "平衡决策",
    purpose: "适合一般问题，先收集事实、分歧和方案，再收敛成行动建议。",
    participantFocus: [
      "先说明你看到的关键事实和假设。",
      "提出一个明确观点，并列出主要证据和风险。",
      "避免重复其他 Agent，优先补充缺口。"
    ],
    organizerProtocol: [
      "先归纳事实和未验证假设。",
      "对比主要方案的收益、风险、成本和下一步。",
      "输出一个推荐动作和需要 Hayden 确认的问题。"
    ],
    outputContract: "结论、分歧、推荐动作、待确认问题"
  },
  daci_decision: {
    name: "DACI 决策",
    purpose: "适合项目决策和协作分工，明确 Driver、Approver、Contributors、Informed。",
    participantFocus: [
      "以 Contributor 视角提供专业输入，不替 Hayden 做最终批准。",
      "明确你的输入影响哪个决策点。",
      "指出谁应该被告知，以及执行依赖。"
    ],
    organizerProtocol: [
      "指定 Driver、Approver、Contributors、Informed。",
      "收集贡献者观点后形成决策建议。",
      "输出行动计划、负责人和需要批准的点。"
    ],
    outputContract: "Driver、Approver、Contributors、Informed、行动计划"
  },
  rapid_decision: {
    name: "RAPID 决策",
    purpose: "适合高责任、高协同决策，明确 Recommend、Agree、Perform、Input、Decide。",
    participantFocus: [
      "说明你的输入属于 Recommend、Agree、Input 或 Perform 的哪一类。",
      "只对你负责的判断给出强意见。",
      "指出是否存在必须被 Agree 的阻断条件。"
    ],
    organizerProtocol: [
      "收集 Input 后形成 Recommend。",
      "识别需要 Agree 的合规、风险或资源门槛。",
      "明确 Decide owner 和 Perform owner。"
    ],
    outputContract: "Recommend、Agree 条件、Input 摘要、Decide、Perform"
  },
  delphi_consensus: {
    name: "Delphi 共识",
    purpose: "适合不确定性高、需要专家逐轮收敛的问题。",
    participantFocus: [
      "独立给出判断、置信度和理由。",
      "后续轮次必须对照上一轮共识/分歧修正观点。",
      "不要迎合多数，保留有证据的少数意见。"
    ],
    organizerProtocol: [
      "汇总各 Agent 判断并标出共识区间。",
      "识别仍需下一轮验证的分歧。",
      "当共识足够或继续收益变低时停止。"
    ],
    outputContract: "共识、分歧、置信度、下一轮问题或最终建议"
  },
  six_hats: {
    name: "六顶思考帽",
    purpose: "适合创意、产品和复杂问题，从事实、情绪、风险、收益、创意、流程六个角度并行思考。",
    participantFocus: [
      "选择一个思考帽角度发言：事实、感受、风险、收益、创意或流程。",
      "不要把所有角度混在一起。",
      "优先补充当前讨论缺失的思考帽。"
    ],
    organizerProtocol: [
      "按白帽事实、红帽直觉、黑帽风险、黄帽收益、绿帽创意、蓝帽流程归类。",
      "检查是否有缺失视角。",
      "用蓝帽视角收敛为下一步。"
    ],
    outputContract: "事实、直觉、风险、收益、创意、流程结论"
  },
  premortem_risk: {
    name: "Pre-mortem 风险预演",
    purpose: "适合任务开工前找失败原因，先假设项目已经失败，再倒推风险。",
    participantFocus: [
      "假设计划已经失败，给出最可能失败原因。",
      "把风险写成可观察信号和预防动作。",
      "区分致命风险和普通风险。"
    ],
    organizerProtocol: [
      "列出最可能失败路径。",
      "按影响和可逆性排序。",
      "输出预防动作、监控信号和需要暂停的触发条件。"
    ],
    outputContract: "失败路径、风险等级、预防动作、触发条件"
  },
  red_team: {
    name: "Red Team 对抗审查",
    purpose: "适合安全、架构、上线前审查，用对抗视角寻找漏洞和误判。",
    participantFocus: [
      "从攻击者、反对者或失败者角度挑战方案。",
      "指出可被利用的假设、权限、数据和流程漏洞。",
      "给出可验证的防护建议。"
    ],
    organizerProtocol: [
      "建立攻击面或反例清单。",
      "区分阻断风险、可接受风险和待观察风险。",
      "必要时向 Hayden 触发风险审批问题。"
    ],
    outputContract: "攻击面、阻断风险、缓解措施、审批问题"
  },
  double_diamond: {
    name: "Double Diamond 设计",
    purpose: "适合产品、体验和问题定义，按 Discover、Define、Develop、Deliver 发散再收敛。",
    participantFocus: [
      "明确你当前处于 Discover、Define、Develop 或 Deliver 哪一阶段。",
      "不要过早给方案；先确认问题是否定义正确。",
      "方案必须绑定用户、约束和验证方式。"
    ],
    organizerProtocol: [
      "先发散发现问题，再收敛定义核心问题。",
      "再发散方案，最后收敛交付路径。",
      "输出当前所在阶段和下一步验证。"
    ],
    outputContract: "Discover、Define、Develop、Deliver、验证动作"
  }
};

function discussionFramework(id) {
  const key = String(id || "").trim();
  return DISCUSSION_FRAMEWORKS[key] ? { id: key, ...DISCUSSION_FRAMEWORKS[key] } : { id: "balanced_decision", ...DISCUSSION_FRAMEWORKS.balanced_decision };
}

function frameworkPromptBlock(framework, audience) {
  const focus = audience === "organizer" ? framework.organizerProtocol : framework.participantFocus;
  return [
    `本次讨论框架：${framework.name}`,
    `框架用途：${framework.purpose}`,
    `${audience === "organizer" ? "组织协议" : "发言协议"}：`,
    ...focus.map((item, index) => `${index + 1}. ${item}`),
    `框架产出：${framework.outputContract}`
  ].join("\n");
}

function taskRequiresTeamExecution(objective) {
  const text = String(objective || "").toLowerCase();
  if (!text.trim()) return false;
  const hasMultiPlatform =
    /(mac|macos|桌面|电脑).*(ios|iphone|手机|移动|mobile)|(ios|iphone|手机|移动|mobile).*(mac|macos|桌面|电脑)/i.test(text);
  const hasArchitectureDeliverable = /(架构图|框架图|软件框架|architecture|diagram|system\s*design)/i.test(text);
  const hasConcreteDeliverable = /(做出|生成|输出|画|绘制|设计|开发|实现|交付|文件|html|页面|图片|图)/i.test(text);
  const hasMultipleOutputs = /(和|与|及|、|,|，|\/).*(端|图|文件|页面|html|app|应用)/i.test(text);
  return (hasMultiPlatform && (hasArchitectureDeliverable || hasConcreteDeliverable)) || (hasArchitectureDeliverable && hasMultipleOutputs);
}

function mandatoryTeamExecutionBlock({ isPrimary, objective }) {
  if (!isPrimary || !taskRequiresTeamExecution(objective)) return "";
  return [
    "系统强制 Team 执行：",
    "本任务命中多端/多交付物/架构图/文件交付规则，禁止按单 Agent 路径直接长时间实施。",
    "第一轮只允许输出工作图、拆分方案和 actions JSON；禁止直接写完整文件、生成完整长文或把最终交付当场做完。",
    "actions 必须创建并委派至少 2 个互不依赖的工作包，且放入同一个 parallel_group：至少 1 个执行交付包，至少 1 个独立审查/验收包。",
    "多端任务应按端拆分执行包，例如 Mac 端交付、iOS/手机端交付，再由审查包核对交付物、图片文件路径、遗漏项和验收标准。",
    "视觉交付必须要求下级输出 PNG/JPEG/WebP/GIF 图片文件路径；HTML/SVG 只能作为源文件，最终消息必须能挂载真实图片附件。",
    "主 Agent 必须等下级输出和审查证据进入 Evidence Pack 后，再走主 Agent 证据收敛给 Hayden 最终结论。"
  ].join("\n");
}

function taskExecutionProtocolBlock({ isPrimary, taskRunId, objective = "" }) {
  return [
    "任务执行系统协议：",
    isPrimary
      ? "你是本次任务的项目经理 Agent，目标是把 Hayden 的任务转成可交付结果，而不是把所有细节都推回给人。"
      : "你是被上级调动的任务 Agent，目标是按委派契约交付你负责的工作包，不越级组织全局任务。",
    "0. 任务接收：先把人的目标转成目标、约束、交付物、验收标准和风险边界；信息不足时先声明假设。",
    "1. Team 启动策略：先做轻重分流，能单 Agent 完成就不要创建临时 Agent；只有能力缺口、需要并行验证、需要独立审查或长周期拆分时才启动 Team。",
    "2. ROI 判断：创建临时 Agent 前必须判断收益是否大于冷启动、Token、合并和写入冲突成本；不确定时优先单 Agent 推进并列出假设。",
    "3. 工作图：复杂任务必须先形成工作图，至少包含目标、验收标准、工作包、依赖关系、并行组、证据要求、独立审查点和最终负责人。",
    "3.1. 工作包拆解：只拆出可以独立交付的工作包，每个工作包必须包含目的、输入、预期输出、验收标准、所需能力和证据要求。",
    "4. 临时 Agent 组建：项目经理只在缺少能力、需要并行验证或需要专门审查时创建临时 Agent；create_agent 必须写清 name、role、description、core_command；需要指定模型时写清 model_provider 和 model_name。",
    `4.1. 最小可行 Team：默认单 Agent 推进；自动协作深度最多 ${MAX_AGENT_DEPTH} 层，超过后必须停止扩张并交付已有证据。`,
    "5. 并行执行：彼此独立的工作包必须放进同一个 parallel_group 并同时 delegate；Team 不是多人聊天，而是并行执行系统。",
    "6. 委派契约：delegate 给下级时必须包含背景、任务边界、输出格式、验收标准、证据要求和停止条件；可附加 work_package_id、parallel_group、acceptance_criteria、evidence_required、review_required。",
    "7. 独立审查：非简单任务必须设置独立审查或 Red Team 工作包，审查者不能只复述执行者输出，必须找证据缺口、反例、风险和验收失败点。",
    "8. 证据收敛：收到下级输出后，对照 Evidence Pack 和 Blackboard 检查缺口；把事实、假设、风险、输出和审查结果收敛到共享状态，只为真实缺口补建 Agent，不为闲聊扩容。",
    "9. 主 Agent 负责制：项目经理可以采纳或否决下级意见，但最终结论、风险说明、证据引用和未完成项由主 Agent 负责，不能把副 Agent 原文堆给 Hayden。",
    "10. 卡点求助：如果短时间内没有可靠思路、路线存在重大分歧、风险无法判断或已有下级输出仍不能推进，不要无限创建任务 Agent；项目经理可以用 request_discussion_help 请求讨论 Leader 组织讨论模块提供方案、反例和下一步。",
    "11. 讨论回流：讨论模块给出的建议只是任务 Evidence Pack 的一部分；项目经理必须回到任务目标，结合证据继续完成任务，不能把讨论结论原样当最终交付；收到讨论回流结果后，必须先基于该结果推进，不得针对同一阻断立即再次 request_discussion_help。",
    "12. 最终交付：项目经理只向 Hayden 汇报最终结论、可用结果、关键证据、独立审查结果、未解决风险、需要人确认的事项和临时 Agent 清理建议。",
    "12.1. 图片交付：凡是图、架构图、框架图、截图、视觉方案或图片类任务，必须生成可直接显示的 PNG/JPEG/WebP/GIF 图片文件，并在最终回复中写出本机图片路径；可以同时保留 HTML/SVG 源文件，但不能只输出 ASCII 图、Markdown 描述或 HTML 路径。",
    "13. 清理边界：任务完成且人确认后，系统清理临时 Agent；Agent 不需要请求保留临时身份，只保留输出和证据。",
    mandatoryTeamExecutionBlock({ isPrimary, objective }),
    taskRunId ? `当前任务运行 ID：${taskRunId}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function discussionParticipantProtocolBlock() {
  return [
    "讨论参与系统协议：",
    "1. 你代表一个独立视角，不要复述其他 Agent 的观点。",
    "2. 先给结论，再给关键理由、证据、反例或风险。",
    "3. 必须参考任务 Evidence Pack、Blackboard 和前面 Agent 的发言。",
    "4. 如果你回应或反对某个对象，可以使用 @Hayden 或 @Agent名称。",
    "5. 不抢讨论 Leader 职责，不决定是否继续，不输出全局组织总结。",
    "6. 输出要能被 Leader 放进观点矩阵：立场、理由、风险、建议。"
  ].join("\n");
}

function discussionRoundPhaseBlock(participant) {
  const nextRound = Number(participant?.rounds_used || 0) + 1;
  if (nextRound <= 1) {
    return [
      "本轮阶段：第 1 轮独立判断。",
      "- 先独立给出你的立场、关键证据、主要风险和推荐方向。",
      "- 不要迎合其他 Agent；本轮重点是拉开视角差异。"
    ].join("\n");
  }
  if (nextRound === 2) {
    return [
      "本轮阶段：第 2 轮交叉审辩。",
      "- 必须引用或回应上一轮至少一个其他 Agent 的观点。",
      "- 明确说明你坚持、修正或反对什么。",
      "- 输出仍未解决的关键分歧、缺失证据和你更新后的推荐。"
    ].join("\n");
  }
  return [
    `本轮阶段：第 ${nextRound} 轮压力测试与收敛。`,
    "- 只围绕上一轮仍未解决的分歧、风险或证据缺口发言。",
    "- 明确给出是否足够收敛，以及最终结论还差什么。"
  ].join("\n");
}

function discussionLeaderProtocolBlock() {
  return [
    "讨论 Leader 组织协议：",
    "0. 定题：把用户话题转成核心问题、讨论边界、判断标准和需要产出的结论类型。",
	    "1. 选择角色：按所选框架把参与 Agent 分配到不同立场或专业视角；Leader 不作为普通观点 Agent 发言。",
	    `2. 并发首轮：默认 ${DEFAULT_DISCUSSION_PARTICIPANTS} 个观点 Agent，同一轮内同时触发；参与 Agent 硬上限 ${MAX_DISCUSSION_PARTICIPANTS} 个。`,
    "3. 共享阅读：参与 Agent 可以看任务内容和讨论历史；Leader 必须把关键事实写入 Blackboard 或 Decision Record，减少重复文本。",
    "4. 收敛：每轮后整理观点矩阵、共识、分歧、证据、风险和缺口。",
	    `5. 最低审辩轮次：默认至少 ${MIN_DISCUSSION_ROUNDS_BEFORE_FINAL} 轮；第 1 轮独立判断，第 2 轮必须交叉审辩、回应分歧并修正观点。低于 ${MIN_DISCUSSION_ROUNDS_BEFORE_FINAL} 轮不得直接最终收敛。`,
	    `6. 续轮条件：第 3 轮以后只有重大分歧未解决、证据不足、风险未澄清、框架要求或 Hayden 明确要求时才继续；硬上限 ${MAX_DISCUSSION_ROUNDS} 轮；普通参与 Agent 不能自行无限续轮。`,
    "7. 人工介入：需要 Hayden 选择方向、补充约束或批准继续时，只问一个清晰问题。",
    "8. 最终输出：形成 Decision Record，包含问题定义、事实证据、观点矩阵、共识、分歧、推荐结论、风险、下一步行动、置信度和是否需要 Hayden 确认。",
    "9. 清理：讨论结束后系统清理本次临时观点 Agent；保留 Leader、长期专家、讨论输出和 Decision Record。"
  ].join("\n");
}

function taskDepthGuardBlock(depth = 0) {
  const remaining = Math.max(0, MAX_AGENT_DEPTH - Number(depth || 0));
  if (remaining > 1) return "";
  if (remaining === 1) {
    return [
      "运行时安全线：你已接近自动协作深度上限。",
      "本轮如果不能明显降低风险或补齐证据，不要再创建/委派新 Agent；优先整合已有事实、未验证假设、风险和下一步。"
    ].join("\n");
  }
  return [
    "运行时安全线：你已达到自动协作深度上限。",
    "禁止继续创建或委派 Agent；必须交付降级结果：已知事实、未验证假设、风险、可用输出、现场路径、回滚/接管命令、推荐下一步、是否需要 Hayden 确认、Safe Log 纯文本兜底。"
  ].join("\n");
}

function discussionConvergenceGuardBlock(maxRoundsUsed = 0) {
  const used = Number(maxRoundsUsed || 0);
  if (used > 0 && used < MIN_DISCUSSION_ROUNDS_BEFORE_FINAL) {
    return [
      `运行时质量线：本讨论只完成 ${used}/${MIN_DISCUSSION_ROUNDS_BEFORE_FINAL} 个最低审辩轮次。`,
      "禁止 decision=final；你必须使用 decision=continue，让参与 Agent 进入交叉审辩轮，回应上一轮观点、补齐分歧和风险。"
    ].join("\n");
  }
  if (used >= MAX_DISCUSSION_ROUNDS) {
    return [
      "运行时安全线：本讨论已达到自动轮次硬上限。",
      "禁止 decision=continue；即使信息不足，也必须输出降级 Decision Record：当前阶段、已完成事项、未完成事项、脏现场路径、相关锁状态、回滚命令、接管命令、Safe Log 纯文本兜底、推荐下一步、是否需要 Hayden 确认。",
      "如果确实需要 Hayden 决策，使用 decision=ask_human 并只提出一个明确问题；否则使用 decision=final。"
    ].join("\n");
  }
  if (used >= MAX_DISCUSSION_ROUNDS - 1) {
    return [
      "运行时安全线：本讨论只剩最后一次自动收敛机会。",
      "除非存在阻断性分歧，否则不要继续扩轮；优先形成可验证 Decision Record。"
    ].join("\n");
  }
  return "";
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeAgentBackend(value) {
  const normalized = String(value || "hermes").trim().toLowerCase();
  return SUPPORTED_AGENT_BACKENDS.has(normalized) ? normalized : "hermes";
}

function agentBackend(agent) {
  return normalizeAgentBackend(agent?.runtime_backend || "hermes");
}

function agentBackendLabel(value) {
  return normalizeAgentBackend(value) === "codex" ? "Codex" : "Hermes";
}

function canceledRunError(label = "Agent") {
  const error = new Error(`${label} 运行已被 /stop 停止。`);
  error.canceled = true;
  return error;
}

function dataDir() {
  const override = process.env.HAT_DATA_DIR;
  const dir = override || path.join(app.getPath("userData"), "data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function hermesHomeDir() {
  return process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
}

function hermesConfigPath() {
  return path.join(hermesHomeDir(), "config.yaml");
}

function hermesProviderCachePath() {
  return path.join(hermesHomeDir(), "provider_models_cache.json");
}

function cleanYamlScalar(value) {
  let text = String(value || "").trim();
  if (!text) return "";
  if ((text.startsWith('"') || text.startsWith("'")) && text.length > 1) {
    const quote = text[0];
    const end = text.indexOf(quote, 1);
    if (end > 0) return text.slice(1, end).trim();
  }
  const commentIndex = text.indexOf(" #");
  if (commentIndex >= 0) text = text.slice(0, commentIndex).trim();
  return text.replace(/^["']|["']$/g, "").trim();
}

function lineIndent(line) {
  return line.match(/^\s*/)?.[0].length || 0;
}

function parseHermesConfigModels(raw) {
  const result = {
    defaultProvider: "",
    defaultModel: "",
    providerModels: []
  };
  let section = "";
  let currentProvider = "";
  let inProviderModels = false;

  for (const line of String(raw || "").split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = lineIndent(line);
    const topLevel = indent === 0 ? line.match(/^([A-Za-z0-9_-]+):/) : null;
    if (topLevel) {
      section = topLevel[1];
      currentProvider = "";
      inProviderModels = false;
      continue;
    }

    if (section === "model" && indent >= 2) {
      const match = line.match(/^\s{2,}([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!match) continue;
      if (match[1] === "provider") result.defaultProvider = cleanYamlScalar(match[2]);
      if (match[1] === "default") result.defaultModel = cleanYamlScalar(match[2]);
      continue;
    }

    if (section !== "providers") continue;

    const providerMatch = line.match(/^\s{2}([A-Za-z0-9_.:-]+):\s*$/);
    if (providerMatch) {
      currentProvider = cleanYamlScalar(providerMatch[1]);
      inProviderModels = false;
      continue;
    }
    if (!currentProvider) continue;

    const providerModelMatch = line.match(/^\s{4}model:\s*(.*)$/);
    if (providerModelMatch) {
      const model = cleanYamlScalar(providerModelMatch[1]);
      if (model) result.providerModels.push({ provider: currentProvider, model, source: "config" });
      inProviderModels = false;
      continue;
    }

    if (/^\s{4}models:\s*$/.test(line)) {
      inProviderModels = true;
      continue;
    }
    if (inProviderModels) {
      if (indent <= 4) {
        inProviderModels = false;
        continue;
      }
      const nestedModelMatch = line.match(/^\s{6}(.+?):\s*(?:\{.*\})?\s*$/);
      if (nestedModelMatch) {
        const model = cleanYamlScalar(nestedModelMatch[1]);
        if (model) result.providerModels.push({ provider: currentProvider, model, source: "config" });
      }
    }
  }
  return result;
}

function readHermesModelState() {
  const configPath = hermesConfigPath();
  const cachePath = hermesProviderCachePath();
  const warnings = [];
  const options = [];
  const seen = new Set();
  let config = { defaultProvider: "", defaultModel: "", providerModels: [] };

  function addOption(option) {
    const provider = String(option.provider || "").trim();
    const model = String(option.model || "").trim();
    if (!model) return;
    const key = `${provider}\u0000${model}`;
    if (seen.has(key)) return;
    seen.add(key);
    options.push({
      provider,
      model,
      label: provider ? `${model} · ${provider}` : model,
      source: option.source || "provider_cache",
      isDefault: Boolean(option.isDefault)
    });
  }

  try {
    config = parseHermesConfigModels(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    warnings.push(`未读取到 Hermes config.yaml：${String(error.message || error)}`);
  }

  if (config.defaultModel) {
    addOption({
      provider: config.defaultProvider,
      model: config.defaultModel,
      source: "current",
      isDefault: true
    });
  }
  for (const item of config.providerModels) {
    addOption({ ...item, isDefault: item.provider === config.defaultProvider && item.model === config.defaultModel });
  }

  try {
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    for (const [provider, meta] of Object.entries(cache || {})) {
      const models = Array.isArray(meta?.models) ? meta.models : [];
      for (const model of models) {
        addOption({
          provider,
          model,
          source: "provider_cache",
          isDefault: provider === config.defaultProvider && model === config.defaultModel
        });
      }
    }
  } catch (error) {
    warnings.push(`未读取到 Hermes provider 模型缓存：${String(error.message || error)}`);
  }

  return {
    defaultProvider: config.defaultProvider,
    defaultModel: config.defaultModel,
    configPath,
    cachePath,
    options,
    updatedAt: nowIso(),
    warning: warnings.join("；")
  };
}

function agentModelLabel(agent) {
  const model = String(agent?.model_name || "").trim();
  const provider = String(agent?.model_provider || "").trim();
  if (!model) return "";
  return provider ? `${provider}/${model}` : model;
}

async function initDb() {
  SQL = await initSqlJs({
    locateFile: (file) => path.join(__dirname, "..", "node_modules", "sql.js", "dist", file)
  });

  dbFilePath = path.join(dataDir(), "team.sqlite");
  if (fs.existsSync(dbFilePath)) {
    db = new SQL.Database(fs.readFileSync(dbFilePath));
  } else {
    db = new SQL.Database();
  }

  db.run(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      description TEXT NOT NULL,
      runtime_backend TEXT NOT NULL DEFAULT 'hermes',
      core_command TEXT NOT NULL DEFAULT '',
      model_provider TEXT NOT NULL DEFAULT '',
      model_name TEXT NOT NULL DEFAULT '',
      parent_agent_id TEXT,
      hermes_profile TEXT NOT NULL UNIQUE,
      is_primary INTEGER NOT NULL DEFAULT 0,
      owned_by_app INTEGER NOT NULL DEFAULT 1,
      agent_kind TEXT NOT NULL DEFAULT 'task',
      status TEXT NOT NULL DEFAULT 'ready',
      current_task TEXT NOT NULL DEFAULT '',
      last_started_at TEXT,
      last_finished_at TEXT,
      last_error TEXT NOT NULL DEFAULT '',
      last_reply_at TEXT,
      is_temporary INTEGER NOT NULL DEFAULT 0,
      task_run_id TEXT,
      created_by_agent_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_agent_id) REFERENCES agents(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS agent_channels (
      agent_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      PRIMARY KEY (agent_id, channel_id),
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      sender_type TEXT NOT NULL,
      sender_id TEXT,
      sender_name TEXT NOT NULL,
      mode TEXT NOT NULL,
      target_agent_id TEXT,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS message_attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'image',
      mime_type TEXT NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL DEFAULT '',
      byte_size INTEGER NOT NULL DEFAULT 0,
      width INTEGER,
      height INTEGER,
      storage_path TEXT NOT NULL,
      public_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_message_attachments_message
      ON message_attachments(message_id);

    CREATE TABLE IF NOT EXISTS audits (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      channel_id TEXT,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      action TEXT NOT NULL,
      result TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS task_runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      primary_agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      objective TEXT NOT NULL,
      final_output TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      completed_at TEXT,
      cleaned_at TEXT,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY (primary_agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS discussion_runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      topic TEXT NOT NULL,
      status TEXT NOT NULL,
      discussion_framework TEXT NOT NULL DEFAULT 'balanced_decision',
      organizer_agent_id TEXT,
      organizer_status TEXT NOT NULL DEFAULT '',
      round_limit INTEGER NOT NULL DEFAULT 2,
      created_at TEXT NOT NULL,
      closed_at TEXT,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS discussion_agents (
      discussion_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      rounds_used INTEGER NOT NULL DEFAULT 0,
      round_limit INTEGER NOT NULL DEFAULT 2,
      status TEXT NOT NULL DEFAULT 'active',
      last_spoke_at TEXT,
      PRIMARY KEY (discussion_id, agent_id),
      FOREIGN KEY (discussion_id) REFERENCES discussion_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS task_discussion_links (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      task_run_id TEXT NOT NULL,
      discussion_id TEXT NOT NULL,
      requester_agent_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      request_text TEXT NOT NULL DEFAULT '',
      execution_snapshot TEXT NOT NULL DEFAULT '{}',
      wait_started_at TEXT,
      expires_at TEXT,
      block_fingerprint TEXT NOT NULL DEFAULT '',
      discuss_count INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY (task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (discussion_id) REFERENCES discussion_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (requester_agent_id) REFERENCES agents(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_task_discussion_links_task_status
      ON task_discussion_links(task_run_id, status);

    CREATE INDEX IF NOT EXISTS idx_task_discussion_links_discussion
      ON task_discussion_links(discussion_id);

    CREATE TABLE IF NOT EXISTS blackboard_entries (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      channel_id TEXT,
      key TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'workspace',
      value TEXT NOT NULL,
      updated_by_type TEXT NOT NULL,
      updated_by_id TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, key),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS runtime_locks (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      channel_id TEXT,
      resource TEXT NOT NULL,
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      reason TEXT NOT NULL DEFAULT '',
      suspect_count INTEGER NOT NULL DEFAULT 0,
      last_suspect_at TEXT,
      acquired_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      released_at TEXT,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_runtime_locks_active_resource
      ON runtime_locks(workspace_id, resource, status, expires_at);

    CREATE TABLE IF NOT EXISTS evidence_items (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      task_run_id TEXT,
      agent_id TEXT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY (task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS decision_records (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      discussion_id TEXT NOT NULL,
      framework TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      decision TEXT NOT NULL,
      risks TEXT NOT NULL DEFAULT '',
      actions TEXT NOT NULL DEFAULT '',
      needs_human INTEGER NOT NULL DEFAULT 0,
      created_by_agent_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY (discussion_id) REFERENCES discussion_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by_agent_id) REFERENCES agents(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS content_assets (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      channel_id TEXT,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      asset_type TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'workspace',
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_by_type TEXT NOT NULL,
      created_by_id TEXT,
      importance INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(source_type, source_id),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL
    );
  `);
  migrateDb();
  reconcileAgentRuntimeState();
  try {
    backfillContentAssets();
  } catch (error) {
    console.warn("Content asset backfill skipped after legacy data error:", error.message || error);
  }
  await cleanupEmptyLegacySeedWorkspaces();

  const existingWorkspaces = all("SELECT * FROM workspaces ORDER BY created_at ASC");
  for (const workspace of existingWorkspaces) {
    const channel = get("SELECT * FROM channels WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 1", [
      workspace.id
    ]);
    if (!channel) continue;
    try {
      await ensureWorkspaceBaseAgents({ workspaceId: workspace.id, channelId: channel.id, actorType: "system" });
    } catch (error) {
      audit({
        workspaceId: workspace.id,
        channelId: channel.id,
        actorType: "system",
        action: "ensure_workspace_base_agents",
        result: "failed",
        detail: `空间主 Agent 自动补齐失败：${String(error.message || error).slice(0, 600)}`
      });
    }
  }
  reapStaleRuntimeLocks();
  reapWaitingDiscussionLinks();
  pruneTaskSandboxes();
  recordStartupDataHealth();
  saveDb();
}

function saveDb() {
  if (!db || !dbFilePath) return;
  safeWriteFileSync(dbFilePath, Buffer.from(db.export()), "写入 SQLite 数据库");
}

function dataSafetyError(error, context = "写入本地数据") {
  const code = error?.code ? String(error.code) : "";
  if (code === "ENOSPC") {
    return new Error(`${context}失败：磁盘空间不足。请先清理本机磁盘或数据治理归档目录后重试。`);
  }
  if (code === "EACCES" || code === "EPERM") {
    return new Error(`${context}失败：没有足够文件权限。请检查目标目录权限后重试。`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function safeWriteFileSync(filePath, content, context = "写入文件") {
  try {
    fs.writeFileSync(filePath, content);
  } catch (error) {
    throw dataSafetyError(error, context);
  }
}

function safeCopyFileSync(sourcePath, targetPath, context = "复制文件") {
  try {
    fs.copyFileSync(sourcePath, targetPath);
  } catch (error) {
    throw dataSafetyError(error, context);
  }
}

function safeCpSync(sourcePath, targetPath, options = {}, context = "复制目录") {
  try {
    fs.cpSync(sourcePath, targetPath, options);
  } catch (error) {
    throw dataSafetyError(error, context);
  }
}

function run(sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    stmt.step();
  } finally {
    stmt.free();
  }
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  const rows = [];
  try {
    stmt.bind(params);
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
  } finally {
    stmt.free();
  }
  return rows;
}

function get(sql, params = []) {
  return all(sql, params)[0] || null;
}

function ensureColumn(table, column, definition) {
  const columns = all(`PRAGMA table_info(${table})`).map((item) => item.name);
  if (!columns.includes(column)) {
    run(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

function migrateDb() {
  ensureColumn("agents", "current_task", "current_task TEXT NOT NULL DEFAULT ''");
  ensureColumn("agents", "last_started_at", "last_started_at TEXT");
  ensureColumn("agents", "last_finished_at", "last_finished_at TEXT");
  ensureColumn("agents", "last_error", "last_error TEXT NOT NULL DEFAULT ''");
  ensureColumn("agents", "last_reply_at", "last_reply_at TEXT");
  ensureColumn("agents", "is_temporary", "is_temporary INTEGER NOT NULL DEFAULT 0");
  ensureColumn("agents", "task_run_id", "task_run_id TEXT");
  ensureColumn("agents", "agent_kind", "agent_kind TEXT NOT NULL DEFAULT 'task'");
  ensureColumn("agents", "runtime_backend", "runtime_backend TEXT NOT NULL DEFAULT 'hermes'");
  ensureColumn("agents", "core_command", "core_command TEXT NOT NULL DEFAULT ''");
  ensureColumn("agents", "model_provider", "model_provider TEXT NOT NULL DEFAULT ''");
  ensureColumn("agents", "model_name", "model_name TEXT NOT NULL DEFAULT ''");
  ensureColumn("discussion_runs", "organizer_agent_id", "organizer_agent_id TEXT");
  ensureColumn("discussion_runs", "organizer_status", "organizer_status TEXT NOT NULL DEFAULT ''");
  ensureColumn("discussion_runs", "discussion_framework", "discussion_framework TEXT NOT NULL DEFAULT 'balanced_decision'");
  ensureColumn("task_discussion_links", "execution_snapshot", "execution_snapshot TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("task_discussion_links", "wait_started_at", "wait_started_at TEXT");
  ensureColumn("task_discussion_links", "expires_at", "expires_at TEXT");
  ensureColumn("task_discussion_links", "block_fingerprint", "block_fingerprint TEXT NOT NULL DEFAULT ''");
  ensureColumn("task_discussion_links", "discuss_count", "discuss_count INTEGER NOT NULL DEFAULT 1");
  ensureColumn("runtime_locks", "suspect_count", "suspect_count INTEGER NOT NULL DEFAULT 0");
  ensureColumn("runtime_locks", "last_suspect_at", "last_suspect_at TEXT");
}

function reconcileAgentRuntimeState() {
  const stoppedAt = nowIso();
  run(
    `UPDATE agents
     SET status = 'failed',
       current_task = '',
       last_finished_at = ?,
       last_error = '上次任务中断：应用关闭或后台进程退出。'
     WHERE status = 'running'`,
    [stoppedAt]
  );

  for (const agent of all("SELECT id, last_error FROM agents WHERE last_error LIKE '%Command failed:%' OR last_error LIKE '%硬性层级规则%'")) {
    run("UPDATE agents SET last_error = ? WHERE id = ?", [summarizeError(agent.last_error), agent.id]);
  }

  run(
    `UPDATE messages
     SET content = ?
     WHERE sender_type = 'agent'
       AND (content LIKE '%Command failed:%' OR content LIKE '%硬性层级规则%')`,
    [`执行失败：${legacyPromptLeakSummary()}`]
  );
  run(
    `UPDATE audits
     SET detail = ?
     WHERE detail LIKE '%Command failed:%' OR detail LIKE '%硬性层级规则%'`,
    [legacyPromptLeakSummary()]
  );

  for (const agent of all("SELECT * FROM agents WHERE (last_finished_at IS NULL OR last_finished_at = '')")) {
    const latestReply = get(
      `SELECT content, created_at
       FROM messages
       WHERE sender_type = 'agent' AND sender_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [agent.id]
    );
    if (latestReply?.content && String(latestReply.content).startsWith("执行失败：")) {
      run(
        `UPDATE agents
         SET status = 'failed',
           current_task = '',
           last_finished_at = ?,
           last_error = ?
         WHERE id = ?`,
        [latestReply.created_at, summarizeError(latestReply.content), agent.id]
      );
    }
  }
}

function legacyPromptLeakSummary() {
  return "Hermes 执行失败。旧版本把完整提示词写进了错误记录，新版已改为显示精简错误；请重新发送任务获取新的状态结果。";
}

function audit({ workspaceId, channelId = null, actorType, actorId = null, action, result, detail }) {
  run(
    `INSERT INTO audits (id, workspace_id, channel_id, actor_type, actor_id, action, result, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [makeId("audit"), workspaceId, channelId, actorType, actorId, action, result, detail, nowIso()]
  );
}

function compactText(value, max = 1200) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function safeJson(value) {
  try {
    return JSON.stringify(value || {});
  } catch {
    return "{}";
  }
}

function parseJsonObject(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function countQuery(sql, params = []) {
  return Number(get(sql, params)?.count || 0);
}

function dataGovernanceDir() {
  const dir = path.join(dataDir(), "data_governance");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function dataHealthReportDir() {
  const dir = path.join(dataGovernanceDir(), "reports");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function dataBackupDir() {
  const dir = path.join(dataGovernanceDir(), "backups");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function dataSafetyStatePath() {
  return path.join(dataGovernanceDir(), "data_safety_state.json");
}

function dataProfileArchiveDir() {
  const dir = path.join(dataGovernanceDir(), "profile_archive");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function governanceTimestamp() {
  return nowIso().replace(/[:.]/g, "-");
}

function hermesProfilesDir() {
  return path.join(hermesHomeDir(), "profiles");
}

function listManagedHermesProfiles() {
  if (process.env.HAT_HERMES_MODE === "mock" && !process.env.HERMES_HOME) return [];
  const profilesDir = hermesProfilesDir();
  if (!fs.existsSync(profilesDir)) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(profilesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const profileName = entry.name;
      const profileDir = path.join(profilesDir, profileName);
      const markerPath = path.join(profileDir, ".hermes-agent-team.json");
      const agentFilePath = path.join(profileDir, "AGENTS.md");
      const marker = fs.existsSync(markerPath) ? parseJsonObject(fs.readFileSync(markerPath, "utf8"), {}) : {};
      const marked =
        marker.managedBy === "Hermes Agent Team" ||
        marker.managed_by === "Hermes Agent Team" ||
        profileName.startsWith("hat") ||
        (fs.existsSync(agentFilePath) &&
          fs.readFileSync(agentFilePath, "utf8").includes("Hermes Agent Team Agent Instructions"));
      if (!marked) return null;
      return {
        profileName,
        path: profileDir,
        markerPath: fs.existsSync(markerPath) ? markerPath : "",
        hasMarker: fs.existsSync(markerPath),
        hasAgentFile: fs.existsSync(agentFilePath),
        updatedAt: marker.updatedAt || marker.createdAt || ""
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.profileName.localeCompare(b.profileName));
}

function dbManagedProfileNames() {
  return new Set(
    all("SELECT hermes_profile FROM agents WHERE COALESCE(runtime_backend, 'hermes') = 'hermes'")
      .map((agent) => String(agent.hermes_profile || ""))
      .filter(Boolean)
  );
}

function dbFileExists() {
  return Boolean(dbFilePath && fs.existsSync(dbFilePath));
}

function listTeamDatabaseBackups() {
  const dir = dataBackupDir();
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && /^team-.*\.sqlite$/.test(entry.name))
    .map((entry) => {
      const filePath = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(filePath);
        return {
          name: entry.name,
          path: filePath,
          mtimeMs: stat.mtimeMs,
          sizeBytes: stat.size
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
}

function readDataSafetyState() {
  const statePath = dataSafetyStatePath();
  if (!fs.existsSync(statePath)) {
    return {
      version: DATA_SAFETY_STATE_VERSION,
      golden_backup_path: "",
      golden_backup_verified_at: "",
      last_data_repair_at: ""
    };
  }
  const parsed = parseJsonObject(fs.readFileSync(statePath, "utf8"), {});
  return {
    version: parsed.version || DATA_SAFETY_STATE_VERSION,
    golden_backup_path: String(parsed.golden_backup_path || ""),
    golden_backup_verified_at: String(parsed.golden_backup_verified_at || ""),
    last_data_repair_at: String(parsed.last_data_repair_at || "")
  };
}

function writeDataSafetyState(nextState) {
  const state = {
    version: DATA_SAFETY_STATE_VERSION,
    ...readDataSafetyState(),
    ...nextState,
    updated_at: nowIso()
  };
  safeWriteFileSync(dataSafetyStatePath(), JSON.stringify(state, null, 2), "写入数据安全状态");
  return state;
}

function currentGoldenBackupPath() {
  const state = readDataSafetyState();
  return state.golden_backup_path && fs.existsSync(state.golden_backup_path) ? state.golden_backup_path : "";
}

function pruneTeamDatabaseBackups({ keep = DATA_BACKUP_RETENTION_COUNT } = {}) {
  const backups = listTeamDatabaseBackups();
  const goldenPath = currentGoldenBackupPath();
  const goldenBackup = goldenPath ? backups.find((backup) => backup.path === goldenPath) : null;
  const rollingKeep = Math.max(0, keep - (goldenBackup ? 1 : 0));
  const keepPaths = new Set([
    ...(goldenBackup ? [goldenBackup.path] : []),
    ...backups.filter((backup) => backup.path !== goldenPath).slice(0, rollingKeep).map((backup) => backup.path)
  ]);
  const removed = [];
  const failed = [];
  for (const backup of backups) {
    if (keepPaths.has(backup.path)) continue;
    try {
      fs.rmSync(backup.path, { force: true });
      removed.push(backup.path);
    } catch (error) {
      failed.push({ path: backup.path, error: String(error.message || error) });
    }
  }
  return {
    scanned: backups.length,
    kept: keepPaths.size,
    goldenBackupPath: goldenBackup?.path || "",
    goldenKept: Boolean(goldenBackup),
    removed,
    failed
  };
}

function teamDatabaseBackupStats() {
  const backups = listTeamDatabaseBackups();
  const goldenPath = currentGoldenBackupPath();
  return {
    count: backups.length,
    bytes: backups.reduce((sum, backup) => sum + Number(backup.sizeBytes || 0), 0),
    golden_backup_path: goldenPath
  };
}

function verifyReadableNonEmptyFile(filePath, label = "文件") {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`${label}不存在，已阻断数据修复。`);
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`${label}不可用或为空，已阻断数据修复：${filePath}`);
  }
  const fd = fs.openSync(filePath, "r");
  fs.closeSync(fd);
  return { path: filePath, sizeBytes: stat.size };
}

function verifySQLiteBackupFile(filePath, label = "SQLite 备份") {
  const verified = verifyReadableNonEmptyFile(filePath, label);
  const header = fs.readFileSync(filePath, { encoding: null, flag: "r" }).subarray(0, 16).toString("binary");
  if (header !== "SQLite format 3\u0000") {
    throw new Error(`${label}不是合法 SQLite 文件，已阻断数据修复：${filePath}`);
  }
  let backupDb;
  try {
    const buffer = fs.readFileSync(filePath);
    backupDb = new SQL.Database(new Uint8Array(buffer));
    const quickCheck = backupDb.exec("PRAGMA quick_check");
    const quickCheckValue = String(quickCheck?.[0]?.values?.[0]?.[0] || "");
    if (quickCheckValue !== "ok") {
      throw new Error(`quick_check=${quickCheckValue || "empty"}`);
    }
    const tableCheck = backupDb.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'");
    if (!tableCheck?.[0]?.values?.length) {
      throw new Error("missing workspaces table");
    }
    return { ...verified, quickCheck: quickCheckValue };
  } catch (error) {
    throw new Error(`${label}无法通过 SQLite 连接校验，已阻断数据修复：${String(error.message || error)}`);
  } finally {
    if (backupDb) backupDb.close();
  }
}

function ensureGoldenDatabaseBackup(backupPath) {
  const current = currentGoldenBackupPath();
  if (current) return current;
  verifySQLiteBackupFile(backupPath, "SQLite 黄金备份");
  writeDataSafetyState({
    golden_backup_path: backupPath,
    golden_backup_verified_at: nowIso()
  });
  return backupPath;
}

function backupTeamDatabase(reason = "manual") {
  if (!dbFileExists()) throw new Error("SQLite 数据库文件不存在，已阻断数据修复。");
  saveDb();
  const backupPath = path.join(dataBackupDir(), `team-${governanceTimestamp()}-${makeId("backup")}-${reason}.sqlite`);
  safeCopyFileSync(dbFilePath, backupPath, "复制 SQLite 修复前备份");
  const verified = verifySQLiteBackupFile(backupPath, "SQLite 修复前备份");
  const goldenBackupPath = ensureGoldenDatabaseBackup(backupPath);
  const rotation = pruneTeamDatabaseBackups();
  return { path: backupPath, sizeBytes: verified.sizeBytes, quickCheck: verified.quickCheck, goldenBackupPath, rotation };
}

function archiveManagedProfile(profileName, reason = "manual") {
  const sourceDir = hermesProfileDir(profileName);
  if (!fs.existsSync(sourceDir)) return "";
  const archiveRoot = path.join(dataProfileArchiveDir(), governanceTimestamp());
  fs.mkdirSync(archiveRoot, { recursive: true });
  const targetDir = path.join(archiveRoot, profileName);
  safeCpSync(sourceDir, targetDir, { recursive: true, force: true }, "归档 Hermes profile");
  fs.rmSync(sourceDir, { recursive: true, force: true });
  return targetDir;
}

function writeDataHealthReport(report) {
  const filePath = path.join(dataHealthReportDir(), `data-health-${governanceTimestamp()}.json`);
  safeWriteFileSync(filePath, JSON.stringify(report, null, 2), "写入数据健康报告");
  return filePath;
}

function dataRepairCooldownRemainingMs() {
  const persistedAt = Date.parse(readDataSafetyState().last_data_repair_at || "") || 0;
  const effectiveRepairAt = Math.max(Number(lastDataRepairAt || 0), persistedAt);
  if (!effectiveRepairAt) return 0;
  return Math.max(0, DATA_REPAIR_COOLDOWN_MS - (Date.now() - effectiveRepairAt));
}

function dataRepairControlState() {
  const cooldownMs = dataRepairCooldownRemainingMs();
  return {
    in_flight: dataRepairInFlight,
    cooldown_ms: cooldownMs,
    cooldown_seconds: Math.ceil(cooldownMs / 1000),
    cooldown_until: cooldownMs > 0 ? new Date(Date.now() + cooldownMs).toISOString() : "",
    backup_retention_count: DATA_BACKUP_RETENTION_COUNT,
    golden_backup_path: currentGoldenBackupPath(),
    backup_dir: dataBackupDir(),
    profile_archive_dir: dataProfileArchiveDir()
  };
}

function withDataRepairControl(report) {
  return {
    ...report,
    repair_control: dataRepairControlState()
  };
}

function assertDataRepairCanStart({ enforceCooldown = false } = {}) {
  if (dataRepairInFlight) throw new Error("数据修复正在执行中，请等待当前修复完成。");
  const cooldownMs = dataRepairCooldownRemainingMs();
  if (enforceCooldown && cooldownMs > 0) {
    throw new Error(`数据修复冷却中，请 ${Math.ceil(cooldownMs / 1000)} 秒后再试。`);
  }
}

function normalizeDataRepairMode({ repairMode = "", cleanupProfiles = false } = {}) {
  const mode = String(repairMode || "").trim();
  if (["database", "profiles", "all"].includes(mode)) return mode;
  return cleanupProfiles ? "all" : "database";
}

function dataRepairModeIncludesDatabase(mode) {
  return mode === "database" || mode === "all";
}

function dataRepairModeIncludesProfiles(mode) {
  return mode === "profiles" || mode === "all";
}

function reportHasDatabaseRepairRisk(report) {
  const counts = report?.counts || {};
  return Boolean(
    counts.foreign_key_failures ||
      counts.orphan_rows ||
      counts.released_lock_overflow ||
      counts.runtime_locks?.stale ||
      counts.runtime_locks?.failed
  );
}

function reportHasRepairableMissingProfiles(report) {
  return Boolean((report?.missing_profile_agents || []).some((agent) => agent.repairable));
}

function reportHasProfileRepairRisk(report) {
  return Boolean(report?.counts?.orphan_managed_profiles || reportHasRepairableMissingProfiles(report));
}

function buildDataHealthReport({ persist = false } = {}) {
  const foreignKeyFailures = all("PRAGMA foreign_key_check");
  const backupStats = teamDatabaseBackupStats();
  const orphanCounts = {
    agents: countQuery("SELECT COUNT(*) AS count FROM agents a LEFT JOIN workspaces w ON w.id = a.workspace_id WHERE w.id IS NULL"),
    channels: countQuery("SELECT COUNT(*) AS count FROM channels c LEFT JOIN workspaces w ON w.id = c.workspace_id WHERE w.id IS NULL"),
    messages: countQuery("SELECT COUNT(*) AS count FROM messages m LEFT JOIN workspaces w ON w.id = m.workspace_id WHERE w.id IS NULL"),
    message_attachments: countQuery(
      `SELECT COUNT(*) AS count
       FROM message_attachments ma
       LEFT JOIN messages m ON m.id = ma.message_id
       LEFT JOIN workspaces w ON w.id = ma.workspace_id
       LEFT JOIN channels c ON c.id = ma.channel_id
       WHERE m.id IS NULL OR w.id IS NULL OR c.id IS NULL`
    ),
    audits: countQuery("SELECT COUNT(*) AS count FROM audits a LEFT JOIN workspaces w ON w.id = a.workspace_id WHERE w.id IS NULL"),
    task_runs: countQuery("SELECT COUNT(*) AS count FROM task_runs tr LEFT JOIN workspaces w ON w.id = tr.workspace_id WHERE w.id IS NULL"),
    discussion_runs: countQuery("SELECT COUNT(*) AS count FROM discussion_runs dr LEFT JOIN workspaces w ON w.id = dr.workspace_id WHERE w.id IS NULL"),
    blackboard_entries: countQuery("SELECT COUNT(*) AS count FROM blackboard_entries b LEFT JOIN workspaces w ON w.id = b.workspace_id WHERE w.id IS NULL"),
    runtime_locks: countQuery("SELECT COUNT(*) AS count FROM runtime_locks rl LEFT JOIN workspaces w ON w.id = rl.workspace_id WHERE w.id IS NULL"),
    task_discussion_links: countQuery("SELECT COUNT(*) AS count FROM task_discussion_links tdl LEFT JOIN workspaces w ON w.id = tdl.workspace_id WHERE w.id IS NULL"),
    evidence_items: countQuery("SELECT COUNT(*) AS count FROM evidence_items ei LEFT JOIN workspaces w ON w.id = ei.workspace_id WHERE w.id IS NULL"),
    decision_records: countQuery("SELECT COUNT(*) AS count FROM decision_records dr LEFT JOIN workspaces w ON w.id = dr.workspace_id WHERE w.id IS NULL"),
    content_assets: countQuery("SELECT COUNT(*) AS count FROM content_assets ca LEFT JOIN workspaces w ON w.id = ca.workspace_id WHERE w.id IS NULL"),
    agent_channels: countQuery(
      `SELECT COUNT(*) AS count
       FROM agent_channels ac
       LEFT JOIN agents a ON a.id = ac.agent_id
       LEFT JOIN channels c ON c.id = ac.channel_id
       WHERE a.id IS NULL OR c.id IS NULL`
    ),
    discussion_agents: countQuery(
      `SELECT COUNT(*) AS count
       FROM discussion_agents da
       LEFT JOIN discussion_runs dr ON dr.id = da.discussion_id
       LEFT JOIN agents a ON a.id = da.agent_id
       WHERE dr.id IS NULL OR a.id IS NULL`
    )
  };
  const checkProfiles = !(process.env.HAT_HERMES_MODE === "mock" && !process.env.HERMES_HOME);
  const managedProfiles = checkProfiles ? listManagedHermesProfiles() : [];
  const diskProfileNames = new Set(managedProfiles.map((profile) => profile.profileName));
  const dbProfileSet = dbManagedProfileNames();
  const missingProfileAgents = checkProfiles
    ? all(
        `SELECT id, name, workspace_id, hermes_profile, owned_by_app
         FROM agents
         WHERE COALESCE(runtime_backend, 'hermes') = 'hermes'
         ORDER BY created_at ASC`
      )
        .filter((agent) => agent.hermes_profile && !diskProfileNames.has(agent.hermes_profile))
        .map((agent) => ({
          id: agent.id,
          name: agent.name,
          workspaceId: agent.workspace_id,
          profileName: agent.hermes_profile,
          ownedByApp: Number(agent.owned_by_app || 0) === 1,
          repairable: Number(agent.owned_by_app || 0) === 1
        }))
    : [];
  const orphanProfiles = checkProfiles
    ? managedProfiles
        .filter((profile) => !dbProfileSet.has(profile.profileName))
        .map((profile) => ({
          profileName: profile.profileName,
          path: profile.path,
          hasMarker: profile.hasMarker,
          hasAgentFile: profile.hasAgentFile,
          updatedAt: profile.updatedAt
        }))
    : [];
  const lockCounts = {
    released: countQuery("SELECT COUNT(*) AS count FROM runtime_locks WHERE status = 'released'"),
    stale: countQuery("SELECT COUNT(*) AS count FROM runtime_locks WHERE status = 'stale'"),
    failed: countQuery("SELECT COUNT(*) AS count FROM runtime_locks WHERE status = 'failed'"),
    active: countQuery("SELECT COUNT(*) AS count FROM runtime_locks WHERE status = 'active'"),
    suspect: countQuery("SELECT COUNT(*) AS count FROM runtime_locks WHERE status = 'suspect'")
  };
  const orphanTotal = Object.values(orphanCounts).reduce((sum, value) => sum + Number(value || 0), 0);
  const releasedLockOverflow = Math.max(0, lockCounts.released - 20);
  const issueCount =
    foreignKeyFailures.length +
    orphanTotal +
    missingProfileAgents.length +
    orphanProfiles.length +
    lockCounts.stale +
    lockCounts.failed +
    releasedLockOverflow;
  const status = issueCount === 0 ? "ok" : issueCount <= 10 ? "warn" : "critical";
  const report = {
    version: DATA_HEALTH_REPORT_VERSION,
    generated_at: nowIso(),
    status,
    issue_count: issueCount,
    db_path: dbFilePath,
    hermes_profiles_dir: hermesProfilesDir(),
    counts: {
      workspaces: countQuery("SELECT COUNT(*) AS count FROM workspaces"),
      agents: countQuery("SELECT COUNT(*) AS count FROM agents"),
      profile_check_enabled: checkProfiles,
      managed_profiles_on_disk: managedProfiles.length,
      foreign_key_failures: foreignKeyFailures.length,
      orphan_rows: orphanTotal,
      missing_profile_agents: missingProfileAgents.length,
      orphan_managed_profiles: orphanProfiles.length,
      released_lock_overflow: releasedLockOverflow,
      backup_files: backupStats.count,
      backup_bytes: backupStats.bytes,
      golden_backup_present: Boolean(backupStats.golden_backup_path),
      runtime_locks: lockCounts
    },
    orphan_counts: orphanCounts,
    foreign_key_failures: foreignKeyFailures.slice(0, 50),
    missing_profile_agents: missingProfileAgents.slice(0, 50),
    orphan_managed_profiles: orphanProfiles.slice(0, 50),
    can_repair: Boolean(
      orphanTotal ||
        orphanProfiles.length ||
        missingProfileAgents.some((agent) => agent.repairable) ||
        lockCounts.released ||
        lockCounts.stale ||
        lockCounts.failed
    ),
    last_report_path: ""
  };
  if (persist) {
    report.last_report_path = writeDataHealthReport(report);
  }
  return withDataRepairControl(report);
}

function getCachedDataHealthReport({ force = false } = {}) {
  if (!force && dataHealthCache.report && Date.now() - dataHealthCache.at < DATA_HEALTH_CACHE_MS) {
    return withDataRepairControl(dataHealthCache.report);
  }
  const report = buildDataHealthReport();
  dataHealthCache = { at: Date.now(), report };
  return withDataRepairControl(report);
}

function recordStartupDataHealth() {
  pruneTeamDatabaseBackups();
  const report = buildDataHealthReport({ persist: true });
  dataHealthCache = { at: Date.now(), report };
  if (report.status === "ok") return report;
  const workspace = get("SELECT * FROM workspaces ORDER BY created_at ASC LIMIT 1");
  const channel = workspace ? get("SELECT * FROM channels WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 1", [workspace.id]) : null;
  if (workspace && channel) {
    audit({
      workspaceId: workspace.id,
      channelId: channel.id,
      actorType: "system",
      action: "data_health_check",
      result: report.status === "critical" ? "blocked" : "warning",
      detail: summarizeDataHealth(report)
    });
  }
  return report;
}

function summarizeDataHealth(report) {
  if (!report || report.status === "ok") return "数据层正常";
  const parts = [];
  if (report.counts?.foreign_key_failures) parts.push(`${report.counts.foreign_key_failures} 个外键异常`);
  if (report.counts?.orphan_rows) parts.push(`${report.counts.orphan_rows} 条孤儿数据`);
  if (report.counts?.missing_profile_agents) parts.push(`${report.counts.missing_profile_agents} 个缺失 profile 的 Agent`);
  if (report.counts?.orphan_managed_profiles) parts.push(`${report.counts.orphan_managed_profiles} 个孤儿 HAT profile`);
  if (report.counts?.runtime_locks?.stale) parts.push(`${report.counts.runtime_locks.stale} 个 stale lock`);
  if (report.counts?.released_lock_overflow) parts.push(`${report.counts.runtime_locks.released} 个 released lock 堆积`);
  return parts.length ? parts.join("，") : "发现数据层风险";
}

function deleteAndCount(sql, params = []) {
  run(sql, params);
  return Math.max(0, Number(db.getRowsModified() || 0));
}

function repairDatabaseOrphans() {
  const deleted = {};
  deleted.agent_channels = deleteAndCount(
    `DELETE FROM agent_channels
     WHERE agent_id NOT IN (SELECT id FROM agents)
        OR channel_id NOT IN (SELECT id FROM channels)`
  );
  deleted.discussion_agents = deleteAndCount(
    `DELETE FROM discussion_agents
     WHERE discussion_id NOT IN (SELECT id FROM discussion_runs)
        OR agent_id NOT IN (SELECT id FROM agents)`
  );
  deleted.task_discussion_links = deleteAndCount(
    `DELETE FROM task_discussion_links
     WHERE workspace_id NOT IN (SELECT id FROM workspaces)
        OR channel_id NOT IN (SELECT id FROM channels)
        OR task_run_id NOT IN (SELECT id FROM task_runs)
        OR discussion_id NOT IN (SELECT id FROM discussion_runs)
        OR requester_agent_id NOT IN (SELECT id FROM agents)`
  );
  deleted.evidence_items = deleteAndCount(
    `DELETE FROM evidence_items
     WHERE workspace_id NOT IN (SELECT id FROM workspaces)
        OR channel_id NOT IN (SELECT id FROM channels)
        OR (task_run_id IS NOT NULL AND task_run_id NOT IN (SELECT id FROM task_runs))
        OR (agent_id IS NOT NULL AND agent_id NOT IN (SELECT id FROM agents))`
  );
  deleted.decision_records = deleteAndCount(
    `DELETE FROM decision_records
     WHERE workspace_id NOT IN (SELECT id FROM workspaces)
        OR channel_id NOT IN (SELECT id FROM channels)
        OR discussion_id NOT IN (SELECT id FROM discussion_runs)
        OR (created_by_agent_id IS NOT NULL AND created_by_agent_id NOT IN (SELECT id FROM agents))`
  );
  deleted.content_assets = deleteAndCount(
    `DELETE FROM content_assets
     WHERE workspace_id NOT IN (SELECT id FROM workspaces)
        OR (channel_id IS NOT NULL AND channel_id NOT IN (SELECT id FROM channels))
        OR (created_by_id IS NOT NULL AND created_by_id NOT IN (SELECT id FROM agents))`
  );
  deleted.message_attachments = deleteAndCount(
    `DELETE FROM message_attachments
     WHERE workspace_id NOT IN (SELECT id FROM workspaces)
        OR channel_id NOT IN (SELECT id FROM channels)
        OR message_id NOT IN (SELECT id FROM messages)`
  );
  deleted.blackboard_entries = deleteAndCount(
    `DELETE FROM blackboard_entries
     WHERE workspace_id NOT IN (SELECT id FROM workspaces)
        OR (channel_id IS NOT NULL AND channel_id NOT IN (SELECT id FROM channels))`
  );
  deleted.runtime_locks = deleteAndCount(
    `DELETE FROM runtime_locks
     WHERE workspace_id NOT IN (SELECT id FROM workspaces)
        OR (channel_id IS NOT NULL AND channel_id NOT IN (SELECT id FROM channels))
        OR status IN ('released', 'stale', 'failed', 'stopped')`
  );
  deleted.messages = deleteAndCount(
    `DELETE FROM messages
     WHERE workspace_id NOT IN (SELECT id FROM workspaces)
        OR channel_id NOT IN (SELECT id FROM channels)`
  );
  deleted.audits = deleteAndCount(
    `DELETE FROM audits
     WHERE workspace_id NOT IN (SELECT id FROM workspaces)
        OR (channel_id IS NOT NULL AND channel_id NOT IN (SELECT id FROM channels))`
  );
  deleted.task_runs = deleteAndCount(
    `DELETE FROM task_runs
     WHERE workspace_id NOT IN (SELECT id FROM workspaces)
        OR channel_id NOT IN (SELECT id FROM channels)
        OR primary_agent_id NOT IN (SELECT id FROM agents)`
  );
  deleted.discussion_runs = deleteAndCount(
    `DELETE FROM discussion_runs
     WHERE workspace_id NOT IN (SELECT id FROM workspaces)
        OR channel_id NOT IN (SELECT id FROM channels)
        OR (organizer_agent_id IS NOT NULL AND organizer_agent_id NOT IN (SELECT id FROM agents))`
  );
  deleted.agents = deleteAndCount("DELETE FROM agents WHERE workspace_id NOT IN (SELECT id FROM workspaces)");
  deleted.channels = deleteAndCount("DELETE FROM channels WHERE workspace_id NOT IN (SELECT id FROM workspaces)");
  return deleted;
}

function archiveOrphanManagedProfiles() {
  const archivedProfiles = [];
  const currentDbProfiles = dbManagedProfileNames();
  for (const profile of listManagedHermesProfiles()) {
    if (currentDbProfiles.has(profile.profileName)) continue;
    const archivedPath = archiveManagedProfile(profile.profileName, "data-repair");
    if (archivedPath) archivedProfiles.push({ profileName: profile.profileName, archivedPath });
  }
  return archivedProfiles;
}

function agentProfileConfig(agent) {
  return {
    name: agent.name,
    role: agent.role,
    description: agent.description,
    runtimeBackend: agentBackend(agent),
    coreCommand: agent.core_command || "",
    modelProvider: agent.model_provider || "",
    modelName: agent.model_name || "",
    agentKind: agent.agent_kind || "task"
  };
}

function missingManagedProfileAgents() {
  if (process.env.HAT_HERMES_MODE === "mock" && !process.env.HERMES_HOME) return [];
  return all(
    `SELECT *
     FROM agents
     WHERE owned_by_app = 1
       AND COALESCE(runtime_backend, 'hermes') = 'hermes'
       AND COALESCE(hermes_profile, '') != ''
     ORDER BY created_at ASC`
  ).filter((agent) => !fs.existsSync(hermesProfileDir(agent.hermes_profile)));
}

async function recreateMissingManagedProfiles() {
  const agents = missingManagedProfileAgents();
  const created = [];
  try {
    for (const agent of agents) {
      let nextProfileName = profileNameForAgent(agent.name);
      while (fs.existsSync(hermesProfileDir(nextProfileName))) {
        nextProfileName = profileNameForAgent(agent.name);
      }
      const config = agentProfileConfig(agent);
      await createHermesProfile(nextProfileName, `${agent.role}: ${agent.description || "Hermes Agent Team managed profile"}`, {
        agentConfig: config
      });
      const probeOutput = await probeHermesProfile(nextProfileName);
      if (!String(probeOutput).includes("HERMES_AGENT_READY")) {
        throw new Error(`Hermes profile 探针没有返回 READY：${String(probeOutput).slice(0, 400)}`);
      }
      created.push({ agent, previousProfileName: agent.hermes_profile, nextProfileName, config });
    }
  } catch (error) {
    for (const item of created) {
      await deleteOwnedHermesProfile(item.nextProfileName).catch(() => undefined);
    }
    throw error;
  }

  const restoredProfiles = [];
  for (const item of created) {
    run(
      `UPDATE agents
       SET hermes_profile = ?,
           status = 'ready',
           current_task = '',
           last_error = ''
       WHERE id = ?`,
      [item.nextProfileName, item.agent.id]
    );
    updateHermesProfileMarker(item.nextProfileName, {
      ...item.config,
      restoredFromMissingProfile: item.previousProfileName
    });
    audit({
      workspaceId: item.agent.workspace_id,
      channelId: get("SELECT id FROM channels WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 1", [
        item.agent.workspace_id
      ])?.id,
      actorType: "system",
      action: "restore_missing_profile",
      result: "allowed",
      detail: `已为 Agent ${item.agent.name} 重建缺失 Hermes profile：${item.previousProfileName} -> ${item.nextProfileName}`
    });
    restoredProfiles.push({
      agentId: item.agent.id,
      agentName: item.agent.name,
      previousProfileName: item.previousProfileName,
      profileName: item.nextProfileName
    });
  }
  return restoredProfiles;
}

async function repairDataHealth({
  cleanupProfiles = false,
  repairMode = "",
  actorType = "human",
  enforceCooldown = false
} = {}) {
  const mode = normalizeDataRepairMode({ repairMode, cleanupProfiles });
  assertDataRepairCanStart({ enforceCooldown: false });
  const before = buildDataHealthReport({ persist: true });
  const shouldRepairDatabase = dataRepairModeIncludesDatabase(mode) && reportHasDatabaseRepairRisk(before);
  const shouldRepairProfiles = dataRepairModeIncludesProfiles(mode) && reportHasProfileRepairRisk(before);
  if (enforceCooldown && shouldRepairDatabase) {
    const cooldownMs = dataRepairCooldownRemainingMs();
    if (cooldownMs > 0) {
      throw new Error(`数据修复冷却中，请 ${Math.ceil(cooldownMs / 1000)} 秒后再试。`);
    }
  }
  dataRepairInFlight = true;
  try {
    const backup = shouldRepairDatabase ? backupTeamDatabase("before-data-repair") : null;
    const backupPath = backup?.path || "";
    if (backupPath) verifySQLiteBackupFile(backupPath, "SQLite 修复前备份");
    const deleted = shouldRepairDatabase ? repairDatabaseOrphans() : {};
    const restoredProfiles = shouldRepairProfiles ? await recreateMissingManagedProfiles() : [];
    const archivedProfiles = shouldRepairProfiles ? archiveOrphanManagedProfiles() : [];
    saveDb();
    const after = buildDataHealthReport({ persist: true });
    dataHealthCache = { at: Date.now(), report: after };
    if (shouldRepairDatabase) {
      lastDataRepairAt = Date.now();
      writeDataSafetyState({ last_data_repair_at: new Date(lastDataRepairAt).toISOString() });
    }
    const result = {
      repaired_at: nowIso(),
      repair_mode: mode,
      backup_path: backupPath,
      backup_size_bytes: backup?.sizeBytes || 0,
      backup_quick_check: backup?.quickCheck || "",
      golden_backup_path: backup?.goldenBackupPath || currentGoldenBackupPath(),
      backup_rotation: backup?.rotation || null,
      cleanup_profiles: dataRepairModeIncludesProfiles(mode),
      before,
      after,
      deleted,
      restored_profiles: restoredProfiles,
      archived_profiles: archivedProfiles,
      profile_archive_dir: dataProfileArchiveDir()
    };
    const resultPath = path.join(dataHealthReportDir(), `data-repair-${governanceTimestamp()}.json`);
    safeWriteFileSync(resultPath, JSON.stringify(result, null, 2), "写入数据修复报告");
    const workspace = get("SELECT * FROM workspaces ORDER BY created_at ASC LIMIT 1");
    const channel = workspace ? get("SELECT * FROM channels WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 1", [workspace.id]) : null;
    if (workspace && channel) {
      audit({
        workspaceId: workspace.id,
        channelId: channel.id,
        actorType,
        action: "data_health_repair",
        result: "allowed",
        detail: `数据治理已完成：模式 ${mode}；备份 ${backupPath || "无"}；删除孤儿/旧锁 ${Object.values(deleted).reduce((sum, value) => sum + Number(value || 0), 0)} 条；重建 profile ${restoredProfiles.length} 个；归档 profile ${archivedProfiles.length} 个。`
      });
      insertMessage({
        workspaceId: workspace.id,
        channelId: channel.id,
        senderType: "system",
        senderName: "系统",
        mode: "system",
        content: `数据治理已完成。\n模式：${mode}\n备份：${backupPath || "无"}\n报告：${resultPath}\n清理数据：${Object.values(deleted).reduce((sum, value) => sum + Number(value || 0), 0)} 条\n重建 profile：${restoredProfiles.length} 个\n归档 profile：${archivedProfiles.length} 个`,
        status: "visible"
      });
    }
    saveDb();
    return result;
  } finally {
    dataRepairInFlight = false;
  }
}

function blackboardSchemaContract() {
  return {
    version: BLACKBOARD_SCHEMA_VERSION,
    fields: BLACKBOARD_SCHEMA_FIELDS,
    write_rules: [
      "facts only store verified observations or command-backed evidence",
      "assumptions must be marked as unverified until evidence upgrades them",
      "decisions are written by the Leader or system after synthesis",
      "risks must include an observable trigger or mitigation path",
      "open_questions are unresolved questions for Hayden or a named Agent",
      "locks identify resources or files that should not be concurrently changed",
      "outputs store verified deliverables and their evidence pointers"
    ],
    conflict_policy: "new writes append with source metadata; conflicting decisions require a Decision Record instead of overwriting silently",
    retention_policy: "keep the most recent 20 items per field in the prompt-facing structured state"
  };
}

function emptyStructuredBlackboard() {
  return BLACKBOARD_SCHEMA_FIELDS.reduce(
    (acc, field) => {
      acc[field] = [];
      return acc;
    },
    { version: BLACKBOARD_SCHEMA_VERSION }
  );
}

function runtimeLockTtlMs() {
  const minTtlMs = process.env.HAT_TEST_HOOKS === "1" ? 1000 : 30000;
  const configured = Number(process.env.HAT_RUNTIME_LOCK_TTL_MS || DEFAULT_RUNTIME_LOCK_TTL_MS);
  return Math.max(minTtlMs, Number.isFinite(configured) ? configured : DEFAULT_RUNTIME_LOCK_TTL_MS);
}

function runtimeLockGraceMs() {
  const minGraceMs = process.env.HAT_TEST_HOOKS === "1" ? 100 : 1000;
  const configured = Number(process.env.HAT_RUNTIME_LOCK_GRACE_MS || DEFAULT_RUNTIME_LOCK_GRACE_MS);
  const fallback = Math.min(DEFAULT_RUNTIME_LOCK_GRACE_MS, Math.max(5000, Math.floor(runtimeLockTtlMs() / 2)));
  return Math.max(minGraceMs, Number.isFinite(configured) ? configured : fallback);
}

function runtimeLockHeartbeatMs() {
  return Math.max(1000, Math.min(30000, Math.floor(runtimeLockTtlMs() / 3)));
}

function lockExpiresAt(ttlMs = runtimeLockTtlMs()) {
  return new Date(Date.now() + ttlMs).toISOString();
}

function lockGraceExpiresAt() {
  return new Date(Date.now() + runtimeLockGraceMs()).toISOString();
}

function taskLockSession(taskRunId) {
  return taskRunId ? `task:${taskRunId}` : "";
}

function discussionLockSession(discussionId) {
  return discussionId ? `discussion:${discussionId}` : "";
}

function taskLockResource(channelId) {
  return `channel:${channelId}:task-execution`;
}

function discussionLockResource(channelId) {
  return `channel:${channelId}:discussion`;
}

function replaceStructuredBlackboardField({ workspaceId, channelId = null, field, items, source = "system" }) {
  if (!workspaceId || !BLACKBOARD_SCHEMA_FIELDS.includes(field)) return;
  ensureBlackboardSchema(workspaceId, channelId);
  const state = readStructuredBlackboard(workspaceId);
  state[field] = Array.isArray(items) ? items.slice(-20) : [];
  upsertBlackboardEntry({
    workspaceId,
    channelId,
    key: BLACKBOARD_STATE_KEY,
    scope: "workspace",
    value: state,
    updatedByType: source === "human" ? "human" : source === "agent" ? "agent" : "system"
  });
}

function syncRuntimeLocksToBlackboard(workspaceId, channelId = null) {
  if (!workspaceId) return;
  const locks = all(
    `SELECT *
     FROM runtime_locks
     WHERE workspace_id = ? AND status IN ('active', 'suspect')
     ORDER BY acquired_at ASC
     LIMIT 20`,
    [workspaceId]
  );
  replaceStructuredBlackboardField({
    workspaceId,
    channelId,
    field: "locks",
    items: locks.map((lock) => ({
      text: `${lock.resource} locked by ${lock.owner_type}:${lock.owner_id}`,
      source: "system",
      metadata: {
        lockId: lock.id,
        resource: lock.resource,
        ownerType: lock.owner_type,
        ownerId: lock.owner_id,
        sessionId: lock.session_id,
        status: lock.status,
        suspectCount: Number(lock.suspect_count || 0),
        suspect_count: Number(lock.suspect_count || 0),
        lastSuspectAt: lock.last_suspect_at || null,
        last_suspect_at: lock.last_suspect_at || null,
        heartbeatAt: lock.heartbeat_at,
        expiresAt: lock.expires_at,
        reason: lock.reason
      },
      at: lock.heartbeat_at || lock.acquired_at
    })),
    source: "system"
  });
}

function noteRuntimeLockConflict({ workspaceId, channelId = null, resource, requestedOwner, existingLock }) {
  const detail = `运行时锁冲突：${resource} 已被 ${existingLock.owner_type}:${existingLock.owner_id} 占用，请求方 ${requestedOwner.ownerType}:${requestedOwner.ownerId} 被拒绝。`;
  appendStructuredBlackboard({
    workspaceId,
    channelId,
    field: "risks",
    text: detail,
    source: "system",
    metadata: {
      resource,
      requestedOwner,
      existingLockId: existingLock.id,
      existingSessionId: existingLock.session_id,
      expiresAt: existingLock.expires_at
    }
  });
  audit({
    workspaceId,
    channelId,
    actorType: "system",
    action: "runtime_lock_conflict",
    result: "blocked",
    detail
  });
}

function decayedRuntimeLockSuspectCount(lock, nowMs = Date.now()) {
  const previous = Number(lock?.suspect_count || 0);
  const lastSuspectAt = lock?.last_suspect_at ? new Date(lock.last_suspect_at).getTime() : 0;
  if (!lastSuspectAt || Number.isNaN(lastSuspectAt)) return previous;
  return nowMs - lastSuspectAt > RUNTIME_LOCK_SUSPECT_DECAY_MS ? 0 : previous;
}

function reapStaleRuntimeLocks(workspaceId = null, channelId = null) {
  const now = nowIso();
  const nowMs = Date.now();
  const params = workspaceId ? [now, workspaceId] : [now];
  const workspaceFilter = workspaceId ? "AND workspace_id = ?" : "";
  const expiredActiveLocks = all(
    `SELECT *
     FROM runtime_locks
     WHERE status = 'active' AND expires_at <= ?
       ${workspaceFilter}
     ORDER BY expires_at ASC`,
	    params
	  );
  const oscillationReapedLocks = [];
  for (const lock of expiredActiveLocks) {
    const baseSuspectCount = decayedRuntimeLockSuspectCount(lock, nowMs);
    const suspectCount = baseSuspectCount + 1;
    if (suspectCount > MAX_RUNTIME_LOCK_SUSPECT_COUNT) {
      run(
        `UPDATE runtime_locks
         SET status = 'stale',
           suspect_count = ?,
           last_suspect_at = ?,
           released_at = ?
         WHERE id = ?`,
        [suspectCount, now, now, lock.id]
      );
      const detail = `运行时锁 suspect 振荡超限，已强制回收：${lock.resource} / owner=${lock.owner_type}:${lock.owner_id} / session=${lock.session_id} / suspect=${suspectCount}`;
      appendStructuredBlackboard({
        workspaceId: lock.workspace_id,
        channelId: lock.channel_id || channelId,
        field: "risks",
        text: detail,
        source: "system",
        metadata: {
          lockId: lock.id,
          resource: lock.resource,
          ownerType: lock.owner_type,
          ownerId: lock.owner_id,
          sessionId: lock.session_id,
          suspectCount,
          maxSuspectCount: MAX_RUNTIME_LOCK_SUSPECT_COUNT
        }
      });
      audit({
        workspaceId: lock.workspace_id,
        channelId: lock.channel_id || channelId,
        actorType: "system",
        action: "runtime_lock_oscillation_reap",
        result: "allowed",
        detail
      });
      oscillationReapedLocks.push(lock);
      continue;
    }
    const suspectUntil = lockGraceExpiresAt();
    run(
      `UPDATE runtime_locks
         SET status = 'suspect',
         suspect_count = ?,
         last_suspect_at = ?,
         expires_at = ?
       WHERE id = ?`,
      [suspectCount, now, suspectUntil, lock.id]
    );
    const detail = `运行时锁进入怀疑态：${lock.resource} / owner=${lock.owner_type}:${lock.owner_id} / session=${lock.session_id}；suspect=${suspectCount}/${MAX_RUNTIME_LOCK_SUSPECT_COUNT}；宽限至 ${suspectUntil}`;
    appendStructuredBlackboard({
      workspaceId: lock.workspace_id,
      channelId: lock.channel_id || channelId,
      field: "risks",
      text: detail,
      source: "system",
      metadata: {
        lockId: lock.id,
        resource: lock.resource,
        ownerType: lock.owner_type,
        ownerId: lock.owner_id,
        sessionId: lock.session_id,
        expiredAt: lock.expires_at,
        suspectUntil,
        suspectCount,
        maxSuspectCount: MAX_RUNTIME_LOCK_SUSPECT_COUNT
      }
    });
    audit({
      workspaceId: lock.workspace_id,
      channelId: lock.channel_id || channelId,
      actorType: "system",
      action: "runtime_lock_suspect",
      result: "allowed",
      detail
    });
  }

  const reapableLocks = all(
    `SELECT *
     FROM runtime_locks
     WHERE status = 'suspect' AND expires_at <= ?
       ${workspaceFilter}
     ORDER BY expires_at ASC`,
    params
  );
  for (const lock of reapableLocks) {
    run(
      `UPDATE runtime_locks
       SET status = 'stale', released_at = ?
       WHERE id = ?`,
      [now, lock.id]
    );
    const detail = `运行时锁已过期回收：${lock.resource} / owner=${lock.owner_type}:${lock.owner_id} / session=${lock.session_id}`;
    appendStructuredBlackboard({
      workspaceId: lock.workspace_id,
      channelId: lock.channel_id || channelId,
      field: "risks",
      text: detail,
      source: "system",
      metadata: {
        lockId: lock.id,
        resource: lock.resource,
        ownerType: lock.owner_type,
        ownerId: lock.owner_id,
        sessionId: lock.session_id,
        expiredAt: lock.expires_at
      }
    });
    audit({
      workspaceId: lock.workspace_id,
      channelId: lock.channel_id || channelId,
      actorType: "system",
      action: "runtime_lock_reap",
      result: "allowed",
      detail
    });
  }
  const touchedLocks = [...expiredActiveLocks, ...reapableLocks, ...oscillationReapedLocks];
  const syncWorkspaceIds = new Set(touchedLocks.map((lock) => lock.workspace_id));
  if (workspaceId) syncWorkspaceIds.add(workspaceId);
  for (const id of syncWorkspaceIds) {
    syncRuntimeLocksToBlackboard(id, channelId);
  }
  if (touchedLocks.length > 0) saveDb();
  return reapableLocks.length + oscillationReapedLocks.length;
}

function acquireRuntimeLock({
  workspaceId,
  channelId = null,
  resource,
  ownerType,
  ownerId,
  sessionId,
  reason = "",
  ttlMs = runtimeLockTtlMs()
}) {
  if (!workspaceId || !resource || !ownerType || !ownerId || !sessionId) return null;
  reapStaleRuntimeLocks(workspaceId, channelId);
  const now = nowIso();
  const existing = get(
    `SELECT *
     FROM runtime_locks
     WHERE workspace_id = ? AND resource = ? AND status IN ('active', 'suspect')
     ORDER BY acquired_at ASC
     LIMIT 1`,
    [workspaceId, resource]
  );
  if (existing && existing.session_id !== sessionId) {
    noteRuntimeLockConflict({
      workspaceId,
      channelId,
      resource,
      requestedOwner: { ownerType, ownerId, sessionId },
      existingLock: existing
    });
    syncRuntimeLocksToBlackboard(workspaceId, channelId);
    saveDb();
    return null;
  }
  if (existing) {
    run(
      `UPDATE runtime_locks
       SET status = 'active',
         heartbeat_at = ?,
         expires_at = ?,
         released_at = NULL,
         reason = ?
       WHERE id = ?`,
      [now, lockExpiresAt(ttlMs), reason, existing.id]
    );
    syncRuntimeLocksToBlackboard(workspaceId, channelId);
    saveDb();
    return get("SELECT * FROM runtime_locks WHERE id = ?", [existing.id]);
  }

  const id = makeId("lock");
  run(
    `INSERT INTO runtime_locks
      (id, workspace_id, channel_id, resource, owner_type, owner_id, session_id, status, reason, suspect_count, acquired_at, heartbeat_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, 0, ?, ?, ?)`,
    [id, workspaceId, channelId, resource, ownerType, ownerId, sessionId, reason, now, now, lockExpiresAt(ttlMs)]
  );
  audit({
    workspaceId,
    channelId,
    actorType: "system",
    action: "runtime_lock_acquire",
    result: "allowed",
    detail: `已获取运行时锁：${resource} / owner=${ownerType}:${ownerId}`
  });
  syncRuntimeLocksToBlackboard(workspaceId, channelId);
  saveDb();
  return get("SELECT * FROM runtime_locks WHERE id = ?", [id]);
}

function heartbeatRuntimeLocks(sessionIds = []) {
  const ids = [...new Set(sessionIds.filter(Boolean))];
  if (ids.length === 0) return;
  const now = nowIso();
  for (const sessionId of ids) {
    run(
      `UPDATE runtime_locks
       SET status = 'active',
         heartbeat_at = ?,
         expires_at = ?,
         released_at = NULL
       WHERE session_id = ? AND status IN ('active', 'suspect')`,
      [now, lockExpiresAt(), sessionId]
    );
  }
  saveDb();
}

function heartbeatRuntimeLocksForRun(runtimeKey) {
  const activeRun = runtimeKey ? activeAgentRuns.get(runtimeKey) : null;
  if (!activeRun?.lockSessionIds?.length) return;
  heartbeatRuntimeLocks(activeRun.lockSessionIds);
}

function releaseRuntimeLocks({ sessionIds = [], ownerType = "", ownerId = "", status = "released" }) {
  const releasedAt = nowIso();
  const touched = [];
  for (const sessionId of [...new Set(sessionIds.filter(Boolean))]) {
    const locks = all("SELECT * FROM runtime_locks WHERE session_id = ? AND status IN ('active', 'suspect')", [
      sessionId
    ]);
    for (const lock of locks) {
      run(
        `UPDATE runtime_locks
         SET status = ?, released_at = ?
         WHERE id = ?`,
        [status, releasedAt, lock.id]
      );
      touched.push(lock);
    }
  }
  if (ownerType && ownerId) {
    const locks = all(
      "SELECT * FROM runtime_locks WHERE owner_type = ? AND owner_id = ? AND status IN ('active', 'suspect')",
      [ownerType, ownerId]
    );
    for (const lock of locks) {
      run(
        `UPDATE runtime_locks
         SET status = ?, released_at = ?
         WHERE id = ?`,
        [status, releasedAt, lock.id]
      );
      touched.push(lock);
    }
  }
  const touchedWorkspaces = new Map();
  for (const lock of touched) {
    touchedWorkspaces.set(lock.workspace_id, lock.channel_id || null);
  }
  for (const [workspaceId, channelId] of touchedWorkspaces) {
    syncRuntimeLocksToBlackboard(workspaceId, channelId);
  }
  if (touched.length > 0) saveDb();
  return touched.length;
}

function testRuntimeLockLifecycle(payload = {}) {
  if (process.env.HAT_TEST_HOOKS !== "1") {
    throw new Error("测试锁生命周期接口仅在 HAT_TEST_HOOKS=1 时可用。");
  }
  const workspaceId = String(payload.workspaceId || "").trim();
  const channelId = String(payload.channelId || "").trim() || null;
  if (!workspaceId) throw new Error("测试锁生命周期缺少 workspaceId。");
  const resource = `test:lock-lifecycle:${makeId("resource")}`;
  const ownerId = makeId("owner");
  const sessionId = makeId("session");
  const lock = acquireRuntimeLock({
    workspaceId,
    channelId,
    resource,
    ownerType: "test",
    ownerId,
    sessionId,
    reason: "Acceptance test runtime lock lifecycle",
    ttlMs: 1000
  });
  if (!lock) throw new Error("测试锁获取失败。");

  run("UPDATE runtime_locks SET expires_at = ? WHERE id = ?", [new Date(Date.now() - 1000).toISOString(), lock.id]);
  reapStaleRuntimeLocks(workspaceId, channelId);
  const suspect = get("SELECT * FROM runtime_locks WHERE id = ?", [lock.id]);

  heartbeatRuntimeLocks([sessionId]);
  const recovered = get("SELECT * FROM runtime_locks WHERE id = ?", [lock.id]);

  run("UPDATE runtime_locks SET status = 'active', expires_at = ? WHERE id = ?", [
    new Date(Date.now() - 1000).toISOString(),
    lock.id
  ]);
  reapStaleRuntimeLocks(workspaceId, channelId);
  const suspectAgain = get("SELECT * FROM runtime_locks WHERE id = ?", [lock.id]);

  run("UPDATE runtime_locks SET expires_at = ? WHERE id = ?", [new Date(Date.now() - 1000).toISOString(), lock.id]);
  reapStaleRuntimeLocks(workspaceId, channelId);
  const reaped = get("SELECT * FROM runtime_locks WHERE id = ?", [lock.id]);
  const riskCount = get(
    "SELECT COUNT(*) AS count FROM audits WHERE workspace_id = ? AND action IN ('runtime_lock_suspect', 'runtime_lock_reap')",
    [workspaceId]
  ).count;
  return {
    lockId: lock.id,
    resource,
    statuses: [lock.status, suspect?.status, recovered?.status, suspectAgain?.status, reaped?.status],
    riskCount
  };
}

function testTaskDiscussionBridgeReliability(payload = {}) {
  if (process.env.HAT_TEST_HOOKS !== "1") {
    throw new Error("测试桥接可靠性接口仅在 HAT_TEST_HOOKS=1 时可用。");
  }
  const workspaceId = String(payload.workspaceId || "").trim();
  const channelId = String(payload.channelId || "").trim();
  if (!workspaceId || !channelId) throw new Error("测试桥接可靠性缺少 workspaceId 或 channelId。");
  const agent =
    (payload.primaryAgentId && get("SELECT * FROM agents WHERE id = ? AND workspace_id = ?", [payload.primaryAgentId, workspaceId])) ||
    get("SELECT * FROM agents WHERE workspace_id = ? AND agent_kind = 'task' AND is_primary = 1 LIMIT 1", [workspaceId]);
  if (!agent) throw new Error("测试桥接可靠性缺少任务主 Agent。");

  const taskRunId = makeId("task");
  const discussionId = makeId("discussion");
  const linkId = makeId("tdlink");
  const createdAt = nowIso();
  run(
    `INSERT INTO task_runs
      (id, workspace_id, channel_id, primary_agent_id, status, objective, created_at)
     VALUES (?, ?, ?, ?, 'waiting_discussion', ?, ?)`,
    [taskRunId, workspaceId, channelId, agent.id, "WAITING_DISCUSSION_TIMEOUT_CHECK", createdAt]
  );
  run(
    `INSERT INTO discussion_runs
      (id, workspace_id, channel_id, topic, status, discussion_framework, organizer_status, round_limit, created_at)
     VALUES (?, ?, ?, ?, 'active', 'balanced_decision', 'test_waiting', 1, ?)`,
    [discussionId, workspaceId, channelId, "WAITING_DISCUSSION_TIMEOUT_CHECK", createdAt]
  );
  const taskRun = getTaskRun(taskRunId);
  const action = {
    topic: "WAITING_DISCUSSION_TIMEOUT_CHECK",
    problem: "讨论模块没有在 TTL 内回传结果。",
    failed_command: "npm run acceptance:dev",
    error_output: "waitFor timed out while waiting discussion help",
    attempted: "已尝试等待讨论 Leader 输出 Decision Record。",
    file_paths: [dbFilePath].filter(Boolean)
  };
  const requestText = discussionHelpTopic({ taskRun, agent, action });
  const snapshot = captureExecutionSnapshot({ taskRun, agent, action, requestText });
  const fingerprint = blockFingerprintFromSnapshot(snapshot);
  run(
    `INSERT INTO task_discussion_links
      (id, workspace_id, channel_id, task_run_id, discussion_id, requester_agent_id, status, request_text, execution_snapshot, wait_started_at, expires_at, block_fingerprint, discuss_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, 1, ?)`,
    [
      linkId,
      workspaceId,
      channelId,
      taskRunId,
      discussionId,
      agent.id,
      requestText,
      JSON.stringify(snapshot),
      createdAt,
      new Date(Date.now() - 1000).toISOString(),
      fingerprint,
      createdAt
    ]
  );
  const timedOutCount = reapWaitingDiscussionLinks(workspaceId, channelId);
  const timedOutLink = get("SELECT * FROM task_discussion_links WHERE id = ?", [linkId]);
  const timedOutTask = getTaskRun(taskRunId);
  const timeoutEvidence = get("SELECT * FROM evidence_items WHERE task_run_id = ? AND kind = 'discussion_help_timeout'", [
    taskRunId
  ]);

  const driftSnapshot = {
    ...snapshot,
    file_hashes: {
      ...(snapshot.file_hashes || {}),
      [dbFilePath || path.join(dataDir(), "team.sqlite")]: "definitely-old-hash"
    }
  };
  const drift = validateExecutionDrift(driftSnapshot);
  const duplicate = previousDiscussionHelpWithFingerprint(taskRunId, fingerprint);
  const countLimitWouldBlock = discussionHelpCount(taskRunId) + MAX_TASK_DISCUSSION_HELP_COUNT > MAX_TASK_DISCUSSION_HELP_COUNT;

  return {
    timedOutCount,
    taskStatus: timedOutTask?.status || "",
    taskFinalOutput: timedOutTask?.final_output || "",
    linkStatus: timedOutLink?.status || "",
    timeoutEvidence: Boolean(timeoutEvidence),
    driftDetected: drift.drifted,
    driftChanges: drift.changes,
    duplicateBlocked: Boolean(duplicate),
    blockFingerprint: fingerprint,
    discussCount: Number(timedOutLink?.discuss_count || 0),
    countLimitWouldBlock
  };
}

function testReliabilityClosure(payload = {}) {
  if (process.env.HAT_TEST_HOOKS !== "1") {
    throw new Error("测试可靠性收尾接口仅在 HAT_TEST_HOOKS=1 时可用。");
  }
  const workspaceId = String(payload.workspaceId || "").trim();
  const channelId = String(payload.channelId || "").trim();
  if (!workspaceId || !channelId) throw new Error("测试可靠性收尾缺少 workspaceId/channelId。");
  const primaryAgent =
    get("SELECT * FROM agents WHERE id = ?", [payload.primaryAgentId]) ||
    get("SELECT * FROM agents WHERE workspace_id = ? AND agent_kind = 'task' ORDER BY is_primary DESC LIMIT 1", [
      workspaceId
    ]) || { id: null, name: "测试 Agent" };

  const lockSessionId = makeId("session");
  const lock = acquireRuntimeLock({
    workspaceId,
    channelId,
    resource: `test:lock-oscillation:${makeId("resource")}`,
    ownerType: "test",
    ownerId: makeId("owner"),
    sessionId: lockSessionId,
    reason: "Acceptance test lock oscillation",
    ttlMs: 1000
  });
  const lockStatuses = [lock?.status || ""];
  for (let index = 0; index < MAX_RUNTIME_LOCK_SUSPECT_COUNT; index += 1) {
    run("UPDATE runtime_locks SET status = 'active', expires_at = ? WHERE id = ?", [
      new Date(Date.now() - 1000).toISOString(),
      lock.id
    ]);
    reapStaleRuntimeLocks(workspaceId, channelId);
    lockStatuses.push(get("SELECT status FROM runtime_locks WHERE id = ?", [lock.id])?.status || "");
    heartbeatRuntimeLocks([lockSessionId]);
    lockStatuses.push(get("SELECT status FROM runtime_locks WHERE id = ?", [lock.id])?.status || "");
  }
  run("UPDATE runtime_locks SET status = 'active', expires_at = ? WHERE id = ?", [
    new Date(Date.now() - 1000).toISOString(),
    lock.id
  ]);
  reapStaleRuntimeLocks(workspaceId, channelId);
  const oscillationLock = get("SELECT * FROM runtime_locks WHERE id = ?", [lock.id]);

  const decaySessionId = makeId("session");
  const decayLock = acquireRuntimeLock({
    workspaceId,
    channelId,
    resource: `test:lock-decay:${makeId("resource")}`,
    ownerType: "test",
    ownerId: makeId("owner"),
    sessionId: decaySessionId,
    reason: "Acceptance test lock suspect decay",
    ttlMs: 1000
  });
  run(
    "UPDATE runtime_locks SET suspect_count = ?, last_suspect_at = ?, expires_at = ? WHERE id = ?",
    [
      MAX_RUNTIME_LOCK_SUSPECT_COUNT,
      new Date(Date.now() - RUNTIME_LOCK_SUSPECT_DECAY_MS - 1000).toISOString(),
      new Date(Date.now() - 1000).toISOString(),
      decayLock.id
    ]
  );
  reapStaleRuntimeLocks(workspaceId, channelId);
  const decayedLock = get("SELECT * FROM runtime_locks WHERE id = ?", [decayLock.id]);
  const decayedStatus = decayedLock?.status || "";
  const decayedSuspectCount = Number(decayedLock?.suspect_count || 0);
  releaseRuntimeLocks({
    workspaceId,
    channelId,
    ownerType: "test",
    ownerId: decayLock.owner_id,
    sessionIds: [decaySessionId],
    result: "allowed",
    detail: "Acceptance test lock suspect decay complete"
  });

  const snapshotTask = {
    id: makeId("task"),
    objective: "SNAPSHOT_IO_TRIM_CHECK"
  };
  const hugeSnapshot = captureExecutionSnapshot({
    taskRun: snapshotTask,
    agent: primaryAgent,
    action: {
      current_stage: "large snapshot",
      failed_command: "npm run acceptance:dev",
      error_output: `Error: shared traceback head\n${"node_modules/internal.js:1\n".repeat(800)}src/App.tsx:1889\n${"x".repeat(90000)}`,
      file_paths: ["node_modules/pkg/index.js", "electron/main.cjs"],
      attempted: "read large tree\n".repeat(2000),
      needed_output: "bounded snapshot"
    },
    requestText: "snapshot must stay small"
  });
  const snapshotBytes = jsonByteLength(hugeSnapshot);

  const actionTaskId = makeId("task");
  run(
    `INSERT INTO task_runs
      (id, workspace_id, channel_id, primary_agent_id, status, objective, final_output, created_at)
     VALUES (?, ?, ?, ?, 'awaiting_confirmation', 'SANDBOX_QUICK_ACTION_CHECK 修改 Electron runtime', '', ?)`,
    [actionTaskId, workspaceId, channelId, primaryAgent.id, nowIso()]
  );
  const sandbox = prepareTaskExecutionSandbox({
    workspaceId,
    channelId,
    taskRunId: actionTaskId,
    objective: "SANDBOX_QUICK_ACTION_CHECK 修改 Electron runtime",
    primaryAgentId: primaryAgent.id
  });
  runSandboxQuickAction({ taskRunId: actionTaskId, action: "takeover" });
  const takeoverEvidence = get(
    "SELECT * FROM evidence_items WHERE task_run_id = ? AND kind = 'execution_sandbox_action' AND title LIKE '%接管%'",
    [actionTaskId]
  );
  runSandboxQuickAction({ taskRunId: actionTaskId, action: "copy_command" });
  const copyCommandEvidence = get(
    "SELECT * FROM evidence_items WHERE task_run_id = ? AND kind = 'execution_sandbox_action' AND title LIKE '%复制命令%'",
    [actionTaskId]
  );

  const exemptTaskId = makeId("task");
  run(
    `INSERT INTO task_runs
      (id, workspace_id, channel_id, primary_agent_id, status, objective, final_output, created_at)
     VALUES (?, ?, ?, ?, 'awaiting_confirmation', 'SANDBOX_GC_EXEMPT_CHECK 修改 Electron runtime', '', ?)`,
    [exemptTaskId, workspaceId, channelId, primaryAgent.id, nowIso()]
  );
  const exemptSandbox = prepareTaskExecutionSandbox({
    workspaceId,
    channelId,
    taskRunId: exemptTaskId,
    objective: "SANDBOX_GC_EXEMPT_CHECK 修改 Electron runtime",
    primaryAgentId: primaryAgent.id
  });
  const oldExemptDate = new Date(Date.now() - TASK_SANDBOX_PRUNE_AGE_MS - 5000);
  fs.utimesSync(exemptSandbox.sandboxPath, oldExemptDate, oldExemptDate);
  const exemptGcSummary = pruneTaskSandboxes({ maxAgeMs: 1000 });
  const exemptPreserved = fs.existsSync(exemptSandbox.sandboxPath);

  const gcTaskId = makeId("task");
  run(
    `INSERT INTO task_runs
      (id, workspace_id, channel_id, primary_agent_id, status, objective, final_output, created_at, completed_at)
     VALUES (?, ?, ?, ?, 'failed', 'SANDBOX_GC_CHECK 修改 Electron runtime', '', ?, ?)`,
    [gcTaskId, workspaceId, channelId, primaryAgent.id, nowIso(), nowIso()]
  );
  const gcSandbox = prepareTaskExecutionSandbox({
    workspaceId,
    channelId,
    taskRunId: gcTaskId,
    objective: "SANDBOX_GC_CHECK 修改 Electron runtime",
    primaryAgentId: primaryAgent.id
  });
  const oldDate = new Date(Date.now() - TASK_SANDBOX_PRUNE_AGE_MS - 5000);
  fs.utimesSync(gcSandbox.sandboxPath, oldDate, oldDate);
  const gcSummary = pruneTaskSandboxes({ maxAgeMs: 1000 });

  return {
    oscillationStatus: oscillationLock?.status || "",
    oscillationSuspectCount: Number(oscillationLock?.suspect_count || 0),
    decayedStatus,
    decayedSuspectCount,
    lockStatuses,
    snapshotBytes,
    snapshotWithinLimit: snapshotBytes <= MAX_EXECUTION_SNAPSHOT_BYTES,
    snapshotExcludedNodeModules: !(hugeSnapshot.file_paths || []).some((filePath) =>
      String(filePath).includes("node_modules")
    ),
    snapshotMeta: hugeSnapshot.snapshot_meta || null,
    takeoverEvidence: Boolean(takeoverEvidence),
    copyCommandEvidence: Boolean(copyCommandEvidence),
    quickActions: parseJsonObject(latestSandboxEvidence(actionTaskId)?.metadata_json, {}).quickActions || [],
    gcExemptPreserved: exemptPreserved,
    gcExemptSkipped: exemptGcSummary.skippedActive >= 1,
    gcPruned: gcSummary.pruned,
    gcPathRemoved: !fs.existsSync(gcSandbox.sandboxPath),
    sandboxPath: sandbox.sandboxPath
  };
}

async function testDataGovernance(payload = {}) {
  if (process.env.HAT_TEST_HOOKS !== "1") {
    throw new Error("测试数据治理接口仅在 HAT_TEST_HOOKS=1 时可用。");
  }
  const workspaceId = String(payload.workspaceId || "").trim();
  const channelId = String(payload.channelId || "").trim();
  if (!workspaceId || !channelId) throw new Error("测试数据治理缺少 workspaceId/channelId。");
  const ghostWorkspaceId = makeId("ghost_ws");
  const ghostChannelId = makeId("ghost_ch");
  const ghostAgentId = makeId("ghost_agent");
  const ghostProfile = `${makeId("hatghost")}`.replace(/_/g, "").slice(0, 30);
  db.run("PRAGMA foreign_keys = OFF");
  run("INSERT INTO channels (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)", [
    ghostChannelId,
    ghostWorkspaceId,
    "orphan channel",
    nowIso()
  ]);
  run(
    `INSERT INTO agents
      (id, workspace_id, name, role, description, core_command, model_provider, model_name, parent_agent_id, hermes_profile, is_primary, owned_by_app, agent_kind, status, is_temporary, task_run_id, created_by_agent_id, created_at)
     VALUES (?, ?, 'orphan agent', 'orphan', '', '', '', '', NULL, ?, 0, 1, 'task', 'ready', 0, NULL, NULL, ?)`,
    [ghostAgentId, ghostWorkspaceId, ghostProfile, nowIso()]
  );
  run(
    "INSERT INTO messages (id, workspace_id, channel_id, sender_type, sender_id, sender_name, mode, target_agent_id, content, status, created_at) VALUES (?, ?, ?, 'agent', ?, 'orphan agent', 'task', NULL, 'orphan message', 'visible', ?)",
    [makeId("msg"), ghostWorkspaceId, ghostChannelId, ghostAgentId, nowIso()]
  );
  run(
    "INSERT INTO audits (id, workspace_id, channel_id, actor_type, actor_id, action, result, detail, created_at) VALUES (?, ?, ?, 'system', NULL, 'orphan_test', 'allowed', 'orphan audit', ?)",
    [makeId("audit"), ghostWorkspaceId, ghostChannelId, nowIso()]
  );
  run(
    `INSERT INTO runtime_locks
      (id, workspace_id, channel_id, resource, owner_type, owner_id, session_id, status, reason, suspect_count, acquired_at, heartbeat_at, expires_at)
     VALUES (?, ?, ?, 'orphan:resource', 'test', ?, ?, 'released', 'orphan test', 0, ?, ?, ?)`,
    [makeId("lock"), ghostWorkspaceId, ghostChannelId, ghostAgentId, makeId("session"), nowIso(), nowIso(), nowIso()]
  );
  db.run("PRAGMA foreign_keys = ON");
  saveDb();
  const before = buildDataHealthReport({ persist: true });
  const repair = await repairDataHealth({ repairMode: "database", actorType: "system" });
  const after = buildDataHealthReport({ persist: true });
  const repairBackupExists = Boolean(repair.backup_path && fs.existsSync(repair.backup_path));
  const emptyBackupPath = path.join(dataBackupDir(), `empty-backup-${makeId("backup")}.sqlite`);
  safeWriteFileSync(emptyBackupPath, "", "写入空备份测试文件");
  let backupIntegrityRejected = false;
  try {
    verifySQLiteBackupFile(emptyBackupPath, "空备份测试文件");
  } catch {
    backupIntegrityRejected = true;
  } finally {
    safeRemovePath(emptyBackupPath);
  }
  const corruptBackupPath = path.join(dataBackupDir(), `corrupt-backup-${makeId("backup")}.sqlite`);
  safeWriteFileSync(corruptBackupPath, "not a sqlite database", "写入损坏备份测试文件");
  let sqliteConnectionRejected = false;
  try {
    verifySQLiteBackupFile(corruptBackupPath, "损坏备份测试文件");
  } catch {
    sqliteConnectionRejected = true;
  } finally {
    safeRemovePath(corruptBackupPath);
  }
  for (let index = 0; index < DATA_BACKUP_RETENTION_COUNT + 3; index += 1) {
    backupTeamDatabase("retention-check");
  }
  const backupsAfterRotation = listTeamDatabaseBackups();
  const goldenBackupPath = currentGoldenBackupPath();
  let repairCooldownBlocked = false;
  try {
    assertDataRepairCanStart({ enforceCooldown: true });
  } catch {
    repairCooldownBlocked = true;
  }
  const originalLastDataRepairAt = lastDataRepairAt;
  lastDataRepairAt = 0;
  let persistedCooldownBlocked = false;
  try {
    assertDataRepairCanStart({ enforceCooldown: true });
  } catch {
    persistedCooldownBlocked = true;
  } finally {
    lastDataRepairAt = originalLastDataRepairAt;
  }
  const diskFullMessage = dataSafetyError({ code: "ENOSPC", message: "no space left" }, "测试写盘").message;
  const profileArchiveDir = dataProfileArchiveDir();
  return {
    beforeStatus: before.status,
    beforeOrphanRows: before.counts.orphan_rows,
    beforeForeignKeyFailures: before.counts.foreign_key_failures,
    afterStatus: after.status,
    afterOrphanRows: after.counts.orphan_rows,
    afterForeignKeyFailures: after.counts.foreign_key_failures,
    repairMode: repair.repair_mode,
    backupPath: repair.backup_path,
    backupSizeBytes: repair.backup_size_bytes,
    backupQuickCheck: repair.backup_quick_check,
    backupExists: repairBackupExists,
    backupRetentionCount: backupsAfterRotation.length,
    backupRetentionLimit: DATA_BACKUP_RETENTION_COUNT,
    backupRetentionOk: backupsAfterRotation.length <= DATA_BACKUP_RETENTION_COUNT,
    goldenBackupPath,
    goldenBackupExists: Boolean(goldenBackupPath && fs.existsSync(goldenBackupPath)),
    backupIntegrityRejected,
    sqliteConnectionRejected,
    repairCooldownBlocked,
    persistedCooldownBlocked,
    diskFullMessage,
    deletedTotal: Object.values(repair.deleted).reduce((sum, value) => sum + Number(value || 0), 0),
    profileArchiveDir,
    profileArchiveDirExists: fs.existsSync(profileArchiveDir),
    reportPath: repair.after.last_report_path
  };
}

function readStructuredBlackboard(workspaceId) {
  const existing = get("SELECT value FROM blackboard_entries WHERE workspace_id = ? AND key = ?", [
    workspaceId,
    BLACKBOARD_STATE_KEY
  ]);
  const parsed = parseJsonObject(existing?.value, emptyStructuredBlackboard());
  const state = emptyStructuredBlackboard();
  for (const field of BLACKBOARD_SCHEMA_FIELDS) {
    state[field] = Array.isArray(parsed[field]) ? parsed[field].slice(-20) : [];
  }
  return state;
}

function ensureBlackboardSchema(workspaceId, channelId = null) {
  if (!workspaceId) return;
  upsertBlackboardEntry({
    workspaceId,
    channelId,
    key: BLACKBOARD_SCHEMA_KEY,
    scope: "workspace",
    value: blackboardSchemaContract(),
    updatedByType: "system"
  });
  if (!get("SELECT id FROM blackboard_entries WHERE workspace_id = ? AND key = ?", [workspaceId, BLACKBOARD_STATE_KEY])) {
    upsertBlackboardEntry({
      workspaceId,
      channelId,
      key: BLACKBOARD_STATE_KEY,
      scope: "workspace",
      value: emptyStructuredBlackboard(),
      updatedByType: "system"
    });
  }
}

function appendStructuredBlackboard({ workspaceId, channelId = null, field, text, source = "system", metadata = {} }) {
  if (!workspaceId || !BLACKBOARD_SCHEMA_FIELDS.includes(field)) return;
  ensureBlackboardSchema(workspaceId, channelId);
  const state = readStructuredBlackboard(workspaceId);
  state[field] = [
    ...(Array.isArray(state[field]) ? state[field] : []),
    {
      text: compactText(text, 500),
      source,
      metadata,
      at: nowIso()
    }
  ].slice(-20);
  upsertBlackboardEntry({
    workspaceId,
    channelId,
    key: BLACKBOARD_STATE_KEY,
    scope: "workspace",
    value: state,
    updatedByType: source === "human" ? "human" : source === "agent" ? "agent" : "system",
    updatedById: metadata.agentId || null
  });
}

function blackboardSchemaPrompt() {
  return [
    `Blackboard schema v${BLACKBOARD_SCHEMA_VERSION}:`,
    "- facts: verified observations and command-backed evidence only.",
    "- assumptions: unverified beliefs, each kept separate from facts.",
    "- decisions: synthesized choices that should survive the chat stream.",
    "- risks: failure paths with trigger or mitigation.",
    "- open_questions: unresolved questions for Hayden or a named Agent.",
    "- locks: resources, files, or work areas that must avoid concurrent writes.",
    "- outputs: verified deliverables with evidence pointers.",
    "Write rule: do not overwrite a conflicting conclusion silently; escalate it into a Decision Record or explicit risk."
  ].join("\n");
}

function clampDiscussionRoundLimit(value) {
  return Math.max(DEFAULT_DISCUSSION_ROUNDS, Math.min(MAX_DISCUSSION_ROUNDS, Number(value || DEFAULT_DISCUSSION_ROUNDS)));
}

function remainingDiscussionRounds(discussion, requested = 1) {
  const currentLimit = Math.max(DEFAULT_DISCUSSION_ROUNDS, Number(discussion?.round_limit || DEFAULT_DISCUSSION_ROUNDS));
  return Math.max(0, Math.min(Number(requested || 1), MAX_DISCUSSION_ROUNDS - currentLimit));
}

function teamStateDir() {
  const dir = path.join(dataDir(), "team_state");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function teamStateFilePath(workspaceId) {
  return workspaceId ? path.join(teamStateDir(), `${workspaceId}.json`) : "";
}

function contentArchiveDir() {
  const dir = path.join(dataDir(), "content_archive");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function contentArchiveFilePath(workspaceId) {
  return workspaceId ? path.join(contentArchiveDir(), `${workspaceId}.json`) : "";
}

function taskSandboxRoot() {
  const dir = path.join(dataDir(), "task_sandboxes");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function taskExecutionSandboxPath(taskRunId) {
  return taskRunId ? path.join(taskSandboxRoot(), taskRunId) : "";
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function safeRemovePath(targetPath) {
  if (!targetPath) return false;
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function pruneTaskSandboxes({ maxAgeMs = TASK_SANDBOX_PRUNE_AGE_MS, force = false } = {}) {
  const root = taskSandboxRoot();
  const nowMs = Date.now();
  const summary = {
    scanned: 0,
    pruned: 0,
    skippedActive: 0,
    failed: 0,
    paths: []
  };
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return summary;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sandboxPath = path.join(root, entry.name);
    if (!isPathInside(root, sandboxPath)) continue;
    summary.scanned += 1;
    let stat;
    try {
      stat = fs.statSync(sandboxPath);
    } catch {
      summary.failed += 1;
      continue;
    }
    const ageMs = nowMs - stat.mtimeMs;
    if (!force && ageMs < maxAgeMs) continue;
    const taskRun = get("SELECT * FROM task_runs WHERE id = ?", [entry.name]);
    const hasGcExemptTask = taskRun && SANDBOX_GC_EXEMPT_TASK_STATUSES.has(taskRun.status);
    const hasActiveLock = Boolean(
      get(
        "SELECT 1 AS found FROM runtime_locks WHERE owner_id = ? AND status IN ('active', 'suspect') LIMIT 1",
        [entry.name]
      )
    );
    if (!force && (hasGcExemptTask || hasActiveLock)) {
      summary.skippedActive += 1;
      continue;
    }

    const worktreePath = path.join(sandboxPath, "worktree");
    if (fs.existsSync(worktreePath)) {
      safeExecGit(["worktree", "remove", "--force", worktreePath]);
      safeRemovePath(worktreePath);
    }
    const removed = safeRemovePath(sandboxPath);
    if (!removed) {
      summary.failed += 1;
      continue;
    }
    summary.pruned += 1;
    summary.paths.push(sandboxPath);
    if (taskRun) {
      addEvidenceItem({
        workspaceId: taskRun.workspace_id,
        channelId: taskRun.channel_id,
        taskRunId: taskRun.id,
        agentId: taskRun.primary_agent_id,
        kind: "execution_sandbox_gc",
        title: "执行沙箱自动回收",
        content: `已回收超过 ${Math.round(maxAgeMs / 3600000)} 小时未活动的执行沙箱：${sandboxPath}`,
        metadata: { sandboxPath, ageMs, force: Boolean(force) }
      });
      audit({
        workspaceId: taskRun.workspace_id,
        channelId: taskRun.channel_id,
        actorType: "system",
        action: "execution_sandbox_gc",
        result: "allowed",
        detail: `已回收执行沙箱：${sandboxPath}`
      });
    }
  }
  if (summary.pruned > 0) saveDb();
  return summary;
}

function maybePruneTaskSandboxes() {
  if (Date.now() - lastSandboxPruneAt < TASK_SANDBOX_PRUNE_INTERVAL_MS) return;
  lastSandboxPruneAt = Date.now();
  pruneTaskSandboxes();
}

function taskDiscussionWaitMs() {
  const minWaitMs = process.env.HAT_TEST_HOOKS === "1" ? 1000 : 30000;
  const configured = Number(process.env.HAT_TASK_DISCUSSION_WAIT_MS || DEFAULT_TASK_DISCUSSION_WAIT_MS);
  return Math.max(minWaitMs, Number.isFinite(configured) ? configured : DEFAULT_TASK_DISCUSSION_WAIT_MS);
}

function taskDiscussionExpiresAt(waitMs = taskDiscussionWaitMs()) {
  return new Date(Date.now() + waitMs).toISOString();
}

function safeExecGit(args) {
  try {
    return execFileSync("git", args, {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}

function currentGitSnapshot() {
  const inside = safeExecGit(["rev-parse", "--is-inside-work-tree"]) === "true";
  if (!inside) {
    return {
      inside: false,
      head: "",
      branch: "",
      dirtyStatus: "",
      dirtyHash: ""
    };
  }
  const dirtyStatus = safeExecGit(["status", "--porcelain=v1"]);
  return {
    inside: true,
    head: safeExecGit(["rev-parse", "HEAD"]),
    branch: safeExecGit(["branch", "--show-current"]) || safeExecGit(["rev-parse", "--abbrev-ref", "HEAD"]),
    dirtyStatus: compactText(dirtyStatus, 1200),
    dirtyHash: crypto.createHash("sha256").update(dirtyStatus).digest("hex")
  };
}

function normalizePossiblePath(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 500) return "";
  const withoutQuotes = raw.replace(/^["'`]+|["'`]+$/g, "");
  if (withoutQuotes.startsWith("~")) return path.join(os.homedir(), withoutQuotes.slice(1));
  return path.isAbsolute(withoutQuotes) ? withoutQuotes : path.resolve(process.cwd(), withoutQuotes);
}

function snapshotPathAllowed(filePath) {
  const normalized = path.normalize(String(filePath || ""));
  if (!normalized) return false;
  const segments = normalized.split(path.sep).filter(Boolean);
  return !segments.some((segment) => SNAPSHOT_EXCLUDED_PATH_SEGMENTS.has(segment));
}

function extractActionFilePaths(action = {}) {
  const values = [];
  for (const key of ["file_path", "file", "path", "target_path"]) {
    if (action[key]) values.push(action[key]);
  }
  for (const key of ["file_paths", "files", "paths", "related_files"]) {
    if (Array.isArray(action[key])) values.push(...action[key]);
    else if (typeof action[key] === "string") values.push(...action[key].split(/[,;\n]/));
  }
  const text = [action.problem, action.error, action.error_output, action.terminal_output, action.attempted, action.context]
    .filter(Boolean)
    .join("\n");
  for (const match of text.matchAll(/(?:^|[\s`'"])([./~\w-][^`'"\n:]*\.(?:js|cjs|mjs|ts|tsx|json|md|css|yml|yaml|toml|txt|py|sh|html|sql))/gi)) {
    values.push(match[1]);
  }
  return [...new Set(values.map(normalizePossiblePath).filter(snapshotPathAllowed))].slice(0, 12);
}

function hashFileIfReadable(filePath) {
  try {
    if (!snapshotPathAllowed(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_SNAPSHOT_FILE_BYTES) return null;
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

function jsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function pickFileHashes(fileHashes, allowedPaths) {
  const allowed = new Set(allowedPaths);
  return Object.fromEntries(Object.entries(fileHashes || {}).filter(([filePath]) => allowed.has(filePath)));
}

function clampExecutionSnapshot(snapshot) {
  const withMeta = {
    ...snapshot,
    snapshot_meta: {
      max_bytes: MAX_EXECUTION_SNAPSHOT_BYTES,
      excluded_path_segments: [...SNAPSHOT_EXCLUDED_PATH_SEGMENTS],
      max_file_bytes: MAX_SNAPSHOT_FILE_BYTES,
      truncated: false
    }
  };
  if (jsonByteLength(withMeta) <= MAX_EXECUTION_SNAPSHOT_BYTES) {
    withMeta.snapshot_meta.bytes = jsonByteLength(withMeta);
    return withMeta;
  }
  const filePaths = Array.isArray(snapshot.file_paths) ? snapshot.file_paths.slice(0, 6) : [];
  const slim = {
    ...snapshot,
    objective: compactText(snapshot.objective, 900),
    blocker: compactText(snapshot.blocker, 600),
    terminal_output_summary: compactText(snapshot.terminal_output_summary, 600),
    attempted: compactText(snapshot.attempted, 600),
    needed_output: compactText(snapshot.needed_output, 500),
    request_text: compactText(snapshot.request_text, 800),
    file_paths: filePaths,
    file_hashes: pickFileHashes(snapshot.file_hashes, filePaths),
    git: {
      ...(snapshot.git || {}),
      dirtyStatus: compactText(snapshot.git?.dirtyStatus || "", 500)
    },
    snapshot_meta: {
      max_bytes: MAX_EXECUTION_SNAPSHOT_BYTES,
      excluded_path_segments: [...SNAPSHOT_EXCLUDED_PATH_SEGMENTS],
      max_file_bytes: MAX_SNAPSHOT_FILE_BYTES,
      truncated: true
    }
  };
  if (jsonByteLength(slim) > MAX_EXECUTION_SNAPSHOT_BYTES) {
    const tinyPaths = filePaths.slice(0, 3);
    slim.objective = compactText(snapshot.objective, 500);
    slim.blocker = compactText(snapshot.blocker, 300);
    slim.terminal_output_summary = compactText(snapshot.terminal_output_summary, 300);
    slim.attempted = compactText(snapshot.attempted, 300);
    slim.needed_output = compactText(snapshot.needed_output, 240);
    slim.request_text = compactText(snapshot.request_text, 400);
    slim.file_paths = tinyPaths;
    slim.file_hashes = pickFileHashes(snapshot.file_hashes, tinyPaths);
    slim.git = {
      ...(snapshot.git || {}),
      dirtyStatus: compactText(snapshot.git?.dirtyStatus || "", 220)
    };
  }
  slim.snapshot_meta.bytes = jsonByteLength(slim);
  return slim;
}

function captureExecutionSnapshot({ taskRun, agent, action = {}, requestText = "" }) {
  const filePaths = extractActionFilePaths(action);
  const fileHashes = Object.fromEntries(
    filePaths
      .slice(0, 8)
      .map((filePath) => [filePath, hashFileIfReadable(filePath)])
      .filter(([, hash]) => Boolean(hash))
  );
  const failedCommand = compactText(action.failed_command || action.command || action.last_command || "", 500);
  const terminalOutput = compactText(action.terminal_output || action.error_output || action.error || "", 1200);
  const blocker = compactText(action.problem || action.blocker || action.reason || requestText || taskRun.objective, 1200);
  return clampExecutionSnapshot({
    task_id: taskRun.id,
    subtask_id: compactText(action.subtask_id || action.subtaskId || "", 160),
    current_stage: compactText(action.current_stage || action.stage || "request_discussion_help", 220),
    requester_agent_id: agent.id,
    requester_agent_name: agent.name,
    objective: taskRun.objective,
    blocker,
    failed_command: failedCommand,
    terminal_output_summary: terminalOutput,
    file_paths: filePaths,
    file_hashes: fileHashes,
    git: currentGitSnapshot(),
    attempted: compactText(action.attempted || action.context || "", 1200),
    needed_output: compactText(action.needed_output || action.output || "", 900),
    request_text: compactText(requestText, 1600),
    captured_at: nowIso()
  });
}

function errorFingerprintText(value) {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const userStackLine = [...lines]
    .reverse()
    .find((line) => /\.(?:js|cjs|mjs|ts|tsx|py|sh|html|css|json)(?::\d+)?/.test(line) && !line.includes("node_modules"));
  return compactText([lines.slice(0, 4).join("\n"), userStackLine || "", lines.slice(-6).join("\n")].filter(Boolean).join("\n"), 700);
}

function blockFingerprintFromSnapshot(snapshot = {}) {
  const basis = {
    task: snapshot.task_id || "",
    subtask: snapshot.subtask_id || "",
    files: Array.isArray(snapshot.file_paths) ? snapshot.file_paths.slice(0, 8).sort() : [],
    command: compactText(snapshot.failed_command || "", 220).toLowerCase(),
    error: errorFingerprintText(snapshot.terminal_output_summary || snapshot.blocker || "").toLowerCase(),
    attempted: compactText(snapshot.attempted || "", 320).toLowerCase()
  };
  return crypto.createHash("sha256").update(JSON.stringify(basis)).digest("hex");
}

function validateExecutionDrift(snapshot = {}) {
  const currentGit = currentGitSnapshot();
  const changes = [];
  if (snapshot.git?.inside && currentGit.inside) {
    if (snapshot.git.head && currentGit.head && snapshot.git.head !== currentGit.head) changes.push("git_head_changed");
    if ((snapshot.git.branch || "") !== (currentGit.branch || "")) changes.push("git_branch_changed");
    if ((snapshot.git.dirtyHash || "") !== (currentGit.dirtyHash || "")) changes.push("git_dirty_status_changed");
  }
  const fileHashes = snapshot.file_hashes && typeof snapshot.file_hashes === "object" ? snapshot.file_hashes : {};
  for (const [filePath, oldHash] of Object.entries(fileHashes)) {
    const nextHash = hashFileIfReadable(filePath);
    if (nextHash && oldHash && nextHash !== oldHash) changes.push(`file_changed:${filePath}`);
    if (!nextHash && oldHash) changes.push(`file_missing:${filePath}`);
  }
  return {
    drifted: changes.length > 0,
    severity: changes.some((item) => item === "git_head_changed" || item.startsWith("file_changed")) ? "high" : changes.length ? "medium" : "none",
    changes,
    capturedGit: snapshot.git || null,
    currentGit
  };
}

function taskNeedsExecutionSandbox(objective) {
  const text = String(objective || "").toLowerCase();
  return /code|electron|runtime|config|file|repo|worktree|sandbox|修改|修复|实现|代码|配置|文件|仓库|打包|验收/.test(text);
}

function sandboxQuickActions({ sandboxPath, protocolPath, worktreePath, workspacePath }) {
  return [
    {
      id: "takeover",
      label: "接管",
      command: `cat "${protocolPath}"`,
      destructive: false
    },
    {
      id: "copy_command",
      label: "复制命令",
      command: `cd "${sandboxPath}" && cat "${protocolPath}"`,
      destructive: false
    },
    {
      id: "remove_worktree",
      label: "移除 worktree",
      command: `git -C "${workspacePath}" worktree remove --force "${worktreePath}"`,
      destructive: true
    },
    {
      id: "cleanup_sandbox",
      label: "清理沙箱",
      command: `rm -rf "${sandboxPath}"`,
      destructive: true
    }
  ];
}

function prepareTaskExecutionSandbox({ workspaceId, channelId, taskRunId, objective, primaryAgentId }) {
  if (!taskNeedsExecutionSandbox(objective)) return null;
  const sandboxPath = taskExecutionSandboxPath(taskRunId);
  const workspacePath = process.cwd();
  const worktreePath = path.join(sandboxPath, "worktree");
  const protocolPath = path.join(sandboxPath, "SANDBOX_PROTOCOL.md");
  const quickActions = sandboxQuickActions({ sandboxPath, protocolPath, worktreePath, workspacePath });
  fs.mkdirSync(sandboxPath, { recursive: true });
  const protocol = [
    "# Agent Team Execution Sandbox",
    "",
    `task_run_id: ${taskRunId}`,
    `workspace_path: ${workspacePath}`,
    `sandbox_path: ${sandboxPath}`,
    `recommended_worktree_path: ${worktreePath}`,
    "",
    "## Rules",
    "- 子 Agent 不应直接修改主工作区；需要代码/配置改动时，先在 sandbox/worktree 内执行和验证。",
    "- 验收通过后，由主进程、Leader 或 Hayden 决定是否合并回主工作区。",
    "- 异常中断时，默认保留 sandbox 现场，除非 Hayden 明确清理。",
    "",
	    "## Suggested Commands",
	    `git -C "${workspacePath}" worktree add --detach "${worktreePath}" HEAD`,
	    ...quickActions.map((action) => `${action.label}: ${action.command}`),
	    "",
	    "## Takeover",
	    `cd "${sandboxPath}"`,
	    `cat "${protocolPath}"`,
    "",
    "## Objective",
    objective
  ].join("\n");
	  fs.writeFileSync(protocolPath, protocol);
  addEvidenceItem({
    workspaceId,
    channelId,
    taskRunId,
    agentId: primaryAgentId,
    kind: "execution_sandbox_protocol",
    title: "执行沙箱协议",
    content: protocol,
    metadata: {
      sandboxPath,
	      protocolPath,
	      worktreePath,
	      workspacePath,
	      quickActions
	    }
	  });
  upsertBlackboardEntry({
    workspaceId,
    channelId,
    key: `task:${taskRunId}:execution_sandbox`,
    scope: "task",
    value: {
      taskRunId,
      sandboxPath,
	      protocolPath,
	      worktreePath,
	      workspacePath,
	      quickActions,
	      status: "prepared"
    },
    updatedByType: "system"
  });
  appendStructuredBlackboard({
    workspaceId,
    channelId,
    field: "facts",
    text: `Execution sandbox prepared for task ${taskRunId}: ${sandboxPath}`,
    source: "system",
    metadata: { taskRunId, sandboxPath, protocolPath, worktreePath }
  });
  audit({
    workspaceId,
    channelId,
    actorType: "system",
    action: "execution_sandbox_prepare",
    result: "allowed",
    detail: `已为任务 ${taskRunId} 准备执行沙箱：${sandboxPath}`
  });
  return { sandboxPath, protocolPath, worktreePath };
}

function latestSandboxEvidence(taskRunId) {
  return get(
    `SELECT *
     FROM evidence_items
     WHERE task_run_id = ? AND kind = 'execution_sandbox_protocol'
     ORDER BY created_at DESC
     LIMIT 1`,
    [taskRunId]
  );
}

function validateSandboxActionRequest(taskRunId, actionId) {
  const taskRun = getTaskRun(taskRunId);
  if (!taskRun) throw new Error("任务记录不存在。");
  const evidence = latestSandboxEvidence(taskRun.id);
  if (!evidence) throw new Error("该任务没有执行沙箱协议。");
  const meta = parseJsonObject(evidence.metadata_json, {});
  const sandboxPath = String(meta.sandboxPath || "");
  const protocolPath = String(meta.protocolPath || "");
  const worktreePath = String(meta.worktreePath || "");
  const workspacePath = String(meta.workspacePath || process.cwd());
  const root = taskSandboxRoot();
  if (!sandboxPath || !isPathInside(root, sandboxPath)) throw new Error("沙箱路径不在受控目录内。");
  if (protocolPath && !isPathInside(sandboxPath, protocolPath)) throw new Error("协议路径不在沙箱内。");
  if (worktreePath && !isPathInside(sandboxPath, worktreePath)) throw new Error("worktree 路径不在沙箱内。");
  const action = sandboxQuickActions({ sandboxPath, protocolPath, worktreePath, workspacePath }).find(
    (item) => item.id === actionId
  );
  if (!action) throw new Error("不支持的沙箱动作。");
  if (action.destructive && ["running", "waiting_discussion"].includes(taskRun.status)) {
    throw new Error("任务仍在运行或等待讨论，不能执行破坏性沙箱动作。");
  }
  return { taskRun, evidence, meta, action, sandboxPath, protocolPath, worktreePath, workspacePath };
}

function runSandboxQuickAction({ taskRunId, action }) {
  const actionId = String(action || "").trim();
  const request = validateSandboxActionRequest(taskRunId, actionId);
  const { taskRun, action: quickAction, sandboxPath, protocolPath, worktreePath, workspacePath } = request;
  let detail = "";
  if (quickAction.id === "takeover") {
    const protocol = fs.existsSync(protocolPath) ? fs.readFileSync(protocolPath, "utf8") : "沙箱协议文件已不存在。";
    detail = `接管协议已发送到消息流。\n\n${compactText(protocol, 4000)}`;
    insertMessage({
      workspaceId: taskRun.workspace_id,
      channelId: taskRun.channel_id,
      senderType: "system",
      senderName: "系统",
      mode: "system",
      content: detail,
      status: "visible"
    });
  } else if (quickAction.id === "copy_command") {
    detail = `接管命令：${quickAction.command}`;
    insertMessage({
      workspaceId: taskRun.workspace_id,
      channelId: taskRun.channel_id,
      senderType: "system",
      senderName: "系统",
      mode: "system",
      content: detail,
      status: "visible"
    });
  } else if (quickAction.id === "remove_worktree") {
    safeExecGit(["-C", workspacePath, "worktree", "remove", "--force", worktreePath]);
    safeRemovePath(worktreePath);
    detail = `已移除任务沙箱 worktree：${worktreePath}`;
  } else if (quickAction.id === "cleanup_sandbox") {
    safeExecGit(["-C", workspacePath, "worktree", "remove", "--force", worktreePath]);
    safeRemovePath(sandboxPath);
    detail = `已清理任务执行沙箱：${sandboxPath}`;
  }

  addEvidenceItem({
    workspaceId: taskRun.workspace_id,
    channelId: taskRun.channel_id,
    taskRunId: taskRun.id,
    agentId: taskRun.primary_agent_id,
    kind: "execution_sandbox_action",
    title: `沙箱快捷动作：${quickAction.label}`,
    content: detail || quickAction.command,
    metadata: {
      action: quickAction.id,
      command: quickAction.command,
      sandboxPath,
      protocolPath,
      worktreePath,
      workspacePath
    }
  });
  upsertBlackboardEntry({
    workspaceId: taskRun.workspace_id,
    channelId: taskRun.channel_id,
    key: `task:${taskRun.id}:execution_sandbox`,
    scope: "task",
    value: {
      taskRunId: taskRun.id,
      sandboxPath,
      protocolPath,
      worktreePath,
      workspacePath,
      status: quickAction.id === "cleanup_sandbox" ? "cleaned" : quickAction.id
    },
    updatedByType: "human"
  });
  audit({
    workspaceId: taskRun.workspace_id,
    channelId: taskRun.channel_id,
    actorType: "human",
    action: `execution_sandbox_${quickAction.id}`,
    result: "allowed",
    detail
  });
  saveDb();
  return getState(taskRun.workspace_id, taskRun.channel_id);
}

function deletedWorkspaceArchiveDir() {
  const dir = path.join(dataDir(), "deleted_workspace_archive");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function deletedWorkspaceArchiveFilePath(workspaceId, deletedAt) {
  if (!workspaceId) return "";
  const suffix = String(deletedAt || nowIso()).replace(/[:.]/g, "-");
  return path.join(deletedWorkspaceArchiveDir(), `${workspaceId}-${suffix}.json`);
}

function contentScopeFromMode(mode) {
  if (mode === "discussion") return "discussion";
  if (mode === "task" || mode === "reply" || mode === "command") return "task";
  return "workspace";
}

function contentAssetTypeForMessage(message) {
  if (message.sender_type === "human" && message.mode === "task") return "human_task_request";
  if (message.sender_type === "human" && message.mode === "discussion") return "human_discussion_topic";
  if (message.sender_type === "human" && message.mode === "command") return "human_command";
  if (message.sender_type === "human") return "human_message";
  if (message.sender_type === "agent" && message.mode === "discussion") return "discussion_agent_output";
  if (message.sender_type === "agent" && message.mode === "reply") return "task_agent_output";
  if (message.sender_type === "agent") return "agent_output";
  return "system_event";
}

function contentTitleForMessage(message) {
  const actor = message.sender_name || message.sender_type;
  if (message.sender_type === "human" && message.mode === "task") return `${actor} 任务需求`;
  if (message.sender_type === "human" && message.mode === "discussion") return `${actor} 讨论主题`;
  if (message.sender_type === "agent" && message.mode === "discussion") return `${actor} 讨论输出`;
  if (message.sender_type === "agent" && message.mode === "reply") return `${actor} 任务输出`;
  return `${actor} ${message.mode}`;
}

function upsertContentAsset({
  workspaceId,
  channelId = null,
  sourceType,
  sourceId,
  assetType,
  scope = "workspace",
  title,
  summary,
  content,
  metadata = {},
  createdByType = "system",
  createdById = null,
  importance = 0,
  createdAt = nowIso()
}) {
  if (!workspaceId || !sourceType || !sourceId || !assetType || !content) return null;
  if (!workspaceExists(workspaceId)) return null;
  const safeChannelId = normalizeContentAssetChannelId(workspaceId, channelId);
  const existing = get("SELECT * FROM content_assets WHERE source_type = ? AND source_id = ?", [sourceType, sourceId]);
  const nextTitle = String(title || assetType).slice(0, 180);
  const nextContent = String(content || "").slice(0, 20000);
  const nextSummary = String(summary || compactText(nextContent, 900)).slice(0, 1600);
  const now = nowIso();
  if (existing) {
    run(
      `UPDATE content_assets
       SET workspace_id = ?, channel_id = ?, asset_type = ?, scope = ?, title = ?, summary = ?, content = ?,
         metadata_json = ?, created_by_type = ?, created_by_id = ?, importance = ?, updated_at = ?
       WHERE id = ?`,
      [
        workspaceId,
        safeChannelId,
        assetType,
        scope,
        nextTitle,
        nextSummary,
        nextContent,
        safeJson(metadata),
        createdByType,
        createdById,
        importance,
        now,
        existing.id
      ]
    );
    return get("SELECT * FROM content_assets WHERE id = ?", [existing.id]);
  }
  const id = makeId("asset");
  run(
    `INSERT INTO content_assets
      (id, workspace_id, channel_id, source_type, source_id, asset_type, scope, title, summary, content,
       metadata_json, created_by_type, created_by_id, importance, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      workspaceId,
      safeChannelId,
      sourceType,
      sourceId,
      assetType,
      scope,
      nextTitle,
      nextSummary,
      nextContent,
      safeJson(metadata),
      createdByType,
      createdById,
      importance,
      createdAt,
      now
    ]
  );
  return get("SELECT * FROM content_assets WHERE id = ?", [id]);
}

function workspaceExists(workspaceId) {
  return Boolean(workspaceId && get("SELECT id FROM workspaces WHERE id = ?", [workspaceId]));
}

function normalizeContentAssetChannelId(workspaceId, channelId) {
  if (!channelId) return null;
  const channel = get("SELECT id FROM channels WHERE id = ? AND workspace_id = ?", [channelId, workspaceId]);
  return channel ? channelId : null;
}

function messageAttachmentRoot() {
  const dir = path.join(dataDir(), "message_attachments");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function messageAttachmentWorkspaceDir(workspaceId) {
  const dir = path.join(messageAttachmentRoot(), String(workspaceId || "workspace"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeAttachmentName(value, fallback = "image") {
  const base = path.basename(String(value || fallback)).replace(/[^\w.\-]+/g, "_").slice(0, 90);
  return base || fallback;
}

function normalizeIncomingAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_MESSAGE_ATTACHMENTS).filter(Boolean);
}

function imageDimensionsFromBuffer(buffer) {
  try {
    const image = nativeImage.createFromBuffer(buffer);
    const size = image.getSize();
    return {
      width: size.width > 0 ? size.width : null,
      height: size.height > 0 ? size.height : null
    };
  } catch {
    return { width: null, height: null };
  }
}

function attachmentPublicPath(attachmentId) {
  return `/api/attachments/${encodeURIComponent(attachmentId)}`;
}

function attachmentPublicUrl(attachmentId) {
  const address = mobileServer?.address?.();
  const port = typeof address === "object" && address ? address.port : 0;
  if (!port) return "";
  return `http://${localNetworkHost()}:${port}${attachmentPublicPath(attachmentId)}?token=${encodeURIComponent(MOBILE_ACCESS_TOKEN)}`;
}

function serializeMessageAttachment(row) {
  if (!row) return null;
  return {
    id: row.id,
    message_id: row.message_id,
    workspace_id: row.workspace_id,
    channel_id: row.channel_id,
    kind: row.kind,
    mime_type: row.mime_type,
    filename: row.filename,
    original_name: row.original_name,
    byte_size: Number(row.byte_size || 0),
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    public_path: row.public_path,
    url: attachmentPublicUrl(row.id),
    created_at: row.created_at
  };
}

function storeImageAttachment({
  message,
  buffer,
  mimeType,
  originalName,
  extension = "",
  width = null,
  height = null,
  byteLimit = MAX_MESSAGE_ATTACHMENT_BYTES
}) {
  const normalizedMimeType = String(mimeType || "").toLowerCase().trim();
  if (!IMAGE_ATTACHMENT_MIME_TYPES.has(normalizedMimeType)) {
    throw new Error(`不支持的图片格式：${normalizedMimeType || "未知"}`);
  }
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("图片附件数据为空。");
  if (buffer.length > byteLimit) {
    throw new Error(`单张图片不能超过 ${Math.round(byteLimit / 1024 / 1024)}MB。`);
  }
  const messageDir = path.join(messageAttachmentWorkspaceDir(message.workspace_id), message.id);
  fs.mkdirSync(messageDir, { recursive: true });
  const attachmentId = makeId("att");
  const resolvedExtension = extension || IMAGE_ATTACHMENT_EXTENSIONS[normalizedMimeType] || ".img";
  const original = sanitizeAttachmentName(originalName || `image${resolvedExtension}`);
  const filename = `${attachmentId}${resolvedExtension}`;
  const storagePath = path.join(messageDir, filename);
  fs.writeFileSync(storagePath, buffer);
  const detectedSize = imageDimensionsFromBuffer(buffer);
  const publicPath = attachmentPublicPath(attachmentId);
  run(
    `INSERT INTO message_attachments
      (id, message_id, workspace_id, channel_id, kind, mime_type, filename, original_name, byte_size, width, height, storage_path, public_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      attachmentId,
      message.id,
      message.workspace_id,
      message.channel_id,
      "image",
      normalizedMimeType,
      filename,
      original,
      buffer.length,
      Number.isFinite(Number(width)) ? Number(width) : detectedSize.width,
      Number.isFinite(Number(height)) ? Number(height) : detectedSize.height,
      storagePath,
      publicPath,
      nowIso()
    ]
  );
  return serializeMessageAttachment(get("SELECT * FROM message_attachments WHERE id = ?", [attachmentId]));
}

function saveMessageAttachments({ message, attachments = [] }) {
  const incoming = normalizeIncomingAttachments(attachments);
  if (!incoming.length) return [];
  const saved = [];
  for (const raw of incoming) {
    const kind = String(raw.kind || "image").trim() || "image";
    if (kind !== "image") throw new Error("当前只支持发送图片附件。");
    const mimeType = String(raw.mimeType || raw.mime_type || "").toLowerCase().trim();
    if (!IMAGE_ATTACHMENT_MIME_TYPES.has(mimeType)) throw new Error(`不支持的图片格式：${mimeType || "未知"}`);
    const base64 = String(raw.dataBase64 || raw.data_base64 || "").replace(/^data:[^;]+;base64,/, "");
    if (!base64) throw new Error("图片附件缺少数据。");
    const buffer = Buffer.from(base64, "base64");
    if (!buffer.length) throw new Error("图片附件数据为空。");
    if (buffer.length > MAX_MESSAGE_ATTACHMENT_BYTES) {
      throw new Error(`单张图片不能超过 ${Math.round(MAX_MESSAGE_ATTACHMENT_BYTES / 1024 / 1024)}MB。`);
    }
    const extension = IMAGE_ATTACHMENT_EXTENSIONS[mimeType] || path.extname(String(raw.fileName || raw.filename || "")).toLowerCase() || ".img";
    saved.push(
      storeImageAttachment({
        message,
        buffer,
        mimeType,
        originalName: raw.fileName || raw.filename || `image${extension}`,
        extension,
        width: raw.width,
        height: raw.height,
        byteLimit: MAX_MESSAGE_ATTACHMENT_BYTES
      })
    );
  }
  return saved;
}

function normalizeGeneratedArtifactPath(value) {
  let text = String(value || "").trim();
  if (!text) return "";
  text = text.replace(/^[`'"]|[`'"]$/g, "").trim();
  text = text.replace(/^[ab](?=\/Users\/)/, "");
  text = text.replace(/[),，。；;:：]+$/g, "");
  if (text.startsWith("~/")) text = path.join(os.homedir(), text.slice(2));
  if (!path.isAbsolute(text)) return "";
  return path.resolve(text);
}

function isSafeGeneratedArtifactPath(filePath) {
  const resolved = path.resolve(filePath);
  const allowedRoots = [os.homedir(), os.tmpdir(), process.cwd()].map((item) => path.resolve(item));
  return allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

function extractGeneratedVisualArtifactPaths(sources = []) {
  const candidates = new Set();
  const quotedRe = /[`'"]((?:[ab](?=\/Users\/)|~|\/)[^`'"]+?\.(?:png|jpe?g|webp|gif|svg|html?))[`'"]/gi;
  const bareRe = /(?:^|[\s([（:：])((?:[ab](?=\/Users\/)|~|\/)[^\n\r"'`<>|]*?\.(?:png|jpe?g|webp|gif|svg|html?))(?=$|[\s)\]）"'`，。；;,|])/gi;
  for (const source of sources) {
    const text = String(source || "");
    for (const match of text.matchAll(quotedRe)) {
      const normalized = normalizeGeneratedArtifactPath(match[1]);
      if (normalized) candidates.add(normalized);
    }
    for (const match of text.matchAll(bareRe)) {
      const normalized = normalizeGeneratedArtifactPath(match[1]);
      if (normalized) candidates.add(normalized);
    }
  }
  return [...candidates].filter((candidate) => {
    const ext = path.extname(candidate).toLowerCase();
    return GENERATED_VISUAL_ARTIFACT_EXTENSIONS.has(ext) && isSafeGeneratedArtifactPath(candidate) && fs.existsSync(candidate);
  });
}

function stripGeneratedVisualReferences(content, sourcePaths = []) {
  let text = String(content || "");
  if (!text.trim()) return text;
  const visualExt = "(?:png|jpe?g|webp|gif|svg|html?)";
  text = text
    .replace(new RegExp(`!\\[[^\\]]*\\]\\([^\\)]*\\.${visualExt}(?:\\?[^\\)]*)?\\)`, "gi"), "")
    .replace(new RegExp(`\\[[^\\]]*\\]\\([^\\)]*\\.${visualExt}(?:\\?[^\\)]*)?\\)`, "gi"), "")
    .replace(
      new RegExp(
        `(?:图片|图像|视觉产物|源文件|文件|路径|链接|输出)?\\s*(?:源文件|文件|路径|链接|输出)?\\s*[:：]?\\s*[\\\`'"]?(?:[ab](?=\\/Users\\/)|~|\\/)[^\\n\\r"'\\\`<>|]*?\\.${visualExt}[\\\`'"]?`,
        "gi"
      ),
      ""
    );
  for (const sourcePath of sourcePaths) {
    const resolved = path.resolve(sourcePath);
    const variants = new Set([
      resolved,
      `a${resolved}`,
      `b${resolved}`,
      `file://${resolved}`,
      resolved.startsWith(os.homedir()) ? `~${resolved.slice(os.homedir().length)}` : ""
    ]);
    for (const variant of variants) {
      if (!variant) continue;
      text = text.replace(new RegExp(`[\\\`'"]?${escapeRegExp(variant)}[\\\`'"]?`, "g"), "");
    }
  }
  text = text
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .filter((line) => !/^\s*(?:[-*]\s*)?$/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || "已发送图片。";
}

async function renderVisualArtifactToPng(sourcePath) {
  const renderDir = path.join(messageAttachmentRoot(), "_rendered");
  fs.mkdirSync(renderDir, { recursive: true });
  const outputPath = path.join(renderDir, `${makeId("render")}.png`);
  const previewWindow = new BrowserWindow({
    show: false,
    width: 1400,
    height: 1000,
    backgroundColor: "#ffffff",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  try {
    await previewWindow.loadFile(sourcePath);
    await sleep(650);
    const metrics = await previewWindow.webContents
      .executeJavaScript(
        `(() => {
          const body = document.body || {};
          const doc = document.documentElement || {};
          return {
            width: Math.ceil(Math.max(window.innerWidth || 0, doc.scrollWidth || 0, body.scrollWidth || 0, doc.clientWidth || 0)),
            height: Math.ceil(Math.max(window.innerHeight || 0, doc.scrollHeight || 0, body.scrollHeight || 0, doc.clientHeight || 0))
          };
        })()`,
        true
      )
      .catch(() => ({ width: 1400, height: 1000 }));
    const width = Math.min(2600, Math.max(900, Number(metrics.width) || 1400));
    const height = Math.min(3600, Math.max(700, Number(metrics.height) || 1000));
    previewWindow.setBounds({ x: 0, y: 0, width, height });
    await sleep(250);
    const image = await previewWindow.webContents.capturePage({ x: 0, y: 0, width, height });
    fs.writeFileSync(outputPath, image.toPNG());
    return outputPath;
  } finally {
    if (!previewWindow.isDestroyed()) previewWindow.destroy();
  }
}

async function prepareGeneratedVisualArtifact(sourcePath) {
  const ext = path.extname(sourcePath).toLowerCase();
  if (ext === ".html" || ext === ".htm" || ext === ".svg") {
    const renderedPath = await renderVisualArtifactToPng(sourcePath);
    return {
      path: renderedPath,
      mimeType: "image/png",
      extension: ".png",
      originalName: `${path.basename(sourcePath, ext)}.png`
    };
  }
  const mimeType = contentTypeFor(sourcePath).split(";")[0].toLowerCase();
  if (!IMAGE_ATTACHMENT_MIME_TYPES.has(mimeType)) return null;
  return {
    path: sourcePath,
    mimeType,
    extension: IMAGE_ATTACHMENT_EXTENSIONS[mimeType] || ext,
    originalName: path.basename(sourcePath)
  };
}

async function attachGeneratedImagesForMessage(message, sources = []) {
  if (!message || message.status !== "visible") return [];
  const existing = listAttachmentsForMessages(message.workspace_id, message.channel_id, [message.id]);
  const capacity = Math.max(0, MAX_MESSAGE_ATTACHMENTS - existing.length);
  if (capacity <= 0) return [];
  const paths = extractGeneratedVisualArtifactPaths(sources).slice(0, capacity);
  const saved = [];
  for (const sourcePath of paths) {
    try {
      const prepared = await prepareGeneratedVisualArtifact(sourcePath);
      if (!prepared || !fs.existsSync(prepared.path)) continue;
      const buffer = fs.readFileSync(prepared.path);
      const attachment = storeImageAttachment({
        message,
        buffer,
        mimeType: prepared.mimeType,
        originalName: prepared.originalName,
        extension: prepared.extension,
        byteLimit: MAX_GENERATED_MESSAGE_ATTACHMENT_BYTES
      });
      if (attachment) saved.push(attachment);
    } catch (error) {
      audit({
        workspaceId: message.workspace_id,
        channelId: message.channel_id,
        actorType: "system",
        action: "generated_image_attachment",
        result: "failed",
        detail: `${path.basename(sourcePath)}：${summarizeError(error.message || error)}`
      });
    }
  }
  if (saved.length) {
    const nextContent = stripGeneratedVisualReferences(message.content, paths);
    if (nextContent !== message.content) {
      run("UPDATE messages SET content = ? WHERE id = ?", [nextContent, message.id]);
      message.content = nextContent;
    }
    message.attachments = [...existing, ...saved];
    captureMessageContentAsset(message);
    audit({
      workspaceId: message.workspace_id,
      channelId: message.channel_id,
      actorType: "system",
      action: "generated_image_attachment",
      result: "allowed",
      detail: `已把 ${saved.length} 个 Agent 视觉产物作为图片附件加入消息。`
    });
    saveDb();
  }
  return saved;
}

function attachmentContextForAgent(attachments = []) {
  const items = (attachments || []).filter(Boolean);
  if (!items.length) return "";
  const lines = items.map((attachment, index) => {
    const row = get("SELECT * FROM message_attachments WHERE id = ?", [attachment.id]);
    const localPath = row?.storage_path || "";
    const sizeKb = Math.max(1, Math.round(Number(attachment.byte_size || 0) / 1024));
    return `${index + 1}. ${attachment.original_name || attachment.filename} (${attachment.mime_type}, ${sizeKb}KB) 本机路径：${localPath}`;
  });
  return ["", "【图片附件】", ...lines, "请在回答时基于以上图片内容；如需要检查图片，请读取对应本机路径。"].join("\n");
}

function composeMessageContentWithAttachments(content, attachments = [], fallbackText = "请处理附件图片。") {
  const text = String(content || "").trim() || fallbackText;
  return `${text}${attachmentContextForAgent(attachments)}`;
}

function listAttachmentsForMessages(workspaceId, channelId, messageIds = []) {
  if (!workspaceId || !channelId || !messageIds.length) return [];
  const placeholders = messageIds.map(() => "?").join(", ");
  return all(
    `SELECT *
     FROM message_attachments
     WHERE workspace_id = ? AND channel_id = ? AND message_id IN (${placeholders})
     ORDER BY created_at ASC`,
    [workspaceId, channelId, ...messageIds]
  )
    .map(serializeMessageAttachment)
    .filter(Boolean);
}

function serveMessageAttachment(req, res, parsedUrl) {
  if (!requestHasMobileToken(req, parsedUrl)) {
    sendText(res, 401, "附件访问令牌无效。");
    return;
  }
  const attachmentId = decodeURIComponent(parsedUrl.pathname.replace(/^\/api\/attachments\//, "")).trim();
  const attachment = get("SELECT * FROM message_attachments WHERE id = ?", [attachmentId]);
  if (!attachment) {
    sendText(res, 404, "附件不存在。");
    return;
  }
  const root = path.resolve(messageAttachmentRoot());
  const target = path.resolve(attachment.storage_path);
  if (!fs.existsSync(target) || (!target.startsWith(`${root}${path.sep}`) && target !== root)) {
    sendText(res, 404, "附件文件不存在。");
    return;
  }
  const body = fs.readFileSync(target);
  res.writeHead(200, {
    "Content-Type": attachment.mime_type || contentTypeFor(target),
    "Content-Length": body.length,
    "Cache-Control": "private, max-age=86400"
  });
  res.end(body);
}

function captureMessageContentAsset(message) {
  if (!message || message.status !== "visible") return null;
  if (!["human", "agent"].includes(message.sender_type)) return null;
  const content = String(message.content || "").trim();
  if (!content) return null;
  const attachmentRows = all("SELECT id, kind, mime_type, original_name, byte_size FROM message_attachments WHERE message_id = ?", [
    message.id
  ]);
  return upsertContentAsset({
    workspaceId: message.workspace_id,
    channelId: message.channel_id,
    sourceType: "message",
    sourceId: message.id,
    assetType: contentAssetTypeForMessage(message),
    scope: contentScopeFromMode(message.mode),
    title: contentTitleForMessage(message),
    summary: compactText(content, 900),
    content,
    metadata: {
      mode: message.mode,
      senderType: message.sender_type,
      senderName: message.sender_name,
      targetAgentId: message.target_agent_id || null,
      attachmentCount: attachmentRows.length,
      attachments: attachmentRows
    },
    createdByType: message.sender_type,
    createdById: message.sender_id || null,
    importance: message.mode === "task" || message.mode === "discussion" ? (attachmentRows.length ? 3 : 2) : attachmentRows.length ? 2 : 1,
    createdAt: message.created_at
  });
}

function backfillContentAssets() {
  for (const message of all(
    `SELECT *
     FROM messages
     WHERE status = 'visible' AND sender_type IN ('human', 'agent')
     ORDER BY created_at ASC`
  )) {
    try {
      captureMessageContentAsset(message);
    } catch (error) {
      console.warn("Skipped legacy message content asset:", message.id, error.message || error);
    }
  }
  for (const task of all(
    `SELECT tr.*, a.name AS agent_name
     FROM task_runs tr
     LEFT JOIN agents a ON a.id = tr.primary_agent_id
     WHERE tr.final_output != ''
     ORDER BY tr.created_at ASC`
  )) {
    try {
      upsertContentAsset({
        workspaceId: task.workspace_id,
        channelId: task.channel_id,
        sourceType: "task_run",
        sourceId: task.id,
        assetType: task.status === "failed" ? "task_failure" : "task_final_output",
        scope: "task",
        title: `任务沉淀：${compactText(task.objective, 80)}`,
        summary: compactText(task.final_output, 1200),
        content: task.final_output,
        metadata: {
          objective: task.objective,
          status: task.status,
          primaryAgentId: task.primary_agent_id,
          primaryAgentName: task.agent_name || ""
        },
        createdByType: "agent",
        createdById: task.primary_agent_id,
        importance: task.status === "failed" ? 2 : 4,
        createdAt: task.completed_at || task.created_at
      });
    } catch (error) {
      console.warn("Skipped legacy task content asset:", task.id, error.message || error);
    }
  }
  for (const decision of all(
    `SELECT dr.*, d.topic
     FROM decision_records dr
     LEFT JOIN discussion_runs d ON d.id = dr.discussion_id
     ORDER BY dr.created_at ASC`
  )) {
    try {
      upsertContentAsset({
        workspaceId: decision.workspace_id,
        channelId: decision.channel_id,
        sourceType: "decision_record",
        sourceId: decision.id,
        assetType: "discussion_decision",
        scope: "discussion",
        title: `讨论决策：${compactText(decision.topic || decision.framework, 80)}`,
        summary: compactText(decision.summary || decision.decision, 1200),
        content: decision.summary || decision.decision,
        metadata: {
          discussionId: decision.discussion_id,
          framework: decision.framework,
          status: decision.status,
          needsHuman: Boolean(decision.needs_human)
        },
        createdByType: "agent",
        createdById: decision.created_by_agent_id,
        importance: 4,
        createdAt: decision.created_at
      });
    } catch (error) {
      console.warn("Skipped legacy decision content asset:", decision.id, error.message || error);
    }
  }
}

function upsertBlackboardEntry({
  workspaceId,
  channelId = null,
  key,
  scope = "workspace",
  value,
  updatedByType = "system",
  updatedById = null
}) {
  if (!workspaceId || !key) return;
  const existing = get("SELECT * FROM blackboard_entries WHERE workspace_id = ? AND key = ?", [workspaceId, key]);
  const nextValue = typeof value === "string" ? value : safeJson(value);
  if (existing) {
    run(
      `UPDATE blackboard_entries
       SET channel_id = ?, scope = ?, value = ?, updated_by_type = ?, updated_by_id = ?, updated_at = ?
       WHERE id = ?`,
      [channelId, scope, nextValue, updatedByType, updatedById, nowIso(), existing.id]
    );
    return;
  }
  run(
    `INSERT INTO blackboard_entries
      (id, workspace_id, channel_id, key, scope, value, updated_by_type, updated_by_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [makeId("bb"), workspaceId, channelId, key, scope, nextValue, updatedByType, updatedById, nowIso()]
  );
}

function blackboardPrompt(workspaceId) {
  const entries = all(
    `SELECT key, value, updated_at
     FROM blackboard_entries
     WHERE workspace_id = ?
     ORDER BY updated_at DESC
     LIMIT 12`,
    [workspaceId]
  );
  if (entries.length === 0) return "暂无共享状态。";
  return entries.map((item) => `- ${item.key}: ${compactText(item.value, 260)} (${item.updated_at})`).join("\n");
}

function addEvidenceItem({
  workspaceId,
  channelId,
  taskRunId = null,
  agentId = null,
  kind,
  title,
  content,
  metadata = {}
}) {
  if (!workspaceId || !channelId || !kind) return null;
  const id = makeId("ev");
  run(
    `INSERT INTO evidence_items
      (id, workspace_id, channel_id, task_run_id, agent_id, kind, title, content, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      workspaceId,
      channelId,
      taskRunId,
      agentId,
      kind,
      String(title || kind).slice(0, 160),
      String(content || "").slice(0, 4000),
      safeJson(metadata),
      nowIso()
    ]
  );
  if (taskRunId) {
    upsertBlackboardEntry({
      workspaceId,
      channelId,
      key: `task:${taskRunId}:latest_evidence`,
      scope: "task",
      value: `${kind} / ${title}: ${compactText(content, 500)}`,
      updatedByType: agentId ? "agent" : "system",
      updatedById: agentId
    });
  }
  return get("SELECT * FROM evidence_items WHERE id = ?", [id]);
}

function evidencePrompt(taskRunId, workspaceId, channelId) {
  const params = taskRunId ? [taskRunId] : [workspaceId, channelId];
  const where = taskRunId ? "ei.task_run_id = ?" : "ei.workspace_id = ? AND ei.channel_id = ?";
  const items = all(
    `SELECT ei.*, a.name AS agent_name
     FROM evidence_items ei
     LEFT JOIN agents a ON a.id = ei.agent_id
     WHERE ${where}
     ORDER BY ei.created_at DESC
     LIMIT 12`,
    params
  ).reverse();
  if (items.length === 0) return "暂无证据包。";
  return items
    .map((item) => `- [${item.kind}] ${item.title}${item.agent_name ? ` / ${item.agent_name}` : ""}: ${compactText(item.content, 320)}`)
    .join("\n");
}

function contentAssetsPrompt(workspaceId, channelId, visibility = "all") {
  const taskOnlyFilter =
    visibility === "task"
      ? "AND ca.scope != 'discussion' AND ca.asset_type NOT LIKE 'discussion_%'"
      : "";
  const items = all(
    `SELECT ca.*
     FROM content_assets ca
     WHERE ca.workspace_id = ? AND ca.channel_id = ?
       ${taskOnlyFilter}
     ORDER BY ca.importance DESC, ca.created_at DESC
     LIMIT 12`,
    [workspaceId, channelId]
  );
  if (items.length === 0) return "暂无内容资产。";
  return items
    .map((item) => `- [${item.asset_type}] ${item.title}: ${compactText(item.summary || item.content, 320)}`)
    .join("\n");
}

function buildSafeHandoffLog({ discussion, framework, reason, visibleText }) {
  const locks = all(
    `SELECT resource, owner_type, owner_id, session_id, status, heartbeat_at, expires_at
     FROM runtime_locks
     WHERE workspace_id = ? AND (? IS NULL OR channel_id = ?)
     ORDER BY acquired_at DESC
     LIMIT 12`,
    [discussion.workspace_id, discussion.channel_id || null, discussion.channel_id || null]
  );
  const sandboxEvidence = all(
    `SELECT content, metadata_json
     FROM evidence_items
     WHERE workspace_id = ? AND channel_id = ? AND kind = 'execution_sandbox_protocol'
     ORDER BY created_at DESC
     LIMIT 5`,
    [discussion.workspace_id, discussion.channel_id]
  );
  const sandboxPaths = sandboxEvidence
    .map((item) => parseJsonObject(item.metadata_json, {}))
    .map((meta) => meta.sandboxPath || meta.protocolPath || "")
    .filter(Boolean);
  const lockLines = locks.length
    ? locks.map((lock) => `- ${lock.status} ${lock.resource} owner=${lock.owner_type}:${lock.owner_id} heartbeat=${lock.heartbeat_at} expires=${lock.expires_at}`)
    : ["- 无当前锁快照"];
  const dirtyPaths = [
    `- db: ${dbFilePath || "unknown"}`,
    `- team_state: ${teamStateFilePath(discussion.workspace_id)}`,
    `- content_archive: ${contentArchiveFilePath(discussion.workspace_id)}`,
    ...sandboxPaths.map((item) => `- sandbox: ${item}`)
  ];
  return [
    "## Safe Log",
    "回滚命令：",
    `- 保留现场：cp "${dbFilePath || teamStateFilePath(discussion.workspace_id)}" "${dataDir()}/handoff-backup-${discussion.id}.bak"`,
    "- 若需停止当前空间运行：在应用内执行 /stop",
    "接管命令：",
    `- cat "${teamStateFilePath(discussion.workspace_id)}"`,
    `- cat "${contentArchiveFilePath(discussion.workspace_id)}"`,
    `当前阶段：${framework.name} 强制收敛 / ${discussion.status}`,
    `已完成事项：已收集参与 Agent 发言并触发 Leader 收敛；原因：${compactText(reason, 500)}`,
    `未完成事项：${visibleText ? "需要 Hayden 审阅降级 Decision Record 并决定是否继续。" : "Leader 未提供足够可读输出，需要 Hayden 接管。"}`,
    "脏现场路径：",
    ...dirtyPaths,
    "相关锁状态：",
    ...lockLines,
    "Safe Log 纯文本兜底：本记录由主进程生成，用于在结构化 Decision Record 不完整时保留恢复路径、锁状态和人工接管入口。"
  ].join("\n");
}

function createDecisionRecord({ discussion, framework, agentId, decision, visibleText }) {
  const id = makeId("decision");
  const status = decision.decision || "final";
  const needsHuman = status === "ask_human" ? 1 : 0;
  const summary = compactText(visibleText, 2200);
  const decisionText = compactText(decision.reason || visibleText, 900);
  run(
    `INSERT INTO decision_records
      (id, workspace_id, channel_id, discussion_id, framework, status, summary, decision, risks, actions, needs_human, created_by_agent_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      discussion.workspace_id,
      discussion.channel_id,
      discussion.id,
      framework.name,
      status,
      summary,
      decisionText,
      "",
      compactText(decision.next_prompt || "", 900),
      needsHuman,
      agentId,
      nowIso()
    ]
  );
  upsertBlackboardEntry({
    workspaceId: discussion.workspace_id,
    channelId: discussion.channel_id,
    key: `discussion:${discussion.id}:latest_decision`,
    scope: "discussion",
    value: {
      framework: framework.name,
      status,
      decision: decisionText,
      summary,
      needsHuman: Boolean(needsHuman)
    },
    updatedByType: "agent",
    updatedById: agentId
  });
	  upsertContentAsset({
	    workspaceId: discussion.workspace_id,
	    channelId: discussion.channel_id,
    sourceType: "decision_record",
    sourceId: id,
    assetType: "discussion_decision",
    scope: "discussion",
    title: `讨论决策：${compactText(discussion.topic, 80)}`,
    summary,
    content: summary,
    metadata: {
      discussionId: discussion.id,
      framework: framework.name,
      status,
      decision: decisionText,
      nextPrompt: compactText(decision.next_prompt || "", 900),
      needsHuman: Boolean(needsHuman)
    },
    createdByType: "agent",
	    createdById: agentId,
	    importance: 4
	  });
	  appendStructuredBlackboard({
	    workspaceId: discussion.workspace_id,
	    channelId: discussion.channel_id,
	    field: needsHuman ? "open_questions" : "decisions",
	    text: `${framework.name} / ${status}: ${decisionText || summary}`,
	    source: "agent",
	    metadata: { discussionId: discussion.id, agentId, decisionRecordId: id }
	  });
	  return get("SELECT * FROM decision_records WHERE id = ?", [id]);
	}

function exportContentArchive(workspaceId, channelId) {
  if (!workspaceId) return "";
  const workspace = get("SELECT * FROM workspaces WHERE id = ?", [workspaceId]);
  if (!workspace) return "";
  const assets = all(
    `SELECT ca.*, a.name AS created_by_agent_name
     FROM content_assets ca
     LEFT JOIN agents a ON a.id = ca.created_by_id
     WHERE ca.workspace_id = ?
       AND (? IS NULL OR ca.channel_id = ?)
     ORDER BY ca.created_at ASC`,
    [workspaceId, channelId || null, channelId || null]
  );
  const byType = assets.reduce((acc, item) => {
    acc[item.asset_type] = (acc[item.asset_type] || 0) + 1;
    return acc;
  }, {});
  const archive = {
    schema_version: 1,
    exported_at: nowIso(),
    workspace,
    channel: channelId ? get("SELECT * FROM channels WHERE id = ?", [channelId]) : null,
    count: assets.length,
    by_type: byType,
    assets
  };
  const filePath = contentArchiveFilePath(workspaceId);
  fs.writeFileSync(filePath, JSON.stringify(archive, null, 2));
  return filePath;
}

function exportTeamStateSnapshot(workspaceId, channelId) {
  if (!workspaceId) return "";
  const workspace = get("SELECT * FROM workspaces WHERE id = ?", [workspaceId]);
  const contentArchivePath = exportContentArchive(workspaceId, channelId);
  if (!workspace) return "";
  const snapshot = {
    exported_at: nowIso(),
    content_archive_path: contentArchivePath,
    workspace,
    channel: channelId ? get("SELECT * FROM channels WHERE id = ?", [channelId]) : null,
    agents: all(
      `SELECT id, name, role, agent_kind, parent_agent_id, is_primary, is_temporary, status, current_task, model_provider, model_name, last_error
       FROM agents
       WHERE workspace_id = ?
       ORDER BY agent_kind ASC, is_primary DESC, created_at ASC`,
      [workspaceId]
    ),
    blackboard: all(
      `SELECT key, scope, value, updated_by_type, updated_by_id, updated_at
       FROM blackboard_entries
       WHERE workspace_id = ?
       ORDER BY updated_at DESC
       LIMIT 50`,
      [workspaceId]
    ),
	    runtime_locks: all(
	      `SELECT id, resource, owner_type, owner_id, session_id, status, reason, suspect_count, last_suspect_at, acquired_at, heartbeat_at, expires_at, released_at
	       FROM runtime_locks
	       WHERE workspace_id = ?
	       ORDER BY acquired_at DESC
	       LIMIT 50`,
	      [workspaceId]
	    ),
	    task_discussion_links: all(
	      `SELECT id, task_run_id, discussion_id, requester_agent_id, status, request_text, execution_snapshot, wait_started_at, expires_at, block_fingerprint, discuss_count, created_at, resolved_at
	       FROM task_discussion_links
	       WHERE workspace_id = ?
	       ORDER BY created_at DESC
	       LIMIT 50`,
	      [workspaceId]
	    ),
    open_tasks: all(
      `SELECT id, primary_agent_id, status, objective, final_output, created_at, completed_at
       FROM task_runs
       WHERE workspace_id = ? AND status != 'cleaned'
       ORDER BY created_at DESC
       LIMIT 20`,
      [workspaceId]
    ),
    recent_evidence: all(
      `SELECT task_run_id, agent_id, kind, title, content, created_at
       FROM evidence_items
       WHERE workspace_id = ?
       ORDER BY created_at DESC
       LIMIT 30`,
      [workspaceId]
    ),
    active_discussions: all(
      `SELECT id, topic, status, discussion_framework, organizer_agent_id, organizer_status, created_at
       FROM discussion_runs
       WHERE workspace_id = ? AND status != 'closed'
       ORDER BY created_at DESC
       LIMIT 20`,
      [workspaceId]
    ),
    recent_decisions: all(
      `SELECT discussion_id, framework, status, summary, decision, actions, needs_human, created_at
       FROM decision_records
       WHERE workspace_id = ?
       ORDER BY created_at DESC
       LIMIT 20`,
      [workspaceId]
    ),
    recent_content_assets: all(
      `SELECT source_type, source_id, asset_type, scope, title, summary, created_by_type, created_by_id, importance, created_at
       FROM content_assets
       WHERE workspace_id = ?
       ORDER BY importance DESC, created_at DESC
       LIMIT 50`,
      [workspaceId]
    ),
    recent_message_attachments: all(
      `SELECT id, message_id, channel_id, kind, mime_type, original_name, byte_size, created_at
       FROM message_attachments
       WHERE workspace_id = ?
       ORDER BY created_at DESC
       LIMIT 50`,
      [workspaceId]
    )
  };
  const filePath = teamStateFilePath(workspaceId);
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
  return filePath;
}

function archiveWorkspaceBeforeDelete(workspaceId) {
  const workspace = get("SELECT * FROM workspaces WHERE id = ?", [workspaceId]);
  if (!workspace) return "";
  const deletedAt = nowIso();
  const channels = all("SELECT * FROM channels WHERE workspace_id = ? ORDER BY created_at ASC", [workspaceId]);
  const auditChannelId = channels[0]?.id || null;
  audit({
    workspaceId,
    channelId: auditChannelId,
    actorType: "human",
    action: "delete_workspace_archive",
    result: "allowed",
    detail: "删除工作空间前已完整归档任务、讨论、消息、证据、决策和内容资产。"
  });
  const teamStatePath = exportTeamStateSnapshot(workspaceId, null);
  const contentArchivePath = exportContentArchive(workspaceId, null);
  const agents = all("SELECT * FROM agents WHERE workspace_id = ? ORDER BY agent_kind ASC, is_primary DESC, created_at ASC", [
    workspaceId
  ]);
  const messages = all("SELECT * FROM messages WHERE workspace_id = ? ORDER BY created_at ASC", [workspaceId]);
  const messageAttachments = all("SELECT * FROM message_attachments WHERE workspace_id = ? ORDER BY created_at ASC", [
    workspaceId
  ]).map(serializeMessageAttachment);
  const audits = all("SELECT * FROM audits WHERE workspace_id = ? ORDER BY created_at ASC", [workspaceId]);
  const taskRuns = all(
    `SELECT tr.*, a.name AS primary_agent_name, a.role AS primary_agent_role, a.hermes_profile AS primary_agent_profile
     FROM task_runs tr
     LEFT JOIN agents a ON a.id = tr.primary_agent_id
     WHERE tr.workspace_id = ?
     ORDER BY tr.created_at ASC`,
    [workspaceId]
  );
  const discussionRuns = all(
    `SELECT dr.*, a.name AS organizer_agent_name, a.role AS organizer_agent_role, a.hermes_profile AS organizer_agent_profile
     FROM discussion_runs dr
     LEFT JOIN agents a ON a.id = dr.organizer_agent_id
     WHERE dr.workspace_id = ?
     ORDER BY dr.created_at ASC`,
    [workspaceId]
  );
  const discussionAgents = all(
    `SELECT da.*, dr.workspace_id, dr.channel_id, a.name AS agent_name, a.role AS agent_role, a.hermes_profile AS agent_profile
     FROM discussion_agents da
     JOIN discussion_runs dr ON dr.id = da.discussion_id
     LEFT JOIN agents a ON a.id = da.agent_id
     WHERE dr.workspace_id = ?
     ORDER BY dr.created_at ASC, a.created_at ASC`,
    [workspaceId]
  );
  const blackboardEntries = all("SELECT * FROM blackboard_entries WHERE workspace_id = ? ORDER BY updated_at ASC", [
    workspaceId
  ]);
	  const runtimeLocks = all("SELECT * FROM runtime_locks WHERE workspace_id = ? ORDER BY acquired_at ASC", [workspaceId]);
	  const taskDiscussionLinks = all("SELECT * FROM task_discussion_links WHERE workspace_id = ? ORDER BY created_at ASC", [
	    workspaceId
	  ]);
  const evidenceItems = all(
    `SELECT ei.*, a.name AS agent_name, a.role AS agent_role, a.hermes_profile AS agent_profile
     FROM evidence_items ei
     LEFT JOIN agents a ON a.id = ei.agent_id
     WHERE ei.workspace_id = ?
     ORDER BY ei.created_at ASC`,
    [workspaceId]
  );
  const decisionRecords = all(
    `SELECT dr.*, a.name AS agent_name, a.role AS agent_role, a.hermes_profile AS agent_profile
     FROM decision_records dr
     LEFT JOIN agents a ON a.id = dr.created_by_agent_id
     WHERE dr.workspace_id = ?
     ORDER BY dr.created_at ASC`,
    [workspaceId]
  );
  const contentAssets = all(
    `SELECT ca.*, a.name AS created_by_agent_name, a.role AS created_by_agent_role, a.hermes_profile AS created_by_agent_profile
     FROM content_assets ca
     LEFT JOIN agents a ON a.id = ca.created_by_id
     WHERE ca.workspace_id = ?
     ORDER BY ca.created_at ASC`,
    [workspaceId]
  );
  const archive = {
    schema_version: 1,
    archive_type: "deleted_workspace",
    deleted_at: deletedAt,
    workspace,
    channels,
    agents,
    messages,
    message_attachments: messageAttachments,
    task_runs: taskRuns,
    discussion_runs: discussionRuns,
	    discussion_agents: discussionAgents,
	    task_discussion_links: taskDiscussionLinks,
	    blackboard_entries: blackboardEntries,
	    runtime_locks: runtimeLocks,
    evidence_items: evidenceItems,
    decision_records: decisionRecords,
    content_assets: contentAssets,
    audits,
    files: {
      team_state_path: teamStatePath,
      content_archive_path: contentArchivePath
    },
    counts: {
      channels: channels.length,
      agents: agents.length,
      messages: messages.length,
      message_attachments: messageAttachments.length,
      task_runs: taskRuns.length,
	      discussion_runs: discussionRuns.length,
	      discussion_agents: discussionAgents.length,
	      task_discussion_links: taskDiscussionLinks.length,
	      runtime_locks: runtimeLocks.length,
      evidence_items: evidenceItems.length,
      decision_records: decisionRecords.length,
      content_assets: contentAssets.length,
      audits: audits.length
    }
  };
  const filePath = deletedWorkspaceArchiveFilePath(workspaceId, deletedAt);
  fs.writeFileSync(filePath, JSON.stringify(archive, null, 2));
  return filePath;
}

function purgeWorkspaceRows(workspaceId) {
  run(
    `DELETE FROM discussion_agents
     WHERE discussion_id IN (SELECT id FROM discussion_runs WHERE workspace_id = ?)
        OR agent_id IN (SELECT id FROM agents WHERE workspace_id = ?)`,
    [workspaceId, workspaceId]
  );
  run(
    `DELETE FROM agent_channels
     WHERE agent_id IN (SELECT id FROM agents WHERE workspace_id = ?)
        OR channel_id IN (SELECT id FROM channels WHERE workspace_id = ?)`,
    [workspaceId, workspaceId]
	  );
	  run("DELETE FROM evidence_items WHERE workspace_id = ?", [workspaceId]);
	  run("DELETE FROM decision_records WHERE workspace_id = ?", [workspaceId]);
	  run("DELETE FROM content_assets WHERE workspace_id = ?", [workspaceId]);
	  run("DELETE FROM message_attachments WHERE workspace_id = ?", [workspaceId]);
	  run("DELETE FROM runtime_locks WHERE workspace_id = ?", [workspaceId]);
	  run("DELETE FROM task_discussion_links WHERE workspace_id = ?", [workspaceId]);
	  run("DELETE FROM blackboard_entries WHERE workspace_id = ?", [workspaceId]);
  run("DELETE FROM messages WHERE workspace_id = ?", [workspaceId]);
  run("DELETE FROM audits WHERE workspace_id = ?", [workspaceId]);
  run("DELETE FROM task_runs WHERE workspace_id = ?", [workspaceId]);
  run("DELETE FROM discussion_runs WHERE workspace_id = ?", [workspaceId]);
  run("DELETE FROM agents WHERE workspace_id = ?", [workspaceId]);
  run("DELETE FROM channels WHERE workspace_id = ?", [workspaceId]);
  run("DELETE FROM workspaces WHERE id = ?", [workspaceId]);
  safeRemovePath(path.join(messageAttachmentRoot(), workspaceId));
}

async function cleanupEmptyLegacySeedWorkspaces() {
  const candidates = all(
    `SELECT DISTINCT w.*
     FROM workspaces w
     JOIN audits a ON a.workspace_id = w.id
     WHERE a.action = 'seed_workspace'`
  );
  for (const workspace of candidates) {
    const hasUserActivity = Boolean(
      get(
        `SELECT 1 AS found
         FROM messages
         WHERE workspace_id = ? AND sender_type = 'human'
         LIMIT 1`,
        [workspace.id]
      ) ||
        get("SELECT 1 AS found FROM task_runs WHERE workspace_id = ? LIMIT 1", [workspace.id]) ||
        get("SELECT 1 AS found FROM discussion_runs WHERE workspace_id = ? LIMIT 1", [workspace.id]) ||
        get("SELECT 1 AS found FROM content_assets WHERE workspace_id = ? LIMIT 1", [workspace.id])
    );
    if (hasUserActivity) continue;
    const agents = all("SELECT * FROM agents WHERE workspace_id = ?", [workspace.id]);
    for (const agent of agents) {
      if (!agent.owned_by_app) continue;
      if (agentBackend(agent) === "hermes") {
        await deleteOwnedHermesProfile(agent.hermes_profile).catch(() => undefined);
      }
    }
    purgeWorkspaceRows(workspace.id);
  }
}

function getState(activeWorkspaceId, activeChannelId) {
  const workspaces = all("SELECT * FROM workspaces ORDER BY created_at ASC");
  const workspace = workspaces.find((item) => item.id === activeWorkspaceId) || workspaces[0] || null;
  const workspaceId = workspace?.id || null;
  const channels = workspaceId
    ? all("SELECT * FROM channels WHERE workspace_id = ? ORDER BY created_at ASC", [workspaceId])
    : [];
  const channel = channels.find((item) => item.id === activeChannelId) || channels[0] || null;
  const channelId = channel?.id || null;
  if (workspaceId) {
    reapStaleRuntimeLocks(workspaceId, channelId);
    reapWaitingDiscussionLinks(workspaceId, channelId);
    maybePruneTaskSandboxes();
  }
  const agents = workspaceId
    ? all(
        `SELECT a.*,
          CASE WHEN ac.channel_id IS NULL THEN 0 ELSE 1 END AS in_active_channel
         FROM agents a
         LEFT JOIN agent_channels ac ON ac.agent_id = a.id AND ac.channel_id = ?
         WHERE a.workspace_id = ?
         ORDER BY a.is_primary DESC, a.created_at ASC`,
        [channelId, workspaceId]
      )
    : [];
  const messages = workspaceId && channelId
    ? all("SELECT * FROM messages WHERE workspace_id = ? AND channel_id = ? ORDER BY created_at ASC", [
        workspaceId,
        channelId
      ])
    : [];
  const messageAttachments = workspaceId && channelId
    ? listAttachmentsForMessages(
        workspaceId,
        channelId,
        messages.map((message) => message.id)
      )
    : [];
  const attachmentsByMessageId = new Map();
  for (const attachment of messageAttachments) {
    const items = attachmentsByMessageId.get(attachment.message_id) || [];
    items.push(attachment);
    attachmentsByMessageId.set(attachment.message_id, items);
  }
  const messagesWithAttachments = messages.map((message) => ({
    ...message,
    attachments: attachmentsByMessageId.get(message.id) || []
  }));
  const audits = workspaceId
    ? all(
        `SELECT * FROM audits
         WHERE workspace_id = ?
         ORDER BY created_at DESC
         LIMIT 80`,
        [workspaceId]
      )
    : [];
  const taskRuns = workspaceId && channelId
    ? all(
        `SELECT tr.*,
          COALESCE((
            SELECT COUNT(*)
            FROM agents a
            WHERE a.task_run_id = tr.id AND a.is_temporary = 1
          ), 0) AS temporary_agent_count
         FROM task_runs tr
         WHERE tr.workspace_id = ? AND tr.channel_id = ?
         ORDER BY tr.created_at DESC
         LIMIT 30`,
        [workspaceId, channelId]
      )
    : [];
  const discussionRuns = workspaceId && channelId
    ? all(
        `SELECT dr.*
         FROM discussion_runs dr
         WHERE dr.workspace_id = ? AND dr.channel_id = ?
         ORDER BY dr.created_at DESC
         LIMIT 30`,
        [workspaceId, channelId]
      )
    : [];
  const discussionAgents = workspaceId && channelId
    ? all(
        `SELECT da.*,
          dr.workspace_id,
          dr.channel_id,
          a.name AS agent_name,
          a.role AS agent_role,
          a.status AS agent_status
         FROM discussion_agents da
         JOIN discussion_runs dr ON dr.id = da.discussion_id
         JOIN agents a ON a.id = da.agent_id
         WHERE dr.workspace_id = ? AND dr.channel_id = ?
         ORDER BY dr.created_at DESC, a.created_at ASC`,
        [workspaceId, channelId]
      )
    : [];
  const blackboardEntries = workspaceId
    ? all(
        `SELECT *
         FROM blackboard_entries
         WHERE workspace_id = ?
         ORDER BY updated_at DESC
         LIMIT 40`,
        [workspaceId]
      )
    : [];
	  const runtimeLocks = workspaceId
	    ? all(
        `SELECT *
         FROM runtime_locks
         WHERE workspace_id = ?
         ORDER BY status ASC, acquired_at DESC
         LIMIT 60`,
        [workspaceId]
	    )
	    : [];
	  const taskDiscussionLinks = workspaceId && channelId
	    ? all(
	        `SELECT *
	         FROM task_discussion_links
	         WHERE workspace_id = ? AND channel_id = ?
	         ORDER BY created_at DESC
	         LIMIT 40`,
	        [workspaceId, channelId]
	      )
	    : [];
	  const evidenceItems = workspaceId && channelId
    ? all(
        `SELECT ei.*, a.name AS agent_name
         FROM evidence_items ei
         LEFT JOIN agents a ON a.id = ei.agent_id
         WHERE ei.workspace_id = ? AND ei.channel_id = ?
         ORDER BY ei.created_at DESC
         LIMIT 80`,
        [workspaceId, channelId]
      )
    : [];
  const decisionRecords = workspaceId && channelId
    ? all(
        `SELECT dr.*, a.name AS agent_name
         FROM decision_records dr
         LEFT JOIN agents a ON a.id = dr.created_by_agent_id
         WHERE dr.workspace_id = ? AND dr.channel_id = ?
         ORDER BY dr.created_at DESC
         LIMIT 40`,
        [workspaceId, channelId]
      )
    : [];
  const contentAssets = workspaceId && channelId
    ? all(
        `SELECT ca.*, a.name AS created_by_agent_name
         FROM content_assets ca
         LEFT JOIN agents a ON a.id = ca.created_by_id
         WHERE ca.workspace_id = ? AND ca.channel_id = ?
         ORDER BY ca.importance DESC, ca.created_at DESC
         LIMIT 100`,
        [workspaceId, channelId]
      )
    : [];
  const teamStatePath = workspaceId ? exportTeamStateSnapshot(workspaceId, channelId) : "";
  const contentArchivePath = workspaceId ? contentArchiveFilePath(workspaceId) : "";

  return {
    workspaces,
    channels,
    agents,
    messages: messagesWithAttachments,
    messageAttachments,
    audits,
    taskRuns,
    discussionRuns,
	    discussionAgents,
	    blackboardEntries,
	    runtimeLocks,
	    taskDiscussionLinks,
	    evidenceItems,
    decisionRecords,
    contentAssets,
    activeWorkspaceId: workspaceId,
    activeChannelId: channelId,
    teamStatePath,
    contentArchivePath,
    dbFilePath,
	    hermesPath: hermesBin(),
	    hermesMode: process.env.HAT_HERMES_MODE === "mock" ? "mock" : "live",
	    hermesModelState: readHermesModelState(),
	    dataHealth: getCachedDataHealthReport(),
	    mobileServer: mobileServerState()
	  };
	}

function preferredMobilePort() {
  const parsed = Number(process.env.HAT_MOBILE_PORT || MOBILE_SERVER_DEFAULT_PORT);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : MOBILE_SERVER_DEFAULT_PORT;
}

function localNetworkHost() {
  const interfaces = os.networkInterfaces();
  const fallback = [];
  for (const [name, items] of Object.entries(interfaces)) {
    for (const item of items || []) {
      if (item.family !== "IPv4" || item.internal) continue;
      if (/^(utun|awdl|llw|bridge|vmnet|vnic)/i.test(name)) {
        fallback.push(item.address);
        continue;
      }
      return item.address;
    }
  }
  return fallback[0] || "127.0.0.1";
}

function mobileTokenPreview() {
  return `${MOBILE_ACCESS_TOKEN.slice(0, 4)}...${MOBILE_ACCESS_TOKEN.slice(-4)}`;
}

function mobileBonjourName() {
  const host = os.hostname().replace(/\.local$/i, "") || "Mac";
  return `Hermes Agent Team ${host}`.slice(0, 63);
}

function mobileBonjourTxtRecords() {
  return [
    `token=${MOBILE_ACCESS_TOKEN}`,
    `host=${localNetworkHost()}`,
    "path=/mobile",
    "api=/api/team",
    "version=1"
  ];
}

function stopMobileBonjour() {
  if (!mobileBonjourProcess) return;
  mobileBonjourStopping = true;
  const processToStop = mobileBonjourProcess;
  mobileBonjourProcess = null;
  processToStop.kill();
}

function startMobileBonjour(port) {
  stopMobileBonjour();
  mobileBonjourWarning = "";
  if (!port || process.env.HAT_MOBILE_BONJOUR === "0") return;
  const dnsSdPath = "/usr/bin/dns-sd";
  if (!fs.existsSync(dnsSdPath)) {
    mobileBonjourWarning = "未找到系统自动发现服务，手机端需要手动输入地址。";
    return;
  }
  mobileBonjourStopping = false;
  const args = ["-R", mobileBonjourName(), MOBILE_BONJOUR_TYPE, "local", String(port), ...mobileBonjourTxtRecords()];
  const child = spawn(dnsSdPath, args, { stdio: ["ignore", "ignore", "pipe"] });
  mobileBonjourProcess = child;
  child.stderr.on("data", (chunk) => {
    const text = String(chunk || "").trim();
    if (text) mobileBonjourWarning = `自动发现提示：${text.slice(0, 240)}`;
  });
  child.on("error", (error) => {
    if (mobileBonjourProcess === child) mobileBonjourProcess = null;
    mobileBonjourWarning = `自动发现启动失败：${String(error.message || error)}`;
  });
  child.on("exit", (code, signal) => {
    if (mobileBonjourProcess === child) mobileBonjourProcess = null;
    if (!mobileBonjourStopping && code !== 0) {
      mobileBonjourWarning = `自动发现已停止：${signal || `退出码 ${code}`}`;
    }
    mobileBonjourStopping = false;
  });
}

function mobileServerState() {
  const address = mobileServer?.address?.();
  const port = typeof address === "object" && address ? address.port : 0;
  const host = port ? localNetworkHost() : "";
  const loopbackOnly = host === "127.0.0.1";
  const warning = mobileServerWarning || mobileBonjourWarning || (loopbackOnly ? "未找到局域网 IPv4，手机可能无法直接访问。" : "");
  return {
    enabled: Boolean(port),
    host,
    port,
    url: port ? `http://${host}:${port}/mobile?token=${encodeURIComponent(MOBILE_ACCESS_TOKEN)}` : "",
    tokenPreview: mobileTokenPreview(),
    warning,
    discovery: {
      enabled: Boolean(mobileBonjourProcess),
      serviceType: MOBILE_BONJOUR_TYPE,
      warning: mobileBonjourWarning
    },
    lastTeamRequest: mobileLastTeamRequest
  };
}

function mobileStaticRoot() {
  return path.join(__dirname, "..", "dist");
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".json": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8"
  };
  return types[ext] || "application/octet-stream";
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text)
  });
  res.end(text);
}

function readJsonRequest(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > MAX_MOBILE_JSON_BYTES) {
        reject(new Error("手机端请求过大。"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("手机端请求 JSON 无效。"));
      }
    });
    req.on("error", reject);
  });
}

function requestHasMobileToken(req, parsedUrl) {
  const headerToken = String(req.headers["x-hat-mobile-token"] || "");
  const queryToken = parsedUrl.searchParams.get("token") || "";
  return headerToken === MOBILE_ACCESS_TOKEN || queryToken === MOBILE_ACCESS_TOKEN;
}

function serveMobileAsset(res, pathname) {
  const root = mobileStaticRoot();
  const indexPath = path.join(root, "index.html");
  const cleanPath = decodeURIComponent(pathname);
  const requestedPath =
    cleanPath === "/" || cleanPath === "/mobile" || cleanPath === "/mobile/"
      ? indexPath
      : path.join(root, cleanPath.replace(/^\/+/, ""));
  const target = fs.existsSync(requestedPath) && fs.statSync(requestedPath).isFile() ? requestedPath : indexPath;
  if (!fs.existsSync(target) || (target !== root && !isPathInside(root, target) && target !== indexPath)) {
    sendText(res, 404, "Mobile app bundle not found. Run npm run build first.");
    return;
  }
  const body = fs.readFileSync(target);
  res.writeHead(200, {
    "Content-Type": contentTypeFor(target),
    "Content-Length": body.length,
    "Cache-Control": target === indexPath ? "no-store" : "public, max-age=31536000, immutable"
  });
  res.end(body);
}

async function handleMobileTeamAction(method, payload = {}) {
  if (method === "bootstrap") return getState(payload.workspaceId, payload.channelId);
  if (method === "refresh-data-health") {
    const report = buildDataHealthReport({ persist: true });
    dataHealthCache = { at: Date.now(), report };
    return getState(payload.workspaceId, payload.channelId);
  }
  if (method === "repair-data-health") {
    await repairDataHealth({
      repairMode: normalizeDataRepairMode({
        repairMode: payload.repairMode,
        cleanupProfiles: Boolean(payload.cleanupProfiles)
      }),
      actorType: "human",
      enforceCooldown: true
    });
    return getState(payload.workspaceId, payload.channelId);
  }
  if (method === "open-data-governance-path") {
    const kind = String(payload.kind || "");
    const root = dataGovernanceDir();
    const target =
      kind === "profile_archive"
        ? dataProfileArchiveDir()
        : kind === "backups"
          ? dataBackupDir()
          : kind === "reports"
            ? dataHealthReportDir()
            : root;
    if (target !== root && !isPathInside(root, target)) throw new Error("只能访问数据治理受控目录。");
    fs.mkdirSync(target, { recursive: true });
    return { ok: true, path: target };
  }
  if (method === "create-workspace") {
    const workspaceId = makeId("ws");
    const channelId = makeId("ch");
    run("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)", [
      workspaceId,
      String(payload.name || "新工作空间").trim(),
      nowIso()
    ]);
    run("INSERT INTO channels (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)", [
      channelId,
      workspaceId,
      "总群",
      nowIso()
    ]);
    audit({
      workspaceId,
      channelId,
      actorType: "human",
      action: "create_workspace_mobile",
      result: "allowed",
      detail: "手机端创建工作空间并生成默认消息流。"
    });
    saveDb();
    try {
      await ensureWorkspaceBaseAgents({ workspaceId, channelId, actorType: "system" });
    } catch (error) {
      const agents = all("SELECT * FROM agents WHERE workspace_id = ?", [workspaceId]);
      for (const agent of agents) {
        if (agent.owned_by_app && agentBackend(agent) === "hermes") {
          await deleteOwnedHermesProfile(agent.hermes_profile).catch(() => undefined);
        }
      }
      run("DELETE FROM workspaces WHERE id = ?", [workspaceId]);
      saveDb();
      throw new Error(`工作空间创建失败：${String(error.message || error).slice(0, 700)}`);
    }
    return getState(workspaceId, channelId);
  }
  if (method === "delete-workspace") {
    const workspace = get("SELECT * FROM workspaces WHERE id = ?", [payload.workspaceId]);
    if (!workspace) return getState();
    archiveWorkspaceBeforeDelete(workspace.id);
    const agents = all("SELECT * FROM agents WHERE workspace_id = ?", [workspace.id]);
    for (const agent of agents) {
      if (agent.owned_by_app && agentBackend(agent) === "hermes") await deleteOwnedHermesProfile(agent.hermes_profile);
    }
    purgeWorkspaceRows(workspace.id);
    saveDb();
    return getState();
  }
  if (method === "create-channel") {
    const workspace = get("SELECT * FROM workspaces WHERE id = ?", [payload.workspaceId]);
    if (!workspace) throw new Error("工作空间不存在。");
    const channelId = makeId("ch");
    run("INSERT INTO channels (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)", [
      channelId,
      workspace.id,
      String(payload.name || "新频道").trim(),
      nowIso()
    ]);
    audit({
      workspaceId: workspace.id,
      channelId,
      actorType: "human",
      action: "create_channel_mobile",
      result: "allowed",
      detail: "手机端创建频道。"
    });
    saveDb();
    return getState(workspace.id, channelId);
  }
  if (method === "delete-channel") {
    const channel = get("SELECT * FROM channels WHERE id = ?", [payload.channelId]);
    if (!channel) return getState(payload.workspaceId);
    run("DELETE FROM channels WHERE id = ?", [channel.id]);
    saveDb();
    return getState(channel.workspace_id);
  }
  if (method === "create-agent") {
    const agentKind = payload.agentKind === "discussion" ? "discussion" : "task";
    const agent = await createAgentInternal({
      workspaceId: payload.workspaceId,
      channelId: payload.channelId,
      name: payload.name,
      role: payload.role,
      description: payload.description,
      coreCommand: payload.coreCommand,
      modelProvider: payload.modelProvider,
      modelName: payload.modelName,
      runtimeBackend: payload.runtimeBackend,
      parentAgentId: agentKind === "task" ? payload.parentAgentId || null : null,
      createdByAgentId: null,
      agentKind
    });
    return getState(agent.workspace_id, payload.channelId);
  }
  if (method === "delete-agent") {
    await deleteAgentInternal({
      agentId: payload.agentId,
      actorType: "human",
      actorId: null,
      channelId: payload.channelId
    });
    return getState(payload.workspaceId, payload.channelId);
  }
  if (method === "set-agent-channel") {
    const agent = get("SELECT * FROM agents WHERE id = ?", [payload.agentId]);
    const channel = get("SELECT * FROM channels WHERE id = ?", [payload.channelId]);
    if (!agent || !channel || agent.workspace_id !== channel.workspace_id) throw new Error("Agent 或工作空间不存在。");
    if (payload.enabled) {
      run("INSERT OR IGNORE INTO agent_channels (agent_id, channel_id) VALUES (?, ?)", [agent.id, channel.id]);
    } else {
      run("DELETE FROM agent_channels WHERE agent_id = ? AND channel_id = ?", [agent.id, channel.id]);
    }
    audit({
      workspaceId: agent.workspace_id,
      channelId: channel.id,
      actorType: "human",
      action: "set_agent_channel_mobile",
      result: "allowed",
      detail: `${payload.enabled ? "加入" : "移出"}空间：${agent.name}`
    });
    saveDb();
    return getState(agent.workspace_id, channel.id);
  }
  if (method === "update-agent-config") {
    const agent = get("SELECT * FROM agents WHERE id = ?", [payload.agentId]);
    const channel = get("SELECT * FROM channels WHERE id = ?", [payload.channelId]);
    if (!agent || !channel || agent.workspace_id !== channel.workspace_id) throw new Error("Agent 或工作空间不存在。");
    await updateAgentRuntimeConfig({
      agent,
      channel,
      payload,
      actorType: "human",
      action: "update_agent_config_mobile"
    });
    return getState(agent.workspace_id, channel.id);
  }
  if (method === "start-task-run") return startTaskRunInternal(payload);
  if (method === "send-channel-message") return sendChannelMessageInternal(payload);
  if (method === "run-slash-command") return runSlashCommandInternal(payload);
  if (method === "confirm-task-cleanup") {
    const taskRun = getTaskRun(payload.taskRunId);
    if (!taskRun) throw new Error("任务记录不存在。");
    if (!["awaiting_confirmation", "failed"].includes(taskRun.status)) throw new Error("任务还不能确认清理。");
    const roots = temporaryAgentRoots(taskRun.id);
    for (const agent of roots) {
      await deleteAgentInternal({ agentId: agent.id, actorType: "human", actorId: null, channelId: taskRun.channel_id });
    }
    run(
      `UPDATE task_runs
       SET status = 'cleaned',
         cleaned_at = ?
       WHERE id = ?`,
      [nowIso(), taskRun.id]
    );
    addEvidenceItem({
      workspaceId: taskRun.workspace_id,
      channelId: taskRun.channel_id,
      taskRunId: taskRun.id,
      agentId: taskRun.primary_agent_id,
      kind: "task_cleanup",
      title: "手机端确认完成并清理",
      content: `人已从手机端确认任务完成，清理 ${roots.length} 个临时 Agent，只保留输出和证据记录。`,
      metadata: { temporaryAgentsCleaned: roots.length, source: "mobile" }
    });
    upsertBlackboardEntry({
      workspaceId: taskRun.workspace_id,
      channelId: taskRun.channel_id,
      key: "current_task",
      scope: "task",
      value: { taskRunId: taskRun.id, objective: taskRun.objective, status: "cleaned", temporaryAgentsCleaned: roots.length },
      updatedByType: "human"
    });
    audit({
      workspaceId: taskRun.workspace_id,
      channelId: taskRun.channel_id,
      actorType: "human",
      action: "task_cleanup_mobile",
      result: "allowed",
      detail: `手机端确认任务完成，已清理 ${roots.length} 个临时 Agent。`
    });
    insertMessage({
      workspaceId: taskRun.workspace_id,
      channelId: taskRun.channel_id,
      senderType: "system",
      senderName: "系统",
      mode: "system",
      content: roots.length > 0 ? `手机端已确认任务完成，已清理 ${roots.length} 个临时 Agent。` : "手机端已确认任务完成，没有需要清理的临时 Agent。",
      status: "visible"
    });
    saveDb();
    return getState(taskRun.workspace_id, taskRun.channel_id);
  }
  if (method === "run-sandbox-quick-action") return runSandboxQuickAction(payload);
  if (method === "start-discussion") return startDiscussionInternal(payload);
  if (method === "respond-discussion") return respondDiscussionInternal(payload);
  if (method === "continue-discussion") {
    const discussion = get("SELECT * FROM discussion_runs WHERE id = ?", [payload.discussionId]);
    if (!discussion) throw new Error("讨论不存在。");
    if (discussion.status !== "active") throw new Error("讨论当前不能继续，需要先批准或已关闭。");
    triggerDiscussionRound({ discussionId: discussion.id, channelId: discussion.channel_id }).catch((error) => {
      releaseRuntimeLocks({
        sessionIds: [discussionLockSession(discussion.id)],
        ownerType: "discussion_run",
        ownerId: discussion.id,
        status: "failed"
      });
      audit({
        workspaceId: discussion.workspace_id,
        channelId: discussion.channel_id,
        actorType: "system",
        action: "discussion_background_run_mobile",
        result: "failed",
        detail: summarizeError(error.message || error)
      });
      saveDb();
    });
    return getState(discussion.workspace_id, discussion.channel_id);
  }
  if (method === "approve-discussion-rounds") {
    const discussion = get("SELECT * FROM discussion_runs WHERE id = ?", [payload.discussionId]);
    if (!discussion) throw new Error("讨论不存在。");
    if (discussion.status === "closed") throw new Error("讨论已关闭。");
    const requestedRounds = Math.max(1, Math.min(MAX_DISCUSSION_ROUNDS, Number(payload.extraRounds || 1)));
    const extraRounds = remainingDiscussionRounds(discussion, requestedRounds);
    if (extraRounds <= 0) throw new Error(`讨论已达到硬上限 ${MAX_DISCUSSION_ROUNDS} 轮。`);
    run(
      `UPDATE discussion_agents
       SET round_limit = round_limit + ?,
         status = 'active'
       WHERE discussion_id = ?`,
      [extraRounds, discussion.id]
    );
    run("UPDATE discussion_runs SET status = 'active', round_limit = round_limit + ? WHERE id = ?", [extraRounds, discussion.id]);
    upsertBlackboardEntry({
      workspaceId: discussion.workspace_id,
      channelId: discussion.channel_id,
      key: "active_discussion",
      scope: "discussion",
      value: { discussionId: discussion.id, topic: discussion.topic, status: "active", extraRounds },
      updatedByType: "human"
    });
    audit({
      workspaceId: discussion.workspace_id,
      channelId: discussion.channel_id,
      actorType: "human",
      action: "discussion_approve_rounds_mobile",
      result: "allowed",
      detail: `手机端授权讨论 Leader Agent 继续 ${extraRounds} 轮判断。`
    });
    insertMessage({
      workspaceId: discussion.workspace_id,
      channelId: discussion.channel_id,
      senderType: "system",
      senderName: "系统",
      mode: "discussion",
      content: `手机端已授权讨论 Leader Agent 继续 ${extraRounds} 轮判断。`,
      status: "visible"
    });
    saveDb();
    triggerDiscussionRound({ discussionId: discussion.id, channelId: discussion.channel_id }).catch((error) => {
      releaseRuntimeLocks({
        sessionIds: [discussionLockSession(discussion.id)],
        ownerType: "discussion_run",
        ownerId: discussion.id,
        status: "failed"
      });
      audit({
        workspaceId: discussion.workspace_id,
        channelId: discussion.channel_id,
        actorType: "system",
        action: "discussion_background_run_mobile",
        result: "failed",
        detail: summarizeError(error.message || error)
      });
      saveDb();
    });
    return getState(discussion.workspace_id, discussion.channel_id);
  }
  if (method === "close-discussion") {
    const discussion = get("SELECT * FROM discussion_runs WHERE id = ?", [payload.discussionId]);
    if (!discussion) throw new Error("讨论不存在。");
    run("UPDATE discussion_runs SET status = 'closed', closed_at = ? WHERE id = ?", [nowIso(), discussion.id]);
    releaseRuntimeLocks({ sessionIds: [discussionLockSession(discussion.id)], ownerType: "discussion_run", ownerId: discussion.id });
    await cleanupTemporaryDiscussionAgents({ discussionId: discussion.id, channelId: discussion.channel_id });
    upsertBlackboardEntry({
      workspaceId: discussion.workspace_id,
      channelId: discussion.channel_id,
      key: "active_discussion",
      scope: "discussion",
      value: { discussionId: discussion.id, topic: discussion.topic, status: "closed" },
      updatedByType: "human"
    });
    audit({
      workspaceId: discussion.workspace_id,
      channelId: discussion.channel_id,
      actorType: "human",
      action: "discussion_close_mobile",
      result: "allowed",
      detail: "手机端关闭讨论。"
    });
    saveDb();
    return getState(discussion.workspace_id, discussion.channel_id);
  }
  if (method === "test-runtime-lock-lifecycle") return testRuntimeLockLifecycle(payload);
  if (method === "test-task-discussion-bridge-reliability") return testTaskDiscussionBridgeReliability(payload);
  if (method === "test-reliability-closure") return testReliabilityClosure(payload);
  if (method === "test-data-governance") return testDataGovernance(payload);
  throw new Error(`手机端不支持的操作：${method}`);
}

async function handleMobileRequest(req, res) {
  const parsedUrl = new URL(req.url || "/", "http://127.0.0.1");
  if (parsedUrl.pathname.startsWith("/api/attachments/")) {
    if (req.method !== "GET") {
      sendText(res, 405, "只支持 GET。");
      return;
    }
    serveMessageAttachment(req, res, parsedUrl);
    return;
  }

  if (parsedUrl.pathname.startsWith("/api/team/")) {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "只支持 POST。" });
      return;
    }
    if (!requestHasMobileToken(req, parsedUrl)) {
      sendJson(res, 401, { error: "手机端访问令牌无效，请从桌面端复制新的手机链接。" });
      return;
    }
    try {
      const method = parsedUrl.pathname.replace(/^\/api\/team\//, "");
      mobileLastTeamRequest = {
        at: nowIso(),
        method,
        remoteAddress: req.socket.remoteAddress || "",
        userAgent: String(req.headers["user-agent"] || "").slice(0, 120)
      };
      const payload = await readJsonRequest(req);
      const result = await handleMobileTeamAction(method, payload);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 500, { error: summarizeError(error.message || error) });
    }
    return;
  }

  if (parsedUrl.pathname === "/api/mobile/status") {
    if (!requestHasMobileToken(req, parsedUrl)) {
      sendJson(res, 401, { error: "手机端访问令牌无效。" });
      return;
    }
    sendJson(res, 200, { ok: true, mobileServer: mobileServerState() });
    return;
  }

  if (parsedUrl.pathname === "/") {
    res.writeHead(302, { Location: `/mobile?token=${encodeURIComponent(MOBILE_ACCESS_TOKEN)}` });
    res.end();
    return;
  }

  serveMobileAsset(res, parsedUrl.pathname);
}

function startMobileServer(port = preferredMobilePort()) {
  if (process.env.HAT_MOBILE_SERVER === "0") {
    mobileServerWarning = "手机端服务已通过 HAT_MOBILE_SERVER=0 关闭。";
    return;
  }
  const server = http.createServer((req, res) => {
    handleMobileRequest(req, res).catch((error) => {
      sendJson(res, 500, { error: summarizeError(error.message || error) });
    });
  });
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE" && port !== 0) {
      startMobileServer(0);
      return;
    }
    mobileServerWarning = `手机端服务启动失败：${String(error.message || error)}`;
    console.warn(mobileServerWarning);
  });
  server.listen(port, "0.0.0.0", () => {
    mobileServer = server;
    startMobileBonjour(server.address().port);
    const state = mobileServerState();
    mobileServerWarning = state.warning;
    console.log(`Hermes Agent Team mobile app: ${state.url}`);
  });
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow();
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 720,
    minHeight: 620,
    title: "Hermes Agent Team",
    backgroundColor: "#f6f5f1",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.once("ready-to-show", showMainWindow);
  mainWindow.webContents.once("did-finish-load", showMainWindow);
  mainWindow.webContents.on("did-fail-load", (_event, code, description, validatedURL) => {
    console.error("Hermes Agent Team failed to load", { code, description, validatedURL });
    showMainWindow();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173";
  if (!app.isPackaged && process.env.HAT_USE_DEV_SERVER === "1") {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  return mainWindow;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  if (process.platform === "darwin") {
    try {
      app.focus({ steal: true });
    } catch {
      app.focus();
    }
  }
  mainWindow.focus();
}

function redactCommandArgs(args = []) {
  let redactNext = false;
  return args.map((arg) => {
    const value = String(arg);
    if (redactNext) {
      redactNext = false;
      return `<redacted:${value.length} chars>`;
    }
    if (["-q", "--query", "--prompt"].includes(value)) {
      redactNext = true;
    }
    return value;
  });
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function runCommandDetailed(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout || 120000;
    const startedAt = nowIso();
    const startedMs = Date.now();
    const heartbeatTimer = options.runtimeKey
      ? setInterval(() => heartbeatRuntimeLocksForRun(options.runtimeKey), runtimeLockHeartbeatMs())
      : null;
    const child = execFile(
      command,
      args,
      {
        timeout,
        env: commandEnv(),
        maxBuffer: 1024 * 1024 * 8
      },
      (error, stdout, stderr) => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (options.runtimeKey) heartbeatRuntimeLocksForRun(options.runtimeKey);
        const activeRun = options.runtimeKey ? activeAgentRuns.get(options.runtimeKey) : null;
        const finishedAt = nowIso();
        const details = {
          command,
          args: redactCommandArgs(args),
          startedAt,
          finishedAt,
          durationMs: Math.max(0, Date.now() - startedMs),
          timeoutMs: timeout,
          exitCode: error ? error.code || null : 0,
          signal: error?.signal || "",
          timedOut: Boolean(error?.killed || error?.signal === "SIGTERM"),
          stdoutChars: String(stdout || "").length,
          stderrChars: String(stderr || "").length,
          stdoutPreview: compactText(stdout || "", 1200),
          stderrPreview: stderr || error ? compactText(summarizeError(stderr || error?.message || ""), 1200) : ""
        };
        if (error) {
          const rawDetails = `${stdout || ""}\n${stderr || ""}`.trim();
          error.hermesDetails = rawDetails;
          error.commandDetails = details;
          if (activeRun?.canceled) {
            error.canceled = true;
            error.message = "Hermes 运行已被 /stop 停止。";
          } else if (error.code === "ENOENT") {
            error.message = `找不到 Hermes 可执行文件：${command}`;
          } else if (error.killed || error.signal === "SIGTERM") {
            error.message = `Hermes 执行超时：${Math.round(timeout / 1000)} 秒内没有完成回复。`;
          } else {
            const exitText = error.code ? `退出码 ${error.code}` : "未知退出状态";
            error.message = details
              ? `Hermes 执行失败（${exitText}）：${summarizeError(details)}`
              : `Hermes 执行失败（${exitText}）。`;
          }
          reject(error);
          return;
        }
        resolve({
          stdout: (stdout || "").trim(),
          stderr: stderr || "",
          details
        });
      }
    );
    if (options.runtimeKey && activeAgentRuns.has(options.runtimeKey)) {
      activeAgentRuns.get(options.runtimeKey).child = child;
      heartbeatRuntimeLocksForRun(options.runtimeKey);
    }
  });
}

function runCommand(command, args, options = {}) {
  return runCommandDetailed(command, args, options).then((result) => result.stdout);
}

function runSpawnDetailed(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout || 120000;
    const maxBuffer = options.maxBuffer || 1024 * 1024 * 8;
    const label = options.label || path.basename(command);
    const startedAt = nowIso();
    const startedMs = Date.now();
    let stdout = "";
    let stderr = "";
    let settled = false;
    const heartbeatTimer = options.runtimeKey
      ? setInterval(() => heartbeatRuntimeLocksForRun(options.runtimeKey), runtimeLockHeartbeatMs())
      : null;
    const child = spawn(command, args, {
      env: commandEnv(),
      stdio: ["pipe", "pipe", "pipe"]
    });
    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
    }, timeout);

    function appendOutput(target, chunk) {
      const next = String(chunk || "");
      if (target === "stdout") stdout = (stdout + next).slice(-maxBuffer);
      else stderr = (stderr + next).slice(-maxBuffer);
    }

    function finish(error = null, code = 0, signal = "") {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (options.runtimeKey) heartbeatRuntimeLocksForRun(options.runtimeKey);
      const activeRun = options.runtimeKey ? activeAgentRuns.get(options.runtimeKey) : null;
      const finishedAt = nowIso();
      const timedOut = Boolean(signal === "SIGTERM" && Date.now() - startedMs >= timeout - 250);
      const details = {
        command,
        args: redactCommandArgs(args),
        startedAt,
        finishedAt,
        durationMs: Math.max(0, Date.now() - startedMs),
        timeoutMs: timeout,
        exitCode: error ? code || null : code,
        signal: signal || "",
        timedOut,
        stdoutChars: String(stdout || "").length,
        stderrChars: String(stderr || "").length,
        stdoutPreview: compactText(stdout || "", 1200),
        stderrPreview: stderr || error ? compactText(summarizeError(stderr || error?.message || ""), 1200) : ""
      };
      if (activeRun?.canceled) {
        const canceled = canceledRunError(label);
        canceled.commandDetails = details;
        reject(canceled);
        return;
      }
      if (error || code !== 0 || signal) {
        const failure = error instanceof Error ? error : new Error(`${label} 执行失败。`);
        failure.commandDetails = details;
        failure.runtimeDetails = `${stdout || ""}\n${stderr || ""}`.trim();
        if (error?.code === "ENOENT") {
          failure.message = `找不到 ${label} 可执行文件：${command}`;
        } else if (timedOut) {
          failure.message = `${label} 执行超时：${Math.round(timeout / 1000)} 秒内没有完成回复。`;
        } else {
          const exitText = code ? `退出码 ${code}` : signal ? `信号 ${signal}` : "未知退出状态";
          failure.message = `${label} 执行失败（${exitText}）：${summarizeError(details)}`;
        }
        reject(failure);
        return;
      }
      resolve({
        stdout: String(stdout || "").trim(),
        stderr,
        details
      });
    }

    child.stdout.on("data", (chunk) => appendOutput("stdout", chunk));
    child.stderr.on("data", (chunk) => appendOutput("stderr", chunk));
    child.on("error", (error) => finish(error, null, ""));
    child.on("close", (code, signal) => finish(null, code || 0, signal || ""));

    if (options.runtimeKey && activeAgentRuns.has(options.runtimeKey)) {
      activeAgentRuns.get(options.runtimeKey).child = child;
      heartbeatRuntimeLocksForRun(options.runtimeKey);
    }
    if (options.stdin != null) {
      child.stdin.write(String(options.stdin));
    }
    child.stdin.end();
  });
}

function summarizeError(value) {
  if (value && typeof value === "object") {
    const detailText = [
      value.stderrPreview,
      value.stdoutPreview,
      value.message,
      value.error,
      value.command ? `command=${value.command}` : "",
      value.exitCode != null ? `exit=${value.exitCode}` : ""
    ]
      .filter(Boolean)
      .join("\n");
    return summarizeError(detailText || JSON.stringify(value));
  }
  const source = String(value || "");
  if (isHermesIterationLimitOutput(source)) {
    return "Hermes 达到迭代上限，系统已扩大轮数重试但仍未拿到可用结果；请重新发送或拆分任务。";
  }
  if (/timed out|timeout|超时/i.test(source)) {
    return "Hermes 执行超时：超过当前执行时间限制仍未完成回复。可以重新发送任务，或把任务拆短。";
  }
  if (source.includes("找不到 Hermes 可执行文件")) {
    return "找不到 Hermes 可执行文件。";
  }
  if (source.includes("Command failed:") || source.includes("硬性层级规则")) {
    return "Hermes 执行失败。旧版本把完整提示词写进了错误记录，新版已改为显示精简错误；请重新发送任务获取新的状态结果。";
  }

  const raw = source
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.includes("pkg_resources is deprecated"))
    .filter((line) => !line.startsWith("/Users/") || !line.includes("site-packages"))
    .join("\n")
    .replace(/Command failed:[\s\S]*?(?=\n[A-Za-z\u4e00-\u9fa5]|$)/, "")
    .trim();
  return (raw || "Hermes 没有返回可读错误。").slice(0, 700);
}

function isHermesIterationLimitOutput(value) {
  const text = String(value || "");
  return /Reached maximum iterations\s*\(\d+\)|iteration limit|couldn['’]t generate a summary/i.test(text);
}

function buildHermesChatArgs({ profileName, prompt, providerName = "", modelName = "", source = "hermes-agent-team", maxTurns }) {
  return [
    "--profile",
    profileName,
    "chat",
    ...(providerName ? ["--provider", providerName] : []),
    ...(modelName ? ["-m", modelName] : []),
    "-Q",
    "--ignore-rules",
    "--source",
    source,
    "--max-turns",
    String(maxTurns),
    "-q",
    prompt
  ];
}

function retryPromptAfterIterationLimit(prompt, maxTurns) {
  return [
    prompt,
    "",
    "【系统自动重试要求】",
    `上一次 Hermes 执行达到迭代上限。本次最多 ${maxTurns} 轮。`,
    "请立即收敛：先输出可用结论或最小可执行计划；需要组织 Team 时，只给必要的 create_agent/delegate 动作，不要展开长篇思考过程。",
    "如果信息不足，直接列出缺口和下一步验证动作，禁止空转。"
  ].join("\n");
}

function isHermesTimeoutError(error) {
  const details = error?.commandDetails || {};
  const text = `${error?.message || ""}\n${error?.hermesDetails || ""}`;
  return Boolean(details.timedOut || /timed out|timeout|超时/i.test(text));
}

function retryPromptAfterTimeout(prompt, error, maxTurns) {
  const partial = compactText(error?.hermesDetails || error?.commandDetails?.stdoutPreview || error?.commandDetails?.stderrPreview || "", 1800);
  return [
    prompt,
    "",
    "【系统自动恢复要求】",
    `上一次 Hermes 执行超时。本次最多 ${maxTurns} 轮，请基于当前文件系统、已有 Evidence Pack 和下方部分输出继续完成，不要从头重复。`,
    "如果已经生成部分文件，先检查缺失交付物和验收标准，补齐后给最终结论；如果任务需要 Team，先输出必要 create_agent/delegate 动作，不要由主 Agent 单独长时间执行。",
    partial ? `上次部分输出/错误摘要：\n${partial}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sleepForRuntime(ms, runtimeKey) {
  const endAt = Date.now() + ms;
  let lastHeartbeatAt = 0;
  while (Date.now() < endAt) {
    if (runtimeKey && activeAgentRuns.get(runtimeKey)?.canceled) {
      throw canceledRunError("Agent");
    }
    if (runtimeKey && Date.now() - lastHeartbeatAt >= runtimeLockHeartbeatMs()) {
      heartbeatRuntimeLocksForRun(runtimeKey);
      lastHeartbeatAt = Date.now();
    }
    await sleep(Math.min(120, Math.max(0, endAt - Date.now())));
  }
  if (runtimeKey) heartbeatRuntimeLocksForRun(runtimeKey);
}

function commandEnv() {
  const home = os.homedir();
  const user = os.userInfo().username || process.env.USER || process.env.LOGNAME || "hayden";
  const pathParts = [
    path.join(home, ".local", "bin"),
    path.join(home, ".hermes", "hermes-agent", "venv", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    process.env.PATH || ""
  ].filter(Boolean);

  return {
    ...process.env,
    HOME: process.env.HOME || home,
    USER: process.env.USER || user,
    LOGNAME: process.env.LOGNAME || user,
    SHELL: process.env.SHELL || "/bin/zsh",
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    LANG: process.env.LANG || "en_US.UTF-8",
    LC_ALL: process.env.LC_ALL || process.env.LANG || "en_US.UTF-8",
    TERM: process.env.TERM || "xterm-256color",
    PATH: [...new Set(pathParts.join(":").split(":").filter(Boolean))].join(":"),
    HERMES_ACCEPT_HOOKS: "1"
  };
}

function hermesBin() {
  if (process.env.HERMES_BIN) return process.env.HERMES_BIN;
  const candidates = [
    path.join(os.homedir(), ".local", "bin", "hermes"),
    path.join(os.homedir(), ".hermes", "hermes-agent", "venv", "bin", "hermes"),
    "/opt/homebrew/bin/hermes",
    "/usr/local/bin/hermes",
    "hermes"
  ];
  return candidates.find((candidate) => candidate === "hermes" || fs.existsSync(candidate)) || "hermes";
}

function codexBin() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const candidates = [
    path.join(os.homedir(), ".local", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "codex"
  ];
  return candidates.find((candidate) => candidate === "codex" || fs.existsSync(candidate)) || "codex";
}

function profileNameForAgent(name) {
  const clean = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 10);
  const suffix = Math.random().toString(36).replace(/[^a-z0-9]/g, "").slice(2, 6);
  return `hat${Date.now().toString(36)}${clean || "agent"}${suffix}`.slice(0, 30);
}

function runtimeIdentityForAgent(backend, name) {
  if (normalizeAgentBackend(backend) === "codex") {
    const clean = String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 10);
    const suffix = Math.random().toString(36).replace(/[^a-z0-9]/g, "").slice(2, 6);
    return `codex${Date.now().toString(36)}${clean || "agent"}${suffix}`.slice(0, 30);
  }
  return profileNameForAgent(name);
}

async function createHermesProfile(profileName, description, metadata = {}) {
  if (process.env.HAT_HERMES_MODE === "mock") {
    return `mock profile ${profileName} created`;
  }
  const output = await runCommand(
    hermesBin(),
    [
      "profile",
      "create",
      profileName,
      "--clone-from",
      "default",
      "--no-alias",
      "--description",
      description || "Hermes Agent Team managed profile"
    ],
    { timeout: 180000 }
  );
  hardenHermesProfile(profileName, description, metadata);
  return output;
}

async function deleteHermesProfile(profileName) {
  if (process.env.HAT_HERMES_MODE === "mock") {
    return `mock profile ${profileName} deleted`;
  }
  return runCommand(hermesBin(), ["profile", "delete", profileName, "-y"], { timeout: 180000 });
}

async function deleteOwnedHermesProfile(profileName) {
  const normalizedProfileName = String(profileName || "").trim();
  if (!normalizedProfileName) return "missing";
  if (process.env.HAT_HERMES_MODE !== "mock" && !fs.existsSync(hermesProfileDir(normalizedProfileName))) {
    return "already_missing";
  }
  await deleteHermesProfile(normalizedProfileName);
  if (process.env.HAT_HERMES_MODE !== "mock" && fs.existsSync(hermesProfileDir(normalizedProfileName))) {
    throw new Error(`Hermes profile 删除后仍存在：${normalizedProfileName}`);
  }
  return "deleted";
}

function hermesProfileDir(profileName) {
  return path.join(os.homedir(), ".hermes", "profiles", profileName);
}

function hardenHermesProfile(profileName, description, metadata = {}) {
  const profileDir = hermesProfileDir(profileName);
  if (!fs.existsSync(profileDir)) return;
  const markerTime = nowIso();

  const marker = {
    managedBy: "Hermes Agent Team",
    profileName,
    description: description || "",
    createdAt: markerTime,
    updatedAt: markerTime,
    isolation: {
      profile: "new independent Hermes profile",
      inherits: ["config.yaml", "SOUL.md", "skills", "model provider settings"],
      doesNotInherit: ["sessions", "history", "gateway runtime state", "messaging platform identity"]
    },
    agentConfig: metadata.agentConfig || {}
  };
  fs.writeFileSync(path.join(profileDir, ".hermes-agent-team.json"), JSON.stringify(marker, null, 2));
  writeHermesProfileAgentFile(profileName, marker.agentConfig);

  removeInheritedMessagingSecrets(profileDir);
  removeInheritedRuntimeState(profileDir);
}

function writeHermesProfileAgentFile(profileName, agentConfig = {}) {
  if (process.env.HAT_HERMES_MODE === "mock") return;
  const profileDir = hermesProfileDir(profileName);
  if (!fs.existsSync(profileDir)) return;
  const lines = [
    "# Hermes Agent Team Agent Instructions",
    "",
    `Name: ${agentConfig.name || profileName}`,
    `Role: ${agentConfig.role || ""}`,
    `Kind: ${agentConfig.agentKind || ""}`,
    `Runtime Backend: ${agentBackendLabel(agentConfig.runtimeBackend || "hermes")}`,
    "",
    "## Description",
    "",
    agentConfig.description || "",
    "",
    "## Core Requirements",
    "",
    agentConfig.coreCommand || "No custom core requirements set.",
    "",
    "## Model",
    "",
    agentConfig.modelName
      ? `${agentConfig.modelProvider ? `Provider: ${agentConfig.modelProvider}\n` : ""}Model: ${agentConfig.modelName}`
      : "Use the inherited Hermes default model.",
    ""
  ];
  fs.writeFileSync(path.join(profileDir, "AGENTS.md"), lines.join("\n"));
}

function updateHermesProfileMarker(profileName, agentConfig = {}) {
  if (process.env.HAT_HERMES_MODE === "mock") return "mock";
  const profileDir = hermesProfileDir(profileName);
  if (!fs.existsSync(profileDir)) {
    throw new Error(`Hermes profile 目录不存在：${profileName}`);
  }

  const markerPath = path.join(profileDir, ".hermes-agent-team.json");
  const updatedAt = nowIso();
  let marker = {};
  if (fs.existsSync(markerPath)) {
    marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  }

  const nextMarker = {
    ...marker,
    managedBy: marker.managedBy || "Hermes Agent Team",
    profileName,
    description: marker.description || "",
    createdAt: marker.createdAt || updatedAt,
    updatedAt,
    isolation: marker.isolation || {
      profile: "new independent Hermes profile",
      inherits: ["config.yaml", "SOUL.md", "skills", "model provider settings"],
      doesNotInherit: ["sessions", "history", "gateway runtime state", "messaging platform identity"]
    },
    agentConfig: {
      ...(marker.agentConfig || {}),
      ...agentConfig,
      updatedAt
    }
  };
  fs.writeFileSync(markerPath, JSON.stringify(nextMarker, null, 2));
  writeHermesProfileAgentFile(profileName, nextMarker.agentConfig);
  return "updated";
}

function removeInheritedMessagingSecrets(profileDir) {
  const envPath = path.join(profileDir, ".env");
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, "utf8");
  const dropped = [];
  const kept = raw
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return true;
      const key = trimmed.split("=")[0]?.trim() || "";
      const shouldDrop =
        /^(FEISHU|LARK|TELEGRAM|WEIXIN|WECHAT|DISCORD|SLACK|IMESSAGE|IMSG|DINGTALK)_/i.test(key) ||
        /^(GATEWAY|WEBHOOK|BOT_TOKEN|CHAT_ID|APP_ID|APP_SECRET)$/i.test(key);
      if (shouldDrop) dropped.push(line);
      return !shouldDrop;
    })
    .join("\n");

  if (dropped.length > 0) {
    const backupPath = `${envPath}.platform-backup-${Date.now()}`;
    fs.writeFileSync(backupPath, raw);
    fs.writeFileSync(
      envPath,
      [
        kept.trimEnd(),
        "",
        "# Hermes Agent Team removed inherited messaging/gateway credentials for profile isolation.",
        `# Backup: ${path.basename(backupPath)}`,
        ""
      ].join("\n")
    );
  }
}

function removeInheritedRuntimeState(profileDir) {
  const runtimeNames = [
    "state.db",
    "state.db-shm",
    "state.db-wal",
    "gateway_state.json",
    "processes.json",
    "sessions",
    "history",
    "logs"
  ];
  for (const name of runtimeNames) {
    const target = path.join(profileDir, name);
    if (!fs.existsSync(target)) continue;
    const backup = path.join(profileDir, `.isolated-backup-${Date.now()}-${name}`);
    fs.renameSync(target, backup);
  }
}

async function askHermes(profileName, prompt, options = {}) {
  if (process.env.HAT_HERMES_MODE === "mock") {
    const delayMs = Number(process.env.HAT_MOCK_AGENT_DELAY_MS || 0);
    if (delayMs > 0) await sleepForRuntime(Math.min(delayMs, 10000), options.runtimeKey);
    if (options.runtimeKey && activeAgentRuns.get(options.runtimeKey)?.canceled) {
      throw canceledRunError("Hermes");
    }
    if (String(prompt).includes("正式任务内容：AGENT_IMAGE_ATTACHMENT_CHECK")) {
      const artifactDir = path.join(dataDir(), "mock_artifacts");
      fs.mkdirSync(artifactDir, { recursive: true });
      const htmlPath = path.join(artifactDir, `${makeId("agent-image-check")}.html`);
      fs.writeFileSync(
        htmlPath,
        [
          "<!doctype html>",
          "<html><head><meta charset=\"utf-8\"><style>",
          "body{margin:0;background:#111827;color:#f9fafb;font-family:Arial,sans-serif;}",
          ".frame{width:960px;height:540px;display:grid;place-items:center;background:linear-gradient(135deg,#0f172a,#14532d);}",
          ".card{border:4px solid #22c55e;border-radius:24px;padding:44px;text-align:center;box-shadow:0 24px 80px rgba(0,0,0,.35);}",
          "h1{font-size:52px;margin:0 0 16px;}p{font-size:26px;margin:0;color:#bbf7d0;}",
          "</style></head><body><main class=\"frame\"><section class=\"card\"><h1>Hermes Image Attachment</h1><p>Agent visual output rendered as message image.</p></section></main></body></html>"
        ].join("")
      );
      return [
        "最终结论：已生成可直接显示的图片产物。",
        `图片源文件：${htmlPath}`,
        "",
        "```hermes-agent-team-actions",
        "{\"actions\":[]}",
        "```"
      ].join("\n");
    }
    const isOrganizerPrompt = String(prompt).includes("你的职责：组织多方讨论");
	    if (isOrganizerPrompt) {
      if (String(prompt).includes("FORCE_CONTINUE_AT_LIMIT")) {
        return [
          "@Hayden 我倾向继续一轮，但如果系统已到上限，请按已有证据收敛。",
          "",
          "```hermes-discussion-organizer",
          "{\"decision\":\"continue\",\"reason\":\"mock requested another round for force-convergence coverage\",\"next_prompt\":\"继续寻找反例\"}",
          "```"
        ].join("\n");
      }
	      if (
        process.env.HAT_MOCK_CONTEXT_ASSERTIONS === "1" &&
        String(prompt).includes("DISCUSSION_AGENT_CONTEXT_CHECK") &&
        String(prompt).includes("DISCUSSION_AGENT_CONTEXT_MARKER") &&
        !String(prompt).includes("DISCUSSION_AGENT_CONTEXT_SEES_AGENT")
      ) {
        return [
          "@Hayden 我需要让参与 Agent 基于上一轮观点再交叉判断一轮。",
          "",
          "```hermes-discussion-organizer",
          "{\"decision\":\"continue\",\"reason\":\"需要验证参与 Agent 是否能参考上一轮观点\",\"next_prompt\":\"请参考上一轮 Agent 发言继续判断\"}",
          "```"
        ].join("\n");
      }
      return [
        "@Hayden 我已组织本轮讨论并完成阶段性汇总：当前观点可以先收敛为一个可执行判断。",
        "",
        "```hermes-discussion-organizer",
        "{\"decision\":\"final\",\"reason\":\"mock discussion complete\",\"next_prompt\":\"\"}",
        "```"
      ].join("\n");
    }
    if (
      process.env.HAT_MOCK_CONTEXT_ASSERTIONS === "1" &&
      String(prompt).includes("DISCUSSION_AGENT_CONTEXT_CHECK") &&
      !isOrganizerPrompt
    ) {
      return String(prompt).includes("DISCUSSION_AGENT_CONTEXT_MARKER")
        ? "@Hayden DISCUSSION_AGENT_CONTEXT_SEES_AGENT"
        : "@Hayden DISCUSSION_AGENT_CONTEXT_MARKER";
    }
    if (process.env.HAT_MOCK_CONTEXT_ASSERTIONS === "1" && String(prompt).includes("DISCUSSION_CAN_SEE_TASK_CHECK")) {
      return String(prompt).includes("TASK_VISIBLE_TO_DISCUSSION")
        ? "DISCUSSION_CONTEXT_SEES_TASK"
        : "DISCUSSION_CONTEXT_MISSING_TASK";
    }
    if (process.env.HAT_MOCK_CONTEXT_ASSERTIONS === "1" && String(prompt).includes("TASK_PRIVACY_CHECK")) {
      return String(prompt).includes("DISCUSSION_SECRET_SHOULD_NOT_BE_VISIBLE")
        ? "PRIVACY_LEAK"
        : "TASK_CONTEXT_CLEAN";
    }
    if (String(prompt).includes("当前是多方讨论模式")) {
      return "@Hayden 我已看到当前空间里人和 Agent 的发言，会基于已有观点给出本轮判断。";
    }
	    if (
	      process.env.HAT_MOCK_AGENT_ACTIONS === "1" &&
	      String(prompt).includes("正式任务内容：TASK_DISCUSSION_HELP_RESULT")
	    ) {
	      return [
	        "TASK_DISCUSSION_HELP_USED 我已收到讨论模块建议，并基于建议继续完成任务。",
        "",
        "```hermes-agent-team-actions",
        "{\"actions\":[]}",
	        "```"
	      ].join("\n");
	    }
	    const mockTriggeredByHayden = String(prompt).includes("本次触发来自：Hayden");
	    const mockTriggeredBySynthesis = String(prompt).includes("本次触发来自：系统证据收敛");
	    const mockTriggeredByAgent =
	      String(prompt).includes("本次触发来自：") && !mockTriggeredByHayden && !mockTriggeredBySynthesis;
	    if (
	      process.env.HAT_MOCK_AGENT_ACTIONS === "1" &&
	      mockTriggeredBySynthesis &&
	      String(prompt).includes("TEAM_SYNTHESIS_REQUEST")
	    ) {
	      return [
	        "TEAM_WORK_SYSTEM_FINAL 最终结论：Team 工作系统已按并行执行 + 独立审查 + 证据收敛 + 主 Agent 负责制完成本次任务。",
	        "",
	        "关键证据：已记录 Team 工作图、并行委派组、执行 Agent 输出和质量审查 Agent 输出。",
	        "独立审查结果：TEAM_WORK_REVIEW_OK，未发现阻断风险。",
	        "剩余风险：mock 验收只证明调度链路，不代表真实业务质量。",
	        "",
	        "```hermes-agent-team-actions",
	        "{\"actions\":[]}",
	        "```"
	      ].join("\n");
	    }
	    if (process.env.HAT_MOCK_AGENT_ACTIONS === "1" && mockTriggeredByAgent && String(prompt).includes("TEAM_WORK_EXECUTOR_OK")) {
	      return [
	        "TEAM_WORK_EXECUTOR_OK 已完成执行工作包，并给出可验收输出与证据。",
	        "",
	        "```hermes-agent-team-actions",
	        "{\"actions\":[]}",
	        "```"
	      ].join("\n");
	    }
	    if (process.env.HAT_MOCK_AGENT_ACTIONS === "1" && mockTriggeredByAgent && String(prompt).includes("TEAM_WORK_REVIEW_OK")) {
	      return [
	        "TEAM_WORK_REVIEW_OK 独立审查完成：执行输出满足验收标准，未发现阻断风险。",
	        "",
	        "```hermes-agent-team-actions",
	        "{\"actions\":[]}",
	        "```"
	      ].join("\n");
		    }
		    if (process.env.HAT_MOCK_AGENT_ACTIONS === "1" && mockTriggeredByHayden) {
		      if (String(prompt).includes("正式任务内容：DELETE_CHILD_TEST")) {
        return [
          "我会删除测试下级 Agent。",
          "",
          "```hermes-agent-team-actions",
          "{\"actions\":[{\"type\":\"delete_agent\",\"agent_name\":\"自动研究员\",\"reason\":\"验收测试结束\"}]}",
	          "```"
	        ].join("\n");
	      }
		      if (String(prompt).includes("正式任务内容：TEAM_WORK_SYSTEM_CHECK")) {
	        return [
	          "我会建立工作图，并行委派执行包和独立审查包；最终由主 Agent 收敛证据并负责结论。",
	          "",
	          "```hermes-agent-team-actions",
	          "{\"actions\":[{\"type\":\"create_agent\",\"name\":\"执行验证 Agent\",\"role\":\"Execution Agent\",\"description\":\"负责执行可验收工作包并提供证据。\",\"core_command\":\"只交付执行工作包结果和证据，不输出全局总结。\"},{\"type\":\"create_agent\",\"name\":\"质量审查 Agent\",\"role\":\"Quality Review Agent\",\"description\":\"负责独立审查执行输出、证据缺口和风险。\",\"core_command\":\"从审查视角验证验收标准、反例、风险和证据缺口。\"},{\"type\":\"delegate\",\"agent_name\":\"执行验证 Agent\",\"work_package_id\":\"wp-exec\",\"parallel_group\":\"team-work-system\",\"acceptance_criteria\":\"返回 TEAM_WORK_EXECUTOR_OK 并说明执行证据。\",\"evidence_required\":\"执行结果、验收点、可复查证据。\",\"review_required\":false,\"message\":\"背景：验证 Team 工作系统是否支持并行执行。任务边界：只完成执行工作包。输出格式：返回 TEAM_WORK_EXECUTOR_OK，加一句执行证据。验收标准：明确可验收输出。证据要求：说明你完成了执行包。停止条件：不要创建新 Agent。\"},{\"type\":\"delegate\",\"agent_name\":\"质量审查 Agent\",\"work_package_id\":\"wp-review\",\"parallel_group\":\"team-work-system\",\"acceptance_criteria\":\"返回 TEAM_WORK_REVIEW_OK 并说明独立审查结果。\",\"evidence_required\":\"审查结论、风险判断、证据缺口。\",\"review_required\":true,\"message\":\"背景：验证 Team 工作系统是否支持独立审查。任务边界：只审查执行机制与证据缺口。输出格式：返回 TEAM_WORK_REVIEW_OK，加一句审查结论。验收标准：明确是否发现阻断风险。证据要求：说明审查依据。停止条件：不要创建新 Agent。\"}]}",
	          "```"
	        ].join("\n");
	      }
		      if (String(prompt).includes("正式任务内容：TASK_DISCUSSION_HELP_CHECK")) {
	        return [
          "当前任务存在路线卡点，我先请求讨论模块给出可执行思路。",
          "",
          "```hermes-agent-team-actions",
          "{\"actions\":[{\"type\":\"request_discussion_help\",\"topic\":\"TASK_DISCUSSION_HELP_CHECK\",\"problem\":\"当前任务缺少可靠推进思路，需要讨论模块给出方案。\",\"attempted\":\"已完成任务初步判断，但无法短时间收敛路线。\",\"needed_output\":\"请给出下一步执行方案、风险和验证动作。\",\"current_stage\":\"planning\",\"failed_command\":\"npm run acceptance:dev\",\"error_output\":\"mock blocker: route not converged\",\"file_paths\":[\"electron/main.cjs\"],\"subtask_id\":\"mock-discussion-help\"}]}",
          "```"
        ].join("\n");
      }
      return [
        "我会创建下级研究员并委派任务。",
        "",
        "```hermes-agent-team-actions",
        "{\"actions\":[{\"type\":\"create_agent\",\"name\":\"自动研究员\",\"role\":\"Research Agent\",\"description\":\"验收测试下级 Agent\",\"core_command\":\"优先做结构化研究并返回证据。\",\"model_name\":\"mock-research-model\"},{\"type\":\"delegate\",\"agent_name\":\"自动研究员\",\"message\":\"请回复 CHILD_DELEGATION_OK\"}]}",
        "```"
      ].join("\n");
    }
    return [
      "已收到。我会按当前层级处理这个任务。",
      "",
      "```hermes-agent-team-actions",
      "{\"actions\":[]}",
      "```"
    ].join("\n");
  }
  const providerName = String(options.modelProvider || "").trim();
  const modelName = String(options.modelName || "").trim();
  const maxTurns = clampIntegerEnv("HAT_HERMES_CHAT_MAX_TURNS", HERMES_CHAT_MAX_TURNS, 2, 20);
  const retryMaxTurns = clampIntegerEnv(
    "HAT_HERMES_CHAT_RETRY_MAX_TURNS",
    Math.max(HERMES_CHAT_RETRY_MAX_TURNS, maxTurns + 4),
    maxTurns + 1,
    30
  );
  const command = hermesBin();
  const attempts = [];
  const firstArgs = buildHermesChatArgs({ profileName, prompt, providerName, modelName, maxTurns });
  let result = null;
  let firstError = null;
  try {
    result = await runCommandDetailed(command, firstArgs, {
      timeout: HERMES_CHAT_TIMEOUT_MS,
      runtimeKey: options.runtimeKey
    });
    attempts.push({
      attempt: 1,
      maxTurns,
      timedOut: false,
      iterationLimit: isHermesIterationLimitOutput(`${result.stdout}\n${result.stderr}`),
      durationMs: result.details.durationMs,
      exitCode: result.details.exitCode
    });
  } catch (error) {
    firstError = error;
    attempts.push({
      attempt: 1,
      maxTurns,
      timedOut: isHermesTimeoutError(error),
      iterationLimit: isHermesIterationLimitOutput(`${error?.hermesDetails || ""}\n${error?.message || ""}`),
      durationMs: error?.commandDetails?.durationMs ?? null,
      exitCode: error?.commandDetails?.exitCode ?? null,
      error: summarizeError(error?.hermesDetails || error?.message || error)
    });
  }

  const shouldRetry =
    (result && attempts[0]?.iterationLimit) ||
    (firstError && (attempts[0]?.timedOut || attempts[0]?.iterationLimit));
  if (shouldRetry) {
    const retryPrompt = firstError && attempts[0]?.timedOut
      ? retryPromptAfterTimeout(prompt, firstError, retryMaxTurns)
      : retryPromptAfterIterationLimit(prompt, retryMaxTurns);
    const retryArgs = buildHermesChatArgs({
      profileName,
      prompt: retryPrompt,
      providerName,
      modelName,
      source: "hermes-agent-team-retry",
      maxTurns: retryMaxTurns
    });
    try {
      result = await runCommandDetailed(command, retryArgs, {
        timeout: HERMES_CHAT_RETRY_TIMEOUT_MS,
        runtimeKey: options.runtimeKey
      });
      attempts.push({
        attempt: 2,
        maxTurns: retryMaxTurns,
        timedOut: false,
        iterationLimit: isHermesIterationLimitOutput(`${result.stdout}\n${result.stderr}`),
        durationMs: result.details.durationMs,
        exitCode: result.details.exitCode
      });
    } catch (error) {
      attempts.push({
        attempt: 2,
        maxTurns: retryMaxTurns,
        timedOut: isHermesTimeoutError(error),
        iterationLimit: isHermesIterationLimitOutput(`${error?.hermesDetails || ""}\n${error?.message || ""}`),
        durationMs: error?.commandDetails?.durationMs ?? null,
        exitCode: error?.commandDetails?.exitCode ?? null,
        error: summarizeError(error?.hermesDetails || error?.message || error)
      });
      error.commandDetails = { ...(error.commandDetails || {}), maxTurns, retryMaxTurns, attempts };
      throw error;
    }
  } else if (firstError) {
    firstError.commandDetails = { ...(firstError.commandDetails || {}), maxTurns, retryMaxTurns, attempts };
    throw firstError;
  }
  if (typeof options.onRunInfo === "function") {
    options.onRunInfo({
      engine: "hermes",
      mode: "live",
      profile: profileName,
      provider: providerName,
      model: modelName,
      maxTurns,
      retryMaxTurns,
      attempts,
      promptChars: String(prompt || "").length,
      promptSha256: hashText(prompt),
      ...result.details
    });
  }
  if (isHermesIterationLimitOutput(`${result.stdout}\n${result.stderr}`)) {
    const error = new Error(`Hermes 达到最大迭代轮数（已自动重试到 ${retryMaxTurns} 轮），没有产出可用结果。`);
    error.hermesDetails = `${result.stdout}\n${result.stderr}`.trim();
    error.commandDetails = { ...result.details, maxTurns, retryMaxTurns, attempts };
    throw error;
  }
  return result.stdout;
}

async function probeHermesProfile(profileName) {
  if (process.env.HAT_HERMES_MODE === "mock") {
    return "HERMES_AGENT_READY";
  }
  return runCommand(
    hermesBin(),
    buildHermesChatArgs({
      profileName,
      prompt: "只回复 HERMES_AGENT_READY",
      source: "hermes-agent-team-probe",
      maxTurns: HERMES_PROBE_MAX_TURNS
    }),
    { timeout: 75000 }
  );
}

function buildCodexExecArgs({ modelProvider = "", modelName = "" } = {}) {
  const provider = String(modelProvider || "").trim().toLowerCase();
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    "danger-full-access",
    "--color",
    "never",
    "-C",
    process.cwd()
  ];
  if (String(modelName || "").trim()) args.push("-m", String(modelName).trim());
  if (provider === "ollama" || provider === "lmstudio") {
    args.push("--oss", "--local-provider", provider);
  }
  args.push("-");
  return args;
}

async function askCodex(prompt, options = {}) {
  if (process.env.HAT_HERMES_MODE === "mock" || process.env.HAT_CODEX_MODE === "mock") {
    const output = await askHermes("codex-mock", prompt, options);
    if (typeof options.onRunInfo === "function") {
      options.onRunInfo({
        engine: "codex",
        mode: "mock",
        profile: "",
        provider: String(options.modelProvider || ""),
        model: String(options.modelName || ""),
        command: "mock-codex",
        args: [],
        startedAt: nowIso(),
        finishedAt: nowIso(),
        durationMs: 0,
        timeoutMs: 0,
        exitCode: 0,
        signal: "",
        timedOut: false,
        stdoutChars: String(output || "").length,
        stderrChars: 0,
        stdoutPreview: compactText(output || "", 1200),
        stderrPreview: "",
        promptChars: String(prompt || "").length,
        promptSha256: hashText(prompt)
      });
    }
    return output;
  }

  const lastMessagePath = path.join(os.tmpdir(), `${makeId("codex-last-message")}.txt`);
  const args = buildCodexExecArgs({
    modelProvider: options.modelProvider,
    modelName: options.modelName
  });
  args.splice(args.length - 1, 0, "--output-last-message", lastMessagePath);
  const result = await runSpawnDetailed(codexBin(), args, {
    timeout: CODEX_EXEC_TIMEOUT_MS,
    runtimeKey: options.runtimeKey,
    stdin: prompt,
    label: "Codex"
  });
  let finalOutput = result.stdout || compactText(result.stderr, 4000);
  let outputMode = result.stdout ? "stdout" : "stderr";
  try {
    const lastMessage = fs.readFileSync(lastMessagePath, "utf8").trim();
    if (lastMessage) {
      finalOutput = lastMessage;
      outputMode = "last_message";
    }
  } catch {
    // Codex versions without --output-last-message still return stdout.
  } finally {
    safeRemovePath(lastMessagePath);
  }
  if (typeof options.onRunInfo === "function") {
    options.onRunInfo({
      engine: "codex",
      mode: "live",
      profile: "",
      provider: String(options.modelProvider || ""),
      model: String(options.modelName || ""),
      promptChars: String(prompt || "").length,
      promptSha256: hashText(prompt),
      ...result.details,
      outputMode
    });
  }
  return finalOutput;
}

async function probeCodexRuntime(modelProvider = "", modelName = "") {
  if (process.env.HAT_HERMES_MODE === "mock" || process.env.HAT_CODEX_MODE === "mock") {
    return "CODEX_AGENT_READY";
  }
  const result = await runSpawnDetailed(codexBin(), buildCodexExecArgs({ modelProvider, modelName }), {
    timeout: CODEX_PROBE_TIMEOUT_MS,
    stdin: "只回复 CODEX_AGENT_READY",
    label: "Codex"
  });
  return result.stdout;
}

async function invokeAgentRuntime(agent, prompt, options = {}) {
  const backend = agentBackend(agent);
  if (backend === "codex") {
    return askCodex(prompt, {
      ...options,
      modelProvider: agent.model_provider,
      modelName: agent.model_name
    });
  }
  return askHermes(agent.hermes_profile, prompt, {
    ...options,
    modelProvider: agent.model_provider,
    modelName: agent.model_name
  });
}

async function createAgentInternal({
  workspaceId,
  channelId,
  name,
  role,
  description,
  runtimeBackend = "hermes",
  coreCommand = "",
  modelProvider = "",
  modelName = "",
  parentAgentId = null,
  createdByAgentId = null,
  isTemporary = false,
  taskRunId = null,
  agentKind = "task",
  isPrimary = null,
  actorTypeOverride = null,
  verifyProfile = true,
  allowTemporaryDiscussion = false
}) {
  const workspace = get("SELECT * FROM workspaces WHERE id = ?", [workspaceId]);
  if (!workspace) throw new Error("工作空间不存在。");
  const channel = get("SELECT * FROM channels WHERE id = ? AND workspace_id = ?", [channelId, workspaceId]);
  if (!channel) throw new Error("工作空间不存在。");
  const normalizedAgentKind = agentKind === "discussion" ? "discussion" : "task";
  if (normalizedAgentKind === "discussion") {
    parentAgentId = null;
    isTemporary = allowTemporaryDiscussion ? Boolean(isTemporary) : false;
    taskRunId = null;
  }

  let parent = null;
  if (parentAgentId) {
    parent = get("SELECT * FROM agents WHERE id = ? AND workspace_id = ?", [parentAgentId, workspaceId]);
    if (!parent) throw new Error("上级 Agent 不存在。");
  }

  const agentId = makeId("agent");
  const normalizedRuntimeBackend = normalizeAgentBackend(runtimeBackend);
  const runtimeIdentity = runtimeIdentityForAgent(normalizedRuntimeBackend, name);
  const normalizedAgentName = String(name || "未命名 Agent").trim();
  const normalizedRole = String(role || (normalizedAgentKind === "discussion" ? "Discussion Agent" : "General Agent")).trim();
  const normalizedDescription = String(
    description ||
      (normalizedAgentKind === "discussion" ? "在多方讨论中提供独立观点。" : "在工作空间内按层级执行任务。")
  ).trim();
  const normalizedCoreCommand = String(coreCommand || "").trim();
  const normalizedModelProvider = String(modelProvider || "").trim();
  const normalizedModelName = String(modelName || "").trim();
  const normalizedIsPrimary = typeof isPrimary === "boolean" ? isPrimary : false;
  const creatorActorType = actorTypeOverride || (createdByAgentId ? "agent" : "human");
  const creatorLabel = creatorActorType === "system" ? "系统" : createdByAgentId ? "主 Agent" : "人";

  audit({
    workspaceId,
    channelId,
    actorType: creatorActorType,
    actorId: createdByAgentId,
    action: normalizedAgentKind === "discussion" ? "create_discussion_agent_start" : "create_agent_start",
    result: "running",
    detail:
      normalizedRuntimeBackend === "hermes"
        ? `正在创建${isTemporary ? "临时" : "独立"} Agent：${normalizedAgentName}，准备生成全新 Hermes profile：${runtimeIdentity}`
        : `正在创建${isTemporary ? "临时" : "独立"} Codex Agent：${normalizedAgentName}，准备验证 Codex 后端：${runtimeIdentity}`
  });
  saveDb();

  let profileCreated = false;
  try {
    const agentConfig = {
      name: normalizedAgentName,
      role: normalizedRole,
      description: normalizedDescription,
      runtimeBackend: normalizedRuntimeBackend,
      coreCommand: normalizedCoreCommand,
      modelProvider: normalizedModelProvider,
      modelName: normalizedModelName,
      agentKind: normalizedAgentKind
    };
    if (normalizedRuntimeBackend === "hermes") {
      await createHermesProfile(runtimeIdentity, `${normalizedRole}: ${normalizedDescription}`, { agentConfig });
      profileCreated = true;
      if (verifyProfile) {
        const probeOutput = await probeHermesProfile(runtimeIdentity);
        if (!String(probeOutput).includes("HERMES_AGENT_READY")) {
          throw new Error(`Hermes profile 探针没有返回 READY：${String(probeOutput).slice(0, 400)}`);
        }
      }
    } else if (verifyProfile) {
      const probeOutput = await probeCodexRuntime(normalizedModelProvider, normalizedModelName);
      if (!String(probeOutput).includes("CODEX_AGENT_READY")) {
        throw new Error(`Codex 后端探针没有返回 READY：${String(probeOutput).slice(0, 400)}`);
      }
    }
  } catch (error) {
    if (profileCreated) {
      try {
        await deleteOwnedHermesProfile(runtimeIdentity);
      } catch (deleteError) {
        audit({
          workspaceId,
          channelId,
          actorType: "system",
          action: "create_agent_rollback",
          result: "failed",
          detail: `创建失败后回滚 profile 也失败：${String(deleteError.message || deleteError).slice(0, 600)}`
        });
      }
    }
    audit({
      workspaceId,
      channelId,
      actorType: creatorActorType,
      actorId: createdByAgentId,
      action: normalizedAgentKind === "discussion" ? "create_discussion_agent" : "create_agent",
      result: "failed",
      detail: `Agent 创建失败，已回滚：${String(error.message || error).slice(0, 800)}`
    });
    saveDb();
    throw new Error(`Agent 创建失败：${String(error.message || error).slice(0, 700)}`);
  }

  run(
    `INSERT INTO agents
      (id, workspace_id, name, role, description, runtime_backend, core_command, model_provider, model_name, parent_agent_id, hermes_profile, is_primary, owned_by_app, agent_kind, status, is_temporary, task_run_id, created_by_agent_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'ready', ?, ?, ?, ?)`,
    [
      agentId,
      workspaceId,
      normalizedAgentName,
      normalizedRole,
      normalizedDescription,
      normalizedRuntimeBackend,
      normalizedCoreCommand,
      normalizedModelProvider,
      normalizedModelName,
      parentAgentId,
      runtimeIdentity,
      normalizedIsPrimary ? 1 : 0,
      normalizedAgentKind,
      isTemporary ? 1 : 0,
      taskRunId,
      createdByAgentId,
      nowIso()
    ]
  );
  run("INSERT OR IGNORE INTO agent_channels (agent_id, channel_id) VALUES (?, ?)", [agentId, channelId]);
  audit({
    workspaceId,
    channelId,
    actorType: creatorActorType,
    actorId: createdByAgentId,
    action: normalizedAgentKind === "discussion" ? "create_discussion_agent" : "create_agent",
    result: "allowed",
    detail: `${creatorLabel}创建${isTemporary ? "临时" : "独立"} ${agentBackendLabel(normalizedRuntimeBackend)} Agent：${normalizedAgentName}，运行身份：${runtimeIdentity}`
  });
  insertMessage({
    workspaceId,
    channelId,
    senderType: "system",
    senderName: "系统",
    mode: normalizedAgentKind === "discussion" ? "discussion" : "system",
    targetAgentId: agentId,
    content: `已创建并验证${isTemporary ? "临时" : "独立"} ${agentBackendLabel(normalizedRuntimeBackend)} Agent：${normalizedAgentName}。`,
    status: "visible"
  });
  saveDb();
  return get("SELECT * FROM agents WHERE id = ?", [agentId]);
}

async function ensureWorkspaceBaseAgents({ workspaceId, channelId, actorType = "system" }) {
  const workspace = get("SELECT * FROM workspaces WHERE id = ?", [workspaceId]);
  const channel = get("SELECT * FROM channels WHERE id = ? AND workspace_id = ?", [channelId, workspaceId]);
  if (!workspace || !channel) throw new Error("工作空间不存在。");
  ensureBlackboardSchema(workspaceId, channelId);

  let taskLead = get(
    `SELECT *
     FROM agents
     WHERE workspace_id = ?
       AND agent_kind = 'task'
       AND parent_agent_id IS NULL
       AND is_temporary = 0
       AND is_primary = 1
     ORDER BY created_at ASC
     LIMIT 1`,
    [workspaceId]
  );
  if (!taskLead) {
    taskLead = get(
      `SELECT *
       FROM agents
       WHERE workspace_id = ?
         AND agent_kind = 'task'
         AND parent_agent_id IS NULL
         AND is_temporary = 0
       ORDER BY created_at ASC
       LIMIT 1`,
      [workspaceId]
    );
    if (taskLead) {
      audit({
        workspaceId,
        channelId,
        actorType,
        action: "promote_task_lead",
        result: "allowed",
        detail: `已将 ${taskLead.name} 设为任务项目经理 Agent。`
      });
    }
  }
  if (!taskLead) {
    taskLead = await createAgentInternal({
      workspaceId,
      channelId,
	      name: "项目经理 Agent",
	      role: "Project Manager",
	      description: "执行任务模块的主 Agent，负责接收人的任务、拆解目标、调度任务 Agent，并汇总交付结果。",
	      coreCommand:
	        "你是执行任务模块的项目经理主 Agent。你直接接收 Hayden 的任务，先明确目标、约束、交付物、验收标准和风险；复杂任务必须组织成并行执行、独立审查、证据收敛、主 Agent 负责制的工作系统；最终只向 Hayden 汇报最终结论、关键证据、审查结果、风险和下一步。",
      parentAgentId: null,
      agentKind: "task",
      isPrimary: true,
      actorTypeOverride: actorType,
      verifyProfile: true
    });
  }
  run(
    `UPDATE agents
     SET is_primary = CASE WHEN id = ? THEN 1 ELSE 0 END
     WHERE workspace_id = ?
       AND agent_kind = 'task'
       AND parent_agent_id IS NULL
       AND is_temporary = 0`,
    [taskLead.id, workspaceId]
  );

  let discussionLead = get(
    `SELECT *
     FROM agents
     WHERE workspace_id = ?
       AND agent_kind = 'discussion'
       AND is_temporary = 0
       AND is_primary = 1
     ORDER BY created_at ASC
     LIMIT 1`,
    [workspaceId]
  );
  if (!discussionLead) {
    const existingDiscussion = get(
      `SELECT *
       FROM agents
       WHERE workspace_id = ?
         AND agent_kind = 'discussion'
         AND is_temporary = 0
       ORDER BY created_at ASC
       LIMIT 1`,
      [workspaceId]
    );
    if (existingDiscussion) {
      run("UPDATE agents SET is_primary = 1 WHERE id = ?", [existingDiscussion.id]);
      discussionLead = get("SELECT * FROM agents WHERE id = ?", [existingDiscussion.id]);
      audit({
        workspaceId,
        channelId,
        actorType,
        action: "promote_discussion_leader",
        result: "allowed",
        detail: `已将 ${existingDiscussion.name} 设为讨论 Leader Agent。`
      });
    } else {
      discussionLead = await createAgentInternal({
        workspaceId,
        channelId,
        name: "讨论 Leader Agent",
        role: "Discussion Leader",
        description: "多方讨论模块的主 Agent，负责组织讨论、控制轮次、调动讨论 Agent，并汇总结论。",
        coreCommand:
          "你是多方讨论模块的 Leader Agent。你负责按讨论框架组织 Agent 发言、控制轮次、判断是否需要继续、是否需要 Hayden 补充信息，并在有阶段性问题或最终结论时汇报给 Hayden。",
        parentAgentId: null,
        agentKind: "discussion",
        isPrimary: true,
        actorTypeOverride: actorType,
        verifyProfile: true
      });
    }
  }
  run(
    `UPDATE agents
     SET is_primary = CASE WHEN id = ? THEN 1 ELSE 0 END
     WHERE workspace_id = ?
       AND agent_kind = 'discussion'
       AND is_temporary = 0`,
    [discussionLead.id, workspaceId]
  );

  saveDb();
  return { taskLead, discussionLead };
}

function descendantsOf(agentId) {
  const queue = [agentId];
  const found = [];
  while (queue.length > 0) {
    const current = queue.shift();
    const children = all("SELECT * FROM agents WHERE parent_agent_id = ?", [current]);
    for (const child of children) {
      found.push(child);
      queue.push(child.id);
    }
  }
  return found;
}

async function deleteAgentInternal({ agentId, actorType = "human", actorId = null, channelId = null }) {
  const agent = get("SELECT * FROM agents WHERE id = ?", [agentId]);
  if (!agent) throw new Error("Agent 不存在。");
  if (Number(agent.is_primary) === 1 && actorType === "human") {
    throw new Error("模块主 Agent 会随工作空间存在，不能单独删除。");
  }
  if (actorType === "agent") {
    if (agent.parent_agent_id !== actorId) {
      audit({
        workspaceId: agent.workspace_id,
        channelId,
        actorType,
        actorId,
        action: "delete_agent",
        result: "blocked",
        detail: "Agent 只能删除自己的直接下级。"
      });
      throw new Error("Agent 只能删除自己的直接下级。");
    }
  }

  const deleteList = [...descendantsOf(agentId).reverse(), agent];
  for (const item of deleteList) {
    if (item.owned_by_app && agentBackend(item) === "hermes") {
      await deleteOwnedHermesProfile(item.hermes_profile);
    }
    run("DELETE FROM agents WHERE id = ?", [item.id]);
    audit({
      workspaceId: item.workspace_id,
      channelId,
      actorType,
      actorId,
      action: item.agent_kind === "discussion" ? "delete_discussion_agent" : "delete_agent",
      result: "allowed",
      detail: `已删除 ${agentBackendLabel(agentBackend(item))} Agent：${item.name}，运行身份：${item.hermes_profile}`
    });
  }
  saveDb();
}

async function cleanupTemporaryDiscussionAgents({ discussionId, channelId, actorId = null }) {
  const discussion = get("SELECT * FROM discussion_runs WHERE id = ?", [discussionId]);
  if (!discussion) return 0;
  const temporaryAgents = all(
    `SELECT DISTINCT a.*
     FROM agents a
     LEFT JOIN discussion_agents da ON da.agent_id = a.id AND da.discussion_id = ?
     WHERE a.workspace_id = ?
       AND a.agent_kind = 'discussion'
       AND a.is_temporary = 1
       AND (a.id = ? OR da.agent_id IS NOT NULL)
     ORDER BY a.created_at DESC`,
    [discussion.id, discussion.workspace_id, discussion.organizer_agent_id]
  );
  for (const agent of temporaryAgents) {
    await deleteAgentInternal({
      agentId: agent.id,
      actorType: "system",
      actorId,
      channelId
    });
  }
  if (temporaryAgents.length > 0) {
    audit({
      workspaceId: discussion.workspace_id,
      channelId,
      actorType: "system",
      actorId,
      action: "discussion_temp_cleanup",
      result: "allowed",
      detail: `讨论结束，已清理 ${temporaryAgents.length} 个临时讨论 Agent，只保留讨论输出。`
    });
    saveDb();
  }
  return temporaryAgents.length;
}

function insertMessage({
  workspaceId,
  channelId,
  senderType,
  senderId = null,
  senderName,
  mode,
  targetAgentId = null,
  content,
  status = "visible",
  attachments = [],
  attachmentFallbackText = "请处理附件图片。",
  appendAttachmentContext = true
}) {
  const messageId = makeId("msg");
  run(
    `INSERT INTO messages
      (id, workspace_id, channel_id, sender_type, sender_id, sender_name, mode, target_agent_id, content, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [messageId, workspaceId, channelId, senderType, senderId, senderName, mode, targetAgentId, content, status, nowIso()]
  );
  let message = get("SELECT * FROM messages WHERE id = ?", [messageId]);
  const savedAttachments = saveMessageAttachments({ message, attachments });
  if (savedAttachments.length && appendAttachmentContext) {
    const nextContent = composeMessageContentWithAttachments(content, savedAttachments, attachmentFallbackText);
    run("UPDATE messages SET content = ? WHERE id = ?", [nextContent, messageId]);
    message = get("SELECT * FROM messages WHERE id = ?", [messageId]);
  }
  message.attachments = savedAttachments;
  captureMessageContentAsset(message);
  saveDb();
  return message;
}

function sendChannelMessageInternal(payload = {}) {
  const workspace = get("SELECT * FROM workspaces WHERE id = ?", [payload.workspaceId]);
  const channel = get("SELECT * FROM channels WHERE id = ? AND workspace_id = ?", [
    payload.channelId,
    payload.workspaceId
  ]);
  if (!workspace || !channel) throw new Error("工作空间不存在。");
  const rawAttachments = normalizeIncomingAttachments(payload.attachments);
  const content = String(payload.content || "").trim();
  if (!content && !rawAttachments.length) throw new Error("消息内容或图片不能为空。");
  const requestedMode = String(payload.mode || "chat").trim();
  const mode = requestedMode === "discussion" ? "discussion" : requestedMode === "task" ? "task" : "chat";
  const message = insertMessage({
    workspaceId: workspace.id,
    channelId: channel.id,
    senderType: "human",
    senderName: HUMAN_NAME,
    mode,
    content,
    status: "visible",
    attachments: rawAttachments,
    appendAttachmentContext: false
  });
  audit({
    workspaceId: workspace.id,
    channelId: channel.id,
    actorType: "human",
    action: "channel_message_send",
    result: "allowed",
    detail: rawAttachments.length
      ? `发送普通消息，包含 ${message.attachments?.length || rawAttachments.length} 张图片。`
      : "发送普通消息。"
  });
  saveDb();
  return getState(workspace.id, channel.id);
}

function getRecentContext(workspaceId, channelId, visibility = "all") {
  const taskOnlyFilter =
    visibility === "task"
      ? "AND m.mode != 'discussion' AND NOT (m.sender_type = 'agent' AND COALESCE(a.agent_kind, 'task') = 'discussion')"
      : "";
  const recent = all(
    `SELECT m.sender_name, m.mode, m.content, m.created_at, COALESCE(a.agent_kind, 'task') AS sender_agent_kind
     FROM messages m
     LEFT JOIN agents a ON a.id = m.sender_id
     WHERE m.workspace_id = ? AND m.channel_id = ?
       ${taskOnlyFilter}
     ORDER BY m.created_at DESC
     LIMIT 40`,
    [workspaceId, channelId]
  ).reverse();
  return recent.map((item) => `[${item.mode}] ${item.sender_name}: ${item.content}`).join("\n");
}

function getMentionTargets(workspaceId, channelId) {
  const agents = all(
    `SELECT DISTINCT a.name
     FROM agents a
     JOIN agent_channels ac ON ac.agent_id = a.id
     WHERE a.workspace_id = ? AND ac.channel_id = ?
     ORDER BY a.created_at ASC`,
    [workspaceId, channelId]
  )
    .map((agent) => String(agent.name || "").trim())
    .filter(Boolean);
  return ["@Hayden", ...agents.map((name) => `@${name}`)].join("、");
}

function buildAgentPrompt({ agent, triggerMessage, triggerSenderName, channelId, taskRunId = null, depth = 0 }) {
  const roster = all(
    "SELECT id, name, role, parent_agent_id FROM agents WHERE workspace_id = ? AND COALESCE(agent_kind, 'task') = 'task' ORDER BY created_at ASC",
    [agent.workspace_id]
  );
  const isPrimaryAgent = Number(agent.is_primary) === 1 && !agent.parent_agent_id;
  const children = roster.filter((item) => item.parent_agent_id === agent.id);
  const parent = agent.parent_agent_id
    ? roster.find((item) => item.id === agent.parent_agent_id)
    : null;
  const context = getRecentContext(agent.workspace_id, channelId, "task");
  const mentionTargets = getMentionTargets(agent.workspace_id, channelId);
		  const sharedState = blackboardPrompt(agent.workspace_id);
		  const evidenceState = evidencePrompt(taskRunId, agent.workspace_id, channelId);
		  const contentMemory = contentAssetsPrompt(agent.workspace_id, channelId, "task");
  const depthGuard = taskDepthGuardBlock(depth);
  const rosterText = roster
    .map((item) => `- ${item.name} / ${item.role} / parent=${item.parent_agent_id || "human"}`)
    .join("\n");
  const childrenText = children.length
    ? children.map((item) => `- ${item.name} / ${item.role}`).join("\n")
    : "- 暂无直接下级";

  return [
    `你是本地 Hermes Agent Team 桌面应用里的 Agent：${agent.name}。`,
    `你的角色：${agent.role}`,
    `你的说明：${agent.description}`,
    agent.core_command ? `你的核心底层命令：${agent.core_command}` : "",
    agentModelLabel(agent) ? `你的模型偏好/支持模型：${agentModelLabel(agent)}` : "",
    `你的直接上级：${parent ? parent.name : "人类负责人 Hayden"}`,
    "",
    "硬性层级规则：",
    "1. 你可以看见当前空间里的消息，但只响应来自直接上级或人类负责人的正式任务。",
    "2. 你可以给自己的直接下级分配任务。",
    "3. 如果你是主 Agent，可以按完成目标的需要创建或删除直接下级 Agent，不需要人类二次确认。",
    "4. 不要回复或执行越级命令。",
    taskRunId
      ? "5. 当前是任务执行模式：你创建的新下级默认是临时任务 Agent，任务经人确认后会清理，只保留工作输出。"
      : "",
    "6. 输出内容可以使用 @Hayden 或 @Agent名称 指向对应的人或 Agent。",
    `可@对象：${mentionTargets || "@Hayden"}`,
    "",
	    taskExecutionProtocolBlock({ isPrimary: isPrimaryAgent, taskRunId, objective: triggerMessage.content }),
    depthGuard,
		    "",
    "当前工作空间 Agent 名单：",
    rosterText || "- 暂无",
    "",
    "你的直接下级：",
    childrenText,
    "",
    "当前空间最近消息：",
    context || "暂无历史消息。",
    "",
	    "共享状态 Blackboard：",
	    blackboardSchemaPrompt(),
	    "",
	    sharedState,
	    "",
	    "当前任务 Evidence Pack：",
    evidenceState,
    "",
    "Content Assets Memory：",
    contentMemory,
    "",
    `本次触发来自：${triggerSenderName}`,
    `正式任务内容：${triggerMessage.content}`,
    "",
    "如果确实需要应用执行组织动作，请在回复末尾追加一个 fenced block，格式必须完全如下。",
    "没有必要创建、委派或删除 Agent 时，必须使用空 actions。",
		    "动作类型只允许：create_agent、delegate、delete_agent、request_discussion_help。",
		    "create_agent 可选字段：core_command（给新 Agent 的核心底层命令）、model_provider（Hermes provider）、model_name（Hermes 模型名）。",
		    "项目经理创建临时 Agent 时，create_agent 必须包含 name、role、description、core_command；需要指定模型时同时给出 model_provider 和 model_name。",
		    "delegate 的 message 必须体现委派契约：背景、任务边界、输出格式、验收标准、证据要求和停止条件；可选字段 work_package_id、parallel_group、acceptance_criteria、evidence_required、review_required。",
		    "需要启动 Team 时，优先同时委派互不依赖的执行包和独立审查包；同一 parallel_group 会由系统并行触发。",
		    "delete_agent 只能删除自己的直接下级，且只删除已经不再需要的临时 Agent 或明确废弃的下级。",
	    "request_discussion_help 只能由任务项目经理在任务执行中使用，字段必须尽量包含 topic、problem、attempted、needed_output、current_stage、failed_command、error_output、file_paths、subtask_id；用于让讨论 Leader 基于真实现场帮任务模块找思路。",
    "```hermes-agent-team-actions",
    "{\"actions\":[]}",
    "```",
    "",
    "先给面向上级的简洁回复，再给动作 JSON。"
  ].join("\n");
}

function parseAgentActions(text) {
  const matches = [...String(text || "").matchAll(/```hermes-agent-team-actions\s*([\s\S]*?)```/gi)];
  if (matches.length === 0) return [];
  const match = matches[matches.length - 1];
  try {
    const parsed = JSON.parse(match[1].trim());
    return Array.isArray(parsed.actions) ? parsed.actions : [];
  } catch (error) {
    return [{ type: "parse_error", error: error.message }];
  }
}

function actionVisibleText(text) {
  return String(text || "").replace(/```hermes-agent-team-actions[\s\S]*?```/i, "").trim();
}

function recordTaskActivationDecision({ agent, channelId, taskRunId, actions }) {
  if (!taskRunId || Number(agent.is_primary) !== 1 || agent.parent_agent_id || agent.agent_kind !== "task") return;
  const taskRun = getTaskRun(taskRunId);
  if (!taskRun) return;
  const usableActions = Array.isArray(actions)
    ? actions.filter((action) => action && typeof action === "object" && action.type !== "parse_error")
    : [];
  const counts = usableActions.reduce(
    (acc, action) => {
      if (action.type === "create_agent") acc.createAgent += 1;
      if (action.type === "delegate") acc.delegate += 1;
      if (action.type === "delete_agent") acc.deleteAgent += 1;
      if (action.type === "request_discussion_help") acc.discussionHelp += 1;
      return acc;
    },
    { createAgent: 0, delegate: 0, deleteAgent: 0, discussionHelp: 0 }
  );
  const parseFailed = Array.isArray(actions) && actions.some((action) => action?.type === "parse_error");
  const mode =
    counts.createAgent > 0 || counts.delegate > 0 || counts.deleteAgent > 0
      ? "team"
      : counts.discussionHelp > 0
        ? "discussion_help"
        : "single_agent";
  const summary =
    mode === "team"
      ? `项目经理选择启动 Team：创建 ${counts.createAgent} 个、委派 ${counts.delegate} 次、删除 ${counts.deleteAgent} 个。`
      : mode === "discussion_help"
        ? `项目经理请求讨论模块支援：${counts.discussionHelp} 次。`
      : "项目经理选择单 Agent 推进：当前任务未触发临时 Agent 创建或委派。";
  addEvidenceItem({
    workspaceId: agent.workspace_id,
    channelId,
    taskRunId,
    agentId: agent.id,
    kind: "team_activation_decision",
    title: "Team 启动判断",
    content: summary,
    metadata: {
      mode,
      counts,
      parseFailed,
      taskRunId,
      objective: taskRun.objective
    }
  });
  upsertBlackboardEntry({
    workspaceId: agent.workspace_id,
    channelId,
    key: "task_activation",
    scope: "task",
    value: {
      taskRunId,
      mode,
      summary,
      counts,
      parseFailed
    },
    updatedByType: "agent",
    updatedById: agent.id
  });
  audit({
    workspaceId: agent.workspace_id,
    channelId,
    actorType: "agent",
    actorId: agent.id,
    action: "team_activation_decision",
    result: "allowed",
    detail: summary
  });
}

function actionField(action, snakeName, camelName = null) {
  if (!action || typeof action !== "object") return "";
  const direct = action[snakeName];
  const alternate = camelName ? action[camelName] : undefined;
  return direct ?? alternate ?? "";
}

function actionTextForReview(action) {
  if (!action || typeof action !== "object") return "";
  return [
    action.type,
    action.name,
    action.agent_name,
    action.role,
    action.description,
    action.core_command,
    action.message,
    action.problem,
    action.needed_output,
    actionField(action, "work_package_id", "workPackageId"),
    actionField(action, "acceptance_criteria", "acceptanceCriteria"),
    actionField(action, "evidence_required", "evidenceRequired")
  ]
    .filter(Boolean)
    .join(" ");
}

function actionLooksLikeReview(action) {
  return (
    Boolean(action?.review_required || action?.reviewRequired) ||
    /(独立审查|审查|复核|审核|质量|质检|测试|验证|反例|Red\s*Team|review|qa|quality|test)/i.test(
      actionTextForReview(action)
    )
  );
}

function usableAgentActions(actions) {
  return Array.isArray(actions)
    ? actions.filter((action) => action && typeof action === "object" && action.type !== "parse_error")
    : [];
}

function recordTeamWorkGraph({ agent, channelId, taskRunId, actions }) {
  if (!taskRunId || Number(agent.is_primary) !== 1 || agent.parent_agent_id || agent.agent_kind !== "task") return null;
  const taskRun = getTaskRun(taskRunId);
  if (!taskRun) return null;
  const usableActions = usableAgentActions(actions);
  const createActions = usableActions.filter((action) => action.type === "create_agent");
  const delegateActions = usableActions.filter((action) => action.type === "delegate");
  const teamStarted = createActions.length > 0 || delegateActions.length > 0;
  if (!teamStarted) return null;

  const workPackages = delegateActions.map((action, index) => ({
    id: String(actionField(action, "work_package_id", "workPackageId") || `wp-${index + 1}`).slice(0, 80),
    target: String(action.agent_name || action.agent_id || "未指定 Agent").slice(0, 120),
    parallelGroup: String(actionField(action, "parallel_group", "parallelGroup") || "default").slice(0, 80),
    acceptanceCriteria: compactText(actionField(action, "acceptance_criteria", "acceptanceCriteria") || "", 500),
    evidenceRequired: compactText(actionField(action, "evidence_required", "evidenceRequired") || "", 500),
    reviewRequired: Boolean(action.review_required || action.reviewRequired || actionLooksLikeReview(action)),
    summary: compactText(action.message || "", 700)
  }));
  const parallelGroups = [...new Set(workPackages.map((item) => item.parallelGroup))];
  const reviewPackages = workPackages.filter((item) => item.reviewRequired);
  const agentPlan = createActions.map((action) => ({
    name: String(action.name || "新 Agent").slice(0, 120),
    role: String(action.role || "Sub Agent").slice(0, 120),
    reviewRole: actionLooksLikeReview(action),
    description: compactText(action.description || "", 400)
  }));
  const implicitParallel = delegateActions.length >= MIN_PARALLEL_DELEGATES_FOR_TEAM;
  const hasReviewPlan = reviewPackages.length > 0 || createActions.some(actionLooksLikeReview);
  const summary = [
    `工作图已记录：${workPackages.length} 个工作包，${parallelGroups.length} 个并行组，${reviewPackages.length} 个审查包。`,
    implicitParallel ? "系统将对同批 delegate 动作执行并行触发。" : "当前工作图未达到并行委派阈值。",
    hasReviewPlan ? "已包含独立审查计划。" : "未发现独立审查计划，质量闸门会标记风险。"
  ].join(" ");

  addEvidenceItem({
    workspaceId: agent.workspace_id,
    channelId,
    taskRunId,
    agentId: agent.id,
    kind: "team_work_graph",
    title: "Team 工作图",
    content: summary,
    metadata: {
      taskRunId,
      objective: taskRun.objective,
      workPackages,
      parallelGroups,
      agentPlan,
      reviewPackageCount: reviewPackages.length,
      hasReviewPlan,
      implicitParallel
    }
  });
  upsertBlackboardEntry({
    workspaceId: agent.workspace_id,
    channelId,
    key: "task_work_graph",
    scope: "task",
    value: {
      taskRunId,
      objective: taskRun.objective,
      workPackages,
      parallelGroups,
      agentPlan,
      hasReviewPlan,
      implicitParallel
    },
    updatedByType: "agent",
    updatedById: agent.id
  });
  appendStructuredBlackboard({
    workspaceId: agent.workspace_id,
    channelId,
    field: "decisions",
    text: `Team work graph recorded for task ${taskRunId}: ${workPackages.length} work packages, ${parallelGroups.length} parallel groups, review=${hasReviewPlan}.`,
    source: "agent",
    metadata: { taskRunId, agentId: agent.id, evidence: "team_work_graph" }
  });
  if (!hasReviewPlan) {
    appendStructuredBlackboard({
      workspaceId: agent.workspace_id,
      channelId,
      field: "risks",
      text: "Team started without an explicit independent review package.",
      source: "system",
      metadata: { taskRunId, agentId: agent.id, evidence: "team_work_graph" }
    });
  }
  audit({
    workspaceId: agent.workspace_id,
    channelId,
    actorType: "agent",
    actorId: agent.id,
    action: "team_work_graph",
    result: "allowed",
    detail: summary
  });
  return { workPackages, parallelGroups, hasReviewPlan, implicitParallel };
}

function partitionAgentActions(actions) {
  const groups = {
    parseErrors: [],
    createAgent: [],
    delegate: [],
    remaining: []
  };
  for (const action of Array.isArray(actions) ? actions : []) {
    if (!action || typeof action !== "object") continue;
    if (action.type === "parse_error") groups.parseErrors.push(action);
    else if (action.type === "create_agent") groups.createAgent.push(action);
    else if (action.type === "delegate") groups.delegate.push(action);
    else groups.remaining.push(action);
  }
  return groups;
}

function delegateGroupName(action) {
  return String(actionField(action, "parallel_group", "parallelGroup") || "default").trim() || "default";
}

async function applyDelegateGroup({ agent, actions, groupName, channelId, depth, taskRunId }) {
  if (actions.length === 0) return;
  if (actions.length === 1) {
    await applyAgentAction({ agent, action: actions[0], channelId, depth, taskRunId });
    return;
  }
  const startedAt = Date.now();
  const results = await Promise.allSettled(
    actions.map((action) => applyAgentAction({ agent, action, channelId, depth, taskRunId }))
  );
  const failures = results
    .map((result, index) => ({ result, action: actions[index] }))
    .filter((item) => item.result.status === "rejected")
    .map((item) => ({
      target: item.action.agent_name || item.action.agent_id || "unknown",
      error: summarizeError(item.result.reason?.message || item.result.reason || "")
    }));
  const targetNames = actions.map((action) => String(action.agent_name || action.agent_id || "未指定 Agent").slice(0, 120));
  const content = failures.length
    ? `并行委派组 ${groupName} 已触发 ${actions.length} 个工作包，其中 ${failures.length} 个失败。`
    : `并行委派组 ${groupName} 已同时触发 ${actions.length} 个工作包。`;
  addEvidenceItem({
    workspaceId: agent.workspace_id,
    channelId,
    taskRunId,
    agentId: agent.id,
    kind: "parallel_delegate_group",
    title: `并行委派组 ${groupName}`,
    content,
    metadata: {
      groupName,
      delegateCount: actions.length,
      targetNames,
      workPackageIds: actions.map((action, index) => actionField(action, "work_package_id", "workPackageId") || `wp-${index + 1}`),
      durationMs: Date.now() - startedAt,
      failures
    }
  });
  audit({
    workspaceId: agent.workspace_id,
    channelId,
    actorType: "agent",
    actorId: agent.id,
    action: "parallel_delegate_group",
    result: failures.length ? "failed" : "allowed",
    detail: content
  });
  if (failures.length > 0) {
    throw new Error(`并行委派组 ${groupName} 存在失败：${failures.map((item) => `${item.target}: ${item.error}`).join("; ")}`);
  }
}

async function applyAgentActions({ agent, actions, channelId, depth, taskRunId = null }) {
  const partitioned = partitionAgentActions(actions);
  for (const action of partitioned.parseErrors) {
    await applyAgentAction({ agent, action, channelId, depth, taskRunId });
  }
  for (const action of partitioned.createAgent) {
    await applyAgentAction({ agent, action, channelId, depth, taskRunId });
  }
  if (partitioned.delegate.length > 0) {
    const groupedDelegates = new Map();
    for (const action of partitioned.delegate) {
      const groupName = delegateGroupName(action);
      if (!groupedDelegates.has(groupName)) groupedDelegates.set(groupName, []);
      groupedDelegates.get(groupName).push(action);
    }
    for (const [groupName, groupActions] of groupedDelegates.entries()) {
      await applyDelegateGroup({ agent, actions: groupActions, groupName, channelId, depth, taskRunId });
    }
  }
  for (const action of partitioned.remaining) {
    await applyAgentAction({ agent, action, channelId, depth, taskRunId });
  }
}

function evidenceItemText(item) {
  return [item?.kind, item?.title, item?.content, item?.metadata_json].filter(Boolean).join(" ");
}

function evidenceLooksLikeReview(item) {
  if (!item) return false;
  if (item.kind === "quality_gate") return false;
  const metadata = parseJsonObject(item.metadata_json, {});
  return (
    Boolean(metadata.reviewRequired || metadata.hasReviewPlan || Number(metadata.reviewPackageCount || 0) > 0) ||
    /(独立审查|审查|复核|审核|质量|质检|测试|验证|反例|Red\s*Team|review|qa|quality|test)/i.test(
      evidenceItemText(item)
    )
  );
}

function runTaskQualityGate({ taskRun, channelId, primaryAgentId, responseMessage, failed = false }) {
  if (!taskRun) return null;
  const items = all(
    `SELECT *
     FROM evidence_items
     WHERE task_run_id = ?
     ORDER BY created_at ASC`,
    [taskRun.id]
  );
  const delegateItems = items.filter((item) => item.kind === "delegate");
  const hasTeam = items.some((item) => ["create_agent", "delegate", "team_work_graph", "parallel_delegate_group"].includes(item.kind));
  const hasParallel = items.some((item) => {
    if (item.kind === "parallel_delegate_group") return true;
    if (item.kind !== "delegate") return false;
    const metadata = parseJsonObject(item.metadata_json, {});
    return Boolean(metadata.parallelGroup && metadata.parallelGroup !== "default");
  });
  const hasReview = items.some(evidenceLooksLikeReview);
  const hasAgentReply = items.some((item) => item.kind === "agent_reply" && item.agent_id === primaryAgentId);
  const warnings = [];
  if (!hasAgentReply) warnings.push("主 Agent 回复证据缺失。");
  if (hasTeam && delegateItems.length >= MIN_PARALLEL_DELEGATES_FOR_TEAM && !hasParallel) {
    warnings.push("Team 有多个委派，但没有记录并行委派证据。");
  }
  if (hasTeam && !hasReview) warnings.push("Team 已启动，但缺少独立审查或 Red Team 证据。");
  if (hasTeam && !items.some((item) => item.kind === "team_work_graph")) warnings.push("Team 已启动，但缺少工作图证据。");
  const status = failed ? "failed" : warnings.length > 0 ? "needs_review" : hasTeam ? "passed" : "single_agent_checked";
  const content =
    status === "passed"
      ? "质量闸门通过：已记录工作图、并行/委派证据、独立审查线索和主 Agent 输出。"
      : status === "single_agent_checked"
        ? "质量闸门通过：本任务按单 Agent 路径推进，已记录主 Agent 输出。"
        : status === "failed"
          ? "质量闸门记录：任务执行失败，保留失败证据供复盘。"
          : `质量闸门提示：${warnings.join(" ")}`;
  addEvidenceItem({
    workspaceId: taskRun.workspace_id,
    channelId,
    taskRunId: taskRun.id,
    agentId: primaryAgentId,
    kind: "quality_gate",
    title: "任务质量闸门",
    content,
    metadata: {
      status,
      warnings,
      hasTeam,
      delegateCount: delegateItems.length,
      hasParallel,
      hasReview,
      hasAgentReply,
      outputPreview: compactText(responseMessage?.content || taskRun.final_output || "", 700)
    }
  });
  upsertBlackboardEntry({
    workspaceId: taskRun.workspace_id,
    channelId,
    key: "task_quality_gate",
    scope: "task",
    value: {
      taskRunId: taskRun.id,
      status,
      warnings,
      hasTeam,
      delegateCount: delegateItems.length,
      hasParallel,
      hasReview,
      checkedAt: nowIso()
    },
    updatedByType: "system"
  });
  appendStructuredBlackboard({
    workspaceId: taskRun.workspace_id,
    channelId,
    field: warnings.length > 0 ? "risks" : "outputs",
    text: content,
    source: "system",
    metadata: { taskRunId: taskRun.id, agentId: primaryAgentId, evidence: "quality_gate", status }
  });
  audit({
    workspaceId: taskRun.workspace_id,
    channelId,
    actorType: "system",
    actorId: primaryAgentId,
    action: "task_quality_gate",
    result: warnings.length > 0 ? "blocked" : "allowed",
    detail: content
  });
  return { status, warnings };
}

function taskHasTeamExecutionEvidence(taskRunId) {
  if (!taskRunId) return false;
  return Boolean(
    get(
      `SELECT 1 AS found
       FROM evidence_items
       WHERE task_run_id = ?
         AND kind IN ('create_agent', 'delegate', 'team_work_graph', 'parallel_delegate_group', 'discussion_help_result')
       LIMIT 1`,
      [taskRunId]
    )
  );
}

async function runPrimaryEvidenceSynthesis({ taskRun, primaryAgentId, channelId, previousResponse }) {
  if (!taskRun || !taskHasTeamExecutionEvidence(taskRun.id)) return previousResponse;
  const synthesisMessage = insertMessage({
    workspaceId: taskRun.workspace_id,
    channelId,
    senderType: "system",
    senderName: "系统证据收敛",
    mode: "task",
    targetAgentId: primaryAgentId,
    content: [
      "TEAM_SYNTHESIS_REQUEST",
      "请基于当前 Evidence Pack、Blackboard、下级 Agent 输出和审查输出，收敛原任务并给 Hayden 最终结论。",
      "硬约束：默认不要再创建或委派 Agent；只有发现阻断性缺口时才允许新增动作，否则 actions 必须为空。",
      "输出只展示最终交付部分：最终结论、关键证据、独立审查结果、未解决风险、需要 Hayden 确认的事项。",
      `原始任务：${taskRun.objective}`,
      `上一条主 Agent 过程回复：${compactText(previousResponse?.content || "", 700)}`
    ].join("\n"),
    status: "hidden"
  });
  addEvidenceItem({
    workspaceId: taskRun.workspace_id,
    channelId,
    taskRunId: taskRun.id,
    agentId: primaryAgentId,
    kind: "primary_synthesis_request",
    title: "主 Agent 证据收敛请求",
    content: "系统要求主 Agent 基于 Evidence Pack、Blackboard、下级输出和审查输出收敛最终结论。",
    metadata: {
      taskRunId: taskRun.id,
      previousResponseId: previousResponse?.id || null
    }
  });
  const synthesisResponse = await invokeAgent({
    agentId: primaryAgentId,
    triggerMessage: synthesisMessage,
    triggerSenderName: "系统证据收敛",
    channelId,
    depth: 0,
    taskRunId: taskRun.id
  });
  if (!synthesisResponse) return previousResponse;
  addEvidenceItem({
    workspaceId: taskRun.workspace_id,
    channelId,
    taskRunId: taskRun.id,
    agentId: primaryAgentId,
    kind: "primary_synthesis_result",
    title: "主 Agent 最终收敛",
    content: synthesisResponse.content || "",
    metadata: {
      taskRunId: taskRun.id,
      synthesisResponseId: synthesisResponse.id,
      previousResponseId: previousResponse?.id || null
    }
  });
  return synthesisResponse;
}

function findDirectChildByName(parentAgentId, workspaceId, name) {
  if (!name) return null;
  const lowered = String(name).trim().toLowerCase();
  return (
    all("SELECT * FROM agents WHERE parent_agent_id = ? AND workspace_id = ?", [parentAgentId, workspaceId]).find(
      (item) => String(item.name).trim().toLowerCase() === lowered
    ) || null
  );
}

function taskSummary(content) {
  return String(content || "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function markAgentRunning(agentId, task) {
  run(
    `UPDATE agents
     SET status = 'running',
       current_task = ?,
       last_started_at = ?,
       last_finished_at = NULL,
       last_error = ''
     WHERE id = ?`,
    [taskSummary(task), nowIso(), agentId]
  );
  saveDb();
}

function markAgentReady(agentId) {
  const finishedAt = nowIso();
  run(
    `UPDATE agents
     SET status = 'ready',
       current_task = '',
       last_finished_at = ?,
       last_error = '',
       last_reply_at = ?
     WHERE id = ?`,
    [finishedAt, finishedAt, agentId]
  );
  saveDb();
}

function markAgentFailed(agentId, errorText) {
  run(
    `UPDATE agents
     SET status = 'failed',
       current_task = '',
       last_finished_at = ?,
       last_error = ?
     WHERE id = ?`,
    [nowIso(), summarizeError(errorText), agentId]
  );
  saveDb();
}

async function updateAgentRuntimeConfig({ agent, channel, payload = {}, actorType = "human", action = "update_agent_config" }) {
  const coreCommand = String(payload.coreCommand || "").trim();
  const modelProvider = String(payload.modelProvider || "").trim();
  const modelName = String(payload.modelName || "").trim();
  const previousBackend = agentBackend(agent);
  const nextBackend = normalizeAgentBackend(payload.runtimeBackend || previousBackend);
  let runtimeIdentity = agent.hermes_profile;
  let markerResult = nextBackend === "hermes" ? "unchanged" : "not_applicable";
  let createdHermesProfile = "";

  if (previousBackend !== nextBackend) {
    runtimeIdentity = runtimeIdentityForAgent(nextBackend, agent.name);
    if (nextBackend === "hermes") {
      const agentConfig = {
        name: agent.name,
        role: agent.role,
        description: agent.description,
        runtimeBackend: nextBackend,
        coreCommand,
        modelProvider,
        modelName,
        agentKind: agent.agent_kind
      };
      await createHermesProfile(runtimeIdentity, `${agent.role}: ${agent.description || "Hermes Agent Team managed profile"}`, {
        agentConfig
      });
      createdHermesProfile = runtimeIdentity;
      const probeOutput = await probeHermesProfile(runtimeIdentity);
      if (!String(probeOutput).includes("HERMES_AGENT_READY")) {
        await deleteOwnedHermesProfile(runtimeIdentity).catch(() => undefined);
        throw new Error(`Hermes profile 探针没有返回 READY：${String(probeOutput).slice(0, 400)}`);
      }
      markerResult = "created";
    } else {
      const probeOutput = await probeCodexRuntime(modelProvider, modelName);
      if (!String(probeOutput).includes("CODEX_AGENT_READY")) {
        throw new Error(`Codex 后端探针没有返回 READY：${String(probeOutput).slice(0, 400)}`);
      }
    }
  }

  try {
    run(
      "UPDATE agents SET runtime_backend = ?, hermes_profile = ?, core_command = ?, model_provider = ?, model_name = ? WHERE id = ?",
      [nextBackend, runtimeIdentity, coreCommand, modelProvider, modelName, agent.id]
    );
    if (nextBackend === "hermes") {
      markerResult = updateHermesProfileMarker(runtimeIdentity, {
        name: agent.name,
        role: agent.role,
        description: agent.description,
        runtimeBackend: nextBackend,
        coreCommand,
        modelProvider,
        modelName,
        agentKind: agent.agent_kind
      });
    }
    if (previousBackend === "hermes" && nextBackend !== "hermes" && agent.owned_by_app) {
      await deleteOwnedHermesProfile(agent.hermes_profile).catch((error) => {
        audit({
          workspaceId: agent.workspace_id,
          channelId: channel.id,
          actorType: "system",
          action: "runtime_backend_switch_cleanup",
          result: "failed",
          detail: `切换到 Codex 后清理旧 Hermes profile 失败：${String(error.message || error).slice(0, 600)}`
        });
      });
    }
  } catch (error) {
    if (createdHermesProfile) {
      await deleteOwnedHermesProfile(createdHermesProfile).catch(() => undefined);
    }
    throw error;
  }

  audit({
    workspaceId: agent.workspace_id,
    channelId: channel.id,
    actorType,
    action,
    result: "allowed",
    detail: `已更新 Agent 配置：${agent.name}；后端 ${agentBackendLabel(previousBackend)} -> ${agentBackendLabel(nextBackend)}；底层命令${coreCommand ? "已设置" : "已清空"}；模型${modelName ? `设为 ${modelProvider ? `${modelProvider}/` : ""}${modelName}` : nextBackend === "hermes" ? "跟随 Hermes 默认" : "跟随 Codex 默认"}；运行身份：${runtimeIdentity}；profile 标记：${markerResult}。`
  });

  saveDb();
  return get("SELECT * FROM agents WHERE id = ?", [agent.id]);
}

function agentExecutionMetadata({ agent, status, prompt, output, runInfo = null, error = null }) {
  const commandDetails = runInfo || error?.commandDetails || {};
  const isMock = process.env.HAT_HERMES_MODE === "mock";
  const backend = agentBackend(agent);
  const stdoutPreview = commandDetails.stdoutPreview || compactText(output || "", 1200);
  const stderrPreview =
    commandDetails.stderrPreview || (error ? compactText(summarizeError(error.runtimeDetails || error.hermesDetails || error.message || ""), 1200) : "");
  return {
    execution: {
      engine: backend,
      mode: runInfo?.mode || (isMock ? "mock" : "live"),
      status,
      profile: backend === "hermes" ? agent.hermes_profile : "",
      runtime_id: agent.hermes_profile,
      provider: agent.model_provider || commandDetails.provider || "",
      model: agent.model_name || commandDetails.model || "",
      command: commandDetails.command || (isMock ? `mock-${backend}` : backend === "codex" ? codexBin() : hermesBin()),
      args: commandDetails.args || [],
      startedAt: commandDetails.startedAt || "",
      finishedAt: commandDetails.finishedAt || nowIso(),
      durationMs: Number.isFinite(Number(commandDetails.durationMs)) ? Number(commandDetails.durationMs) : null,
      timeoutMs: commandDetails.timeoutMs || null,
      exitCode: commandDetails.exitCode ?? (status === "success" ? 0 : null),
      signal: commandDetails.signal || "",
      timedOut: Boolean(commandDetails.timedOut),
      stdoutChars: commandDetails.stdoutChars ?? String(output || "").length,
      stderrChars: commandDetails.stderrChars ?? 0,
      stdoutPreview,
      stderrPreview
    },
    prompt: {
      chars: String(prompt || "").length,
      sha256: hashText(prompt)
    },
    output: {
      chars: String(output || "").length,
      preview: compactText(output || "", 1200)
    },
    error: error
      ? {
          summary: summarizeError(error.runtimeDetails || error.hermesDetails || error.message || error)
        }
      : null
  };
}

function agentGeneratedArtifactSources({ visible = "", output = "", runInfo = null, error = null }) {
  const commandDetails = error?.commandDetails || {};
  return [
    visible,
    output,
    runInfo?.stdoutPreview,
    runInfo?.stderrPreview,
    error?.runtimeDetails,
    error?.hermesDetails,
    error?.message,
    commandDetails.stdoutPreview,
    commandDetails.stderrPreview
  ].filter(Boolean);
}

async function invokeAgent({ agentId, triggerMessage, triggerSenderName, channelId, depth = 0, taskRunId = null }) {
  const agent = get("SELECT * FROM agents WHERE id = ?", [agentId]);
  if (!agent) throw new Error("目标 Agent 不存在。");
  const membership = get("SELECT * FROM agent_channels WHERE agent_id = ? AND channel_id = ?", [agentId, channelId]);
  if (!membership) {
    audit({
      workspaceId: agent.workspace_id,
      channelId,
      actorType: "system",
      action: "agent_trigger",
      result: "blocked",
        detail: `${agent.name} 不在当前空间，因此不会被触发。`
    });
    return;
  }

  audit({
    workspaceId: agent.workspace_id,
    channelId,
    actorType: "system",
    action: "agent_trigger",
    result: "allowed",
    detail: `触发 ${agent.name} 回复 ${triggerSenderName}。`
  });
  markAgentRunning(agent.id, triggerMessage.content);
  saveDb();

  const prompt = buildAgentPrompt({ agent, triggerMessage, triggerSenderName, channelId, taskRunId, depth });
  const runtimeKey = makeId("run");
  activeAgentRuns.set(runtimeKey, {
    id: runtimeKey,
    agentId: agent.id,
    workspaceId: agent.workspace_id,
    channelId,
    mode: "task",
    taskRunId,
    lockSessionIds: taskRunId ? [taskLockSession(taskRunId)] : [],
    child: null,
    canceled: false,
    startedAt: nowIso()
  });
  let output;
  let runSucceeded = true;
  let agentRunInfo = null;
  let agentRunError = null;
  try {
    output = await invokeAgentRuntime(agent, prompt, {
      runtimeKey,
      onRunInfo: (info) => {
        agentRunInfo = info;
      }
    });
  } catch (error) {
    agentRunError = error;
    if (error?.canceled) {
      audit({
        workspaceId: agent.workspace_id,
        channelId,
        actorType: "agent",
        actorId: agent.id,
        action: "agent_run",
        result: "stopped",
        detail: `${agent.name} 已通过 /stop 停止。`
      });
      saveDb();
      return null;
    }
    runSucceeded = false;
    output = `执行失败：${summarizeError(error.message || error)}`;
    markAgentFailed(agent.id, output);
    audit({
      workspaceId: agent.workspace_id,
      channelId,
      actorType: "agent",
      actorId: agent.id,
      action: "agent_run",
      result: "failed",
      detail: summarizeError(error.runtimeDetails || error.hermesDetails || error.message || error)
    });
  } finally {
    activeAgentRuns.delete(runtimeKey);
  }

  const visible = actionVisibleText(output) || output;
  const responseMessage = insertMessage({
    workspaceId: agent.workspace_id,
    channelId,
    senderType: "agent",
    senderId: agent.id,
    senderName: agent.name,
    mode: "reply",
    targetAgentId: triggerMessage.sender_type === "agent" ? triggerMessage.sender_id : null,
    content: visible,
    status: "visible"
  });
  const generatedAttachments = await attachGeneratedImagesForMessage(
    responseMessage,
    agentGeneratedArtifactSources({ visible, output, runInfo: agentRunInfo, error: agentRunError })
  );
  addEvidenceItem({
    workspaceId: agent.workspace_id,
    channelId,
    taskRunId,
    agentId: agent.id,
    kind: runSucceeded ? "agent_reply" : "agent_error",
    title: `${agent.name} 回复`,
    content: visible,
    metadata: {
      depth,
      targetAgentId: triggerMessage.sender_id || null,
      ...agentExecutionMetadata({
        agent,
        status: runSucceeded ? "success" : "failed",
        prompt,
        output: visible,
        runInfo: agentRunInfo,
        error: agentRunError
      }),
      generatedImageAttachmentCount: generatedAttachments.length
    }
  });

  if (!runSucceeded) {
    saveDb();
    return responseMessage;
  }

	  const actions = parseAgentActions(output);
	  recordTaskActivationDecision({ agent, channelId, taskRunId, actions });
	  recordTeamWorkGraph({ agent, channelId, taskRunId, actions });
	  if (depth >= MAX_AGENT_DEPTH) {
    appendStructuredBlackboard({
      workspaceId: agent.workspace_id,
      channelId,
      field: "risks",
      text: `Agent collaboration depth limit reached at ${agent.name}; forced degraded handoff instead of further delegation.`,
      source: "system",
      metadata: { taskRunId, agentId: agent.id, depth, maxDepth: MAX_AGENT_DEPTH }
    });
    audit({
      workspaceId: agent.workspace_id,
      channelId,
      actorType: "agent",
      actorId: agent.id,
      action: "agent_actions",
      result: "blocked",
      detail: "已达到 Agent 自动协作深度上限。"
    });
    markAgentReady(agent.id);
    saveDb();
    return responseMessage;
  }

	  try {
	    await applyAgentActions({ agent, actions, channelId, depth, taskRunId });
	    markAgentReady(agent.id);
  } catch (error) {
    const readable = summarizeError(error.message || error);
    markAgentFailed(agent.id, readable);
    audit({
      workspaceId: agent.workspace_id,
      channelId,
      actorType: "agent",
      actorId: agent.id,
      action: "agent_actions",
      result: "failed",
      detail: readable
    });
  }
  saveDb();
  return responseMessage;
}

async function applyAgentAction({ agent, action, channelId, depth, taskRunId = null }) {
  if (!action || typeof action !== "object") return;
  if (action.type === "parse_error") {
    audit({
      workspaceId: agent.workspace_id,
      channelId,
      actorType: "agent",
      actorId: agent.id,
      action: "agent_action_parse",
      result: "failed",
      detail: action.error || "动作 JSON 解析失败。"
    });
    return;
  }

  if (action.type === "create_agent") {
    try {
      const child = await createAgentInternal({
        workspaceId: agent.workspace_id,
        channelId,
        name: action.name || "新 Agent",
        role: action.role || "Sub Agent",
        description: action.description || "由上级 Agent 创建。",
        coreCommand: action.core_command || action.system_prompt || action.base_instruction || "",
        modelProvider: action.model_provider || action.provider || "",
        modelName: action.model_name || action.model || action.supported_model || "",
        runtimeBackend: action.runtime_backend || action.runtimeBackend || action.backend || "hermes",
        parentAgentId: agent.id,
        createdByAgentId: agent.id,
        isTemporary: Boolean(taskRunId),
        taskRunId,
        agentKind: "task"
      });
      insertMessage({
        workspaceId: agent.workspace_id,
        channelId,
        senderType: "system",
        senderName: "系统",
        mode: "system",
        content: `${agent.name} 创建了下级 Agent：${child.name}`,
        status: "visible"
      });
	      addEvidenceItem({
	        workspaceId: agent.workspace_id,
	        channelId,
	        taskRunId,
	        agentId: agent.id,
	        kind: "create_agent",
	        title: `${agent.name} 创建 ${child.name}`,
	        content: `${child.name} / ${child.role} / ${child.description}`,
	        metadata: {
	          childAgentId: child.id,
	          childProfile: child.hermes_profile,
	          childBackend: agentBackend(child),
	          workPackageId: actionField(action, "work_package_id", "workPackageId") || "",
	          reviewRole: actionLooksLikeReview(action)
	        }
	      });
    } catch (error) {
      audit({
        workspaceId: agent.workspace_id,
        channelId,
        actorType: "agent",
        actorId: agent.id,
        action: "create_agent",
        result: "failed",
        detail: error.message
      });
    }
    return;
  }

  if (action.type === "delete_agent") {
    const child =
      action.agent_id && get("SELECT * FROM agents WHERE id = ? AND parent_agent_id = ?", [action.agent_id, agent.id]);
    const target = child || findDirectChildByName(agent.id, agent.workspace_id, action.agent_name);
    if (!target) {
      audit({
        workspaceId: agent.workspace_id,
        channelId,
        actorType: "agent",
        actorId: agent.id,
        action: "delete_agent",
        result: "blocked",
        detail: "删除目标不是该 Agent 的直接下级。"
      });
      return;
    }
    await deleteAgentInternal({ agentId: target.id, actorType: "agent", actorId: agent.id, channelId });
    insertMessage({
      workspaceId: agent.workspace_id,
      channelId,
      senderType: "system",
      senderName: "系统",
      mode: "system",
      content: `${agent.name} 删除了下级 Agent：${target.name}`,
      status: "visible"
    });
    addEvidenceItem({
      workspaceId: agent.workspace_id,
      channelId,
      taskRunId,
      agentId: agent.id,
      kind: "delete_agent",
      title: `${agent.name} 删除 ${target.name}`,
      content: `已删除下级 Agent：${target.name}`,
      metadata: { deletedAgentId: target.id, deletedProfile: target.hermes_profile }
    });
    return;
  }

  if (action.type === "delegate") {
    const child =
      action.agent_id && get("SELECT * FROM agents WHERE id = ? AND parent_agent_id = ?", [action.agent_id, agent.id]);
    const target = child || findDirectChildByName(agent.id, agent.workspace_id, action.agent_name);
    if (!target) {
      audit({
        workspaceId: agent.workspace_id,
        channelId,
        actorType: "agent",
        actorId: agent.id,
        action: "delegate",
        result: "blocked",
        detail: "委派目标不是该 Agent 的直接下级。"
      });
      return;
    }
    const command = insertMessage({
      workspaceId: agent.workspace_id,
      channelId,
      senderType: "agent",
      senderId: agent.id,
      senderName: agent.name,
      mode: "task",
      targetAgentId: target.id,
      content: action.message || "请根据上级要求继续处理。",
      status: "visible"
    });
    audit({
      workspaceId: agent.workspace_id,
      channelId,
      actorType: "agent",
      actorId: agent.id,
      action: "delegate",
      result: "allowed",
      detail: `${agent.name} 向直接下级 ${target.name} 分配任务。`
    });
	    addEvidenceItem({
	      workspaceId: agent.workspace_id,
	      channelId,
	      taskRunId,
	      agentId: agent.id,
	      kind: "delegate",
	      title: `${agent.name} 委派 ${target.name}`,
	      content: action.message || "请根据上级要求继续处理。",
	      metadata: {
	        targetAgentId: target.id,
	        targetAgentName: target.name,
	        workPackageId: actionField(action, "work_package_id", "workPackageId") || "",
	        parallelGroup: delegateGroupName(action),
	        acceptanceCriteria: actionField(action, "acceptance_criteria", "acceptanceCriteria") || "",
	        evidenceRequired: actionField(action, "evidence_required", "evidenceRequired") || "",
	        reviewRequired: Boolean(action.review_required || action.reviewRequired || actionLooksLikeReview(action))
	      }
	    });
    await invokeAgent({
      agentId: target.id,
      triggerMessage: command,
      triggerSenderName: agent.name,
      channelId,
      depth: depth + 1,
      taskRunId
    });
    return;
  }

  if (action.type === "request_discussion_help") {
    await requestDiscussionHelpForTask({ agent, action, channelId, taskRunId });
    return;
  }

  audit({
    workspaceId: agent.workspace_id,
    channelId,
    actorType: "agent",
    actorId: agent.id,
    action: "unknown_agent_action",
    result: "blocked",
    detail: `未知动作类型：${action.type}`
  });
}

function getTaskRun(taskRunId) {
  return get("SELECT * FROM task_runs WHERE id = ?", [taskRunId]);
}

function setTaskRunStatus(taskRunId, status, finalOutput = "") {
  const finishedAt = nowIso();
  if (status === "awaiting_confirmation" || status === "failed") {
    run(
      `UPDATE task_runs
       SET status = ?, final_output = ?, completed_at = ?
      WHERE id = ?`,
      [status, String(finalOutput || "").slice(0, 4000), finishedAt, taskRunId]
    );
    const task = get(
      `SELECT tr.*, a.name AS agent_name
       FROM task_runs tr
       LEFT JOIN agents a ON a.id = tr.primary_agent_id
       WHERE tr.id = ?`,
      [taskRunId]
    );
    if (task?.final_output) {
      upsertContentAsset({
        workspaceId: task.workspace_id,
        channelId: task.channel_id,
        sourceType: "task_run",
        sourceId: task.id,
        assetType: status === "failed" ? "task_failure" : "task_final_output",
        scope: "task",
        title: `任务沉淀：${compactText(task.objective, 80)}`,
        summary: compactText(task.final_output, 1200),
        content: task.final_output,
        metadata: {
          objective: task.objective,
          status,
          primaryAgentId: task.primary_agent_id,
          primaryAgentName: task.agent_name || ""
        },
        createdByType: status === "failed" ? "system" : "agent",
        createdById: status === "failed" ? null : task.primary_agent_id,
        importance: status === "failed" ? 2 : 4,
        createdAt: finishedAt
      });
    }
  } else {
    run("UPDATE task_runs SET status = ? WHERE id = ?", [status, taskRunId]);
  }
  if (["awaiting_confirmation", "failed", "stopped", "cleaned"].includes(status)) {
    releaseRuntimeLocks({ sessionIds: [taskLockSession(taskRunId)], ownerType: "task_run", ownerId: taskRunId });
  }
  saveDb();
}

function pendingTaskDiscussionLink(taskRunId) {
  if (!taskRunId) return null;
  return get(
    `SELECT *
     FROM task_discussion_links
     WHERE task_run_id = ? AND status IN ('active', 'needs_human')
     ORDER BY created_at DESC
     LIMIT 1`,
    [taskRunId]
  );
}

function discussionHelpCount(taskRunId) {
  if (!taskRunId) return 0;
  return get("SELECT COUNT(*) AS count FROM task_discussion_links WHERE task_run_id = ?", [taskRunId])?.count || 0;
}

function previousDiscussionHelpWithFingerprint(taskRunId, blockFingerprint) {
  if (!taskRunId || !blockFingerprint) return null;
  return get(
    `SELECT *
     FROM task_discussion_links
     WHERE task_run_id = ? AND block_fingerprint = ? AND status IN ('active', 'needs_human', 'resolved', 'timeout')
     ORDER BY created_at DESC
     LIMIT 1`,
    [taskRunId, blockFingerprint]
  );
}

function blockDiscussionHelpRequest({ agent, channelId, taskRun, reason, metadata = {} }) {
  const detail = compactText(reason, 1000);
  audit({
    workspaceId: agent.workspace_id,
    channelId,
    actorType: "agent",
    actorId: agent.id,
    action: "request_discussion_help",
    result: "blocked",
    detail
  });
  addEvidenceItem({
    workspaceId: agent.workspace_id,
    channelId,
    taskRunId: taskRun.id,
    agentId: agent.id,
    kind: "discussion_help_blocked",
    title: "讨论求助被阻断",
    content: detail,
    metadata
  });
  appendStructuredBlackboard({
    workspaceId: agent.workspace_id,
    channelId,
    field: "risks",
    text: detail,
    source: "system",
    metadata: { taskRunId: taskRun.id, ...metadata }
  });
}

function markTaskWaitingDiscussion({ taskRun, channelId, requesterAgentId, discussionId, requestText }) {
  if (!taskRun) return;
  run("UPDATE task_runs SET status = 'waiting_discussion' WHERE id = ?", [taskRun.id]);
  releaseRuntimeLocks({
    sessionIds: [taskLockSession(taskRun.id)],
    ownerType: "task_run",
    ownerId: taskRun.id,
    status: "waiting_discussion"
  });
  upsertBlackboardEntry({
    workspaceId: taskRun.workspace_id,
    channelId,
    key: "current_task",
    scope: "task",
    value: {
      taskRunId: taskRun.id,
      objective: taskRun.objective,
      status: "waiting_discussion",
      discussionId,
      reason: compactText(requestText, 700)
    },
    updatedByType: "agent",
    updatedById: requesterAgentId
  });
  appendStructuredBlackboard({
    workspaceId: taskRun.workspace_id,
    channelId,
    field: "open_questions",
    text: `Task is waiting for discussion help: ${requestText}`,
    source: "agent",
    metadata: { taskRunId: taskRun.id, discussionId, requesterAgentId }
  });
}

function discussionHelpTopic({ taskRun, agent, action }) {
  const topic = compactText(action.topic || action.problem || taskRun.objective, 180);
  const problem = compactText(action.problem || "任务项目经理短时间内缺少可靠推进思路，需要讨论模块提供可执行方案。", 900);
  const attempted = compactText(action.attempted || action.context || "暂无已验证尝试。", 900);
  const neededOutput = compactText(
    action.needed_output || action.output || "请给出可执行方案、关键风险、反例、下一步验证动作和是否需要 Hayden 确认。",
    900
  );
  return [
    `任务模块求助：${topic}`,
    "",
    `任务 ID：${taskRun.id}`,
    `任务目标：${taskRun.objective}`,
    `求助方：${agent.name}`,
    "",
    "卡点/问题：",
    problem,
    "",
    "已尝试/已有证据：",
    attempted,
    "",
    "需要讨论模块输出：",
    neededOutput,
    "",
    "要求：讨论 Leader 需要把建议收敛成可回流给任务项目经理继续执行的 Decision Record。"
  ].join("\n");
}

async function requestDiscussionHelpForTask({ agent, action, channelId, taskRunId }) {
  if (!taskRunId) {
    audit({
      workspaceId: agent.workspace_id,
      channelId,
      actorType: "agent",
      actorId: agent.id,
      action: "request_discussion_help",
      result: "blocked",
      detail: "没有任务运行 ID，不能请求讨论模块支援。"
    });
    return;
  }
  if (agent.agent_kind !== "task" || Number(agent.is_primary) !== 1 || agent.parent_agent_id) {
    audit({
      workspaceId: agent.workspace_id,
      channelId,
      actorType: "agent",
      actorId: agent.id,
      action: "request_discussion_help",
      result: "blocked",
      detail: "只有任务项目经理 Agent 可以请求讨论模块支援。"
    });
    return;
  }
  const taskRun = getTaskRun(taskRunId);
  if (!taskRun || taskRun.status === "stopped" || taskRun.status === "cleaned") return;
  const existing = pendingTaskDiscussionLink(taskRunId);
  if (existing) {
    audit({
      workspaceId: agent.workspace_id,
      channelId,
      actorType: "agent",
      actorId: agent.id,
      action: "request_discussion_help",
      result: "blocked",
      detail: `任务已有未完成的讨论求助：${existing.discussion_id}`
    });
    return;
  }

  const topic = discussionHelpTopic({ taskRun, agent, action });
  const executionSnapshot = captureExecutionSnapshot({ taskRun, agent, action, requestText: topic });
  const blockFingerprint = blockFingerprintFromSnapshot(executionSnapshot);
  const discussCount = discussionHelpCount(taskRunId) + 1;
  const expiresAt = taskDiscussionExpiresAt();
  if (discussCount > MAX_TASK_DISCUSSION_HELP_COUNT) {
    blockDiscussionHelpRequest({
      agent,
      channelId,
      taskRun,
      reason: `任务 ${taskRun.id} 的讨论求助次数已达到上限 ${MAX_TASK_DISCUSSION_HELP_COUNT}，已阻止继续跨模块求助，转为人工确认或降级执行。`,
      metadata: { blockFingerprint, discussCount, maxCount: MAX_TASK_DISCUSSION_HELP_COUNT }
    });
    return;
  }
  const duplicate = previousDiscussionHelpWithFingerprint(taskRunId, blockFingerprint);
  if (duplicate) {
    blockDiscussionHelpRequest({
      agent,
      channelId,
      taskRun,
      reason: `任务 ${taskRun.id} 命中相同阻断指纹，已阻止重复讨论求助：${blockFingerprint}`,
      metadata: { blockFingerprint, previousDiscussionId: duplicate.discussion_id, previousStatus: duplicate.status }
    });
    return;
  }
  addEvidenceItem({
    workspaceId: agent.workspace_id,
    channelId,
    taskRunId,
    agentId: agent.id,
    kind: "discussion_help_request",
    title: "请求讨论模块支援",
    content: topic,
    metadata: {
      action,
      requesterAgentId: agent.id,
      executionSnapshot,
      blockFingerprint,
      discussCount,
      expiresAt
    }
  });
  insertMessage({
    workspaceId: agent.workspace_id,
    channelId,
    senderType: "system",
    senderName: "系统",
    mode: "system",
    targetAgentId: agent.id,
    content: `${agent.name} 判断任务遇到卡点，已请求讨论 Leader Agent 组织讨论模块提供思路。`,
    status: "visible"
  });
  audit({
    workspaceId: agent.workspace_id,
    channelId,
    actorType: "agent",
    actorId: agent.id,
    action: "request_discussion_help",
    result: "allowed",
    detail: compactText(topic, 1000)
  });
  await startDiscussionInternal({
    workspaceId: agent.workspace_id,
    channelId,
    topic,
    discussionFramework: action.discussion_framework || action.framework || "balanced_decision",
    roundLimit: 1,
    source: "task_help",
    sourceTaskRunId: taskRunId,
    requestedByAgentId: agent.id,
    requestText: topic,
    executionSnapshot,
    blockFingerprint,
    discussCount,
    expiresAt
  });
}

async function continueTaskAfterDiscussionHelp({ discussionId, decisionRecordId, organizerAgentId }) {
  const link = get("SELECT * FROM task_discussion_links WHERE discussion_id = ? ORDER BY created_at DESC LIMIT 1", [
    discussionId
  ]);
  if (!link || !["active", "needs_human"].includes(link.status)) return;
  const taskRun = getTaskRun(link.task_run_id);
  const decisionRecord = get("SELECT * FROM decision_records WHERE id = ?", [decisionRecordId]);
  if (!taskRun || !decisionRecord) return;
  const resolvedAt = nowIso();
  const needsHuman = Number(decisionRecord.needs_human || 0) === 1 || decisionRecord.status === "ask_human";
  const nextStatus = needsHuman ? "needs_human" : "resolved";
  run("UPDATE task_discussion_links SET status = ?, resolved_at = ? WHERE id = ?", [nextStatus, resolvedAt, link.id]);
  addEvidenceItem({
    workspaceId: taskRun.workspace_id,
    channelId: taskRun.channel_id,
    taskRunId: taskRun.id,
    agentId: organizerAgentId,
    kind: "discussion_help_result",
    title: "讨论模块回流建议",
    content: decisionRecord.summary || decisionRecord.decision,
    metadata: {
      discussionId,
      decisionRecordId,
      status: decisionRecord.status,
      needsHuman
    }
  });
  upsertBlackboardEntry({
    workspaceId: taskRun.workspace_id,
    channelId: taskRun.channel_id,
    key: `task:${taskRun.id}:discussion_help`,
    scope: "task",
    value: {
      taskRunId: taskRun.id,
      discussionId,
      decisionRecordId,
      status: decisionRecord.status,
      summary: compactText(decisionRecord.summary || decisionRecord.decision, 1200),
      needsHuman
    },
    updatedByType: "agent",
    updatedById: organizerAgentId
  });
  appendStructuredBlackboard({
    workspaceId: taskRun.workspace_id,
    channelId: taskRun.channel_id,
    field: needsHuman ? "open_questions" : "decisions",
    text: `Discussion help returned to task ${taskRun.id}: ${decisionRecord.decision || decisionRecord.summary}`,
    source: "agent",
    metadata: { taskRunId: taskRun.id, discussionId, decisionRecordId }
  });

  if (needsHuman || ["stopped", "cleaned", "awaiting_confirmation", "failed"].includes(taskRun.status)) {
    saveDb();
    return;
  }

  const executionSnapshot = parseJsonObject(link.execution_snapshot, {});
  const drift = validateExecutionDrift(executionSnapshot);
  if (drift.drifted) {
    const driftText = `讨论回流前检测到现场漂移：${drift.changes.join(", ")}。任务必须先重新对齐现场，再决定是否应用 Decision Record。`;
    addEvidenceItem({
      workspaceId: taskRun.workspace_id,
      channelId: taskRun.channel_id,
      taskRunId: taskRun.id,
      agentId: organizerAgentId,
      kind: "discussion_help_drift",
      title: "讨论回流现场漂移",
      content: driftText,
      metadata: { discussionId, decisionRecordId, drift }
    });
    appendStructuredBlackboard({
      workspaceId: taskRun.workspace_id,
      channelId: taskRun.channel_id,
      field: "risks",
      text: driftText,
      source: "system",
      metadata: { taskRunId: taskRun.id, discussionId, decisionRecordId, drift }
    });
  }

  const taskLock = acquireRuntimeLock({
    workspaceId: taskRun.workspace_id,
    channelId: taskRun.channel_id,
    resource: taskLockResource(taskRun.channel_id),
    ownerType: "task_run",
    ownerId: taskRun.id,
    sessionId: taskLockSession(taskRun.id),
    reason: `Resume task after discussion help: ${compactText(taskRun.objective, 120)}`
  });
  if (!taskLock) {
    run("UPDATE task_runs SET status = 'waiting_discussion' WHERE id = ?", [taskRun.id]);
    appendStructuredBlackboard({
      workspaceId: taskRun.workspace_id,
      channelId: taskRun.channel_id,
      field: "risks",
      text: `Discussion help is ready but task ${taskRun.id} could not resume because task runtime lock is busy.`,
      source: "system",
      metadata: { taskRunId: taskRun.id, discussionId, decisionRecordId }
    });
    saveDb();
    return;
  }

  run("UPDATE task_runs SET status = 'running' WHERE id = ?", [taskRun.id]);
  const resumeContent = [
    "TASK_DISCUSSION_HELP_RESULT",
    "讨论模块已给出任务求助建议。请把以下内容作为 Evidence Pack 的补充，继续完成原任务，不要原样转述讨论结论。",
    drift.drifted
      ? `TASK_DISCUSSION_HELP_DRIFT_DETECTED：${drift.changes.join(", ")}。先重新对齐现场，再判断建议是否仍有效。`
      : "TASK_DISCUSSION_HELP_CONTEXT_OK：唤醒前未发现 Git/关键文件漂移。",
    "",
    `原任务：${taskRun.objective}`,
    "",
    "挂起前 Execution Snapshot：",
    compactText(JSON.stringify(executionSnapshot, null, 2), 1800),
    "",
    decisionRecord.summary || decisionRecord.decision
  ].join("\n");
  const command = insertMessage({
    workspaceId: taskRun.workspace_id,
    channelId: taskRun.channel_id,
    senderType: "system",
    senderName: "系统",
    mode: "task",
    targetAgentId: taskRun.primary_agent_id,
    content: resumeContent,
    status: "visible"
  });
  addEvidenceItem({
    workspaceId: taskRun.workspace_id,
    channelId: taskRun.channel_id,
    taskRunId: taskRun.id,
    agentId: taskRun.primary_agent_id,
    kind: "discussion_help_resume",
    title: "讨论建议回传任务项目经理",
    content: resumeContent,
    metadata: { discussionId, decisionRecordId, executionSnapshot, drift }
  });
  upsertBlackboardEntry({
    workspaceId: taskRun.workspace_id,
    channelId: taskRun.channel_id,
    key: "current_task",
    scope: "task",
    value: {
      taskRunId: taskRun.id,
      objective: taskRun.objective,
      status: "running",
      resumedFromDiscussionId: discussionId,
      drift
    },
    updatedByType: "system"
  });
  saveDb();
  await runTaskInBackground({
    taskRunId: taskRun.id,
    primaryAgentId: taskRun.primary_agent_id,
    message: command,
    channelId: taskRun.channel_id
  });
}

function reapWaitingDiscussionLinks(workspaceId = null, channelId = null) {
  const now = nowIso();
  const params = workspaceId ? [now, workspaceId] : [now];
  const workspaceFilter = workspaceId ? "AND workspace_id = ?" : "";
  const expiredLinks = all(
    `SELECT *
     FROM task_discussion_links
     WHERE status IN ('active', 'needs_human')
       AND expires_at IS NOT NULL
       AND expires_at <= ?
       ${workspaceFilter}
     ORDER BY expires_at ASC`,
    params
  );
  for (const link of expiredLinks) {
    const taskRun = getTaskRun(link.task_run_id);
    if (!taskRun || taskRun.status !== "waiting_discussion") {
      run("UPDATE task_discussion_links SET status = 'timeout', resolved_at = ? WHERE id = ?", [now, link.id]);
      continue;
    }
    const snapshot = parseJsonObject(link.execution_snapshot, {});
    const timeoutText = [
      "讨论模块求助等待超时。",
      `任务：${taskRun.objective}`,
      `讨论 ID：${link.discussion_id}`,
      `等待开始：${link.wait_started_at || link.created_at}`,
      `超时时间：${link.expires_at}`,
      "兜底：请 Hayden 确认是否按已有 Evidence Pack 降级执行、重新发起讨论，或清理任务。"
    ].join("\n");
    run("UPDATE task_discussion_links SET status = 'timeout', resolved_at = ? WHERE id = ?", [now, link.id]);
    run(
      "UPDATE discussion_runs SET status = 'closed', closed_at = ?, organizer_status = 'timeout' WHERE id = ? AND status != 'closed'",
      [now, link.discussion_id]
    );
    releaseRuntimeLocks({
      sessionIds: [discussionLockSession(link.discussion_id)],
      ownerType: "discussion_run",
      ownerId: link.discussion_id,
      status: "failed"
    });
    addEvidenceItem({
      workspaceId: taskRun.workspace_id,
      channelId: taskRun.channel_id,
      taskRunId: taskRun.id,
      agentId: taskRun.primary_agent_id,
      kind: "discussion_help_timeout",
      title: "讨论求助等待超时",
      content: timeoutText,
      metadata: { linkId: link.id, discussionId: link.discussion_id, executionSnapshot: snapshot }
    });
    appendStructuredBlackboard({
      workspaceId: taskRun.workspace_id,
      channelId: taskRun.channel_id,
      field: "risks",
      text: timeoutText,
      source: "system",
      metadata: { taskRunId: taskRun.id, linkId: link.id, discussionId: link.discussion_id }
    });
    insertMessage({
      workspaceId: taskRun.workspace_id,
      channelId: taskRun.channel_id,
      senderType: "system",
      senderName: "系统",
      mode: "task",
      targetAgentId: taskRun.primary_agent_id,
      content: `TASK_DISCUSSION_HELP_TIMEOUT\n${timeoutText}`,
      status: "visible"
    });
    setTaskRunStatus(taskRun.id, "awaiting_confirmation", `讨论求助超时，任务已转为人工确认。\n\n${timeoutText}`);
    upsertBlackboardEntry({
      workspaceId: taskRun.workspace_id,
      channelId: taskRun.channel_id,
      key: "current_task",
      scope: "task",
      value: {
        taskRunId: taskRun.id,
        objective: taskRun.objective,
        status: "awaiting_confirmation",
        discussionHelpStatus: "timeout",
        discussionId: link.discussion_id
      },
      updatedByType: "system"
    });
    audit({
      workspaceId: taskRun.workspace_id,
      channelId: taskRun.channel_id,
      actorType: "system",
      action: "task_discussion_wait_timeout",
      result: "allowed",
      detail: compactText(timeoutText, 1000)
    });
  }
  if (expiredLinks.length > 0) saveDb();
  return expiredLinks.length;
}

function temporaryAgentRoots(taskRunId) {
  const temps = all("SELECT * FROM agents WHERE task_run_id = ? AND is_temporary = 1", [taskRunId]);
  const tempIds = new Set(temps.map((agent) => agent.id));
  return temps.filter((agent) => !agent.parent_agent_id || !tempIds.has(agent.parent_agent_id));
}

function validatePrimaryAgent(workspaceId, primaryAgentId) {
  const agent = get("SELECT * FROM agents WHERE id = ? AND workspace_id = ?", [primaryAgentId, workspaceId]);
  if (!agent) throw new Error("主 Agent 不存在。");
  if (agent.parent_agent_id) throw new Error("任务执行只能交给主 Agent，不能直接交给下级 Agent。");
  if (Number(agent.is_primary) !== 1) throw new Error("任务执行只能交给空间项目经理 Agent。");
  if (agent.is_temporary) throw new Error("临时 Agent 不能作为长期主 Agent。");
  if (agent.agent_kind !== "task") throw new Error("讨论 Agent 不能接收任务执行。");
  return agent;
}

async function runTaskInBackground({ taskRunId, primaryAgentId, message, channelId }) {
  const taskRun = getTaskRun(taskRunId);
  if (!taskRun || taskRun.status !== "running") return;
  try {
    const responseMessage = await invokeAgent({
      agentId: primaryAgentId,
      triggerMessage: message,
      triggerSenderName: HUMAN_NAME,
      channelId,
      depth: 0,
      taskRunId
    });
	    const latestTaskRun = getTaskRun(taskRunId);
	    if (!responseMessage || latestTaskRun?.status === "stopped") {
	      return;
	    }
	    const pendingDiscussionHelp = pendingTaskDiscussionLink(taskRunId);
	    if (pendingDiscussionHelp && latestTaskRun?.status === "waiting_discussion") {
	      insertMessage({
	        workspaceId: taskRun.workspace_id,
	        channelId,
	        senderType: "system",
	        senderName: "系统",
	        mode: "system",
	        content: "任务已暂挂，等待讨论模块回传思路后继续执行。",
	        status: "visible"
	      });
	      saveDb();
	      return;
		    }
		    let primary = get("SELECT * FROM agents WHERE id = ?", [primaryAgentId]);
	    let finalResponseMessage = responseMessage;
	    let failed = primary?.status === "failed" || String(responseMessage?.content || "").startsWith("执行失败：");
	    if (!failed && taskHasTeamExecutionEvidence(taskRunId)) {
	      finalResponseMessage = await runPrimaryEvidenceSynthesis({
	        taskRun,
	        primaryAgentId,
	        channelId,
	        previousResponse: responseMessage
	      });
	      const afterSynthesisTaskRun = getTaskRun(taskRunId);
	      const afterSynthesisDiscussionHelp = pendingTaskDiscussionLink(taskRunId);
	      if (afterSynthesisDiscussionHelp && afterSynthesisTaskRun?.status === "waiting_discussion") {
	        insertMessage({
	          workspaceId: taskRun.workspace_id,
	          channelId,
	          senderType: "system",
	          senderName: "系统",
	          mode: "system",
	          content: "任务收敛阶段发现仍需讨论支援，已暂挂等待讨论模块回传。",
	          status: "visible"
	        });
	        saveDb();
	        return;
	      }
	      primary = get("SELECT * FROM agents WHERE id = ?", [primaryAgentId]);
	      failed = primary?.status === "failed" || String(finalResponseMessage?.content || "").startsWith("执行失败：");
	    }
	    const qualityGate = runTaskQualityGate({ taskRun, channelId, primaryAgentId, responseMessage: finalResponseMessage, failed });
	    setTaskRunStatus(taskRunId, failed ? "failed" : "awaiting_confirmation", finalResponseMessage?.content || "");
	    addEvidenceItem({
	      workspaceId: taskRun.workspace_id,
	      channelId,
	      taskRunId,
	      agentId: primaryAgentId,
	      kind: failed ? "task_failed" : "task_result",
	      title: failed ? "任务失败" : "任务产出结果",
	      content: finalResponseMessage?.content || "",
	      metadata: { status: failed ? "failed" : "awaiting_confirmation", qualityGate }
	    });
    upsertBlackboardEntry({
      workspaceId: taskRun.workspace_id,
      channelId,
      key: "latest_task_result",
      scope: "task",
      value: {
	        taskRunId,
	        objective: taskRun.objective,
	        status: failed ? "failed" : "awaiting_confirmation",
	        output: compactText(finalResponseMessage?.content || "", 900)
		    },
	    updatedByType: "agent",
	    updatedById: primaryAgentId
	  });
	  appendStructuredBlackboard({
	    workspaceId: taskRun.workspace_id,
		    channelId,
		    field: failed ? "risks" : "outputs",
		    text: failed ? `Task failed: ${finalResponseMessage?.content || ""}` : `Task output: ${finalResponseMessage?.content || ""}`,
	    source: failed ? "system" : "agent",
	    metadata: { taskRunId, agentId: primaryAgentId, evidence: failed ? "task_failed" : "task_result" }
	  });
	  insertMessage({
	    workspaceId: taskRun.workspace_id,
      channelId,
	      senderType: "system",
	      senderName: "系统",
	      mode: "system",
	      content: failed
	        ? "任务执行失败，请查看 Agent 状态。"
	        : qualityGate?.status === "needs_review"
	          ? `任务已产出结果，但质量闸门提示需要复核：${qualityGate.warnings.join(" ")}`
	          : "任务已产出结果，等待确认完成并清理临时 Agent。",
	      status: "visible"
	    });
  } catch (error) {
    const readable = summarizeError(error.message || error);
    markAgentFailed(primaryAgentId, readable);
    setTaskRunStatus(taskRunId, "failed", readable);
    addEvidenceItem({
      workspaceId: taskRun.workspace_id,
      channelId,
      taskRunId,
      agentId: primaryAgentId,
      kind: "task_failed",
      title: "任务执行异常",
      content: readable,
      metadata: { status: "failed" }
    });
    upsertBlackboardEntry({
      workspaceId: taskRun.workspace_id,
      channelId,
      key: "latest_task_result",
      scope: "task",
      value: {
        taskRunId,
        objective: taskRun.objective,
        status: "failed",
        output: readable
	    },
	    updatedByType: "system"
	  });
	  appendStructuredBlackboard({
	    workspaceId: taskRun.workspace_id,
	    channelId,
	    field: "risks",
	    text: `Task execution exception: ${readable}`,
	    source: "system",
	    metadata: { taskRunId, agentId: primaryAgentId, evidence: "task_failed" }
	  });
    audit({
      workspaceId: taskRun.workspace_id,
      channelId,
      actorType: "system",
      action: "task_run",
      result: "failed",
      detail: readable
    });
    insertMessage({
      workspaceId: taskRun.workspace_id,
      channelId,
      senderType: "system",
      senderName: "系统",
      mode: "system",
      content: `任务执行失败：${readable}`,
      status: "visible"
    });
  }
  saveDb();
}

function buildDiscussionPrompt({ agent, discussion, channelId, participant }) {
  const context = getRecentContext(discussion.workspace_id, channelId, "all");
	  const sharedState = blackboardPrompt(discussion.workspace_id);
	  const evidenceState = evidencePrompt(null, discussion.workspace_id, channelId);
  const contentMemory = contentAssetsPrompt(discussion.workspace_id, channelId, "all");
  const remaining = Math.max(0, Number(participant.round_limit || 0) - Number(participant.rounds_used || 0));
  const mentionTargets = getMentionTargets(discussion.workspace_id, channelId);
  const organizer = discussion.organizer_agent_id
    ? get("SELECT name FROM agents WHERE id = ?", [discussion.organizer_agent_id])
    : null;
  const framework = discussionFramework(discussion.discussion_framework);
  return [
    `你是本地 Hermes Agent Team 多方讨论里的 Agent：${agent.name}。`,
    `你的角色：${agent.role}`,
    `你的说明：${agent.description}`,
    agent.core_command ? `你的核心底层命令：${agent.core_command}` : "",
    agentModelLabel(agent) ? `你的模型偏好/支持模型：${agentModelLabel(agent)}` : "",
    "",
    "当前是多方讨论模式，不是任务执行模式。",
    `本次讨论 Leader Agent：${organizer?.name || "讨论 Leader Agent"}`,
    "",
    frameworkPromptBlock(framework, "participant"),
    "",
    discussionParticipantProtocolBlock(),
    "",
    discussionRoundPhaseBlock(participant),
    "",
    "硬性规则：",
    "1. 你只发表自己的观点、判断、风险或建议。",
    "2. 不创建 Agent，不删除 Agent，不委派任务，不输出 hermes-agent-team-actions 动作块。",
    "3. 每次回复要简洁，围绕讨论主题，不展开无关话题。",
    "4. 是否继续下一轮由讨论 Leader Agent 决定，你不要向人申请继续轮次。",
    "5. 你可以看到当前空间里人、任务 Agent、讨论 Agent 和系统的发言；后续轮次必须参考前面 Agent 的观点。",
    "6. 输出内容可以使用 @Hayden 或 @Agent名称 指向对应的人或 Agent。",
    `可@对象：${mentionTargets || "@Hayden"}`,
    "",
    `讨论主题：${discussion.topic}`,
    `你本轮发言后剩余额度：${Math.max(0, remaining - 1)}`,
    "",
    "当前空间最近 40 条消息：",
    context || "暂无历史消息。",
    "",
	    "共享状态 Blackboard：",
	    blackboardSchemaPrompt(),
	    "",
	    sharedState,
	    "",
    "任务 Evidence Pack：",
    evidenceState,
    "",
    "Content Assets Memory：",
    contentMemory,
    "",
    "请给出本轮讨论发言。"
  ].join("\n");
}

function buildDiscussionOrganizerPrompt({ agent, discussion, channelId }) {
  const context = getRecentContext(discussion.workspace_id, channelId, "all");
	  const sharedState = blackboardPrompt(discussion.workspace_id);
	  const evidenceState = evidencePrompt(null, discussion.workspace_id, channelId);
  const contentMemory = contentAssetsPrompt(discussion.workspace_id, channelId, "all");
  const participants = discussionParticipants(discussion.id);
  const framework = discussionFramework(discussion.discussion_framework);
  const maxRoundsUsed = Math.max(0, ...participants.map((item) => Number(item.rounds_used || 0)));
  const convergenceGuard = discussionConvergenceGuardBlock(maxRoundsUsed);
  const participantText = participants
    .map((item) => `- ${item.agent_name} / ${item.agent_role} / ${item.rounds_used}/${item.round_limit}`)
    .join("\n");
  return [
    `你是本地 Hermes Agent Team 的讨论 Leader Agent：${agent.name}。`,
    `你的角色：${agent.role}`,
    `你的说明：${agent.description}`,
    agent.core_command ? `你的核心底层命令：${agent.core_command}` : "",
    agentModelLabel(agent) ? `你的模型偏好/支持模型：${agentModelLabel(agent)}` : "",
    "",
    "你的职责：组织多方讨论、控制轮次、压缩噪音，并只在阶段性需要人确认或已有结论时汇报给 Hayden。",
    "",
    frameworkPromptBlock(framework, "organizer"),
    "",
	    discussionLeaderProtocolBlock(),
    convergenceGuard ? "" : "",
    convergenceGuard,
	    "",
    "硬性规则：",
    "1. 不要让参与 Agent 无限对话。",
    `2. 如果已完成少于 ${MIN_DISCUSSION_ROUNDS_BEFORE_FINAL} 轮，禁止直接最终收敛；必须继续到交叉审辩轮。`,
    "3. 如果达到最低审辩轮次且现有信息足够，直接给 Hayden 汇总结论。",
    "4. 如果还缺少关键判断，你可以决定继续一轮。",
    "5. 如果必须让 Hayden 选择方向或补充信息，再向 Hayden 提出一个明确问题。",
    "6. 输出内容可以使用 @Hayden 或 @Agent名称。",
    "",
    `讨论主题：${discussion.topic}`,
    `当前已完成参与者轮次：${maxRoundsUsed}/${discussion.round_limit}；最低审辩轮次：${MIN_DISCUSSION_ROUNDS_BEFORE_FINAL}；硬上限：${MAX_DISCUSSION_ROUNDS}。`,
    "参与 Agent：",
    participantText || "- 暂无",
    "",
    "当前空间最近消息：",
    context || "暂无历史消息。",
    "",
	    "共享状态 Blackboard：",
	    blackboardSchemaPrompt(),
	    "",
	    sharedState,
	    "",
    "任务 Evidence Pack：",
    evidenceState,
    "",
    "Content Assets Memory：",
    contentMemory,
    "",
    "请先给 Hayden 可读的组织结论或阶段问题，优先沉淀为 Decision Record：问题定义、事实证据、观点矩阵、分歧、共识、风险、推荐结论、下一步行动、置信度。",
    "然后追加 fenced block，格式必须完全如下。",
    "decision 只允许：final、continue、ask_human。",
    "```hermes-discussion-organizer",
    "{\"decision\":\"final\",\"reason\":\"已有足够结论\",\"next_prompt\":\"\"}",
    "```"
  ].join("\n");
}

function parseOrganizerDecision(text) {
  const matches = [...String(text || "").matchAll(/```hermes-discussion-organizer\s*([\s\S]*?)```/gi)];
  if (matches.length === 0) return { decision: "final", reason: "", next_prompt: "" };
  try {
    const parsed = JSON.parse(matches[matches.length - 1][1].trim());
    const decision = ["continue", "ask_human", "final"].includes(parsed.decision) ? parsed.decision : "final";
    return {
      decision,
      reason: String(parsed.reason || ""),
      next_prompt: String(parsed.next_prompt || "")
    };
  } catch (error) {
    return { decision: "final", reason: "组织决策 JSON 解析失败，按最终汇总处理。", next_prompt: "" };
  }
}

function discussionParticipants(discussionId) {
  return all(
    `SELECT da.*, a.name AS agent_name, a.role AS agent_role
     FROM discussion_agents da
     JOIN agents a ON a.id = da.agent_id
     WHERE da.discussion_id = ?
     ORDER BY a.created_at ASC`,
    [discussionId]
  );
}

function ensureDiscussionRuntimeLock(discussion, channelId) {
  const lock = acquireRuntimeLock({
    workspaceId: discussion.workspace_id,
    channelId,
    resource: discussionLockResource(channelId),
    ownerType: "discussion_run",
    ownerId: discussion.id,
    sessionId: discussionLockSession(discussion.id),
    reason: `Discussion: ${compactText(discussion.topic, 160)}`
  });
  if (!lock) {
    throw new Error("当前空间已有讨论正在运行，已阻止新的讨论轮次以避免状态冲突。");
  }
  return lock;
}

function defaultDiscussionAgentSpecs(framework, topic) {
  const topicHint = compactText(String(topic || ""), 120);
  const fallback = [
    {
      name: "讨论观点 Agent A",
      role: "Risk Perspective",
      description: "从风险、漏洞、失败路径和反对意见角度参与讨论。",
      coreCommand: "优先指出风险、反例、隐藏成本和需要验证的假设。"
    },
    {
      name: "讨论观点 Agent B",
      role: "Execution Perspective",
      description: "从执行路径、资源配置和落地步骤角度参与讨论。",
      coreCommand: "优先给出可执行路径、约束、取舍和下一步行动。"
    }
  ];
  const map = {
    red_team: [
      {
        name: "红队质疑 Agent",
        role: "Red Team Critic",
        description: "对方案做对抗式审查，找出脆弱点、反例和不可接受风险。",
        coreCommand: "优先攻击假设、流程漏洞、权限风险和被忽略的失败路径。"
      },
      {
        name: "修复路径 Agent",
        role: "Mitigation Planner",
        description: "针对红队指出的问题给出可执行修复、验证和阻断方案。",
        coreCommand: "优先把风险转成行动清单、验证标准和停止条件。"
      }
    ],
    premortem_risk: [
      {
        name: "失败预演 Agent",
        role: "Failure Analyst",
        description: "假设目标已经失败，倒推根因、连锁风险和预防动作。",
        coreCommand: "优先列出最可能导致失败的三类原因，并说明早期信号。"
      },
      {
        name: "防线设计 Agent",
        role: "Risk Control Designer",
        description: "把失败预演转化为检查点、熔断点、证据和负责人。",
        coreCommand: "优先输出防线、监控指标、审批触发条件和下一步行动。"
      }
    ],
    six_hats: [
      {
        name: "事实视角 Agent",
        role: "Facts Perspective",
        description: "只关注事实、证据、已知条件和未知缺口。",
        coreCommand: "优先区分事实、假设和待验证信息。"
      },
      {
        name: "风险收益 Agent",
        role: "Risk Benefit Perspective",
        description: "同时评估收益、代价、机会和不可逆风险。",
        coreCommand: "优先给出收益/风险权衡和触发条件。"
      }
    ],
    double_diamond: [
      {
        name: "问题定义 Agent",
        role: "Problem Framer",
        description: "负责发现、界定真实问题和用户目标。",
        coreCommand: "优先澄清问题边界、用户需求、约束和成功标准。"
      },
      {
        name: "方案落地 Agent",
        role: "Solution Designer",
        description: "负责提出方案、验证路径和交付步骤。",
        coreCommand: "优先给出可落地方案、取舍和最小验证步骤。"
      }
    ],
    daci_decision: [
      {
        name: "贡献者 Agent",
        role: "Contributor",
        description: "补充关键信息、风险和备选方案。",
        coreCommand: "优先提供输入、约束、依赖和证据。"
      },
      {
        name: "审批视角 Agent",
        role: "Approver Perspective",
        description: "从最终拍板者角度判断是否足够决策。",
        coreCommand: "优先判断是否可批准、缺什么证据、下一步谁负责。"
      }
    ],
    rapid_decision: [
      {
        name: "推荐方案 Agent",
        role: "Recommend",
        description: "提出推荐路径和选择理由。",
        coreCommand: "优先输出推荐方案、替代方案和决策依据。"
      },
      {
        name: "执行负责 Agent",
        role: "Perform",
        description: "评估执行成本、资源、顺序和落地风险。",
        coreCommand: "优先给出执行路线、资源需求、时间顺序和失败预案。"
      }
    ],
    delphi_consensus: [
      {
        name: "专家判断 Agent",
        role: "Domain Expert",
        description: "给出专业判断、依据和置信度。",
        coreCommand: "优先输出独立判断、证据链和置信度。"
      },
      {
        name: "共识校准 Agent",
        role: "Consensus Calibrator",
        description: "寻找分歧根因、共识边界和需要继续验证的问题。",
        coreCommand: "优先压缩分歧，提炼共识、未决问题和验证路径。"
      }
    ]
  };
  return (map[framework.id] || fallback).slice(0, DEFAULT_DISCUSSION_PARTICIPANTS).map((item) => ({
    ...item,
    description: `${item.description} 讨论主题：${topicHint || "未命名主题"}`
  }));
}

async function prepareDiscussionParticipantsAndTriggerRound({ discussionId, channelId, selectedAgentIds }) {
  const discussion = get("SELECT * FROM discussion_runs WHERE id = ?", [discussionId]);
  if (!discussion || discussion.status === "closed") return;
  const workspace = get("SELECT * FROM workspaces WHERE id = ?", [discussion.workspace_id]);
  const channel = get("SELECT * FROM channels WHERE id = ? AND workspace_id = ?", [
    channelId,
    discussion.workspace_id
  ]);
  if (!workspace || !channel) return;
  const organizer = discussion.organizer_agent_id
    ? get("SELECT * FROM agents WHERE id = ? AND workspace_id = ?", [discussion.organizer_agent_id, workspace.id])
    : null;
  const framework = discussionFramework(discussion.discussion_framework);
  const agentIds = [...new Set((Array.isArray(selectedAgentIds) ? selectedAgentIds : []).map(String))];
  let agents = agentIds.map((agentId) =>
    get(
      `SELECT a.*
       FROM agents a
       JOIN agent_channels ac ON ac.agent_id = a.id AND ac.channel_id = ?
       WHERE a.id = ? AND a.workspace_id = ? AND a.is_temporary = 0 AND a.agent_kind = 'discussion'`,
      [channel.id, agentId, workspace.id]
    )
  );
	  if (agents.some((agent) => !agent)) throw new Error("讨论只能选择当前空间内的讨论 Agent。");
	  agents = agents.filter((agent) => agent.id !== organizer?.id);
	  if (agents.length > MAX_DISCUSSION_PARTICIPANTS) {
	    throw new Error(`讨论参与 Agent 已超过硬上限：最多 ${MAX_DISCUSSION_PARTICIPANTS} 个。`);
	  }

	  if (agents.length === 0) {
    const generatedAgents = [];
    for (const item of defaultDiscussionAgentSpecs(framework, discussion.topic)) {
      generatedAgents.push(
        await createAgentInternal({
          workspaceId: workspace.id,
          channelId: channel.id,
          name: item.name,
          role: item.role,
          description: item.description,
          coreCommand: item.coreCommand,
          parentAgentId: null,
          createdByAgentId: organizer?.id || null,
          isTemporary: true,
          agentKind: "discussion",
          allowTemporaryDiscussion: true,
          verifyProfile: true
        })
      );
    }
    agents = generatedAgents;
  }

  for (const agent of agents) {
    run(
      `INSERT OR IGNORE INTO discussion_agents
        (discussion_id, agent_id, rounds_used, round_limit, status)
       VALUES (?, ?, 0, ?, 'active')`,
      [discussionId, agent.id, discussion.round_limit]
    );
  }
  run("UPDATE discussion_runs SET organizer_status = 'running' WHERE id = ?", [discussionId]);
  audit({
    workspaceId: workspace.id,
    channelId: channel.id,
    actorType: "agent",
    actorId: organizer?.id || null,
    action: "discussion_agents_ready",
    result: "allowed",
    detail: `${organizer?.name || "讨论 Leader Agent"} 根据「${framework.name}」框架组织 ${agents.length} 个讨论 Agent：${agents.map((agent) => agent.name).join("、")}。`
  });
  insertMessage({
    workspaceId: workspace.id,
    channelId: channel.id,
    senderType: "system",
    senderName: "系统",
    mode: "discussion",
    targetAgentId: organizer?.id || null,
    content: `${organizer?.name || "讨论 Leader Agent"} 已组织 ${agents.length} 个讨论 Agent，将并发开始第一轮发言。`,
    status: "visible"
  });
	  upsertBlackboardEntry({
	    workspaceId: workspace.id,
	    channelId: channel.id,
	    key: "active_discussion",
    scope: "discussion",
    value: {
      discussionId,
      topic: discussion.topic,
      framework: framework.name,
      status: "active",
      organizer: organizer?.name || "讨论 Leader Agent",
      participants: agents.map((agent) => agent.name)
    },
    updatedByType: "agent",
    updatedById: organizer?.id || null
  });
  saveDb();
  await triggerDiscussionRound({ discussionId, channelId: channel.id });
}

function updateDiscussionExhausted(discussionId, channelId) {
  const discussion = get("SELECT * FROM discussion_runs WHERE id = ?", [discussionId]);
  if (!discussion || discussion.status !== "active") return;
  const participants = discussionParticipants(discussionId);
  const hasRemaining = participants.some((item) => Number(item.rounds_used) < Number(item.round_limit));
  if (!hasRemaining) {
    run("UPDATE discussion_runs SET status = 'needs_approval' WHERE id = ?", [discussionId]);
    insertMessage({
      workspaceId: discussion.workspace_id,
      channelId,
      senderType: "system",
      senderName: "系统",
      mode: "discussion",
      content: "讨论轮次已用完，等待批准后才能继续。",
      status: "visible"
    });
    saveDb();
  }
}

async function invokeDiscussionAgent({ discussionId, agentId, channelId, preMarked = false, promptOverride = null }) {
  const discussion = get("SELECT * FROM discussion_runs WHERE id = ?", [discussionId]);
  if (!discussion || discussion.status === "closed") return;
  const participant = get("SELECT * FROM discussion_agents WHERE discussion_id = ? AND agent_id = ?", [
    discussionId,
    agentId
  ]);
  const agent = get("SELECT * FROM agents WHERE id = ? AND workspace_id = ?", [agentId, discussion.workspace_id]);
  if (!participant || !agent) return;
  if (Number(participant.rounds_used) >= Number(participant.round_limit)) {
    updateDiscussionExhausted(discussionId, channelId);
    return;
  }

  if (!preMarked) markAgentRunning(agent.id, `讨论：${discussion.topic}`);
  const runtimeKey = makeId("run");
  activeAgentRuns.set(runtimeKey, {
    id: runtimeKey,
    agentId: agent.id,
    workspaceId: discussion.workspace_id,
    channelId,
    mode: "discussion",
    discussionId,
    lockSessionIds: [discussionLockSession(discussionId)],
    child: null,
    canceled: false,
    startedAt: nowIso()
  });
  let output;
  let failed = false;
  let agentRunError = null;
  try {
    const prompt = promptOverride || buildDiscussionPrompt({ agent, discussion, channelId, participant });
    output = await invokeAgentRuntime(agent, prompt, { runtimeKey });
  } catch (error) {
    if (error?.canceled) {
      releaseRuntimeLocks({
        sessionIds: [discussionLockSession(discussion.id)],
        ownerType: "discussion_run",
        ownerId: discussion.id,
        status: "stopped"
      });
      audit({
        workspaceId: discussion.workspace_id,
        channelId,
        actorType: "agent",
        actorId: agent.id,
        action: "discussion_run",
        result: "stopped",
        detail: `${agent.name} 已通过 /stop 停止。`
      });
      saveDb();
      return;
    }
    failed = true;
    agentRunError = error;
    output = `执行失败：${summarizeError(error.message || error)}`;
    markAgentFailed(agent.id, output);
    audit({
      workspaceId: discussion.workspace_id,
      channelId,
      actorType: "agent",
      actorId: agent.id,
      action: "discussion_run",
      result: "failed",
      detail: summarizeError(error.runtimeDetails || error.hermesDetails || error.message || error)
    });
  } finally {
    activeAgentRuns.delete(runtimeKey);
  }

  const visible = actionVisibleText(output) || output;
  const responseMessage = insertMessage({
    workspaceId: discussion.workspace_id,
    channelId,
    senderType: "agent",
    senderId: agent.id,
    senderName: agent.name,
    mode: "discussion",
    content: visible,
    status: "visible"
  });
  await attachGeneratedImagesForMessage(
    responseMessage,
    agentGeneratedArtifactSources({ visible, output, error: agentRunError })
  );
  run(
    `UPDATE discussion_agents
     SET rounds_used = rounds_used + 1,
       last_spoke_at = ?
     WHERE discussion_id = ? AND agent_id = ?`,
    [nowIso(), discussionId, agentId]
  );
  if (!failed) markAgentReady(agent.id);
  saveDb();
}

async function invokeDiscussionOrganizer({ discussionId, channelId }) {
  const discussion = get("SELECT * FROM discussion_runs WHERE id = ?", [discussionId]);
  if (!discussion || discussion.status === "closed" || !discussion.organizer_agent_id) return;
  const agent = get("SELECT * FROM agents WHERE id = ? AND workspace_id = ?", [
    discussion.organizer_agent_id,
    discussion.workspace_id
  ]);
  if (!agent) return;
  const maxRoundsUsed = Math.max(0, ...discussionParticipants(discussionId).map((item) => Number(item.rounds_used || 0)));

  markAgentRunning(agent.id, `组织讨论：${discussion.topic}`);
  const runtimeKey = makeId("run");
  activeAgentRuns.set(runtimeKey, {
    id: runtimeKey,
    agentId: agent.id,
    workspaceId: discussion.workspace_id,
    channelId,
    mode: "discussion",
    discussionId,
    lockSessionIds: [discussionLockSession(discussionId)],
    child: null,
    canceled: false,
    startedAt: nowIso()
  });

  let output;
  let failed = false;
  let agentRunError = null;
  try {
    output = await invokeAgentRuntime(agent, buildDiscussionOrganizerPrompt({ agent, discussion, channelId }), { runtimeKey });
  } catch (error) {
    if (error?.canceled) {
      releaseRuntimeLocks({
        sessionIds: [discussionLockSession(discussion.id)],
        ownerType: "discussion_run",
        ownerId: discussion.id,
        status: "stopped"
      });
      audit({
        workspaceId: discussion.workspace_id,
        channelId,
        actorType: "agent",
        actorId: agent.id,
        action: "discussion_organizer_run",
        result: "stopped",
        detail: `${agent.name} 已通过 /stop 停止。`
      });
      saveDb();
      return;
    }
    failed = true;
    agentRunError = error;
    output = `执行失败：${summarizeError(error.message || error)}`;
    markAgentFailed(agent.id, output);
    audit({
      workspaceId: discussion.workspace_id,
      channelId,
      actorType: "agent",
      actorId: agent.id,
      action: "discussion_organizer_run",
      result: "failed",
      detail: summarizeError(error.runtimeDetails || error.hermesDetails || error.message || error)
    });
  } finally {
    activeAgentRuns.delete(runtimeKey);
  }

  let visible = actionVisibleText(String(output || "").replace(/```hermes-discussion-organizer[\s\S]*?```/i, "")) || output;
  const responseMessage = insertMessage({
    workspaceId: discussion.workspace_id,
    channelId,
    senderType: "agent",
    senderId: agent.id,
    senderName: agent.name,
    mode: "discussion",
    content: visible,
    status: "visible"
  });
  await attachGeneratedImagesForMessage(
    responseMessage,
    agentGeneratedArtifactSources({ visible, output, error: agentRunError })
  );
  if (failed) {
    run("UPDATE discussion_runs SET organizer_status = 'failed' WHERE id = ?", [discussion.id]);
    releaseRuntimeLocks({
      sessionIds: [discussionLockSession(discussion.id)],
      ownerType: "discussion_run",
      ownerId: discussion.id,
      status: "failed"
    });
    saveDb();
    return;
  }
  markAgentReady(agent.id);
  let decision = parseOrganizerDecision(output);
  const framework = discussionFramework(discussion.discussion_framework);
  if (
    decision.decision === "final" &&
    maxRoundsUsed > 0 &&
    maxRoundsUsed < MIN_DISCUSSION_ROUNDS_BEFORE_FINAL &&
    maxRoundsUsed < MAX_DISCUSSION_ROUNDS
  ) {
    const forcedReason = `系统质量线：本讨论只完成 ${maxRoundsUsed}/${MIN_DISCUSSION_ROUNDS_BEFORE_FINAL} 个最低审辩轮次，不能一轮即最终收敛；已自动进入交叉审辩轮。`;
    decision = {
      decision: "continue",
      reason: forcedReason,
      next_prompt: "请基于上一轮观点进行交叉审辩：回应至少一个其他 Agent 的观点，说明坚持/修正/反对点，并补齐未覆盖的风险和证据缺口。"
    };
    visible = [visible, "", forcedReason].join("\n");
    appendStructuredBlackboard({
      workspaceId: discussion.workspace_id,
      channelId,
      field: "decisions",
      text: forcedReason,
      source: "system",
      metadata: { discussionId: discussion.id, minRounds: MIN_DISCUSSION_ROUNDS_BEFORE_FINAL }
    });
    audit({
      workspaceId: discussion.workspace_id,
      channelId,
      actorType: "system",
      action: "discussion_min_round_enforced",
      result: "allowed",
      detail: forcedReason
    });
  }
  if (decision.decision === "continue" && maxRoundsUsed >= MAX_DISCUSSION_ROUNDS) {
    const forcedReason = compactText(
      `已达到自动讨论轮次硬上限 ${MAX_DISCUSSION_ROUNDS}，系统强制收敛为降级 Decision Record。${decision.reason || visible}`,
      900
    );
    const safeLog = buildSafeHandoffLog({
      discussion,
      framework,
      reason: forcedReason,
      visibleText: visible
    });
    visible = [
      visible,
      "",
      `系统强制收敛：已达到自动讨论轮次硬上限 ${MAX_DISCUSSION_ROUNDS}，本次记录按降级 Decision Record 关闭。`,
      "",
      safeLog
    ].join("\n");
    decision = { decision: "final", reason: `${safeLog}\n\n${forcedReason}`, next_prompt: "" };
    appendStructuredBlackboard({
      workspaceId: discussion.workspace_id,
      channelId,
      field: "risks",
      text: forcedReason,
      source: "system",
      metadata: { discussionId: discussion.id, maxRounds: MAX_DISCUSSION_ROUNDS }
    });
    audit({
      workspaceId: discussion.workspace_id,
      channelId,
      actorType: "system",
      action: "discussion_force_converge",
      result: "allowed",
      detail: forcedReason
    });
    insertMessage({
      workspaceId: discussion.workspace_id,
      channelId,
      senderType: "system",
      senderName: "系统",
      mode: "discussion",
      content: `已达到自动讨论轮次硬上限 ${MAX_DISCUSSION_ROUNDS}，系统要求 Leader 输出降级 Decision Record 并关闭讨论。`,
      status: "visible"
    });
  }
	  const decisionRecord = createDecisionRecord({
	    discussion,
	    framework,
	    agentId: agent.id,
	    decision,
	    visibleText: visible
	  });
  if (decision.decision === "continue" && maxRoundsUsed < MAX_DISCUSSION_ROUNDS) {
    const hasPreapprovedRound = discussionParticipants(discussion.id).some(
      (item) => Number(item.rounds_used || 0) < Number(item.round_limit || 0)
    );
    if (hasPreapprovedRound) {
      run("UPDATE discussion_agents SET status = 'active' WHERE discussion_id = ?", [discussion.id]);
      run("UPDATE discussion_runs SET status = 'active', organizer_status = 'continue' WHERE id = ?", [discussion.id]);
    } else {
	      run(
	        `UPDATE discussion_agents
	         SET round_limit = MIN(round_limit + 1, ?),
	           status = 'active'
	         WHERE discussion_id = ?`,
	        [MAX_DISCUSSION_ROUNDS, discussion.id]
	      );
	      run(
	        "UPDATE discussion_runs SET status = 'active', round_limit = MIN(round_limit + 1, ?), organizer_status = 'continue' WHERE id = ?",
	        [MAX_DISCUSSION_ROUNDS, discussion.id]
	      );
    }
    insertMessage({
      workspaceId: discussion.workspace_id,
      channelId,
      senderType: "system",
      senderName: "系统",
      mode: "discussion",
      content: decision.next_prompt
        ? `讨论 Leader Agent 决定继续下一轮：${decision.next_prompt}`
        : "讨论 Leader Agent 决定继续下一轮。",
      status: "visible"
    });
    saveDb();
    await triggerDiscussionRound({ discussionId: discussion.id, channelId });
    return;
  }
  if (decision.decision === "ask_human") {
    run("UPDATE discussion_runs SET status = 'needs_approval', organizer_status = 'ask_human' WHERE id = ?", [
      discussion.id
    ]);
    insertMessage({
      workspaceId: discussion.workspace_id,
      channelId,
      senderType: "system",
      senderName: "系统",
      mode: "discussion",
      content: "讨论 Leader Agent 请求你的阶段性回复。",
      status: "visible"
    });
	    releaseRuntimeLocks({
	      sessionIds: [discussionLockSession(discussion.id)],
	      ownerType: "discussion_run",
	      ownerId: discussion.id,
	      status: "needs_approval"
	    });
	    saveDb();
	    await continueTaskAfterDiscussionHelp({
	      discussionId: discussion.id,
	      decisionRecordId: decisionRecord.id,
	      organizerAgentId: agent.id
	    });
	    return;
	  }
  run("UPDATE discussion_runs SET status = 'closed', closed_at = ?, organizer_status = 'final' WHERE id = ?", [
    nowIso(),
    discussion.id
  ]);
  upsertBlackboardEntry({
    workspaceId: discussion.workspace_id,
    channelId,
    key: "active_discussion",
    scope: "discussion",
    value: {
      discussionId: discussion.id,
      topic: discussion.topic,
      framework: framework.name,
      status: "closed",
      organizer: agent.name
    },
    updatedByType: "agent",
    updatedById: agent.id
  });
	  releaseRuntimeLocks({
	    sessionIds: [discussionLockSession(discussion.id)],
	    ownerType: "discussion_run",
	    ownerId: discussion.id
	  });
	  saveDb();
	  await cleanupTemporaryDiscussionAgents({ discussionId: discussion.id, channelId, actorId: agent.id });
	  await continueTaskAfterDiscussionHelp({
	    discussionId: discussion.id,
	    decisionRecordId: decisionRecord.id,
	    organizerAgentId: agent.id
	  });
	}

async function triggerDiscussionRound({ discussionId, channelId }) {
  const discussion = get("SELECT * FROM discussion_runs WHERE id = ?", [discussionId]);
  if (!discussion || discussion.status !== "active") return;
  ensureDiscussionRuntimeLock(discussion, channelId);
  const participants = discussionParticipants(discussionId).filter(
    (item) => Number(item.rounds_used) < Number(item.round_limit)
  );
  const runnableParticipants = participants
    .map((participant) => ({
      participant,
      agent: get("SELECT * FROM agents WHERE id = ? AND workspace_id = ?", [
        participant.agent_id,
        discussion.workspace_id
      ])
    }))
    .filter((item) => item.agent);
  if (runnableParticipants.length === 0) {
    await invokeDiscussionOrganizer({ discussionId, channelId });
    return;
  }
  const nextRound = Math.max(...runnableParticipants.map(({ participant }) => Number(participant.rounds_used || 0))) + 1;
  insertMessage({
    workspaceId: discussion.workspace_id,
    channelId,
    senderType: "system",
    senderName: "系统",
    mode: "discussion",
    content: `开始第 ${nextRound} 轮讨论发言，所有参与 Agent 已同时进入思考。`,
    status: "visible"
  });
  for (const { agent } of runnableParticipants) {
    markAgentRunning(agent.id, `讨论：${discussion.topic}`);
  }
  const promptByAgentId = new Map(
    runnableParticipants.map(({ participant, agent }) => [
      agent.id,
      buildDiscussionPrompt({ agent, discussion, channelId, participant })
    ])
  );
  saveDb();
  const results = await Promise.allSettled(
    runnableParticipants.map(({ participant, agent }) =>
      invokeDiscussionAgent({
        discussionId,
        agentId: participant.agent_id,
        channelId,
        preMarked: true,
        promptOverride: promptByAgentId.get(agent.id)
      })
    )
  );
  for (const result of results) {
    if (result.status === "rejected") {
      audit({
        workspaceId: discussion.workspace_id,
        channelId,
        actorType: "system",
        action: "discussion_parallel_run",
        result: "failed",
        detail: summarizeError(result.reason?.message || result.reason)
      });
    }
  }
  await invokeDiscussionOrganizer({ discussionId, channelId });
  saveDb();
}

function startTaskRunInternal(payload = {}) {
  const workspace = get("SELECT * FROM workspaces WHERE id = ?", [payload.workspaceId]);
  const channel = get("SELECT * FROM channels WHERE id = ? AND workspace_id = ?", [
    payload.channelId,
    payload.workspaceId
  ]);
  if (!workspace || !channel) throw new Error("工作空间不存在。");
  const rawAttachments = normalizeIncomingAttachments(payload.attachments);
  const objective = String(payload.objective || "").trim();
  if (!objective && !rawAttachments.length) throw new Error("任务内容或图片不能为空。");
  const objectiveSummary = objective || `图片任务（${rawAttachments.length} 张）`;
  const primaryAgent = validatePrimaryAgent(workspace.id, payload.primaryAgentId);
	  const membership = get("SELECT * FROM agent_channels WHERE agent_id = ? AND channel_id = ?", [
	    primaryAgent.id,
	    channel.id
	  ]);
	  if (!membership) throw new Error("主 Agent 不在当前空间。");
  reapWaitingDiscussionLinks(workspace.id, channel.id);
	  const openTask = get(
	    `SELECT *
	     FROM task_runs
	     WHERE workspace_id = ? AND channel_id = ? AND status IN ('running', 'waiting_discussion')
	     ORDER BY created_at DESC
	     LIMIT 1`,
	    [workspace.id, channel.id]
	  );
	  if (openTask) {
	    throw new Error("当前空间已有任务正在运行或等待讨论模块回传，已阻止新的任务写入以避免状态冲突。");
	  }

	  const taskRunId = makeId("task");
  const taskLock = acquireRuntimeLock({
    workspaceId: workspace.id,
    channelId: channel.id,
    resource: taskLockResource(channel.id),
    ownerType: "task_run",
    ownerId: taskRunId,
    sessionId: taskLockSession(taskRunId),
    reason: `Task execution: ${compactText(objectiveSummary, 160)}`
  });
  if (!taskLock) {
    throw new Error("当前空间已有任务正在运行，已阻止新的任务写入以避免状态冲突。");
  }
  run(
    `INSERT INTO task_runs
      (id, workspace_id, channel_id, primary_agent_id, status, objective, created_at)
     VALUES (?, ?, ?, ?, 'running', ?, ?)`,
    [taskRunId, workspace.id, channel.id, primaryAgent.id, objectiveSummary, nowIso()]
  );
  audit({
    workspaceId: workspace.id,
    channelId: channel.id,
    actorType: "human",
    action: "task_run_start",
    result: "allowed",
    detail: `人向主 Agent ${primaryAgent.name} 启动任务。`
  });
  const message = insertMessage({
    workspaceId: workspace.id,
    channelId: channel.id,
    senderType: "human",
    senderName: HUMAN_NAME,
    mode: "task",
    targetAgentId: primaryAgent.id,
    content: objective,
    status: "visible",
    attachments: rawAttachments,
    attachmentFallbackText: "请分析并处理附件图片。"
  });
  insertMessage({
    workspaceId: workspace.id,
    channelId: channel.id,
    senderType: "system",
    senderName: "系统",
    mode: "system",
    content: `任务已发送给 ${primaryAgent.name}，它会先判断目标、拆分需求，并按需要创建或委派临时 Agent。`,
    status: "visible"
  });
  addEvidenceItem({
    workspaceId: workspace.id,
    channelId: channel.id,
    taskRunId,
    agentId: primaryAgent.id,
    kind: "task_start",
    title: "任务启动",
    content: message.content,
    metadata: { primaryAgentId: primaryAgent.id, attachmentCount: message.attachments?.length || 0 }
  });
  const executionSandbox = prepareTaskExecutionSandbox({
    workspaceId: workspace.id,
    channelId: channel.id,
    taskRunId,
    objective: message.content,
    primaryAgentId: primaryAgent.id
  });
	  upsertBlackboardEntry({
	    workspaceId: workspace.id,
	    channelId: channel.id,
	    key: "current_task",
    scope: "task",
    value: {
      taskRunId,
      objective: message.content,
      primaryAgent: primaryAgent.name,
      status: "running",
      executionSandbox
	    },
	    updatedByType: "human"
	  });
	  appendStructuredBlackboard({
	    workspaceId: workspace.id,
	    channelId: channel.id,
	    field: "facts",
	    text: `Task started: ${message.content}`,
	    source: "human",
	    metadata: { taskRunId, primaryAgentId: primaryAgent.id, attachmentCount: message.attachments?.length || 0 }
	  });
	  appendStructuredBlackboard({
	    workspaceId: workspace.id,
	    channelId: channel.id,
	    field: "locks",
	    text: `Task run ${taskRunId} owns its temporary Agent workspace until cleanup.`,
	    source: "system",
	    metadata: { taskRunId }
	  });
	  saveDb();
  runTaskInBackground({
    taskRunId,
    primaryAgentId: primaryAgent.id,
    message,
    channelId: channel.id
  }).catch((error) => {
    const readable = summarizeError(error.message || error);
    const latestTaskRun = getTaskRun(taskRunId);
    if (latestTaskRun?.status === "stopped") return;
    setTaskRunStatus(taskRunId, "failed", readable);
    markAgentFailed(primaryAgent.id, readable);
    audit({
      workspaceId: workspace.id,
      channelId: channel.id,
      actorType: "system",
      action: "task_background_run",
      result: "failed",
      detail: readable
    });
    saveDb();
  });
  return getState(workspace.id, channel.id);
}

async function startDiscussionInternal(payload = {}) {
  const workspace = get("SELECT * FROM workspaces WHERE id = ?", [payload.workspaceId]);
  const channel = get("SELECT * FROM channels WHERE id = ? AND workspace_id = ?", [
    payload.channelId,
    payload.workspaceId
  ]);
  if (!workspace || !channel) throw new Error("工作空间不存在。");
  const rawAttachments = normalizeIncomingAttachments(payload.attachments);
  const topic = String(payload.topic || "").trim();
  if (!topic && !rawAttachments.length) throw new Error("讨论主题或图片不能为空。");
  const topicSummary = topic || `图片讨论（${rawAttachments.length} 张）`;
  const selectedFramework = discussionFramework(payload.discussionFramework);
  const roundLimit = clampDiscussionRoundLimit(payload.roundLimit);
  const source = String(payload.source || "").trim();
  const sourceTaskRunId = String(payload.sourceTaskRunId || "").trim();
  const requestedByAgentId = String(payload.requestedByAgentId || "").trim();
  const requesterAgent =
    source === "task_help" && requestedByAgentId
      ? get("SELECT * FROM agents WHERE id = ? AND workspace_id = ?", [requestedByAgentId, workspace.id])
      : null;
  const sourceTaskRun =
    source === "task_help" && sourceTaskRunId
      ? get("SELECT * FROM task_runs WHERE id = ? AND workspace_id = ? AND channel_id = ?", [
          sourceTaskRunId,
          workspace.id,
          channel.id
        ])
      : null;
  if (source === "task_help" && (!requesterAgent || !sourceTaskRun)) {
    throw new Error("任务讨论求助缺少有效的任务或请求 Agent。");
  }
  const rawAgentIds = Array.isArray(payload.agentIds) ? payload.agentIds : [];
  const agentIds = [...new Set(rawAgentIds.map(String))];
  const selectedAgents = agentIds.map((agentId) =>
    get(
      `SELECT a.*
       FROM agents a
       JOIN agent_channels ac ON ac.agent_id = a.id AND ac.channel_id = ?
       WHERE a.id = ? AND a.workspace_id = ? AND a.is_temporary = 0 AND a.agent_kind = 'discussion'`,
      [channel.id, agentId, workspace.id]
    )
  );
  if (selectedAgents.some((agent) => !agent)) throw new Error("讨论只能选择当前空间内的讨论 Agent。");

  const { discussionLead: organizer } = await ensureWorkspaceBaseAgents({
    workspaceId: workspace.id,
    channelId: channel.id,
    actorType: "system"
  });
  const selectedParticipantIds = selectedAgents.filter((agent) => agent.id !== organizer.id).map((agent) => agent.id);
  if (selectedParticipantIds.length > MAX_DISCUSSION_PARTICIPANTS) {
    throw new Error(`讨论参与 Agent 已超过硬上限：最多 ${MAX_DISCUSSION_PARTICIPANTS} 个。`);
  }

  const discussionId = makeId("discussion");
  const discussionLock = acquireRuntimeLock({
    workspaceId: workspace.id,
    channelId: channel.id,
    resource: discussionLockResource(channel.id),
    ownerType: "discussion_run",
    ownerId: discussionId,
    sessionId: discussionLockSession(discussionId),
    reason: `Discussion: ${compactText(topicSummary, 160)}`
  });
  if (!discussionLock) {
    throw new Error("当前空间已有讨论正在运行，已阻止新的讨论写入以避免状态冲突。");
  }
  run(
    `INSERT INTO discussion_runs
      (id, workspace_id, channel_id, topic, status, discussion_framework, organizer_agent_id, organizer_status, round_limit, created_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, 'planning_agents', ?, ?)`,
    [discussionId, workspace.id, channel.id, topicSummary, selectedFramework.id, organizer.id, roundLimit, nowIso()]
  );
  audit({
    workspaceId: workspace.id,
    channelId: channel.id,
    actorType: source === "task_help" ? "agent" : "human",
    actorId: requesterAgent?.id || null,
    action: source === "task_help" ? "task_discussion_help_start" : "discussion_start",
    result: "allowed",
    detail:
      source === "task_help"
        ? `${requesterAgent.name} 请求讨论模块支援任务 ${sourceTaskRun.id}，框架：${selectedFramework.name}。`
        : `人发起讨论，框架：${selectedFramework.name}；讨论主题已交给 Leader Agent：${organizer.name}。`
  });
  const message = insertMessage({
    workspaceId: workspace.id,
    channelId: channel.id,
    senderType: source === "task_help" ? "agent" : "human",
    senderId: requesterAgent?.id || null,
    senderName: requesterAgent?.name || HUMAN_NAME,
    mode: "discussion",
    targetAgentId: organizer.id,
    content: topic,
    status: "visible",
    attachments: rawAttachments,
    attachmentFallbackText: "请围绕附件图片发起讨论。"
  });
  insertMessage({
    workspaceId: workspace.id,
    channelId: channel.id,
    senderType: "system",
    senderName: "系统",
    mode: "discussion",
    targetAgentId: organizer.id,
    content: `${organizer.name} 已收到讨论主题，正在按「${selectedFramework.name}」框架判断需要哪些临时讨论 Agent。`,
    status: "visible"
  });
  upsertBlackboardEntry({
    workspaceId: workspace.id,
    channelId: channel.id,
    key: "active_discussion",
    scope: "discussion",
    value: {
      discussionId,
      topic: message.content,
      framework: selectedFramework.name,
      status: "active",
      organizer: organizer.name,
      participants: []
    },
    updatedByType: source === "task_help" ? "agent" : "human",
    updatedById: requesterAgent?.id || null
  });
  appendStructuredBlackboard({
	    workspaceId: workspace.id,
	    channelId: channel.id,
	    field: "open_questions",
    text: `Discussion started with ${selectedFramework.name}: ${message.content}`,
    source: source === "task_help" ? "agent" : "human",
    metadata: { discussionId, framework: selectedFramework.name, source, sourceTaskRunId, attachmentCount: message.attachments?.length || 0 }
  });
  if (source === "task_help") {
    const linkId = makeId("tdlink");
    const waitStartedAt = nowIso();
    const expiresAt = payload.expiresAt || taskDiscussionExpiresAt();
    const executionSnapshot = JSON.stringify(payload.executionSnapshot || {});
    const blockFingerprint = String(payload.blockFingerprint || "");
    const discussCount = Math.max(1, Number(payload.discussCount || 1));
    run(
      `INSERT INTO task_discussion_links
        (id, workspace_id, channel_id, task_run_id, discussion_id, requester_agent_id, status, request_text, execution_snapshot, wait_started_at, expires_at, block_fingerprint, discuss_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
      [
        linkId,
        workspace.id,
        channel.id,
        sourceTaskRun.id,
        discussionId,
        requesterAgent.id,
        payload.requestText || message.content,
        executionSnapshot,
        waitStartedAt,
        expiresAt,
        blockFingerprint,
        discussCount,
        waitStartedAt
      ]
    );
    markTaskWaitingDiscussion({
      taskRun: sourceTaskRun,
      channelId: channel.id,
      requesterAgentId: requesterAgent.id,
      discussionId,
      requestText: payload.requestText || message.content
    });
  }
  saveDb();
  prepareDiscussionParticipantsAndTriggerRound({
    discussionId,
    channelId: channel.id,
    selectedAgentIds: selectedParticipantIds
  }).catch((error) => {
    const readable = summarizeError(error.message || error);
    releaseRuntimeLocks({
      sessionIds: [discussionLockSession(discussionId)],
      ownerType: "discussion_run",
      ownerId: discussionId,
      status: "failed"
    });
    run("UPDATE discussion_runs SET organizer_status = 'failed' WHERE id = ?", [discussionId]);
    insertMessage({
      workspaceId: workspace.id,
      channelId: channel.id,
      senderType: "system",
      senderName: "系统",
      mode: "discussion",
      targetAgentId: organizer.id,
      content: `讨论组织失败：${readable}`,
      status: "visible"
    });
    audit({
      workspaceId: workspace.id,
      channelId: channel.id,
      actorType: "system",
      action: "discussion_background_run",
      result: "failed",
      detail: readable
    });
    saveDb();
  });
  return getState(workspace.id, channel.id);
}

function respondDiscussionInternal(payload = {}) {
  const discussion = get("SELECT * FROM discussion_runs WHERE id = ?", [payload.discussionId]);
  if (!discussion) throw new Error("讨论不存在。");
  if (discussion.status === "closed") throw new Error("讨论已结束。");
  const rawAttachments = normalizeIncomingAttachments(payload.attachments);
  const content = String(payload.content || "").trim();
  if (!content && !rawAttachments.length) throw new Error("回复内容或图片不能为空。");
  const message = insertMessage({
    workspaceId: discussion.workspace_id,
    channelId: discussion.channel_id,
    senderType: "human",
    senderName: HUMAN_NAME,
    mode: "discussion",
    content,
    status: "visible",
    attachments: rawAttachments,
    attachmentFallbackText: "请基于附件图片继续讨论。"
  });
  const participants = discussionParticipants(discussion.id);
  for (const participant of participants) {
    run(
	      `UPDATE discussion_agents
	       SET round_limit = ?
	       WHERE discussion_id = ? AND agent_id = ?`,
	      [Math.min(MAX_DISCUSSION_ROUNDS, Number(participant.rounds_used || 0) + 1), discussion.id, participant.agent_id]
	    );
	  }
  run("UPDATE discussion_runs SET status = 'active', organizer_status = 'human_replied' WHERE id = ?", [
    discussion.id
  ]);
  upsertBlackboardEntry({
    workspaceId: discussion.workspace_id,
    channelId: discussion.channel_id,
    key: "active_discussion",
    scope: "discussion",
    value: {
      discussionId: discussion.id,
      topic: discussion.topic,
      status: "active",
      lastHumanReply: compactText(message.content, 600)
    },
    updatedByType: "human"
  });
  audit({
    workspaceId: discussion.workspace_id,
    channelId: discussion.channel_id,
    actorType: "human",
    action: "discussion_human_reply",
    result: "allowed",
    detail: "人回复讨论 Leader Agent 的阶段性问题。"
  });
  saveDb();
  triggerDiscussionRound({ discussionId: discussion.id, channelId: discussion.channel_id }).catch((error) => {
    releaseRuntimeLocks({
      sessionIds: [discussionLockSession(discussion.id)],
      ownerType: "discussion_run",
      ownerId: discussion.id,
      status: "failed"
    });
    audit({
      workspaceId: discussion.workspace_id,
      channelId: discussion.channel_id,
      actorType: "system",
      action: "discussion_background_run",
      result: "failed",
      detail: summarizeError(error.message || error)
    });
    saveDb();
  });
  return getState(discussion.workspace_id, discussion.channel_id);
}

function parseSlashCommand(raw) {
  const text = String(raw || "").trim();
  if (!text.startsWith("/")) return null;
  const body = text.slice(1).trim();
  if (!body) return { name: "help", args: [], rest: "" };
  const [name, ...args] = body.split(/\s+/);
  return {
    name: String(name || "help").toLowerCase(),
    args,
    rest: body.slice(String(name || "").length).trim()
  };
}

function commandResultMode(mode) {
  return mode === "discussion" ? "discussion" : "command";
}

function insertCommandResult({ workspaceId, channelId, mode, content }) {
  insertMessage({
    workspaceId,
    channelId,
    senderType: "system",
    senderName: "系统",
    mode: commandResultMode(mode),
    content,
    status: "visible"
  });
}

function countAgentsByStatus(agents) {
  return agents.reduce((acc, agent) => {
    const key = agent.status || "ready";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function statusLine(counts) {
  const ready = counts.ready || 0;
  const running = counts.running || 0;
  const stopped = counts.stopped || 0;
  const failed = counts.failed || 0;
  return `${ready} 空闲，${running} 运行中，${stopped} 已停止，${failed} 失败`;
}

function commandStatusText(workspaceId, channelId) {
  const agents = all(
    `SELECT a.*
     FROM agents a
     JOIN agent_channels ac ON ac.agent_id = a.id AND ac.channel_id = ?
     WHERE a.workspace_id = ?
     ORDER BY a.created_at ASC`,
    [channelId, workspaceId]
  );
  const taskAgents = agents.filter((agent) => agent.agent_kind !== "discussion");
  const discussionAgents = agents.filter((agent) => agent.agent_kind === "discussion");
  const taskCounts = countAgentsByStatus(taskAgents);
  const discussionCounts = countAgentsByStatus(discussionAgents);
	  const runningTasks = get(
	    "SELECT COUNT(*) AS count FROM task_runs WHERE workspace_id = ? AND channel_id = ? AND status = 'running'",
	    [workspaceId, channelId]
	  ).count;
	  const waitingDiscussionTasks = get(
	    "SELECT COUNT(*) AS count FROM task_runs WHERE workspace_id = ? AND channel_id = ? AND status = 'waiting_discussion'",
	    [workspaceId, channelId]
	  ).count;
  const openDiscussion = get(
    `SELECT *
     FROM discussion_runs
     WHERE workspace_id = ? AND channel_id = ? AND status != 'closed'
     ORDER BY created_at DESC
     LIMIT 1`,
    [workspaceId, channelId]
  );
  const activeProcesses = [...activeAgentRuns.values()].filter(
    (item) => item.workspaceId === workspaceId && item.channelId === channelId && !item.canceled
  ).length;
  reapStaleRuntimeLocks(workspaceId, channelId);
  const activeLocks = get(
    "SELECT COUNT(*) AS count FROM runtime_locks WHERE workspace_id = ? AND channel_id = ? AND status = 'active'",
    [workspaceId, channelId]
  ).count;
  const suspectLocks = get(
    "SELECT COUNT(*) AS count FROM runtime_locks WHERE workspace_id = ? AND channel_id = ? AND status = 'suspect'",
    [workspaceId, channelId]
  ).count;
  const staleLocks = get(
    "SELECT COUNT(*) AS count FROM runtime_locks WHERE workspace_id = ? AND channel_id = ? AND status = 'stale'",
    [workspaceId, channelId]
  ).count;
  return [
    "命令 /status：",
    `任务 Agent：${taskAgents.length} 个（${statusLine(taskCounts)}）`,
    `讨论 Agent：${discussionAgents.length} 个（${statusLine(discussionCounts)}）`,
    `运行任务：${runningTasks} 个，等待讨论：${waitingDiscussionTasks} 个`,
    `本机 Agent 进程：${activeProcesses} 个`,
    `运行锁：${activeLocks} 个活跃，${suspectLocks} 个观察，${staleLocks} 个过期`,
    `当前讨论：${openDiscussion ? openDiscussion.status : "无"}`
  ].join("\n");
}

function stopCurrentChannelRuns(workspaceId, channelId) {
  const stoppedAt = nowIso();
  const activeRuns = [...activeAgentRuns.values()].filter(
    (item) => item.workspaceId === workspaceId && item.channelId === channelId && !item.canceled
  );
  for (const activeRun of activeRuns) {
    activeRun.canceled = true;
    if (activeRun.child && !activeRun.child.killed) {
      activeRun.child.kill("SIGTERM");
    }
  }

  const runningAgents = all(
    `SELECT a.id
     FROM agents a
     JOIN agent_channels ac ON ac.agent_id = a.id AND ac.channel_id = ?
     WHERE a.workspace_id = ? AND a.status = 'running'`,
    [channelId, workspaceId]
  );
  for (const agent of runningAgents) {
    run(
      `UPDATE agents
       SET status = 'stopped',
         current_task = '',
         last_finished_at = ?,
         last_error = '已通过 /stop 停止。'
       WHERE id = ?`,
      [stoppedAt, agent.id]
    );
  }

  const runningTaskRows = all(
    "SELECT * FROM task_runs WHERE workspace_id = ? AND channel_id = ? AND status IN ('running', 'waiting_discussion')",
    [workspaceId, channelId]
  );
  const runningTasks = runningTaskRows.length;
  run(
    `UPDATE task_runs
       SET status = 'stopped',
       final_output = '已通过 /stop 停止。',
       completed_at = ?
     WHERE workspace_id = ? AND channel_id = ? AND status IN ('running', 'waiting_discussion')`,
    [stoppedAt, workspaceId, channelId]
  );
  run(
    `UPDATE task_discussion_links
     SET status = 'stopped',
       resolved_at = ?
     WHERE workspace_id = ? AND channel_id = ? AND status IN ('active', 'needs_human')`,
    [stoppedAt, workspaceId, channelId]
  );
  for (const task of runningTaskRows) {
    releaseRuntimeLocks({ sessionIds: [taskLockSession(task.id)], ownerType: "task_run", ownerId: task.id, status: "stopped" });
    addEvidenceItem({
      workspaceId,
      channelId,
      taskRunId: task.id,
      agentId: task.primary_agent_id,
      kind: "task_stopped",
      title: "任务停止",
      content: "已通过 /stop 停止当前任务和相关 Agent 运行。",
      metadata: { stoppedAt }
    });
  }
  if (runningTaskRows.length > 0) {
    upsertBlackboardEntry({
      workspaceId,
      channelId,
      key: "current_task",
      scope: "task",
      value: {
        taskRunId: runningTaskRows[0].id,
        objective: runningTaskRows[0].objective,
        status: "stopped"
      },
      updatedByType: "human"
    });
  }

  const activeDiscussionRows = all(
    "SELECT * FROM discussion_runs WHERE workspace_id = ? AND channel_id = ? AND status = 'active'",
    [workspaceId, channelId]
  );
  const activeDiscussions = activeDiscussionRows.length;
  run(
    `UPDATE discussion_runs
     SET status = 'needs_approval'
     WHERE workspace_id = ? AND channel_id = ? AND status = 'active'`,
    [workspaceId, channelId]
  );
  if (activeDiscussions > 0) {
    for (const discussion of activeDiscussionRows) {
      releaseRuntimeLocks({
        sessionIds: [discussionLockSession(discussion.id)],
        ownerType: "discussion_run",
        ownerId: discussion.id,
        status: "stopped"
      });
    }
    upsertBlackboardEntry({
      workspaceId,
      channelId,
      key: "active_discussion",
      scope: "discussion",
      value: {
        status: "needs_approval",
        reason: "/stop 暂停当前讨论"
      },
      updatedByType: "human"
    });
  }
  saveDb();
  return {
    processCount: activeRuns.length,
    agentCount: runningAgents.length,
    taskCount: runningTasks,
    discussionCount: activeDiscussions
  };
}

function approveDiscussionRoundForCommand(discussion, extraRounds = 1) {
  const allowedExtraRounds = remainingDiscussionRounds(discussion, extraRounds);
  if (allowedExtraRounds <= 0) {
    insertCommandResult({
      workspaceId: discussion.workspace_id,
      channelId: discussion.channel_id,
      mode: "discussion",
      content: `命令 /round：讨论已达到硬上限 ${MAX_DISCUSSION_ROUNDS} 轮，不能继续自动扩轮。`
    });
    audit({
      workspaceId: discussion.workspace_id,
      channelId: discussion.channel_id,
      actorType: "human",
      action: "slash_round",
      result: "blocked",
      detail: `讨论已达到硬上限 ${MAX_DISCUSSION_ROUNDS} 轮。`
    });
    saveDb();
    return;
  }
  run(
    `UPDATE discussion_agents
     SET round_limit = round_limit + ?,
       status = 'active'
     WHERE discussion_id = ?`,
    [allowedExtraRounds, discussion.id]
  );
  run("UPDATE discussion_runs SET status = 'active', round_limit = round_limit + ? WHERE id = ?", [
    allowedExtraRounds,
    discussion.id
  ]);
  upsertBlackboardEntry({
    workspaceId: discussion.workspace_id,
    channelId: discussion.channel_id,
    key: "active_discussion",
    scope: "discussion",
    value: {
      discussionId: discussion.id,
      topic: discussion.topic,
      status: "active",
      extraRounds: allowedExtraRounds
    },
    updatedByType: "human"
  });
  audit({
    workspaceId: discussion.workspace_id,
    channelId: discussion.channel_id,
    actorType: "human",
    action: "slash_round",
    result: "allowed",
    detail: `通过 /round 授权讨论 Leader Agent 继续 ${allowedExtraRounds} 轮判断。`
  });
  insertCommandResult({
    workspaceId: discussion.workspace_id,
    channelId: discussion.channel_id,
    mode: "discussion",
    content: `命令 /round：已授权讨论 Leader Agent 继续 ${allowedExtraRounds} 轮判断。`
  });
  saveDb();
  triggerDiscussionRound({ discussionId: discussion.id, channelId: discussion.channel_id }).catch((error) => {
    releaseRuntimeLocks({
      sessionIds: [discussionLockSession(discussion.id)],
      ownerType: "discussion_run",
      ownerId: discussion.id,
      status: "failed"
    });
    audit({
      workspaceId: discussion.workspace_id,
      channelId: discussion.channel_id,
      actorType: "system",
      action: "discussion_background_run",
      result: "failed",
      detail: summarizeError(error.message || error)
    });
    saveDb();
  });
}

async function runSlashCommandInternal(payload = {}) {
  const workspace = get("SELECT * FROM workspaces WHERE id = ?", [payload.workspaceId]);
  const channel = get("SELECT * FROM channels WHERE id = ? AND workspace_id = ?", [
    payload.channelId,
    payload.workspaceId
  ]);
  if (!workspace || !channel) throw new Error("工作空间不存在。");
  const mode = payload.mode === "discussion" ? "discussion" : "task";
  const parsed = parseSlashCommand(payload.command);
  if (!parsed) throw new Error("命令必须以 / 开头。");
  const aliases = {
    commands: "help",
    "命令": "help",
    "状态": "status",
    "停止": "stop",
    "开始": "start",
    "下一轮": "round",
    continue: "round",
    reset: "new",
    "新对话": "new",
    "模型": "model"
  };
  const name = aliases[parsed.name] || parsed.name;

  if (name === "help") {
    insertCommandResult({
      workspaceId: workspace.id,
      channelId: channel.id,
      mode,
      content: [
        "命令 /help：",
        "/status 查看当前 Agent 和进程状态",
        "/stop 停止当前空间所有 Agent 运行",
        "/start <内容> 用当前选择启动任务或讨论",
        "/round 请求讨论 Leader Agent 进入下一轮判断",
        "/new 开启新的本地上下文标记",
        "/model <模型名> 记录模型切换需求；实际运行模型在右侧 Agent 卡片设置"
      ].join("\n")
    });
    audit({
      workspaceId: workspace.id,
      channelId: channel.id,
      actorType: "human",
      action: "slash_help",
      result: "visible",
      detail: "显示斜杠命令列表。"
    });
    saveDb();
    return getState(workspace.id, channel.id);
  }

  if (name === "status") {
    insertCommandResult({
      workspaceId: workspace.id,
      channelId: channel.id,
      mode,
      content: commandStatusText(workspace.id, channel.id)
    });
    audit({
      workspaceId: workspace.id,
      channelId: channel.id,
      actorType: "human",
      action: "slash_status",
      result: "visible",
      detail: "查看当前空间运行状态。"
    });
    saveDb();
    return getState(workspace.id, channel.id);
  }

  if (name === "stop") {
    const stopped = stopCurrentChannelRuns(workspace.id, channel.id);
    insertCommandResult({
      workspaceId: workspace.id,
      channelId: channel.id,
      mode,
      content: [
        "命令 /stop：已停止当前空间运行。",
        `取消进程：${stopped.processCount} 个`,
        `更新 Agent：${stopped.agentCount} 个`,
        `停止任务：${stopped.taskCount} 个`,
        `暂停讨论：${stopped.discussionCount} 个`
      ].join("\n")
    });
    audit({
      workspaceId: workspace.id,
      channelId: channel.id,
      actorType: "human",
      action: "slash_stop",
      result: "allowed",
      detail: `停止 ${stopped.processCount} 个本机 Agent 进程。`
    });
    saveDb();
    return getState(workspace.id, channel.id);
  }

  if (name === "start") {
    if (!parsed.rest) {
      insertCommandResult({
        workspaceId: workspace.id,
        channelId: channel.id,
        mode,
        content: "命令 /start：请在命令后输入要启动的任务或讨论内容。"
      });
      return getState(workspace.id, channel.id);
    }
    audit({
      workspaceId: workspace.id,
      channelId: channel.id,
      actorType: "human",
      action: "slash_start",
      result: "allowed",
      detail: `通过 /start 启动${mode === "discussion" ? "讨论" : "任务"}。`
    });
    if (mode === "discussion") {
      return startDiscussionInternal({
        workspaceId: workspace.id,
        channelId: channel.id,
        agentIds: payload.agentIds,
        topic: parsed.rest,
        roundLimit: 1
      });
    }
    return startTaskRunInternal({
      workspaceId: workspace.id,
      channelId: channel.id,
      primaryAgentId: payload.primaryAgentId,
      objective: parsed.rest
    });
  }

  if (name === "round") {
    if (mode !== "discussion") {
      insertCommandResult({
        workspaceId: workspace.id,
        channelId: channel.id,
        mode,
        content: "命令 /round：只在多方讨论里使用。"
      });
      return getState(workspace.id, channel.id);
    }
    const discussion = get(
      `SELECT *
       FROM discussion_runs
       WHERE workspace_id = ? AND channel_id = ? AND status != 'closed'
       ORDER BY created_at DESC
       LIMIT 1`,
      [workspace.id, channel.id]
    );
    if (!discussion) {
      insertCommandResult({
        workspaceId: workspace.id,
        channelId: channel.id,
        mode,
        content: "命令 /round：当前没有正在进行的讨论。"
      });
      return getState(workspace.id, channel.id);
    }
    const runningDiscussionAgents = get(
      `SELECT COUNT(*) AS count
       FROM discussion_agents da
       JOIN agents a ON a.id = da.agent_id
       WHERE da.discussion_id = ? AND a.status = 'running'`,
      [discussion.id]
    ).count;
    if (runningDiscussionAgents > 0) {
      insertCommandResult({
        workspaceId: workspace.id,
        channelId: channel.id,
        mode,
        content: `命令 /round：已有 ${runningDiscussionAgents} 个讨论 Agent 正在运行，先等待本轮结束。`
      });
      return getState(workspace.id, channel.id);
    }
    if (discussion.status === "needs_approval") {
      approveDiscussionRoundForCommand(discussion, 1);
      return getState(workspace.id, channel.id);
    }
    insertCommandResult({
      workspaceId: workspace.id,
      channelId: channel.id,
      mode,
      content: "命令 /round：已请求讨论 Leader Agent 进入下一轮判断。"
    });
    audit({
      workspaceId: workspace.id,
      channelId: channel.id,
      actorType: "human",
      action: "slash_round",
      result: "allowed",
    detail: "通过 /round 请求讨论 Leader Agent 进入下一轮判断。"
    });
    saveDb();
    triggerDiscussionRound({ discussionId: discussion.id, channelId: channel.id }).catch((error) => {
      releaseRuntimeLocks({
        sessionIds: [discussionLockSession(discussion.id)],
        ownerType: "discussion_run",
        ownerId: discussion.id,
        status: "failed"
      });
      audit({
        workspaceId: workspace.id,
        channelId: channel.id,
        actorType: "system",
        action: "discussion_background_run",
        result: "failed",
        detail: summarizeError(error.message || error)
      });
      saveDb();
    });
    return getState(workspace.id, channel.id);
  }

  if (name === "new") {
    if (mode === "discussion") {
      const activeDiscussions = all(
        `SELECT id
         FROM discussion_runs
         WHERE workspace_id = ? AND channel_id = ? AND status != 'closed'`,
        [workspace.id, channel.id]
      );
      run(
        `UPDATE discussion_runs
         SET status = 'closed',
           closed_at = ?
         WHERE workspace_id = ? AND channel_id = ? AND status != 'closed'`,
        [nowIso(), workspace.id, channel.id]
      );
      for (const discussion of activeDiscussions) {
        await cleanupTemporaryDiscussionAgents({ discussionId: discussion.id, channelId: channel.id });
      }
    }
    insertCommandResult({
      workspaceId: workspace.id,
      channelId: channel.id,
      mode,
      content:
        mode === "discussion"
          ? "命令 /new：已关闭当前讨论，并开启新的本地讨论上下文。"
          : "命令 /new：已开启新的本地任务上下文标记。"
    });
    audit({
      workspaceId: workspace.id,
      channelId: channel.id,
      actorType: "human",
      action: "slash_new",
      result: "allowed",
      detail: `开启新的${mode === "discussion" ? "讨论" : "任务"}上下文。`
    });
    saveDb();
    return getState(workspace.id, channel.id);
  }

  if (name === "model") {
    insertCommandResult({
      workspaceId: workspace.id,
      channelId: channel.id,
      mode,
      content: [
        `命令 /model：已记录模型切换需求${parsed.rest ? `：${parsed.rest}` : "。"}。`,
        "请在右侧 Agent 卡片点击“编辑”设置模型；保存后后续 Hermes 调用会使用该模型。"
      ].join("\n")
    });
    audit({
      workspaceId: workspace.id,
      channelId: channel.id,
      actorType: "human",
      action: "slash_model",
      result: "visible",
      detail: parsed.rest
        ? `收到模型切换需求：${parsed.rest}；实际运行模型请在 Agent 卡片编辑。`
        : "收到模型切换命令；实际运行模型请在 Agent 卡片编辑。"
    });
    saveDb();
    return getState(workspace.id, channel.id);
  }

  insertCommandResult({
    workspaceId: workspace.id,
    channelId: channel.id,
    mode,
    content: `未知命令 /${parsed.name}。输入 /help 查看可用命令。`
  });
  audit({
    workspaceId: workspace.id,
    channelId: channel.id,
    actorType: "human",
    action: "slash_unknown",
    result: "blocked",
    detail: `未知命令：/${parsed.name}`
  });
  saveDb();
  return getState(workspace.id, channel.id);
}

ipcMain.handle("team:bootstrap", (_event, payload = {}) => {
  return getState(payload.workspaceId, payload.channelId);
});

ipcMain.handle("team:refresh-data-health", (_event, payload = {}) => {
  const report = buildDataHealthReport({ persist: true });
  dataHealthCache = { at: Date.now(), report };
  return getState(payload.workspaceId, payload.channelId);
});

ipcMain.handle("team:repair-data-health", async (_event, payload = {}) => {
  await new Promise((resolve) => setImmediate(resolve));
  await repairDataHealth({
    repairMode: normalizeDataRepairMode({
      repairMode: payload.repairMode,
      cleanupProfiles: Boolean(payload.cleanupProfiles)
    }),
    actorType: "human",
    enforceCooldown: true
  });
  return getState(payload.workspaceId, payload.channelId);
});

ipcMain.handle("team:open-data-governance-path", async (_event, payload = {}) => {
  const kind = String(payload.kind || "");
  const root = dataGovernanceDir();
  const target =
    kind === "profile_archive"
      ? dataProfileArchiveDir()
      : kind === "backups"
        ? dataBackupDir()
        : kind === "reports"
          ? dataHealthReportDir()
          : root;
  if (target !== root && !isPathInside(root, target)) throw new Error("只能打开数据治理受控目录。");
  fs.mkdirSync(target, { recursive: true });
  if (!payload.dryRun) {
    const error = await shell.openPath(target);
    if (error) throw new Error(`打开目录失败：${error}`);
  }
  return { ok: true, path: target };
});

ipcMain.handle("team:create-workspace", async (_event, payload = {}) => {
  const workspaceId = makeId("ws");
  const channelId = makeId("ch");
  run("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)", [
    workspaceId,
    String(payload.name || "新工作空间").trim(),
    nowIso()
  ]);
  run("INSERT INTO channels (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)", [
    channelId,
    workspaceId,
    "总群",
    nowIso()
  ]);
  audit({
    workspaceId,
    channelId,
    actorType: "human",
    action: "create_workspace",
    result: "allowed",
    detail: "创建工作空间并生成默认消息流。"
  });
  saveDb();
  try {
    await ensureWorkspaceBaseAgents({ workspaceId, channelId, actorType: "system" });
  } catch (error) {
    const agents = all("SELECT * FROM agents WHERE workspace_id = ?", [workspaceId]);
    for (const agent of agents) {
      if (agent.owned_by_app && agentBackend(agent) === "hermes") {
        await deleteOwnedHermesProfile(agent.hermes_profile).catch(() => undefined);
      }
    }
    run("DELETE FROM workspaces WHERE id = ?", [workspaceId]);
    saveDb();
    throw new Error(`工作空间创建失败：${String(error.message || error).slice(0, 700)}`);
  }
  return getState(workspaceId, channelId);
});

ipcMain.handle("team:delete-workspace", async (_event, payload = {}) => {
  const workspace = get("SELECT * FROM workspaces WHERE id = ?", [payload.workspaceId]);
  if (!workspace) return getState();
  archiveWorkspaceBeforeDelete(workspace.id);
  const agents = all("SELECT * FROM agents WHERE workspace_id = ?", [workspace.id]);
  for (const agent of agents) {
    if (agent.owned_by_app && agentBackend(agent) === "hermes") {
      await deleteOwnedHermesProfile(agent.hermes_profile);
    }
  }
  purgeWorkspaceRows(workspace.id);
  saveDb();
  return getState();
});

ipcMain.handle("team:create-channel", (_event, payload = {}) => {
  const workspace = get("SELECT * FROM workspaces WHERE id = ?", [payload.workspaceId]);
  if (!workspace) throw new Error("工作空间不存在。");
  const channelId = makeId("ch");
  run("INSERT INTO channels (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)", [
    channelId,
    workspace.id,
    String(payload.name || "新频道").trim(),
    nowIso()
  ]);
  audit({
    workspaceId: workspace.id,
    channelId,
    actorType: "human",
    action: "create_channel",
    result: "allowed",
    detail: "创建频道。"
  });
  saveDb();
  return getState(workspace.id, channelId);
});

ipcMain.handle("team:delete-channel", (_event, payload = {}) => {
  const channel = get("SELECT * FROM channels WHERE id = ?", [payload.channelId]);
  if (!channel) return getState(payload.workspaceId);
  run("DELETE FROM channels WHERE id = ?", [channel.id]);
  saveDb();
  return getState(channel.workspace_id);
});

ipcMain.handle("team:create-agent", async (_event, payload = {}) => {
  const agentKind = payload.agentKind === "discussion" ? "discussion" : "task";
  const agent = await createAgentInternal({
    workspaceId: payload.workspaceId,
    channelId: payload.channelId,
    name: payload.name,
    role: payload.role,
    description: payload.description,
    coreCommand: payload.coreCommand,
    modelProvider: payload.modelProvider,
    modelName: payload.modelName,
    runtimeBackend: payload.runtimeBackend,
    parentAgentId: agentKind === "task" ? payload.parentAgentId || null : null,
    createdByAgentId: null,
    agentKind
  });
  return getState(agent.workspace_id, payload.channelId);
});

ipcMain.handle("team:delete-agent", async (_event, payload = {}) => {
  await deleteAgentInternal({
    agentId: payload.agentId,
    actorType: "human",
    actorId: null,
    channelId: payload.channelId
  });
  return getState(payload.workspaceId, payload.channelId);
});

ipcMain.handle("team:set-agent-channel", (_event, payload = {}) => {
  const agent = get("SELECT * FROM agents WHERE id = ?", [payload.agentId]);
  const channel = get("SELECT * FROM channels WHERE id = ?", [payload.channelId]);
  if (!agent || !channel || agent.workspace_id !== channel.workspace_id) {
    throw new Error("Agent 或工作空间不存在。");
  }
  if (payload.enabled) {
    run("INSERT OR IGNORE INTO agent_channels (agent_id, channel_id) VALUES (?, ?)", [agent.id, channel.id]);
  } else {
    run("DELETE FROM agent_channels WHERE agent_id = ? AND channel_id = ?", [agent.id, channel.id]);
  }
  audit({
    workspaceId: agent.workspace_id,
    channelId: channel.id,
    actorType: "human",
    action: "set_agent_channel",
    result: "allowed",
    detail: `${payload.enabled ? "加入" : "移出"}空间：${agent.name}`
  });
  saveDb();
  return getState(agent.workspace_id, channel.id);
});

ipcMain.handle("team:update-agent-config", async (_event, payload = {}) => {
  const agent = get("SELECT * FROM agents WHERE id = ?", [payload.agentId]);
  const channel = get("SELECT * FROM channels WHERE id = ?", [payload.channelId]);
  if (!agent || !channel || agent.workspace_id !== channel.workspace_id) {
    throw new Error("Agent 或工作空间不存在。");
  }

  await updateAgentRuntimeConfig({
    agent,
    channel,
    payload,
    actorType: "human",
    action: "update_agent_config"
  });
  return getState(agent.workspace_id, channel.id);
});

ipcMain.handle("team:start-task-run", (_event, payload = {}) => {
  return startTaskRunInternal(payload);
});

ipcMain.handle("team:send-channel-message", (_event, payload = {}) => {
  return sendChannelMessageInternal(payload);
});

ipcMain.handle("team:run-slash-command", (_event, payload = {}) => {
  return runSlashCommandInternal(payload);
});

ipcMain.handle("team:confirm-task-cleanup", async (_event, payload = {}) => {
  const taskRun = getTaskRun(payload.taskRunId);
  if (!taskRun) throw new Error("任务记录不存在。");
  if (!["awaiting_confirmation", "failed"].includes(taskRun.status)) {
    throw new Error("任务还不能确认清理。");
  }
  const roots = temporaryAgentRoots(taskRun.id);
  for (const agent of roots) {
    await deleteAgentInternal({
      agentId: agent.id,
      actorType: "human",
      actorId: null,
      channelId: taskRun.channel_id
    });
  }
  run(
    `UPDATE task_runs
     SET status = 'cleaned',
       cleaned_at = ?
     WHERE id = ?`,
    [nowIso(), taskRun.id]
  );
  addEvidenceItem({
    workspaceId: taskRun.workspace_id,
    channelId: taskRun.channel_id,
    taskRunId: taskRun.id,
    agentId: taskRun.primary_agent_id,
    kind: "task_cleanup",
    title: "确认完成并清理",
    content: `人已确认任务完成，清理 ${roots.length} 个临时 Agent，只保留输出和证据记录。`,
    metadata: { temporaryAgentsCleaned: roots.length }
  });
  upsertBlackboardEntry({
    workspaceId: taskRun.workspace_id,
    channelId: taskRun.channel_id,
    key: "current_task",
    scope: "task",
    value: {
      taskRunId: taskRun.id,
      objective: taskRun.objective,
      status: "cleaned",
      temporaryAgentsCleaned: roots.length
    },
    updatedByType: "human"
  });
  audit({
    workspaceId: taskRun.workspace_id,
    channelId: taskRun.channel_id,
    actorType: "human",
    action: "task_cleanup",
    result: "allowed",
    detail: `任务确认完成，已清理 ${roots.length} 个临时 Agent。`
  });
  insertMessage({
    workspaceId: taskRun.workspace_id,
    channelId: taskRun.channel_id,
    senderType: "system",
    senderName: "系统",
    mode: "system",
    content: roots.length > 0 ? `任务已确认完成，已清理 ${roots.length} 个临时 Agent。` : "任务已确认完成，没有需要清理的临时 Agent。",
    status: "visible"
  });
  saveDb();
  return getState(taskRun.workspace_id, taskRun.channel_id);
});

ipcMain.handle("team:run-sandbox-quick-action", (_event, payload = {}) => {
  return runSandboxQuickAction(payload);
});

ipcMain.handle("team:start-discussion", (_event, payload = {}) => {
  return startDiscussionInternal(payload);
});

ipcMain.handle("team:respond-discussion", (_event, payload = {}) => {
  return respondDiscussionInternal(payload);
});

ipcMain.handle("team:continue-discussion", (_event, payload = {}) => {
  const discussion = get("SELECT * FROM discussion_runs WHERE id = ?", [payload.discussionId]);
  if (!discussion) throw new Error("讨论不存在。");
  if (discussion.status !== "active") throw new Error("讨论当前不能继续，需要先批准或已关闭。");
  triggerDiscussionRound({ discussionId: discussion.id, channelId: discussion.channel_id }).catch((error) => {
    releaseRuntimeLocks({
      sessionIds: [discussionLockSession(discussion.id)],
      ownerType: "discussion_run",
      ownerId: discussion.id,
      status: "failed"
    });
    audit({
      workspaceId: discussion.workspace_id,
      channelId: discussion.channel_id,
      actorType: "system",
      action: "discussion_background_run",
      result: "failed",
      detail: summarizeError(error.message || error)
    });
    saveDb();
  });
  return getState(discussion.workspace_id, discussion.channel_id);
});

ipcMain.handle("team:approve-discussion-rounds", (_event, payload = {}) => {
	  const discussion = get("SELECT * FROM discussion_runs WHERE id = ?", [payload.discussionId]);
	  if (!discussion) throw new Error("讨论不存在。");
	  if (discussion.status === "closed") throw new Error("讨论已关闭。");
	  const requestedRounds = Math.max(1, Math.min(MAX_DISCUSSION_ROUNDS, Number(payload.extraRounds || 1)));
	  const extraRounds = remainingDiscussionRounds(discussion, requestedRounds);
	  if (extraRounds <= 0) throw new Error(`讨论已达到硬上限 ${MAX_DISCUSSION_ROUNDS} 轮。`);
	  run(
	    `UPDATE discussion_agents
	     SET round_limit = round_limit + ?,
       status = 'active'
     WHERE discussion_id = ?`,
    [extraRounds, discussion.id]
  );
  run("UPDATE discussion_runs SET status = 'active', round_limit = round_limit + ? WHERE id = ?", [
    extraRounds,
    discussion.id
  ]);
  upsertBlackboardEntry({
    workspaceId: discussion.workspace_id,
    channelId: discussion.channel_id,
    key: "active_discussion",
    scope: "discussion",
    value: {
      discussionId: discussion.id,
      topic: discussion.topic,
      status: "active",
      extraRounds
    },
    updatedByType: "human"
  });
  audit({
    workspaceId: discussion.workspace_id,
    channelId: discussion.channel_id,
    actorType: "human",
    action: "discussion_approve_rounds",
    result: "allowed",
    detail: `授权讨论 Leader Agent 继续 ${extraRounds} 轮判断。`
  });
  insertMessage({
    workspaceId: discussion.workspace_id,
    channelId: discussion.channel_id,
    senderType: "system",
    senderName: "系统",
    mode: "discussion",
    content: `已授权讨论 Leader Agent 继续 ${extraRounds} 轮判断。`,
    status: "visible"
  });
  saveDb();
  triggerDiscussionRound({ discussionId: discussion.id, channelId: discussion.channel_id }).catch((error) => {
    releaseRuntimeLocks({
      sessionIds: [discussionLockSession(discussion.id)],
      ownerType: "discussion_run",
      ownerId: discussion.id,
      status: "failed"
    });
    audit({
      workspaceId: discussion.workspace_id,
      channelId: discussion.channel_id,
      actorType: "system",
      action: "discussion_background_run",
      result: "failed",
      detail: summarizeError(error.message || error)
    });
    saveDb();
  });
  return getState(discussion.workspace_id, discussion.channel_id);
});

ipcMain.handle("team:close-discussion", async (_event, payload = {}) => {
  const discussion = get("SELECT * FROM discussion_runs WHERE id = ?", [payload.discussionId]);
  if (!discussion) throw new Error("讨论不存在。");
  run("UPDATE discussion_runs SET status = 'closed', closed_at = ? WHERE id = ?", [nowIso(), discussion.id]);
  releaseRuntimeLocks({
    sessionIds: [discussionLockSession(discussion.id)],
    ownerType: "discussion_run",
    ownerId: discussion.id
  });
  await cleanupTemporaryDiscussionAgents({ discussionId: discussion.id, channelId: discussion.channel_id });
  upsertBlackboardEntry({
    workspaceId: discussion.workspace_id,
    channelId: discussion.channel_id,
    key: "active_discussion",
    scope: "discussion",
    value: {
      discussionId: discussion.id,
      topic: discussion.topic,
      status: "closed"
    },
    updatedByType: "human"
  });
  audit({
    workspaceId: discussion.workspace_id,
    channelId: discussion.channel_id,
    actorType: "human",
    action: "discussion_close",
    result: "allowed",
    detail: "讨论已关闭。"
  });
  saveDb();
  return getState(discussion.workspace_id, discussion.channel_id);
});

ipcMain.handle("team:test-runtime-lock-lifecycle", (_event, payload = {}) => {
  return testRuntimeLockLifecycle(payload);
});

ipcMain.handle("team:test-task-discussion-bridge-reliability", (_event, payload = {}) => {
  return testTaskDiscussionBridgeReliability(payload);
});

ipcMain.handle("team:test-reliability-closure", (_event, payload = {}) => {
  return testReliabilityClosure(payload);
});

ipcMain.handle("team:test-data-governance", (_event, payload = {}) => {
  return testDataGovernance(payload);
});

ipcMain.handle("team:send-human-message", async (_event, payload = {}) => {
  const workspace = get("SELECT * FROM workspaces WHERE id = ?", [payload.workspaceId]);
  const channel = get("SELECT * FROM channels WHERE id = ? AND workspace_id = ?", [
    payload.channelId,
    payload.workspaceId
  ]);
  if (!workspace || !channel) throw new Error("工作空间不存在。");
  const mode = payload.mode || "chat";
  const rawAttachments = normalizeIncomingAttachments(payload.attachments);
  const content = String(payload.content || "").trim();
  if (!content && !rawAttachments.length) throw new Error("消息内容或图片不能为空。");

  let status = "visible";
  let targetAgent = null;
  if (payload.targetAgentId) {
    targetAgent = get("SELECT * FROM agents WHERE id = ? AND workspace_id = ?", [
      payload.targetAgentId,
      workspace.id
    ]);
  }

  if (mode === "command") {
    if (!targetAgent) {
      status = "blocked";
      audit({
        workspaceId: workspace.id,
        channelId: channel.id,
        actorType: "human",
        action: "human_command",
        result: "blocked",
        detail: "正式任务必须指定主 Agent。"
      });
    } else if (targetAgent.parent_agent_id) {
      status = "blocked";
      audit({
        workspaceId: workspace.id,
        channelId: channel.id,
        actorType: "human",
        action: "human_command",
        result: "blocked",
        detail: "人不能直接命令下级 Agent，只能命令主 Agent。"
      });
    } else {
      audit({
        workspaceId: workspace.id,
        channelId: channel.id,
        actorType: "human",
        action: "human_command",
        result: "allowed",
        detail: `人向主 Agent ${targetAgent.name} 下达正式任务。`
      });
    }
  } else {
    audit({
      workspaceId: workspace.id,
      channelId: channel.id,
      actorType: "human",
      action: `human_${mode}`,
      result: "visible",
      detail: mode === "notice" ? "通知可被当前空间成员看到，但不会触发 Agent 回复。" : "普通聊天不会触发 Agent 回复。"
    });
  }

  const message = insertMessage({
    workspaceId: workspace.id,
    channelId: channel.id,
    senderType: "human",
    senderName: HUMAN_NAME,
    mode,
    targetAgentId: targetAgent?.id || null,
    content,
    status,
    attachments: rawAttachments,
    attachmentFallbackText: "请查看附件图片。"
  });

  if (mode === "chat") {
    insertMessage({
      workspaceId: workspace.id,
      channelId: channel.id,
      senderType: "system",
      senderName: "系统",
      mode: "system",
      content: "普通聊天已记录，不会触发 Agent 回复。需要 Agent 回复时，请切换到“任务”。",
      status: "visible"
    });
  }

  if (mode === "notice") {
    insertMessage({
      workspaceId: workspace.id,
      channelId: channel.id,
      senderType: "system",
      senderName: "系统",
      mode: "system",
      content: "通知已发送，不会触发 Agent 回复。",
      status: "visible"
    });
  }

  if (mode === "command" && status === "visible" && targetAgent) {
    insertMessage({
      workspaceId: workspace.id,
      channelId: channel.id,
      senderType: "system",
      senderName: "系统",
      mode: "system",
      content: `已触发 ${targetAgent.name}，后台处理中。`,
      status: "visible"
    });
    invokeAgent({
      agentId: targetAgent.id,
      triggerMessage: message,
      triggerSenderName: HUMAN_NAME,
      channelId: channel.id,
      depth: 0
    }).catch((error) => {
      markAgentFailed(targetAgent.id, error.message || error);
      audit({
        workspaceId: workspace.id,
        channelId: channel.id,
        actorType: "system",
        action: "agent_background_run",
        result: "failed",
        detail: String(error.message || error).slice(0, 1000)
      });
      saveDb();
    });
  }

  saveDb();
  return getState(workspace.id, channel.id);
});

app.whenReady().then(async () => {
  await initDb();
  startMobileServer();
  createWindow();

  app.on("activate", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      showMainWindow();
    } else {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  stopMobileBonjour();
  if (mobileServer) {
    mobileServer.close();
    mobileServer = null;
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
