import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  Building2,
  Check,
  ChevronRight,
  ClipboardList,
  Copy,
  FileText,
  Image as ImageIcon,
  MessageSquare,
  Pencil,
  Plus,
  Radio,
  Send,
  ShieldCheck,
  Smartphone,
  Trash2,
  Users,
  X
} from "lucide-react";
import { isMobileWebClient, teamApi } from "./teamApi";
import type { Agent, ContentAsset, EvidenceItem, ImageUploadAttachment, MessageAttachment, MessageMode, RuntimeLock, TeamState } from "./types";

const emptyState: TeamState = {
  workspaces: [],
  channels: [],
  agents: [],
  messages: [],
  messageAttachments: [],
  audits: [],
  taskRuns: [],
  discussionRuns: [],
  discussionAgents: [],
  blackboardEntries: [],
  runtimeLocks: [],
  taskDiscussionLinks: [],
  evidenceItems: [],
  decisionRecords: [],
  contentAssets: [],
  activeWorkspaceId: null,
  activeChannelId: null,
  teamStatePath: "",
  contentArchivePath: "",
  dbFilePath: "",
  hermesPath: "",
  hermesMode: "live",
  hermesModelState: {
    defaultProvider: "",
    defaultModel: "",
    configPath: "",
    cachePath: "",
    options: [],
    updatedAt: "",
    warning: ""
  },
  dataHealth: {
    version: "",
    generated_at: "",
    status: "ok",
    issue_count: 0,
    db_path: "",
    hermes_profiles_dir: "",
    counts: {
      workspaces: 0,
      agents: 0,
      profile_check_enabled: false,
      managed_profiles_on_disk: 0,
      foreign_key_failures: 0,
      orphan_rows: 0,
      missing_profile_agents: 0,
      orphan_managed_profiles: 0,
      released_lock_overflow: 0,
      backup_files: 0,
      backup_bytes: 0,
      golden_backup_present: false,
      runtime_locks: {
        released: 0,
        stale: 0,
        failed: 0,
        active: 0,
        suspect: 0
      }
    },
    orphan_counts: {},
    foreign_key_failures: [],
    missing_profile_agents: [],
    orphan_managed_profiles: [],
    can_repair: false,
    last_report_path: "",
    repair_control: {
      in_flight: false,
      cooldown_ms: 0,
      cooldown_seconds: 0,
      cooldown_until: "",
      backup_retention_count: 5,
      golden_backup_path: "",
      backup_dir: "",
      profile_archive_dir: ""
    }
  },
  mobileServer: {
    enabled: false,
    host: "",
    port: 0,
    url: "",
    tokenPreview: "",
    warning: ""
  }
};

const slashCommandItems = [
  { command: "/help", title: "命令列表", description: "显示当前可用的本地控制命令。" },
  { command: "/status", title: "运行状态", description: "查看 Agent、任务、讨论和本机进程状态。" },
  { command: "/stop", title: "停止运行", description: "停止当前空间所有正在运行的 Agent。" },
  { command: "/start", title: "启动", description: "用当前选择启动任务或讨论。" },
  { command: "/round", title: "下一轮", description: "请求讨论 Leader Agent 进入下一轮判断。" },
  { command: "/new", title: "新上下文", description: "开启新的本地任务或讨论上下文。" },
  { command: "/model", title: "模型切换", description: "模型在右侧 Agent 卡片里实际修改。" }
];

const discussionFrameworks = [
  { id: "balanced_decision", name: "平衡决策", description: "事实、分歧、方案、行动" },
  { id: "daci_decision", name: "DACI 决策", description: "Driver / Approver / Contributors / Informed" },
  { id: "rapid_decision", name: "RAPID 决策", description: "Recommend / Agree / Perform / Input / Decide" },
  { id: "delphi_consensus", name: "Delphi 共识", description: "多轮专家共识与分歧收敛" },
  { id: "six_hats", name: "六顶思考帽", description: "事实、直觉、风险、收益、创意、流程" },
  { id: "premortem_risk", name: "Pre-mortem 风险", description: "先假设失败，再倒推预防" },
  { id: "red_team", name: "Red Team 审查", description: "对抗视角、漏洞、阻断风险" },
  { id: "double_diamond", name: "Double Diamond", description: "Discover / Define / Develop / Deliver" }
];

const maxDiscussionParticipants = 3;

function discussionFrameworkMeta(id: string | null | undefined) {
  return discussionFrameworks.find((item) => item.id === id) || discussionFrameworks[0];
}

function modelOptionValue(provider: string, model: string) {
  if (!model.trim()) return "";
  return `${encodeURIComponent(provider.trim())}::${encodeURIComponent(model.trim())}`;
}

function parseModelOptionValue(value: string) {
  if (!value) return { provider: "", model: "" };
  const [provider = "", model = ""] = value.split("::");
  return {
    provider: decodeURIComponent(provider),
    model: decodeURIComponent(model)
  };
}

function modelRouteLabel(provider: string, model: string) {
  const cleanModel = model.trim();
  const cleanProvider = provider.trim();
  if (!cleanModel) return "";
  return cleanProvider ? `${cleanProvider}/${cleanModel}` : cleanModel;
}

function agentBackend(agent: Agent) {
  return agent.runtime_backend === "codex" ? "codex" : "hermes";
}

function agentBackendLabel(agent: Agent | { runtime_backend?: string }) {
  return agent.runtime_backend === "codex" ? "Codex" : "Hermes";
}

function dataHealthSummary(state: TeamState) {
  const health = state.dataHealth;
  if (!health || health.status === "ok") return "数据正常";
  const parts = [];
  if (health.counts.foreign_key_failures) parts.push(`${health.counts.foreign_key_failures} 外键`);
  if (health.counts.orphan_rows) parts.push(`${health.counts.orphan_rows} 孤儿数据`);
  if (health.counts.missing_profile_agents) parts.push(`${health.counts.missing_profile_agents} 缺 profile`);
  if (health.counts.orphan_managed_profiles) parts.push(`${health.counts.orphan_managed_profiles} 孤儿 profile`);
  if (health.counts.released_lock_overflow) parts.push(`${health.counts.runtime_locks.released} 已释放锁`);
  return parts.join(" · ") || "发现风险";
}

function hermesDefaultModelText(state: TeamState) {
  const model = state.hermesModelState.defaultModel;
  const provider = state.hermesModelState.defaultProvider;
  const route = modelRouteLabel(provider, model);
  return route ? `跟随 Hermes 默认：${route}` : "跟随 Hermes 默认";
}

function isSlashCommand(value: string) {
  return value.trimStart().startsWith("/");
}

interface ImageDraftAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  dataBase64: string;
  previewUrl: string;
  byteSize: number;
  width: number | null;
  height: number | null;
}

const maxImageDraftCount = 4;
const maxImageDraftBytes = 6 * 1024 * 1024;

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

function imageSizeFromDataUrl(dataUrl: string) {
  return new Promise<{ width: number | null; height: number | null }>((resolve) => {
    const image = new window.Image();
    image.onload = () => resolve({ width: image.naturalWidth || null, height: image.naturalHeight || null });
    image.onerror = () => resolve({ width: null, height: null });
    image.src = dataUrl;
  });
}

async function readImageDraft(file: File): Promise<ImageDraftAttachment> {
  if (!file.type.startsWith("image/")) throw new Error("只能选择图片文件。");
  if (file.size > maxImageDraftBytes) throw new Error("单张图片不能超过 6MB。");
  const dataUrl = await fileToDataUrl(file);
  const [, dataBase64 = ""] = dataUrl.split(",", 2);
  const size = await imageSizeFromDataUrl(dataUrl);
  return {
    id: `${file.name}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
    fileName: file.name || "image",
    mimeType: file.type || "image/png",
    dataBase64,
    previewUrl: dataUrl,
    byteSize: file.size,
    width: size.width,
    height: size.height
  };
}

function draftToUpload(attachment: ImageDraftAttachment): ImageUploadAttachment {
  return {
    kind: "image",
    mimeType: attachment.mimeType,
    fileName: attachment.fileName,
    dataBase64: attachment.dataBase64,
    width: attachment.width,
    height: attachment.height
  };
}

function slashCommandSeed(command: string) {
  return command === "/start" || command === "/model" ? `${command} ` : command;
}

function commandSuggestions(value: string) {
  const raw = value.trimStart();
  if (!raw.startsWith("/")) return [];
  const query = raw.slice(1).split(/\s+/)[0]?.toLowerCase() || "";
  return slashCommandItems.filter((item) => item.command.slice(1).startsWith(query)).slice(0, 6);
}

function CommandPalette({ value, onPick }: { value: string; onPick: (value: string) => void }) {
  const suggestions = commandSuggestions(value);
  if (suggestions.length === 0) return null;
  return (
    <div className="command-palette">
      {suggestions.map((item) => (
        <button key={item.command} onClick={() => onPick(slashCommandSeed(item.command))} type="button">
          <code>{item.command}</code>
          <span>
            <strong>{item.title}</strong>
            <small>{item.description}</small>
          </span>
        </button>
      ))}
    </div>
  );
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function modeLabel(mode: MessageMode) {
  const labels: Record<MessageMode, string> = {
    chat: "聊天",
    notice: "通知",
    command: "命令",
    task: "任务",
    discussion: "讨论",
    reply: "回复",
    system: "系统"
  };
  return labels[mode];
}

function agentStatusMeta(status: string) {
  if (status === "running") return { label: "运行中", className: "running" };
  if (status === "failed") return { label: "失败", className: "failed" };
  if (status === "stopped") return { label: "已停止", className: "stopped" };
  return { label: "空闲", className: "ready" };
}

function formatRuntimeTime(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function isLongContent(value: string) {
  return value.length > 520 || value.split("\n").length > 8;
}

function compactStateText(value: string, max = 120) {
  let text = value || "";
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null) {
      text = Object.entries(parsed)
        .map(([key, item]) => `${key}: ${String(item)}`)
        .join(" / ");
    }
  } catch {
    text = value;
  }
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function compactMessagePreview(value: string, max = 160) {
  const text = stripAttachmentContext(value).replace(/\s+/g, " ").trim();
  if (!text) return "空输出";
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function stripAttachmentContext(value: string) {
  return stripVisualReferences(String(value || "").replace(/\n?【图片附件】[\s\S]*$/m, "")).trim();
}

function stripVisualReferences(value: string) {
  const visualExt = "(?:png|jpe?g|webp|gif|svg|html?)";
  return String(value || "")
    .replace(new RegExp(`!\\[[^\\]]*\\]\\([^\\)]*\\.${visualExt}(?:\\?[^\\)]*)?\\)`, "gi"), "")
    .replace(new RegExp(`\\[[^\\]]*\\]\\([^\\)]*\\.${visualExt}(?:\\?[^\\)]*)?\\)`, "gi"), "")
    .replace(
      new RegExp(
        `(?:图片|图像|视觉产物|源文件|文件|路径|链接|输出)?\\s*(?:源文件|文件|路径|链接|输出)?\\s*[:：]?\\s*[\\\`'"]?(?:[ab](?=\\/Users\\/)|~|\\/)[^\\n\\r"'\\\`<>|]*?\\.${visualExt}[\\\`'"]?`,
        "gi"
      ),
      ""
    )
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => !/^\s*(?:[-*]\s*)?$/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

type FocusedMessageContent = {
  conclusion: string;
  process: string;
  hasConclusion: boolean;
};

const finalConclusionMarkers = [
  "推荐结论",
  "最终结论",
  "最终答案",
  "最终输出",
  "结论建议",
  "决策结论",
  "Final Answer",
  "Final Output",
  "Conclusion",
  "Decision",
  "结论",
  "Final"
];

function normalizeHeadingLine(value: string) {
  return value
    .trim()
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[-*>•\d.)\s]+/, "")
    .replace(/^\*\*/, "")
    .replace(/\*\*$/, "")
    .trim();
}

function finalMarkerRest(value: string) {
  const normalized = normalizeHeadingLine(value);
  for (const marker of finalConclusionMarkers) {
    if (normalized.localeCompare(marker, undefined, { sensitivity: "accent" }) === 0) return "";
    if (normalized.toLocaleLowerCase().startsWith(marker.toLocaleLowerCase())) {
      const rest = normalized.slice(marker.length).trim();
      if (!rest) return "";
      if (/^[（(][^）)]*[）)]$/.test(rest)) return rest;
      if (/^[:：\-—–]\s*/.test(rest)) return rest.replace(/^[:：\-—–]\s*/, "").trim();
    }
  }
  return null;
}

function isDividerBlock(value: string) {
  const compact = value.replace(/\s+/g, "");
  return compact.length > 0 && /^[=\-_*`~#─━]+$/.test(compact);
}

function isSectionHeading(value: string) {
  const normalized = normalizeHeadingLine(value);
  return (
    /^\s*(?:#{1,6}\s*)?(?:\d+[\.)、]|[一二三四五六七八九十]+[、.])\s+/.test(value) ||
    /^(risks?|actions?|next actions?|confidence|needs hayden|是否需要|风险|下一步|行动|置信度|细节分歧|分歧)/i.test(normalized)
  );
}

function cleanConclusionText(value: string) {
  return value
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed && !isDividerBlock(trimmed) && !trimmed.startsWith("```");
    })
    .join("\n")
    .trim();
}

function isGenericDecisionText(value: string) {
  const text = value.replace(/\s+/g, " ").trim();
  return !text || /^(已有足够结论|已有阶段性结论|组织决策 JSON 解析失败.*|mock discussion complete)$/i.test(text);
}

function hasConclusionSignal(value: string) {
  return /(建议|推荐|结论|因此|总之|应当|必须|可以直接|核心价值|Recommendation|Conclusion|Therefore|Recommend)/i.test(value);
}

function paragraphBlocks(value: string) {
  return value
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block && !isDividerBlock(block));
}

function extractOrganizerDecisionReason(value: string) {
  const matches = [...value.matchAll(/```hermes-discussion-organizer\s*([\s\S]*?)```/gi)];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(matches[index][1].trim());
      const reason = cleanConclusionText(String(parsed.reason || ""));
      if (reason && !isGenericDecisionText(reason)) return reason;
    } catch {
      continue;
    }
  }
  return "";
}

function focusMessageContent(value: string): FocusedMessageContent {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return { conclusion: "空输出", process: "", hasConclusion: false };

  const organizerReason = extractOrganizerDecisionReason(normalized);
  if (organizerReason) {
    return {
      conclusion: organizerReason,
      process: normalized.replace(/```hermes-discussion-organizer[\s\S]*?```/gi, "").trim(),
      hasConclusion: true
    };
  }

  const lines = normalized.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const rest = finalMarkerRest(lines[index]);
    if (rest === null) continue;
    let endIndex = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (cursor > index + 1 && isSectionHeading(lines[cursor])) {
        endIndex = cursor;
        break;
      }
    }
    const after = lines.slice(index + 1, endIndex).join("\n").trim();
    const cleanedRest = /^[（(][^）)]*[）)]$/.test(rest) ? "" : rest;
    const conclusion = cleanConclusionText([cleanedRest, after].filter(Boolean).join("\n"));
    if (!conclusion || isGenericDecisionText(conclusion)) continue;
    return {
      conclusion,
      process: [...lines.slice(0, index), ...lines.slice(endIndex)].join("\n").trim(),
      hasConclusion: true
    };
  }

  const blocks = paragraphBlocks(normalized);
  if (blocks.length > 1 && (normalized.length > 520 || lines.length > 8)) {
    const lastMeaningfulBlock = cleanConclusionText(blocks[blocks.length - 1]);
    if (lastMeaningfulBlock && hasConclusionSignal(lastMeaningfulBlock)) {
      return {
        conclusion: lastMeaningfulBlock,
        process: blocks.slice(0, -1).join("\n\n").trim(),
        hasConclusion: true
      };
    }
    return {
      conclusion: "主 Agent 尚未给出可识别的最终结论，非结论内容已折叠。",
      process: normalized,
      hasConclusion: false
    };
  }

  if (lines.length > 8) {
    const lastLines = cleanConclusionText(lines.slice(-6).join("\n"));
    if (lastLines && hasConclusionSignal(lastLines)) {
      return {
        conclusion: lastLines,
        process: lines.slice(0, -6).join("\n").trim(),
        hasConclusion: true
      };
    }
    return {
      conclusion: "主 Agent 尚未给出可识别的最终结论，非结论内容已折叠。",
      process: normalized,
      hasConclusion: false
    };
  }

  return { conclusion: normalized, process: "", hasConclusion: true };
}

function decisionLabel(status: string) {
  if (status === "continue") return "继续";
  if (status === "ask_human") return "待确认";
  if (status === "final") return "结论";
  return status || "记录";
}

function taskStatusLabel(status: string) {
  if (status === "running") return "运行中";
  if (status === "waiting_discussion") return "等讨论";
  if (status === "awaiting_confirmation") return "待确认";
  if (status === "cleaned") return "已清理";
  if (status === "failed") return "失败";
  if (status === "stopped") return "已停止";
  return status || "任务";
}

function discussionStatusLabel(status: string) {
  if (status === "active") return "组织中";
  if (status === "needs_approval") return "等待回复";
  if (status === "closed") return "已关闭";
  return status || "讨论";
}

function lockStatusLabel(status: string) {
  if (status === "active") return "活跃";
  if (status === "suspect") return "观察中";
  if (status === "stale") return "已过期";
  if (status === "released") return "已释放";
  if (status === "failed") return "失败释放";
  if (status === "stopped") return "已停止";
  if (status === "needs_approval") return "待确认";
  return status || "锁";
}

function lockOwnerLabel(lock: RuntimeLock) {
  if (lock.owner_type === "task_run") return `任务 ${lock.owner_id.slice(0, 8)}`;
  if (lock.owner_type === "discussion_run") return `讨论 ${lock.owner_id.slice(0, 8)}`;
  return `${lock.owner_type}:${lock.owner_id.slice(0, 8)}`;
}

function assetTypeLabel(type: string) {
  const labels: Record<string, string> = {
    human_task_request: "任务需求",
    task_agent_output: "任务输出",
    task_final_output: "最终交付",
    task_failure: "任务失败",
    human_discussion_topic: "讨论主题",
    discussion_agent_output: "讨论观点",
    discussion_decision: "讨论决策",
    human_message: "人的发言",
    agent_output: "Agent 输出",
    human_command: "人的命令"
  };
  return labels[type] || type;
}

function parseAssetMetadata(asset: ContentAsset | null): Record<string, unknown> {
  if (!asset?.metadata_json) return {};
  try {
    const parsed = JSON.parse(asset.metadata_json);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function parseEvidenceMetadata(item: EvidenceItem | null): Record<string, unknown> {
  if (!item?.metadata_json) return {};
  try {
    const parsed = JSON.parse(item.metadata_json);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function formatDateTime(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatDurationMs(value: unknown) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
}

function evidenceExecutionRows(item: EvidenceItem) {
  const metadata = parseEvidenceMetadata(item);
  const execution =
    metadata.execution && typeof metadata.execution === "object"
      ? (metadata.execution as Record<string, unknown>)
      : null;
  if (!execution) return null;
  const prompt =
    metadata.prompt && typeof metadata.prompt === "object"
      ? (metadata.prompt as Record<string, unknown>)
      : null;
  const args = Array.isArray(execution.args) ? execution.args.map(String) : [];
  const commandText = [execution.command, ...args].filter(Boolean).map(String).join(" ");
  const modelText = [execution.provider, execution.model].filter(Boolean).map(String).join(" / ");
  const exitText =
    execution.exitCode !== undefined && execution.exitCode !== null && execution.exitCode !== ""
      ? String(execution.exitCode)
      : "";
  const rows = [
    ["运行", [execution.mode, execution.status].filter(Boolean).map(String).join(" / ")],
    ["Profile", String(execution.profile || "")],
    ["模型", modelText || "跟随 Hermes 默认"],
    ["耗时", formatDurationMs(execution.durationMs)],
    ["退出", exitText ? `${exitText}${execution.signal ? ` / ${String(execution.signal)}` : ""}` : ""],
    ["命令", commandText ? compactStateText(commandText, 220) : ""],
    [
      "提示",
      prompt ? `${String(prompt.chars || 0)} chars · ${String(prompt.sha256 || "").slice(0, 12)}` : ""
    ]
  ].filter(([, value]) => value);

  return {
    rows,
    stderrPreview: String(execution.stderrPreview || "")
  };
}

function EvidenceExecutionMeta({ item }: { item: EvidenceItem }) {
  const details = evidenceExecutionRows(item);
  if (!details) return null;
  return (
    <div className="evidence-meta" aria-label="执行细节">
      <strong>执行细节</strong>
      <dl>
        {details.rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {details.stderrPreview ? <p>{details.stderrPreview}</p> : null}
    </div>
  );
}

type SandboxQuickAction = {
  id: "takeover" | "copy_command" | "remove_worktree" | "cleanup_sandbox";
  label: string;
  command: string;
  destructive: boolean;
};

function sandboxQuickActionsFromEvidence(item: EvidenceItem): SandboxQuickAction[] {
  if (item.kind !== "execution_sandbox_protocol" || !item.task_run_id) return [];
  const metadata = parseEvidenceMetadata(item);
  const rawActions = Array.isArray(metadata.quickActions) ? metadata.quickActions : [];
  const parsed = rawActions
    .map((action) => {
      if (!action || typeof action !== "object") return null;
      const record = action as Record<string, unknown>;
      const id = String(record.id || "");
      if (!["takeover", "copy_command", "remove_worktree", "cleanup_sandbox"].includes(id)) return null;
      return {
        id: id as SandboxQuickAction["id"],
        label: String(record.label || id),
        command: String(record.command || ""),
        destructive: Boolean(record.destructive)
      };
    })
    .filter(Boolean) as SandboxQuickAction[];
  if (parsed.length > 0) return parsed;
  if (metadata.sandboxPath || metadata.protocolPath || metadata.worktreePath) {
    return [
      { id: "takeover", label: "接管", command: "", destructive: false },
      { id: "copy_command", label: "复制命令", command: "", destructive: false },
      { id: "remove_worktree", label: "移除 worktree", command: "", destructive: true },
      { id: "cleanup_sandbox", label: "清理", command: "", destructive: true }
    ];
  }
  return [];
}

function SandboxQuickActions({
  item,
	  busy,
	  onRun,
	  onCopy,
	  copiedTarget
	}: {
	  item: EvidenceItem;
	  busy: boolean;
	  onRun: (taskRunId: string, action: SandboxQuickAction) => void;
	  onCopy: (command: string, target: string) => void;
	  copiedTarget: string;
	}) {
  const actions = sandboxQuickActionsFromEvidence(item);
  if (!item.task_run_id || actions.length === 0) return null;
  return (
    <div className="sandbox-actions" aria-label="沙箱快捷动作">
      {actions.map((action) => (
	        <button
	          className={action.destructive ? "danger" : ""}
	          disabled={busy}
	          key={action.id}
	          onClick={() =>
	            action.id === "copy_command" && action.command
	              ? onCopy(action.command, `sandbox-command:${item.id}`)
	              : onRun(item.task_run_id || "", action)
	          }
	          title={action.command || action.label}
	          type="button"
	        >
	          {action.id === "cleanup_sandbox" ? (
	            <Trash2 size={13} />
	          ) : action.id === "copy_command" && copiedTarget === `sandbox-command:${item.id}` ? (
	            <Check size={13} />
	          ) : action.id === "copy_command" ? (
	            <Copy size={13} />
	          ) : (
	            <FileText size={13} />
	          )}
	          <span>{action.id === "copy_command" && copiedTarget === `sandbox-command:${item.id}` ? "已复制" : action.label}</span>
	        </button>
      ))}
    </div>
  );
}

function DetailOverlay({
  title,
  subtitle,
  onClose,
  children
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="detail-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="detail-panel" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <header className="detail-head">
          <div>
            <span>{subtitle}</span>
            <h2>{title}</h2>
          </div>
          <button aria-label="关闭详情" onClick={onClose} title="关闭详情" type="button">
            <X size={18} />
          </button>
        </header>
        <div className="detail-body">{children}</div>
      </section>
    </div>
  );
}

function DetailEmpty({ text }: { text: string }) {
  return <p className="detail-empty">{text}</p>;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderMessageContent(value: string, mentionNames: string[]) {
  const names = [...new Set(mentionNames.map((name) => name.trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length
  );
  if (names.length === 0) return value;
  const pattern = new RegExp(`@(?:${names.map(escapeRegExp).join("|")})`, "g");
  const nodes = [];
  let lastIndex = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index || 0;
    if (index > lastIndex) nodes.push(value.slice(lastIndex, index));
    nodes.push(
      <span className="mention" key={`${index}-${match[0]}`}>
        {match[0]}
      </span>
    );
    lastIndex = index + match[0].length;
  }
  if (lastIndex < value.length) nodes.push(value.slice(lastIndex));
  return nodes.length > 0 ? nodes : value;
}

function MessageAttachmentGrid({
  attachments,
  onOpenImage
}: {
  attachments?: MessageAttachment[];
  onOpenImage?: (attachment: MessageAttachment) => void;
}) {
  const items = (attachments || []).filter((attachment) => attachment.kind === "image" && attachment.url);
  if (items.length === 0) return null;
  return (
    <div className="message-attachments">
      {items.map((attachment) => (
        <button
          aria-label={`查看图片 ${attachment.original_name || attachment.filename}`}
          className="message-attachment"
          key={attachment.id}
          onClick={() => onOpenImage?.(attachment)}
          title={attachment.original_name || attachment.filename}
          type="button"
        >
          <img alt={attachment.original_name || attachment.filename} src={attachment.url} />
        </button>
      ))}
    </div>
  );
}

function DraftAttachmentTray({
  attachments,
  onRemove
}: {
  attachments: ImageDraftAttachment[];
  onRemove: (id: string) => void;
}) {
  if (!attachments.length) return null;
  return (
    <div className="draft-attachments" aria-label="待发送图片">
      {attachments.map((attachment) => (
        <div className="draft-attachment" key={attachment.id}>
          <img alt={attachment.fileName} src={attachment.previewUrl} />
          <span>{attachment.fileName}</span>
          <button aria-label={`移除 ${attachment.fileName}`} onClick={() => onRemove(attachment.id)} title="移除图片" type="button">
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

function textMentionsAnyAgent(value: string, agentNames: string[]) {
  const text = String(value || "");
  return agentNames.some((name) => {
    if (!name) return false;
    return (
      text.includes(`Agent：${name}`) ||
      text.includes(`Agent: ${name}`) ||
      text.includes(`Agent ${name}`) ||
      text.includes(`：${name}`)
    );
  });
}

function isDiscussionSystemText(value: string, discussionAgentNames: string[]) {
  const text = String(value || "");
  return text.includes("讨论") || textMentionsAnyAgent(text, discussionAgentNames);
}

function agentDepth(agent: Agent, agents: Agent[]) {
  let depth = 0;
  let parentId = agent.parent_agent_id;
  const guard = new Set<string>();
  while (parentId && !guard.has(parentId)) {
    guard.add(parentId);
    const parent = agents.find((item) => item.id === parentId);
    if (!parent) break;
    depth += 1;
    parentId = parent.parent_agent_id;
  }
  return Math.min(depth, 4);
}

export default function App() {
  const [state, setState] = useState<TeamState>(emptyState);
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<{ kind: string; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceNameError, setWorkspaceNameError] = useState<string | null>(null);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [editingCoreCommand, setEditingCoreCommand] = useState("");
  const [editingModelProvider, setEditingModelProvider] = useState("");
  const [editingModelName, setEditingModelName] = useState("");
  const [editingRuntimeBackend, setEditingRuntimeBackend] = useState<"hermes" | "codex">("hermes");
  const [workMode, setWorkMode] = useState<"task" | "discussion">("task");
  const [targetAgentId, setTargetAgentId] = useState("");
  const [taskText, setTaskText] = useState("");
  const [discussionText, setDiscussionText] = useState("");
  const [taskImageDrafts, setTaskImageDrafts] = useState<ImageDraftAttachment[]>([]);
  const [discussionImageDrafts, setDiscussionImageDrafts] = useState<ImageDraftAttachment[]>([]);
  const [discussionFramework, setDiscussionFramework] = useState("balanced_decision");
  const [discussionAgentIds, setDiscussionAgentIds] = useState<string[]>([]);
  const [detailView, setDetailView] = useState<"task" | "discussion" | "assets" | "message" | null>(null);
  const [detailTaskId, setDetailTaskId] = useState("");
  const [detailDiscussionId, setDetailDiscussionId] = useState("");
  const [detailAssetId, setDetailAssetId] = useState("");
  const [expandedMessageId, setExpandedMessageId] = useState("");
  const [imagePreviewAttachment, setImagePreviewAttachment] = useState<MessageAttachment | null>(null);
  const [copiedTarget, setCopiedTarget] = useState("");
  const knownDiscussionAgentIdsRef = useRef<{ scope: string; ids: Set<string> }>({ scope: "", ids: new Set() });
  const workspaceNameInputRef = useRef<HTMLInputElement | null>(null);
  const messageListRef = useRef<HTMLElement | null>(null);
  const taskTextAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const discussionTextAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const taskImageInputRef = useRef<HTMLInputElement | null>(null);
  const discussionImageInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    teamApi
      .bootstrap()
      .then(setState)
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!state.activeWorkspaceId || !state.activeChannelId) return undefined;
    const timer = window.setInterval(() => {
      teamApi
        .bootstrap({ workspaceId: state.activeWorkspaceId, channelId: state.activeChannelId })
        .then(setState)
        .catch((err) => setError(err.message));
    }, 2500);
    return () => window.clearInterval(timer);
  }, [state.activeWorkspaceId, state.activeChannelId]);

  const activeWorkspace = useMemo(
    () => state.workspaces.find((item) => item.id === state.activeWorkspaceId) || null,
    [state.workspaces, state.activeWorkspaceId]
  );
  const activeChannel = useMemo(
    () => state.channels.find((item) => item.id === state.activeChannelId) || null,
    [state.channels, state.activeChannelId]
  );
  const hasWorkspace = Boolean(activeWorkspace && activeChannel);
  const dataRepairControl = state.dataHealth.repair_control;
  const dataRepairCoolingDown = Number(dataRepairControl?.cooldown_ms || 0) > 0;
  const dataRepairLocked = busy || Boolean(dataRepairControl?.in_flight);
  const databaseRepairLocked = dataRepairLocked || dataRepairCoolingDown;
  const hasDbRepairRisk = Boolean(
    state.dataHealth.counts.foreign_key_failures ||
      state.dataHealth.counts.orphan_rows ||
      state.dataHealth.counts.released_lock_overflow ||
      state.dataHealth.counts.runtime_locks.stale ||
      state.dataHealth.counts.runtime_locks.failed
  );
  const hasMissingProfileRepairRisk = Boolean(state.dataHealth.counts.missing_profile_agents);
  const hasProfileRepairRisk = Boolean(state.dataHealth.counts.orphan_managed_profiles || hasMissingProfileRepairRisk);
  const dataRepairCooldownLabel = dataRepairCoolingDown
    ? `冷却 ${Math.max(1, Math.ceil(Number(dataRepairControl.cooldown_seconds || 0) / 60))} 分钟`
    : "";
  const taskAgents = useMemo(
    () => state.agents.filter((agent) => agent.agent_kind !== "discussion"),
    [state.agents]
  );
  const discussionAgentsPool = useMemo(
    () => state.agents.filter((agent) => agent.agent_kind === "discussion"),
    [state.agents]
  );
  const discussionAgentNames = useMemo(
    () => discussionAgentsPool.map((agent) => agent.name).filter(Boolean),
    [discussionAgentsPool]
  );
  const primaryAgents = useMemo(
    () => taskAgents.filter((agent) => Number(agent.is_primary) === 1 && agent.in_active_channel),
    [taskAgents]
  );
  const discussionLeadAgents = useMemo(
    () =>
      discussionAgentsPool.filter(
        (agent) => agent.in_active_channel && !agent.is_temporary && Number(agent.is_primary) === 1
      ),
    [discussionAgentsPool]
  );
  const selectableDiscussionAgents = useMemo(
    () =>
      discussionAgentsPool.filter(
        (agent) => agent.in_active_channel && !agent.is_temporary && Number(agent.is_primary) !== 1
      ),
    [discussionAgentsPool]
  );
  const visibleAgents = useMemo(
    () => (workMode === "discussion" ? discussionAgentsPool : taskAgents),
    [discussionAgentsPool, taskAgents, workMode]
  );
  const agentById = useMemo(
    () => new Map(state.agents.map((agent) => [agent.id, agent])),
    [state.agents]
  );
  const taskMainMessageAgentIds = useMemo(
    () =>
      new Set([
        ...primaryAgents.map((agent) => agent.id),
        ...state.taskRuns.map((task) => task.primary_agent_id).filter(Boolean)
      ]),
    [primaryAgents, state.taskRuns]
  );
  const discussionMainMessageAgentIds = useMemo(
    () =>
      new Set([
        ...discussionLeadAgents.map((agent) => agent.id),
        ...state.discussionRuns.map((discussion) => discussion.organizer_agent_id).filter(Boolean)
      ]),
    [discussionLeadAgents, state.discussionRuns]
  );
  const mainMessageAgentIds = workMode === "discussion" ? discussionMainMessageAgentIds : taskMainMessageAgentIds;
  const mentionNames = useMemo(
    () => ["Hayden", ...state.agents.map((agent) => agent.name)],
    [state.agents]
  );
  const visibleMessages = useMemo(
    () =>
      workMode === "discussion"
        ? state.messages
        : state.messages.filter((messageItem) => {
            const sender = messageItem.sender_id ? agentById.get(messageItem.sender_id) : null;
            const target = messageItem.target_agent_id ? agentById.get(messageItem.target_agent_id) : null;
            const discussionSystemText =
              messageItem.sender_type === "system" &&
              messageItem.mode === "system" &&
              isDiscussionSystemText(messageItem.content, discussionAgentNames);
            return (
              messageItem.mode !== "discussion" &&
              sender?.agent_kind !== "discussion" &&
              target?.agent_kind !== "discussion" &&
              !discussionSystemText
            );
          }),
    [agentById, discussionAgentNames, state.messages, workMode]
  );
  const visibleAudits = useMemo(
    () =>
      workMode === "discussion"
        ? state.audits
        : state.audits.filter((audit) => {
            const actor = audit.actor_id ? agentById.get(audit.actor_id) : null;
            return (
              !audit.action.includes("discussion") &&
              actor?.agent_kind !== "discussion" &&
              !isDiscussionSystemText(audit.detail, discussionAgentNames)
            );
          }),
    [agentById, discussionAgentNames, state.audits, workMode]
  );
  const runningAgents = useMemo(
    () => visibleAgents.filter((agent) => agent.status === "running"),
    [visibleAgents]
  );
  const failedAgents = useMemo(
    () => visibleAgents.filter((agent) => agent.status === "failed"),
    [visibleAgents]
  );

  useEffect(() => {
    if (primaryAgents.length === 0) return;
    const hasValidTarget = Boolean(targetAgentId && primaryAgents.some((agent) => agent.id === targetAgentId));
    if (!hasValidTarget) {
      setTargetAgentId(primaryAgents[0].id);
    }
  }, [primaryAgents, targetAgentId]);

	  useEffect(() => {
	    const scope = `${state.activeWorkspaceId || ""}:${state.activeChannelId || ""}`;
	    const validIds = selectableDiscussionAgents.map((agent) => agent.id).slice(0, maxDiscussionParticipants);
	    const validIdSet = new Set(validIds);
    const previousKnown = knownDiscussionAgentIdsRef.current;
    const scopeChanged = previousKnown.scope !== scope;
    const knownIds = scopeChanged ? new Set<string>() : previousKnown.ids;
    const newIds = validIds.filter((agentId) => !knownIds.has(agentId));
    knownDiscussionAgentIdsRef.current = { scope, ids: validIdSet };
    setDiscussionAgentIds((previous) => {
      if (validIds.length === 0) return [];
      if (scopeChanged || knownIds.size === 0) return validIds;
      const kept = previous.filter((agentId) => validIdSet.has(agentId));
      const next = [...kept, ...newIds.filter((agentId) => !kept.includes(agentId))];
      return next;
    });
  }, [selectableDiscussionAgents, state.activeWorkspaceId, state.activeChannelId]);

  const pendingCleanupTask = useMemo(
    () => state.taskRuns.find((task) => ["awaiting_confirmation", "failed"].includes(task.status)) || null,
    [state.taskRuns]
  );
  const activeDiscussion = useMemo(
    () => state.discussionRuns.find((discussion) => discussion.status !== "closed") || null,
    [state.discussionRuns]
  );
  const activeDiscussionAgents = useMemo(
    () =>
      activeDiscussion
        ? state.discussionAgents.filter((agent) => agent.discussion_id === activeDiscussion.id)
        : [],
    [activeDiscussion, state.discussionAgents]
  );
  const activeDiscussionRoundText = useMemo(() => {
    if (!activeDiscussion) return "轮次 0/0";
    const used = Math.max(0, ...activeDiscussionAgents.map((agent) => Number(agent.rounds_used || 0)));
    const limit = Math.max(Number(activeDiscussion.round_limit || 0), ...activeDiscussionAgents.map((agent) => Number(agent.round_limit || 0)));
    return `轮次 ${used}/${limit || activeDiscussion.round_limit || 0}`;
  }, [activeDiscussion, activeDiscussionAgents]);
  const visibleBlackboardEntries = useMemo(
    () =>
      workMode === "discussion"
        ? state.blackboardEntries
        : state.blackboardEntries.filter((item) => item.scope !== "discussion" && !item.key.includes("discussion:")),
    [state.blackboardEntries, workMode]
  );
  const recentEvidenceItems = useMemo(() => state.evidenceItems.slice(0, 6), [state.evidenceItems]);
  const recentDecisionRecords = useMemo(() => state.decisionRecords.slice(0, 5), [state.decisionRecords]);
  const visibleContentAssets = useMemo(
    () =>
      workMode === "discussion"
        ? state.contentAssets
        : state.contentAssets.filter((item) => item.scope !== "discussion" && !item.asset_type.startsWith("discussion_")),
    [state.contentAssets, workMode]
  );
  const activeRuntimeLocks = useMemo(
    () => state.runtimeLocks.filter((lock) => lock.status === "active"),
    [state.runtimeLocks]
  );
  const suspectRuntimeLocks = useMemo(
    () => state.runtimeLocks.filter((lock) => lock.status === "suspect"),
    [state.runtimeLocks]
  );
  const staleRuntimeLocks = useMemo(
    () => state.runtimeLocks.filter((lock) => lock.status === "stale"),
    [state.runtimeLocks]
  );
  const recentRuntimeLocks = useMemo(
    () => [...activeRuntimeLocks, ...suspectRuntimeLocks, ...staleRuntimeLocks].slice(0, 4),
    [activeRuntimeLocks, suspectRuntimeLocks, staleRuntimeLocks]
  );
  const recentContentAssets = useMemo(() => visibleContentAssets.slice(0, 5), [visibleContentAssets]);
  const selectedTaskDetail = useMemo(
    () => state.taskRuns.find((task) => task.id === detailTaskId) || state.taskRuns[0] || null,
    [detailTaskId, state.taskRuns]
  );
  const selectedDiscussionDetail = useMemo(
    () => state.discussionRuns.find((discussion) => discussion.id === detailDiscussionId) || activeDiscussion || state.discussionRuns[0] || null,
    [activeDiscussion, detailDiscussionId, state.discussionRuns]
  );
  const selectedContentAsset = useMemo(
    () => visibleContentAssets.find((asset) => asset.id === detailAssetId) || visibleContentAssets[0] || null,
    [detailAssetId, visibleContentAssets]
  );
  const selectedMessage = useMemo(
    () => state.messages.find((message) => message.id === expandedMessageId) || null,
    [expandedMessageId, state.messages]
  );
  const selectedTaskEvidence = useMemo(
    () =>
      selectedTaskDetail
        ? state.evidenceItems.filter((item) => item.task_run_id === selectedTaskDetail.id)
        : [],
    [selectedTaskDetail, state.evidenceItems]
  );
  const selectedTaskAgents = useMemo(
    () =>
      selectedTaskDetail
        ? state.agents.filter((agent) => agent.task_run_id === selectedTaskDetail.id)
        : [],
    [selectedTaskDetail, state.agents]
  );
  const selectedTaskAssets = useMemo(
    () =>
      selectedTaskDetail
        ? state.contentAssets.filter(
            (asset) =>
              asset.source_type === "task_run" && asset.source_id === selectedTaskDetail.id
          )
        : [],
    [selectedTaskDetail, state.contentAssets]
  );
  const selectedDiscussionParticipants = useMemo(
    () =>
      selectedDiscussionDetail
        ? state.discussionAgents.filter((item) => item.discussion_id === selectedDiscussionDetail.id)
        : [],
    [selectedDiscussionDetail, state.discussionAgents]
  );
  const selectedDiscussionDecisions = useMemo(
    () =>
      selectedDiscussionDetail
        ? state.decisionRecords.filter((item) => item.discussion_id === selectedDiscussionDetail.id)
        : [],
    [selectedDiscussionDetail, state.decisionRecords]
  );
  const selectedDiscussionAssets = useMemo(
    () =>
      selectedDiscussionDetail
        ? state.contentAssets.filter((asset) => {
            const metadata = parseAssetMetadata(asset);
            return String(metadata.discussionId || "") === selectedDiscussionDetail.id;
          })
        : [],
    [selectedDiscussionDetail, state.contentAssets]
  );
  const selectedContentAssetMetadata = useMemo(
    () => parseAssetMetadata(selectedContentAsset),
    [selectedContentAsset]
  );
  const taskIsSlashCommand = isSlashCommand(taskText);
  const discussionIsSlashCommand = isSlashCommand(discussionText);
  const discussionFrameworkValue = activeDiscussion?.discussion_framework || discussionFramework;
  const selectedDiscussionFramework = discussionFrameworkMeta(discussionFrameworkValue);

  useLayoutEffect(() => {
    const list = messageListRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
    const timer = window.setTimeout(() => {
      list.scrollTop = list.scrollHeight;
    }, 0);
    return () => window.clearTimeout(timer);
  }, [visibleMessages.length, workMode]);

  async function mutate(
    action: () => Promise<TeamState>,
    clear?: () => void,
    nextOperation?: { kind: string; label: string }
  ) {
    setBusy(true);
    setOperation(nextOperation || null);
    setError(null);
    try {
      const next = await action();
      setState(next);
      clear?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setOperation(null);
    }
  }

  function switchWorkspace(workspaceId: string) {
    mutate(() => teamApi.bootstrap({ workspaceId }));
  }

  function refreshDataHealth() {
    mutate(
      () => teamApi.refreshDataHealth({ workspaceId: state.activeWorkspaceId, channelId: state.activeChannelId }),
      undefined,
      { kind: "data-health-refresh", label: "正在检查数据层健康状态" }
    );
  }

  function repairDataHealth(repairMode: "database" | "profiles" | "all") {
    const includesDatabase = repairMode === "database" || (repairMode === "all" && hasDbRepairRisk);
    if ((includesDatabase && databaseRepairLocked) || (!includesDatabase && dataRepairLocked)) {
      setError(dataRepairCooldownLabel || "数据修复正在执行中。");
      return;
    }
    const labels = {
      database: "正在备份并修复数据库",
      profiles: "正在修复 profile",
      all: "正在全部修复：DB + profile"
    };
    mutate(
      () =>
        teamApi.repairDataHealth({
          workspaceId: state.activeWorkspaceId,
          channelId: state.activeChannelId,
          repairMode
        }),
      undefined,
      { kind: `data-health-repair-${repairMode}`, label: labels[repairMode] }
    );
  }

  async function openDataGovernancePath(kind: "profile_archive" | "backups" | "reports" | "root") {
    if (busy) return;
    setBusy(true);
    setOperation({ kind: "data-health-open-path", label: "正在打开数据治理目录" });
    setError(null);
    try {
      await teamApi.openDataGovernancePath({ kind });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setOperation(null);
    }
  }

  function createWorkspace(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const name = workspaceName.trim();
    if (!name) {
      setError(null);
      setWorkspaceNameError("请先填写工作空间名称，再点击 + 创建。");
      window.setTimeout(() => workspaceNameInputRef.current?.focus(), 0);
      return;
    }
    setWorkspaceNameError(null);
    mutate(
      () => teamApi.createWorkspace({ name }),
      () => {
        setWorkspaceName("");
        setWorkspaceNameError(null);
      },
      { kind: "create-workspace", label: "正在创建工作空间、任务项目经理 Agent 和讨论 Leader Agent" }
    );
  }

  function beginEditAgent(agent: Agent) {
    setEditingAgentId(agent.id);
    setEditingCoreCommand(agent.core_command || "");
    setEditingModelProvider(agent.model_provider || "");
    setEditingModelName(agent.model_name || "");
    setEditingRuntimeBackend(agentBackend(agent));
  }

  function cancelEditAgent() {
    setEditingAgentId(null);
    setEditingCoreCommand("");
    setEditingModelProvider("");
    setEditingModelName("");
    setEditingRuntimeBackend("hermes");
  }

  function saveAgentConfig(agent: Agent) {
    if (!activeChannel) return;
    mutate(
      () =>
        teamApi.updateAgentConfig({
          agentId: agent.id,
          channelId: activeChannel.id,
          coreCommand: editingCoreCommand,
          modelProvider: editingModelProvider,
          modelName: editingModelName,
          runtimeBackend: editingRuntimeBackend
        }),
      cancelEditAgent
    );
  }

  async function addImageDrafts(files: File[], mode: "task" | "discussion") {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    const text = mode === "task" ? taskText.trim() : discussionText.trim();
    const currentCount = mode === "task" ? taskImageDrafts.length : discussionImageDrafts.length;
    const availableSlots = maxImageDraftCount - currentCount;
    if (availableSlots <= 0) {
      setError(`最多一次发送 ${maxImageDraftCount} 张图片。`);
      return;
    }
    try {
      const drafts = await Promise.all(images.slice(0, availableSlots).map(readImageDraft));
      if (!text && currentCount === 0 && !busy && activeWorkspace && activeChannel) {
        mutate(
          () =>
            teamApi.sendChannelMessage({
              workspaceId: activeWorkspace.id,
              channelId: activeChannel.id,
              mode,
              content: "",
              attachments: drafts.map(draftToUpload)
            }),
          undefined,
          { kind: `${mode}-direct-image-message`, label: "正在发送图片" }
        );
        if (images.length > availableSlots) setError(`最多一次发送 ${maxImageDraftCount} 张图片，已发送前 ${availableSlots} 张。`);
        return;
      }
      if (mode === "task") {
        setTaskImageDrafts((previous) => [...previous, ...drafts].slice(0, maxImageDraftCount));
      } else {
        setDiscussionImageDrafts((previous) => [...previous, ...drafts].slice(0, maxImageDraftCount));
      }
      if (images.length > availableSlots) setError(`最多一次发送 ${maxImageDraftCount} 张图片，已保留前 ${availableSlots} 张。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleImageInput(files: FileList | null, mode: "task" | "discussion") {
    if (!files) return;
    void addImageDrafts(Array.from(files), mode);
    const input = mode === "task" ? taskImageInputRef.current : discussionImageInputRef.current;
    if (input) input.value = "";
  }

  function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>, mode: "task" | "discussion") {
    const files = Array.from(event.clipboardData.files || []).filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    void addImageDrafts(files, mode);
  }

  function startTask(event: FormEvent) {
    event.preventDefault();
    const text = taskText.trim();
    const attachments = taskImageDrafts.map(draftToUpload);
    if (busy || !activeWorkspace || !activeChannel || (!text && !attachments.length)) return;
    if (isSlashCommand(text)) {
      if (attachments.length) {
        setError("命令不能附带图片，请先移除图片或改用普通任务发送。");
        return;
      }
      mutate(
        () =>
          teamApi.runSlashCommand({
            workspaceId: activeWorkspace.id,
            channelId: activeChannel.id,
            mode: "task",
            command: text,
            primaryAgentId: targetAgentId || null
          }),
        () => {
          setTaskText("");
          setTaskImageDrafts([]);
        },
        { kind: "task-command", label: "正在执行任务命令" }
      );
      return;
    }
    if (!text && attachments.length) {
      mutate(
        () =>
          teamApi.sendChannelMessage({
            workspaceId: activeWorkspace.id,
            channelId: activeChannel.id,
            mode: "task",
            content: "",
            attachments
          }),
        () => {
          setTaskText("");
          setTaskImageDrafts([]);
        },
        { kind: "task-image-message", label: "正在把图片发送到桌面端消息流" }
      );
      return;
    }
    if (!targetAgentId) return;
    mutate(
      () =>
        teamApi.startTaskRun({
          workspaceId: activeWorkspace.id,
          channelId: activeChannel.id,
          primaryAgentId: targetAgentId,
          objective: text,
          attachments
        }),
      () => {
        setTaskText("");
        setTaskImageDrafts([]);
      },
      { kind: "task-send", label: "正在发送任务给项目经理 Agent，随后由它判断是否需要临时 Agent" }
    );
  }

  function confirmTaskCleanup(taskRunId: string) {
    mutate(() => teamApi.confirmTaskCleanup({ taskRunId }));
  }

  function runSandboxQuickAction(taskRunId: string, action: SandboxQuickAction) {
    if (!taskRunId) return;
    if (action.destructive) {
      const confirmed = window.confirm(`${action.label} 会修改或删除本地沙箱现场，确认继续？`);
      if (!confirmed) return;
    }
    mutate(
      () => teamApi.runSandboxQuickAction({ taskRunId, action: action.id }),
      undefined,
      { kind: `sandbox-${action.id}`, label: `正在执行沙箱动作：${action.label}` }
    );
  }

  function toggleDiscussionAgent(agentId: string) {
    setDiscussionAgentIds((previous) =>
      previous.includes(agentId)
        ? previous.filter((item) => item !== agentId)
        : previous.length >= maxDiscussionParticipants
          ? previous
          : [...previous, agentId]
    );
  }

  function startDiscussion(event: FormEvent) {
    event.preventDefault();
    const text = discussionText.trim();
    const attachments = discussionImageDrafts.map(draftToUpload);
    if (busy || !activeWorkspace || !activeChannel || (!text && !attachments.length)) return;
    if (isSlashCommand(text)) {
      if (attachments.length) {
        setError("命令不能附带图片，请先移除图片或改用普通讨论发送。");
        return;
      }
      mutate(
        () =>
          teamApi.runSlashCommand({
            workspaceId: activeWorkspace.id,
            channelId: activeChannel.id,
            mode: "discussion",
            command: text,
            agentIds: discussionAgentIds
          }),
        () => {
          setDiscussionText("");
          setDiscussionImageDrafts([]);
        },
        { kind: "discussion-command", label: "正在执行讨论命令" }
      );
      return;
    }
    if (!text && attachments.length) {
      mutate(
        () =>
          teamApi.sendChannelMessage({
            workspaceId: activeWorkspace.id,
            channelId: activeChannel.id,
            mode: "discussion",
            content: "",
            attachments
          }),
        () => {
          setDiscussionText("");
          setDiscussionImageDrafts([]);
        },
        { kind: "discussion-image-message", label: "正在把图片发送到桌面端消息流" }
      );
      return;
    }
    if (activeDiscussion?.status === "needs_approval") {
      mutate(
        () => teamApi.respondDiscussion({ discussionId: activeDiscussion.id, content: text, attachments }),
        () => {
          setDiscussionText("");
          setDiscussionImageDrafts([]);
        },
        { kind: "discussion-reply", label: "正在把你的回复发送给讨论 Leader Agent" }
      );
      return;
    }
    mutate(
      () =>
        teamApi.startDiscussion({
          workspaceId: activeWorkspace.id,
          channelId: activeChannel.id,
          agentIds: discussionAgentIds,
          topic: text,
          discussionFramework,
          roundLimit: 1,
          attachments
        }),
      () => {
        setDiscussionText("");
        setDiscussionImageDrafts([]);
      },
      { kind: "discussion-send", label: "正在发送讨论主题给 Leader Agent，随后由它组织临时讨论 Agent" }
    );
  }

  function openSlashCommands(mode: "task" | "discussion") {
    if (mode === "task") {
      setTaskText((previous) => (isSlashCommand(previous) ? previous : "/"));
      window.setTimeout(() => taskTextAreaRef.current?.focus(), 0);
      return;
    }
    setDiscussionText((previous) => (isSlashCommand(previous) ? previous : "/"));
    window.setTimeout(() => discussionTextAreaRef.current?.focus(), 0);
  }

  function submitOnCommandReturn(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!event.metaKey || event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  function scrollMessagesToBottom() {
    const scroll = () => {
      const list = messageListRef.current;
      if (list) list.scrollTop = list.scrollHeight;
    };
    window.setTimeout(scroll, 0);
    window.setTimeout(scroll, 80);
  }

  function selectWorkMode(mode: "task" | "discussion") {
    setWorkMode(mode);
    scrollMessagesToBottom();
  }

  function openTaskDetail(taskId?: string) {
    setDetailTaskId(taskId || selectedTaskDetail?.id || state.taskRuns[0]?.id || "");
    setDetailView("task");
  }

  function openDiscussionDetail(discussionId?: string) {
    setDetailDiscussionId(
      discussionId || selectedDiscussionDetail?.id || activeDiscussion?.id || state.discussionRuns[0]?.id || ""
    );
    setDetailView("discussion");
  }

  function openAssetsDetail(assetId?: string) {
    setDetailAssetId(assetId || selectedContentAsset?.id || visibleContentAssets[0]?.id || "");
    setDetailView("assets");
  }

  function openMessageDetail(messageId: string) {
    setExpandedMessageId(messageId);
    setDetailView("message");
  }

  async function copyOutput(text: string, target: string) {
    const value = String(text || "");
    if (!value) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = value;
        textarea.setAttribute("readonly", "true");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      setCopiedTarget(target);
      window.setTimeout(() => {
        setCopiedTarget((current) => (current === target ? "" : current));
      }, 1400);
    } catch (err) {
      setError("复制失败，请展开后手动选择文本复制。");
    }
  }

  const workspaceCreationNeedsName = !hasWorkspace && Boolean(workspaceNameError);

  return (
    <div className={isMobileWebClient ? "app-shell mobile-client" : "app-shell"}>
      <header className="mission-topbar">
        <div className="mission-wordmark">
          <strong>HERMES</strong>
          <span>AGENT TEAM</span>
        </div>
        <div className="mission-nav" aria-hidden="true">
          <span>TASKS</span>
          <span>DISCUSSIONS</span>
          <span>BLACKBOARD</span>
          <span>RUNTIME</span>
          <span>SAFETY</span>
        </div>
        <div className="mission-live">
          <span>{state.hermesMode === "live" ? "LOCAL HERMES" : "MOCK MODE"}</span>
          <strong>{hasWorkspace ? activeWorkspace?.name || "ACTIVE" : "NO SPACE"}</strong>
        </div>
      </header>

      <aside className="workspace-rail">
        <div className="brand">
          <div className="brand-mark">
            <Bot size={22} />
          </div>
          <div>
            <strong>Hermes Team</strong>
            <span>{state.hermesMode === "live" ? "本地 Hermes" : "Mock"}</span>
          </div>
        </div>

        <div className="rail-section">
          <div className="section-title">
            <Building2 size={15} />
            <span>工作空间</span>
          </div>
          <div className="workspace-list">
            {state.workspaces.map((workspace) => (
              <button
                className={workspace.id === state.activeWorkspaceId ? "workspace active" : "workspace"}
                key={workspace.id}
                onClick={() => switchWorkspace(workspace.id)}
                type="button"
              >
                <span>{workspace.name}</span>
                <ChevronRight size={15} />
              </button>
            ))}
          </div>
          <form className="inline-form" onSubmit={createWorkspace}>
            <input
              aria-describedby={workspaceNameError ? "workspace-name-error" : undefined}
              aria-invalid={Boolean(workspaceNameError)}
              ref={workspaceNameInputRef}
              value={workspaceName}
              onChange={(event) => {
                const next = event.target.value;
                setWorkspaceName(next);
                if (next.trim()) setWorkspaceNameError(null);
              }}
              placeholder="输入工作空间名称"
            />
            <button aria-label="创建工作空间" disabled={busy} title="创建工作空间" type="submit">
              {operation?.kind === "create-workspace" ? <Activity className="spin" size={17} /> : <Plus size={17} />}
            </button>
          </form>
          {workspaceNameError && (
            <div className="field-error" id="workspace-name-error">
              <AlertTriangle size={14} />
              <span>{workspaceNameError}</span>
            </div>
          )}
          {operation?.kind === "create-workspace" && (
            <div className="inline-progress">
              <Activity className="spin" size={14} />
              <span>{operation.label}</span>
            </div>
          )}
          {activeWorkspace && (
            <div className="active-space-card">
              <div>
                <span>当前空间</span>
                <strong>{activeWorkspace.name}</strong>
              </div>
              <button
                aria-label="删除工作空间"
                className="icon-danger"
                disabled={busy}
                onClick={() => mutate(() => teamApi.deleteWorkspace({ workspaceId: activeWorkspace.id }))}
                title="删除工作空间"
                type="button"
              >
                <Trash2 size={16} />
              </button>
            </div>
          )}
          <div className="status-block">
            <div>
              <ShieldCheck size={16} />
              <span>权限审计</span>
            </div>
            <strong>{state.audits.length}</strong>
          </div>
	          <div className="path-block" title={state.hermesPath}>
	            <span>Hermes</span>
	            <strong>{state.hermesPath.includes("/") ? "已定位" : "使用 PATH"}</strong>
	          </div>
          {!isMobileWebClient && (
            <div className={`mobile-access-card ${state.mobileServer.enabled ? "enabled" : "disabled"}`} title={state.mobileServer.url || state.mobileServer.warning}>
              <div className="mobile-access-head">
                <span>
                  <Smartphone size={15} />
                  手机端
                </span>
                <strong>{state.mobileServer.enabled ? "已开启" : "未启动"}</strong>
              </div>
              {state.mobileServer.url ? <code>{state.mobileServer.url}</code> : <p>{state.mobileServer.warning || "等待本机服务启动"}</p>}
              <button
                disabled={!state.mobileServer.url}
                onClick={() => copyOutput(state.mobileServer.url, "mobile-url")}
                type="button"
              >
                {copiedTarget === "mobile-url" ? <Check size={13} /> : <Copy size={13} />}
                {copiedTarget === "mobile-url" ? "已复制" : "复制链接"}
              </button>
              {state.mobileServer.warning ? <p>{state.mobileServer.warning}</p> : null}
            </div>
          )}
	          <div className={`data-health-card ${state.dataHealth.status}`} title={state.dataHealth.last_report_path || state.dataHealth.db_path}>
	            <div>
	              <span>数据健康</span>
	              <strong>{state.dataHealth.status === "ok" ? "正常" : `${state.dataHealth.issue_count} 个风险`}</strong>
	            </div>
	            <p>{dataHealthSummary(state)}</p>
	            <p>
	              备份 {state.dataHealth.counts.backup_files}/{dataRepairControl.backup_retention_count} ·{" "}
	              {dataRepairCoolingDown ? dataRepairCooldownLabel : dataRepairControl.in_flight ? "修复中" : "可修复"}
	            </p>
	            {state.dataHealth.last_report_path ? <code>{state.dataHealth.last_report_path}</code> : null}
	            <div className="data-health-actions">
	              <button disabled={busy} onClick={refreshDataHealth} type="button">
	                检查
	              </button>
	              <button
	                disabled={databaseRepairLocked || !hasDbRepairRisk}
	                onClick={() => repairDataHealth("database")}
	                title={dataRepairCooldownLabel || dataRepairControl.backup_dir}
	                type="button"
	              >
	                修复DB
	              </button>
		              <button
		                className="danger"
		                disabled={dataRepairLocked || !hasProfileRepairRisk}
		                onClick={() => repairDataHealth("profiles")}
		                type="button"
		              >
		                修复profile
		              </button>
		              <button
		                disabled={(hasDbRepairRisk ? databaseRepairLocked : dataRepairLocked) || !state.dataHealth.can_repair}
		                onClick={() => repairDataHealth("all")}
		                title={dataRepairCooldownLabel || "自动执行 DB 修复、缺失 profile 重建、孤儿 profile 归档和健康刷新"}
		                type="button"
		              >
	                全部修复
	              </button>
	              <button disabled={busy} onClick={() => openDataGovernancePath("profile_archive")} type="button">
	                打开归档
	              </button>
	            </div>
	          </div>
	        </div>
	      </aside>

      <main className="chat-pane">
        <header className="chat-head">
          <div>
            <span>{hasWorkspace ? "当前空间" : "未创建空间"}</span>
            <h1>{activeWorkspace?.name || "暂无工作空间"}</h1>
          </div>
        </header>

        {hasWorkspace && (
        <div className="chat-toolbar">
          <div className="view-tabs" role="tablist">
            <button
              className={workMode === "task" ? "active" : ""}
              onClick={() => selectWorkMode("task")}
              type="button"
            >
              <ClipboardList size={15} />
              任务执行
            </button>
            <button
              className={workMode === "discussion" ? "active" : ""}
              onClick={() => selectWorkMode("discussion")}
              type="button"
            >
              <MessageSquare size={15} />
              多方讨论
            </button>
          </div>
          <div className="head-metrics">
            <span>
              <Users size={15} />
              {visibleAgents.length} {workMode === "discussion" ? "讨论 Agent" : "任务 Agent"}
            </span>
            <span>
              <Radio size={15} />
              {workMode === "discussion" ? `${discussionLeadAgents.length} Leader` : `${primaryAgents.length} 主 Agent`}
            </span>
            <span className={runningAgents.length ? "running" : ""}>
              <Activity size={15} />
              {runningAgents.length} 运行中
            </span>
            <span className={staleRuntimeLocks.length ? "failed" : suspectRuntimeLocks.length ? "warn" : activeRuntimeLocks.length ? "running" : ""}>
              <ShieldCheck size={15} />
              {activeRuntimeLocks.length} 锁{suspectRuntimeLocks.length ? ` / ${suspectRuntimeLocks.length} suspect` : ""}{staleRuntimeLocks.length ? ` / ${staleRuntimeLocks.length} stale` : ""}
            </span>
            <span className={failedAgents.length ? "failed" : ""}>
              <AlertTriangle size={15} />
              {failedAgents.length} 失败
            </span>
          </div>
        </div>
        )}

        {error && <div className="error-strip">{error}</div>}
        {operation && operation.kind !== "create-workspace" && (
          <div className="busy-strip">
            <Activity className="spin" size={15} />
            <span>{operation.label}</span>
          </div>
        )}

        <section className="message-list" ref={messageListRef}>
          {visibleMessages.length === 0 ? (
            <div className="empty-panel">
              {operation?.kind === "create-workspace" ? (
                <Activity className="spin" size={28} />
              ) : workspaceCreationNeedsName ? (
                <AlertTriangle size={28} />
              ) : (
                <MessageSquare size={28} />
              )}
              <strong>
                {hasWorkspace
                  ? "暂无消息"
                  : operation?.kind === "create-workspace"
                    ? "正在创建工作空间"
                    : workspaceCreationNeedsName
                      ? "需要填写工作空间名称"
                      : "请先创建工作空间"}
              </strong>
              {!hasWorkspace && (
                <span>
                  {operation?.kind === "create-workspace"
                    ? operation.label
                    : workspaceNameError
                      ? "在左侧输入工作空间名称后，再点击 + 创建。"
                    : "创建空间后，任务项目经理 Agent 和讨论 Leader Agent 会自动生成。"}
                </span>
              )}
            </div>
          ) : (
            visibleMessages.map((item) => {
              const displayContent = stripAttachmentContext(item.content);
              const longContent = isLongContent(displayContent);
              const messageCopyTarget = `message:${item.id}`;
              const messageCopied = copiedTarget === messageCopyTarget;
              const senderAgent = item.sender_id ? agentById.get(item.sender_id) : null;
              const isAgentMessage = item.sender_type === "agent" && Boolean(item.sender_id);
              const isTemporaryAgentMessage = Boolean(senderAgent?.is_temporary);
              const isSecondaryAgentMessage =
                isAgentMessage && (!mainMessageAgentIds.has(item.sender_id || "") || isTemporaryAgentMessage);
              const isPrimaryAgentMessage = isAgentMessage && !isSecondaryAgentMessage;
              if (isSecondaryAgentMessage) {
                return (
                  <details
                    className={[
                      "message",
                      "agent",
                      "secondary-agent-message",
                      item.status === "blocked" ? "blocked" : "",
                      longContent ? "long-message" : ""
                    ].join(" ")}
                    key={item.id}
                  >
                    <summary className="secondary-agent-summary">
                      <div className="message-meta">
                        <strong>{item.sender_name}</strong>
                        <span>{isTemporaryAgentMessage ? "临时 Agent" : "副 Agent"}</span>
                        <span>{modeLabel(item.mode)}</span>
                        <time>{formatTime(item.created_at)}</time>
                      </div>
                      <p>{compactMessagePreview(displayContent)}</p>
                    </summary>
                    <div className="message-body secondary-agent-body">
                      <p>{renderMessageContent(displayContent, mentionNames)}</p>
                      <MessageAttachmentGrid attachments={item.attachments} onOpenImage={setImagePreviewAttachment} />
                      <div className="message-actions">
                        <button
                          aria-label={`${messageCopied ? "已复制" : "复制"} ${item.sender_name} 的输出`}
                          className="message-copy"
                          onClick={() => copyOutput(displayContent, messageCopyTarget)}
                          title="复制这条输出"
                          type="button"
                        >
                          {messageCopied ? <Check size={14} /> : <Copy size={14} />}
                          {messageCopied ? "已复制" : "复制"}
                        </button>
                        {longContent && (
                          <button
                            className="message-expand"
                            onClick={() => openMessageDetail(item.id)}
                            title="放大查看完整输出"
                            type="button"
                          >
                            <FileText size={14} />
                            展开全文
                          </button>
                        )}
                      </div>
                    </div>
                  </details>
                );
              }
              if (isPrimaryAgentMessage) {
                const focusedContent = focusMessageContent(displayContent);
                const conclusionCopyTarget = `message-conclusion:${item.id}`;
                const conclusionCopied = copiedTarget === conclusionCopyTarget;
                return (
                  <article
                    className={[
                      "message",
                      "agent",
                      "primary-agent-message",
                      item.status === "blocked" ? "blocked" : "",
                      focusedContent.process ? "has-process" : ""
                    ].join(" ")}
                    key={item.id}
                  >
                    <div className="message-meta">
                      <strong>{item.sender_name}</strong>
                      <span>主 Agent</span>
                      <span>{modeLabel(item.mode)}</span>
                      <time>{formatTime(item.created_at)}</time>
                    </div>
                    <div className="message-body">
                      <p className={focusedContent.hasConclusion ? "message-conclusion" : "message-conclusion muted"}>
                        {renderMessageContent(focusedContent.conclusion, mentionNames)}
                      </p>
                      <MessageAttachmentGrid attachments={item.attachments} onOpenImage={setImagePreviewAttachment} />
                      {focusedContent.process && (
                        <details className="primary-agent-process">
                          <summary>
                            <FileText size={14} />
                            查看非结论内容
                          </summary>
                          <p>{renderMessageContent(focusedContent.process, mentionNames)}</p>
                        </details>
                      )}
                      <div className="message-actions">
                        {focusedContent.hasConclusion && (
                          <button
                            aria-label={`${conclusionCopied ? "已复制" : "复制"} ${item.sender_name} 的结论`}
                            className="message-copy"
                            onClick={() => copyOutput(focusedContent.conclusion, conclusionCopyTarget)}
                            title="复制默认展示的结论"
                            type="button"
                          >
                            {conclusionCopied ? <Check size={14} /> : <Copy size={14} />}
                            {conclusionCopied ? "已复制" : "复制结论"}
                          </button>
                        )}
                        {(focusedContent.process || longContent) && (
                          <button
                            className="message-expand"
                            onClick={() => openMessageDetail(item.id)}
                            title="放大查看完整输出"
                            type="button"
                          >
                            <FileText size={14} />
                            完整输出
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                );
              }
              return (
                <article
                  className={[
                    "message",
                    item.sender_type,
                    item.status === "blocked" ? "blocked" : "",
                    item.mode === "system" ? "system-message" : "",
                    longContent ? "long-message" : ""
                  ].join(" ")}
                  key={item.id}
                >
                  <div className="message-meta">
                    <strong>{item.sender_name}</strong>
                    <span>{modeLabel(item.mode)}</span>
                    <time>{formatTime(item.created_at)}</time>
                  </div>
                  <div className="message-body">
                    <p>{renderMessageContent(displayContent, mentionNames)}</p>
                    <MessageAttachmentGrid attachments={item.attachments} onOpenImage={setImagePreviewAttachment} />
                    <div className="message-actions">
                      <button
                        aria-label={`${messageCopied ? "已复制" : "复制"} ${item.sender_name} 的输出`}
                        className="message-copy"
                        onClick={() => copyOutput(displayContent, messageCopyTarget)}
                        title="复制这条输出"
                        type="button"
                      >
                        {messageCopied ? <Check size={14} /> : <Copy size={14} />}
                        {messageCopied ? "已复制" : "复制"}
                      </button>
                      {longContent && (
                        <button
                          className="message-expand"
                          onClick={() => openMessageDetail(item.id)}
                          title="放大查看完整输出"
                          type="button"
                        >
                          <FileText size={14} />
                          展开全文
                        </button>
                      )}
                    </div>
                  </div>
                </article>
              );
            })
          )}
        </section>

        {hasWorkspace && (workMode === "task" ? (
          <form className="composer" onSubmit={startTask}>
            <div className="workflow-bar">
              <select value={targetAgentId} onChange={(event) => setTargetAgentId(event.target.value)}>
                <option value="">选择主 Agent</option>
                {primaryAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name} · {agent.role}
                  </option>
                ))}
              </select>
              {pendingCleanupTask && (
                <button
                  className="confirm-cleanup"
                  disabled={busy}
                  onClick={() => confirmTaskCleanup(pendingCleanupTask.id)}
                  type="button"
                >
                  <Check size={16} />
                  确认完成并清理临时 Agent
                </button>
              )}
              {state.taskRuns.length > 0 && (
                <button className="detail-action" onClick={() => openTaskDetail()} type="button">
                  <FileText size={15} />
                  任务详情
                </button>
              )}
            </div>
            {state.taskRuns.length > 0 && (
              <div className="run-strip">
                {state.taskRuns.slice(0, 3).map((task) => (
                  <button
                    className={`run-pill ${task.status}`}
                    key={task.id}
                    onClick={() => openTaskDetail(task.id)}
                    title={task.objective}
                    type="button"
                  >
                    <strong>
	                      {task.status === "running"
	                        ? "运行中"
	                        : task.status === "waiting_discussion"
	                          ? "等讨论"
	                        : task.status === "cleaned"
                          ? "已清理"
                          : task.status === "failed"
                            ? "失败"
                            : task.status === "stopped"
                              ? "已停止"
                            : "待确认"}
                    </strong>
                    <span>{task.temporary_agent_count} 临时 Agent</span>
                  </button>
                ))}
              </div>
            )}
            <CommandPalette value={taskText} onPick={setTaskText} />
            <input
              accept="image/*"
              hidden
              multiple
              onChange={(event) => handleImageInput(event.currentTarget.files, "task")}
              ref={taskImageInputRef}
              type="file"
            />
            <DraftAttachmentTray
              attachments={taskImageDrafts}
              onRemove={(id) => setTaskImageDrafts((previous) => previous.filter((item) => item.id !== id))}
            />
            <div className="composer-row">
              <button
                aria-label="打开常用命令"
                className="command-trigger"
                onClick={() => openSlashCommands("task")}
                title="打开常用命令"
                type="button"
              >
                /
              </button>
              <button
                aria-label="添加任务图片"
                className="attachment-trigger"
                disabled={busy || taskImageDrafts.length >= maxImageDraftCount}
                onClick={() => taskImageInputRef.current?.click()}
                title="添加图片"
                type="button"
              >
                <ImageIcon size={18} />
              </button>
              <textarea
                ref={taskTextAreaRef}
                value={taskText}
                onChange={(event) => setTaskText(event.target.value)}
                onKeyDown={submitOnCommandReturn}
                onPaste={(event) => handleComposerPaste(event, "task")}
                placeholder="描述要完成的具体任务"
                title="Command + Return 发送"
              />
              <button
                aria-label="启动任务"
                disabled={
                  busy ||
                  !activeWorkspace ||
                  !activeChannel ||
                  (!taskIsSlashCommand && !targetAgentId) ||
                  (!taskText.trim() && taskImageDrafts.length === 0)
                }
                title="启动任务"
                type="submit"
              >
                {busy ? <Activity className="spin" size={18} /> : <Send size={18} />}
              </button>
            </div>
          </form>
        ) : (
          <form className="composer discussion-composer" onSubmit={startDiscussion}>
            <div className="framework-picker">
              <select
                aria-label="选择讨论框架"
                disabled={busy || Boolean(activeDiscussion && activeDiscussion.status !== "closed")}
                value={discussionFrameworkValue}
                onChange={(event) => setDiscussionFramework(event.target.value)}
              >
                {discussionFrameworks.map((framework) => (
                  <option key={framework.id} value={framework.id}>
                    {framework.name}
                  </option>
                ))}
              </select>
              <span title={selectedDiscussionFramework.description}>{selectedDiscussionFramework.description}</span>
            </div>
            <div className="discussion-agents">
              {selectableDiscussionAgents.length > 0 && (
                <span className="participant-limit">
                  {discussionAgentIds.length}/{maxDiscussionParticipants} 观点 Agent
                </span>
              )}
              {selectableDiscussionAgents.map((agent) => (
                <button
                  className={discussionAgentIds.includes(agent.id) ? "participant active" : "participant"}
                  disabled={!discussionAgentIds.includes(agent.id) && discussionAgentIds.length >= maxDiscussionParticipants}
                  key={agent.id}
                  onClick={() => toggleDiscussionAgent(agent.id)}
                  title={
                    !discussionAgentIds.includes(agent.id) && discussionAgentIds.length >= maxDiscussionParticipants
                      ? `最多选择 ${maxDiscussionParticipants} 个观点 Agent`
                      : agent.name
                  }
                  type="button"
                >
                  <Bot size={14} />
                  <span>{agent.name}</span>
                </button>
              ))}
            </div>
            {activeDiscussion && (
              <div className="discussion-strip">
                <div>
	                  <strong>{activeDiscussion.status === "needs_approval" ? "等待你的回复" : activeDiscussion.status === "closed" ? "已关闭" : "组织中"}</strong>
	                  <span>{activeDiscussionRoundText} · {activeDiscussionAgents.map((agent) => `${agent.agent_name} ${agent.rounds_used}/${agent.round_limit}`).join(" · ")}</span>
	                </div>
                <button onClick={() => openDiscussionDetail(activeDiscussion.id)} type="button">
                  <FileText size={15} />
                  讨论详情
                </button>
              </div>
            )}
            {!activeDiscussion && state.discussionRuns.length > 0 && (
              <div className="detail-actions-row">
                <button className="detail-action" onClick={() => openDiscussionDetail()} type="button">
                  <FileText size={15} />
                  讨论详情
                </button>
              </div>
            )}
            <CommandPalette value={discussionText} onPick={setDiscussionText} />
            <input
              accept="image/*"
              hidden
              multiple
              onChange={(event) => handleImageInput(event.currentTarget.files, "discussion")}
              ref={discussionImageInputRef}
              type="file"
            />
            <DraftAttachmentTray
              attachments={discussionImageDrafts}
              onRemove={(id) => setDiscussionImageDrafts((previous) => previous.filter((item) => item.id !== id))}
            />
            <div className="composer-row">
              <button
                aria-label="打开常用命令"
                className="command-trigger"
                onClick={() => openSlashCommands("discussion")}
                title="打开常用命令"
                type="button"
              >
                /
              </button>
              <button
                aria-label="添加讨论图片"
                className="attachment-trigger"
                disabled={busy || discussionImageDrafts.length >= maxImageDraftCount}
                onClick={() => discussionImageInputRef.current?.click()}
                title="添加图片"
                type="button"
              >
                <ImageIcon size={18} />
              </button>
              <textarea
                ref={discussionTextAreaRef}
                value={discussionText}
                onChange={(event) => setDiscussionText(event.target.value)}
                onKeyDown={submitOnCommandReturn}
                onPaste={(event) => handleComposerPaste(event, "discussion")}
                placeholder={activeDiscussion?.status === "needs_approval" ? "回复讨论 Leader Agent" : "输入讨论主题或新的讨论背景"}
                title="Command + Return 发送"
              />
              <button
                aria-label="发起讨论"
                disabled={
                  busy ||
                  !activeWorkspace ||
                  !activeChannel ||
                  (!discussionText.trim() && discussionImageDrafts.length === 0)
                }
                title="发起讨论"
                type="submit"
              >
                {busy ? <Activity className="spin" size={18} /> : <Send size={18} />}
              </button>
            </div>
          </form>
        ))}
      </main>

      <aside className="agent-pane">
        <section className="panel-section">
          <div className="section-title">
            <Bot size={15} />
            <span>{hasWorkspace ? (workMode === "discussion" ? "讨论 Agent" : "任务 Agent") : "Agent"}</span>
          </div>
          {hasWorkspace ? (
            <>
              <div className="auto-agent-note">
                <Bot size={17} />
                <span>{workMode === "discussion" ? "空间自带讨论 Leader" : "空间自带项目经理"}</span>
              </div>

              <div className="agent-list">
            {visibleAgents.map((agent) => {
              const status = agentStatusMeta(agent.status);
              const startedAt = formatRuntimeTime(agent.last_started_at);
              const finishedAt = formatRuntimeTime(agent.last_finished_at || agent.last_reply_at);
              const isEditing = editingAgentId === agent.id;
              const backend = agentBackend(agent);
              const hasCustomConfig = Boolean(agent.core_command || agent.model_name || agent.model_provider || backend !== "hermes");
              const savedModelLabel = modelRouteLabel(agent.model_provider || "", agent.model_name || "");
              const modelSelectValue = modelOptionValue(editingModelProvider, editingModelName);
              const modelOptionKnown =
                !modelSelectValue ||
                state.hermesModelState.options.some(
                  (option) => modelOptionValue(option.provider, option.model) === modelSelectValue
                );
              return (
                <div className="agent-item" key={agent.id} style={{ marginLeft: agentDepth(agent, visibleAgents) * 14 }}>
                  <div className="agent-main-row">
                    <div className="agent-main">
                      <div className={agent.parent_agent_id ? "agent-avatar child" : "agent-avatar"}>
                        <Bot size={16} />
                      </div>
                      <div>
                        <strong>{agent.name}</strong>
                        <span>{agent.role}</span>
                      </div>
                    </div>
                    <div className="agent-badges">
                      <span className={`agent-status kind-${agent.agent_kind}`}>
                        {agent.agent_kind === "discussion" ? "讨论" : "任务"}
                      </span>
                      {agent.is_temporary ? <span className="agent-status temporary">临时</span> : null}
                      <span className={`agent-status backend-${backend}`}>{agentBackendLabel(agent)}</span>
                      <span className={`agent-status ${status.className}`}>{status.label}</span>
                    </div>
                  </div>
                  {agent.status === "running" && (
                    <div className="agent-runtime running">
                      <strong>当前任务</strong>
                      <p title={agent.current_task}>{agent.current_task || "处理中"}</p>
                      {startedAt && <time>开始 {startedAt}</time>}
                    </div>
                  )}
                  {agent.status === "failed" && (
                    <div className="agent-runtime failed">
                      <strong>最近失败</strong>
                      <p title={agent.last_error}>{agent.last_error || `${agentBackendLabel(agent)} 执行失败`}</p>
                      {finishedAt && <time>结束 {finishedAt}</time>}
                    </div>
                  )}
                  {agent.status !== "running" && agent.status !== "failed" && finishedAt && (
                    <div className="agent-runtime ready">
                      <strong>最近完成</strong>
                      <time>{finishedAt}</time>
                    </div>
                  )}
                  {isEditing ? (
                    <div className="agent-edit-form">
                      <select
                        aria-label={`${agent.name} 底层后端`}
                        value={editingRuntimeBackend}
                        onChange={(event) => setEditingRuntimeBackend(event.target.value === "codex" ? "codex" : "hermes")}
                      >
                        <option value="hermes">Hermes</option>
                        <option value="codex">Codex</option>
                      </select>
                      <textarea
                        aria-label={`${agent.name} 底层要求 AGENTS.md`}
                        value={editingCoreCommand}
                        onChange={(event) => setEditingCoreCommand(event.target.value)}
                        placeholder="底层要求 / AGENTS.md"
                      />
                      {editingRuntimeBackend === "codex" ? (
                        <>
                          <input
                            aria-label={`${agent.name} Codex provider`}
                            value={editingModelProvider}
                            onChange={(event) => setEditingModelProvider(event.target.value)}
                            placeholder="Codex provider，可空"
                          />
                          <input
                            aria-label={`${agent.name} Codex model`}
                            value={editingModelName}
                            onChange={(event) => setEditingModelName(event.target.value)}
                            placeholder="Codex model，可空"
                          />
                          <small className="agent-model-source">Codex 模型可留空，跟随本机 Codex 默认配置。</small>
                        </>
                      ) : (
                        <>
                          <select
                            aria-label={`${agent.name} 模型`}
                            value={modelSelectValue}
                            onChange={(event) => {
                              const next = parseModelOptionValue(event.target.value);
                              setEditingModelProvider(next.provider);
                              setEditingModelName(next.model);
                            }}
                          >
                            <option value="">{hermesDefaultModelText(state)}</option>
                            {editingModelName && !modelOptionKnown ? (
                              <option value={modelSelectValue}>{modelRouteLabel(editingModelProvider, editingModelName)}（当前保存）</option>
                            ) : null}
                            {state.hermesModelState.options.map((option) => (
                              <option key={`${option.provider}:${option.model}`} value={modelOptionValue(option.provider, option.model)}>
                                {option.label}
                                {option.isDefault ? "（Hermes 默认）" : ""}
                              </option>
                            ))}
                          </select>
                          {state.hermesModelState.warning ? (
                            <small className="agent-model-warning">{state.hermesModelState.warning}</small>
                          ) : (
                            <small className="agent-model-source">模型列表来自 Hermes config 和 provider cache。</small>
                          )}
                        </>
                      )}
                      <div className="agent-edit-actions">
                        <button disabled={busy || !activeChannel} onClick={() => saveAgentConfig(agent)} type="button">
                          <Check size={14} />
                          保存
                        </button>
                        <button disabled={busy} onClick={cancelEditAgent} type="button">
                          <X size={14} />
                          取消
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className={hasCustomConfig ? "agent-config" : "agent-config empty"}>
                      <p>后端：{agentBackendLabel(agent)}</p>
                      {agent.core_command ? <p title={agent.core_command}>底层：{agent.core_command}</p> : null}
                      <p title={savedModelLabel || (backend === "hermes" ? hermesDefaultModelText(state) : "跟随 Codex 默认")}>
                        模型：{savedModelLabel || (backend === "hermes" ? hermesDefaultModelText(state) : "跟随 Codex 默认")}
                      </p>
                    </div>
                  )}
                  <div className="agent-actions">
                    <button
                      aria-label={`编辑 ${agent.name} 的底层命令和模型`}
                      className="chip"
                      disabled={busy}
                      onClick={() => beginEditAgent(agent)}
                      title="编辑底层命令和模型"
                      type="button"
                    >
                      <Pencil size={13} />
                      编辑
                    </button>
                    <button
                      className={agent.in_active_channel ? "chip active" : "chip"}
                      disabled={busy || !activeChannel}
                      onClick={() =>
                        activeChannel &&
                        mutate(() =>
                          teamApi.setAgentChannel({
                            agentId: agent.id,
                            channelId: activeChannel.id,
                            enabled: !agent.in_active_channel
                          })
                        )
                      }
                      type="button"
                    >
                      {agent.in_active_channel ? "空间内" : "未加入"}
                    </button>
                    {Number(agent.is_primary) !== 1 && (
                      <button
                        aria-label="删除 Agent"
                        className="icon-danger"
                        disabled={busy || !activeWorkspace || !activeChannel}
                        onClick={() =>
                          activeWorkspace &&
                          activeChannel &&
                          mutate(() =>
                            teamApi.deleteAgent({
                              workspaceId: activeWorkspace.id,
                              channelId: activeChannel.id,
                              agentId: agent.id
                            })
                          )
                        }
                        title="删除 Agent"
                        type="button"
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </div>
                  <code>{backend === "hermes" ? `Hermes profile: ${agent.hermes_profile}` : `Codex runtime: ${agent.hermes_profile}`}</code>
                </div>
              );
            })}
              </div>
            </>
          ) : (
            <div className="empty-panel side-empty">
              <Bot size={24} />
              <strong>暂无 Agent</strong>
              <span>创建工作空间后，系统才会创建任务项目经理和讨论 Leader。</span>
            </div>
          )}
        </section>

        <section className="panel-section collab-panel">
          <div className="section-title">
            <ClipboardList size={15} />
            <span>协作状态</span>
          </div>
          {hasWorkspace ? (
            <>
          <div className="state-export" title={state.teamStatePath || "尚未导出"}>
            <span>team_state.json</span>
            <strong>{state.teamStatePath ? "已导出" : "未生成"}</strong>
          </div>
	          <div className="state-export" title={state.contentArchivePath || "尚未导出"}>
	            <span>content_archive.json</span>
	            <strong>{state.contentArchivePath ? "已沉淀" : "未生成"}</strong>
	          </div>
          <div className="state-group runtime-locks">
            <div className="state-group-title">
              <strong>Runtime Locks</strong>
              <span className={staleRuntimeLocks.length || suspectRuntimeLocks.length ? "warn" : ""}>
                {activeRuntimeLocks.length} / {suspectRuntimeLocks.length} / {staleRuntimeLocks.length}
              </span>
            </div>
            <div className="state-list">
              {recentRuntimeLocks.length === 0 ? (
                <p className="state-empty">暂无运行锁</p>
              ) : (
                recentRuntimeLocks.map((lock) => (
                  <article className={`state-item lock ${lock.status}`} key={lock.id}>
                    <div>
                      <strong>{lock.resource}</strong>
                      <span>{lockStatusLabel(lock.status)}</span>
                    </div>
                    <p>{lockOwnerLabel(lock)} · {lock.reason || lock.session_id}</p>
                    <time>
                      心跳 {formatTime(lock.heartbeat_at)} · 到期 {formatTime(lock.expires_at)}
                    </time>
                  </article>
                ))
              )}
            </div>
          </div>
	          <div className="state-group">
            <div className="state-group-title">
              <strong>Blackboard</strong>
              <span>{visibleBlackboardEntries.length}</span>
            </div>
            <div className="state-list">
              {visibleBlackboardEntries.length === 0 ? (
                <p className="state-empty">暂无共享状态</p>
              ) : (
                visibleBlackboardEntries.slice(0, 4).map((item) => (
                  <article className="state-item" key={item.id}>
                    <div>
                      <strong>{item.key}</strong>
                      <span>{item.scope}</span>
                    </div>
                    <p>{compactStateText(item.value)}</p>
                    <time>{formatTime(item.updated_at)}</time>
                  </article>
                ))
              )}
            </div>
          </div>
          <div className="state-group">
            <div className="state-group-title">
              <strong>Content Assets</strong>
              <div className="state-title-actions">
                <button disabled={visibleContentAssets.length === 0} onClick={() => openAssetsDetail()} type="button">
                  详情
                </button>
                <span>{visibleContentAssets.length}</span>
              </div>
            </div>
            <div className="state-list">
              {recentContentAssets.length === 0 ? (
                <p className="state-empty">暂无内容资产</p>
              ) : (
                recentContentAssets.map((item) => (
                  <button
                    className="state-item state-item-button"
                    key={item.id}
                    onClick={() => openAssetsDetail(item.id)}
                    type="button"
                  >
                    <div>
                      <strong>{item.title}</strong>
                      <span>{item.asset_type}</span>
                    </div>
                    <p>{compactStateText(item.summary || item.content)}</p>
                    <time>
                      {item.created_by_agent_name ? `${item.created_by_agent_name} · ` : ""}
                      {formatTime(item.created_at)}
                    </time>
                  </button>
                ))
              )}
            </div>
          </div>
          {workMode === "task" ? (
            <div className="state-group">
              <div className="state-group-title">
                <strong>Evidence Pack</strong>
                <span>{recentEvidenceItems.length}</span>
              </div>
              <div className="state-list">
                {recentEvidenceItems.length === 0 ? (
                  <p className="state-empty">暂无任务证据</p>
                ) : (
                  recentEvidenceItems.map((item) => (
                    <article className="state-item" key={item.id}>
                      <div>
                        <strong>{item.title}</strong>
                        <span>{item.kind}</span>
                      </div>
                      <p>{item.content}</p>
                      <time>
                        {item.agent_name ? `${item.agent_name} · ` : ""}
                        {formatTime(item.created_at)}
                      </time>
                    </article>
                  ))
                )}
              </div>
            </div>
          ) : (
            <div className="state-group">
              <div className="state-group-title">
                <strong>Decision Record</strong>
                <span>{recentDecisionRecords.length}</span>
              </div>
              <div className="state-list">
                {recentDecisionRecords.length === 0 ? (
                  <p className="state-empty">暂无讨论决策</p>
                ) : (
                  recentDecisionRecords.map((item) => (
                    <article className="state-item decision" key={item.id}>
                      <div>
                        <strong>{decisionLabel(item.status)}</strong>
                        <span>{item.framework}</span>
                      </div>
                      <p>{item.summary || item.decision}</p>
                      <time>
                        {item.agent_name ? `${item.agent_name} · ` : ""}
                        {formatTime(item.created_at)}
                      </time>
                    </article>
                  ))
                )}
              </div>
            </div>
          )}
            </>
          ) : (
            <div className="empty-panel side-empty">
              <ClipboardList size={24} />
              <strong>暂无协作状态</strong>
              <span>创建工作空间后才会生成 team_state、内容资产和审计记录。</span>
            </div>
          )}
        </section>

        {hasWorkspace && (
        <section className="panel-section audit-panel">
          <div className="section-title">
            <ShieldCheck size={15} />
            <span>审计</span>
          </div>
          <div className="audit-list">
            {visibleAudits.map((audit) => (
              <article className="audit-item" key={audit.id}>
                <div>
                  <strong>{audit.action}</strong>
                  <span className={audit.result}>{audit.result}</span>
                </div>
                <p>{audit.detail}</p>
                <time>{formatTime(audit.created_at)}</time>
              </article>
            ))}
          </div>
        </section>
        )}
      </aside>

      {detailView === "task" && (
        <DetailOverlay title="任务详情" subtitle={activeWorkspace?.name || "工作空间"} onClose={() => setDetailView(null)}>
          {!selectedTaskDetail ? (
            <DetailEmpty text="暂无任务记录" />
          ) : (
            <div className="detail-grid">
              <div className="detail-switcher" aria-label="任务记录">
                {state.taskRuns.slice(0, 12).map((task) => (
                  <button
                    className={task.id === selectedTaskDetail.id ? "active" : ""}
                    key={task.id}
                    onClick={() => setDetailTaskId(task.id)}
                    type="button"
                  >
                    <strong>{taskStatusLabel(task.status)}</strong>
                    <span>{compactStateText(task.objective, 74)}</span>
                    <time>{formatDateTime(task.created_at)}</time>
                  </button>
                ))}
              </div>

              <div className="detail-content">
                <section className="detail-card">
                  <div className="detail-card-head">
                    <strong>任务需求</strong>
                    <span className={`detail-badge ${selectedTaskDetail.status}`}>
                      {taskStatusLabel(selectedTaskDetail.status)}
                    </span>
                  </div>
                  <p className="detail-main-text">{selectedTaskDetail.objective}</p>
                  <dl className="detail-facts">
                    <div>
                      <dt>项目经理</dt>
                      <dd>{agentById.get(selectedTaskDetail.primary_agent_id)?.name || "主 Agent"}</dd>
                    </div>
                    <div>
                      <dt>临时 Agent</dt>
                      <dd>{selectedTaskDetail.temporary_agent_count}</dd>
                    </div>
                    <div>
                      <dt>创建时间</dt>
                      <dd>{formatDateTime(selectedTaskDetail.created_at) || "-"}</dd>
                    </div>
                    <div>
                      <dt>完成时间</dt>
                      <dd>{formatDateTime(selectedTaskDetail.completed_at) || "未完成"}</dd>
                    </div>
                  </dl>
                </section>

                <section className="detail-card">
                  <div className="detail-card-head">
                    <strong>最终输出</strong>
                  </div>
                  {selectedTaskDetail.final_output ? (
                    <pre className="detail-pre">{selectedTaskDetail.final_output}</pre>
                  ) : (
                    <DetailEmpty text="还没有最终输出" />
                  )}
                </section>

                <div className="detail-subgrid">
                  <section className="detail-card">
                    <div className="detail-card-head">
                      <strong>临时 Agent</strong>
                      <span>{selectedTaskAgents.length}</span>
                    </div>
                    <div className="detail-list">
                      {selectedTaskAgents.length === 0 ? (
                        <DetailEmpty text="没有临时 Agent 记录" />
                      ) : (
                        selectedTaskAgents.map((agent) => (
                          <article className="detail-row" key={agent.id}>
                            <strong>{agent.name}</strong>
                            <span>{agent.role}</span>
                            <p>{agent.current_task || agent.last_error || agent.hermes_profile}</p>
                          </article>
                        ))
                      )}
                    </div>
                  </section>

                  <section className="detail-card">
                    <div className="detail-card-head">
                      <strong>证据包</strong>
                      <span>{selectedTaskEvidence.length}</span>
                    </div>
                    <div className="detail-list">
                      {selectedTaskEvidence.length === 0 ? (
                        <DetailEmpty text="没有证据记录" />
                      ) : (
                        selectedTaskEvidence.map((item) => (
                          <article className="detail-row" key={item.id}>
	                            <strong>{item.title}</strong>
	                            <span>{item.kind}</span>
	                            <p>{item.content}</p>
	                            <EvidenceExecutionMeta item={item} />
	                            <SandboxQuickActions
	                              item={item}
	                              busy={busy}
	                              onRun={runSandboxQuickAction}
	                              onCopy={copyOutput}
	                              copiedTarget={copiedTarget}
	                            />
	                            <time>{formatDateTime(item.created_at)}</time>
	                          </article>
                        ))
                      )}
                    </div>
                  </section>
                </div>

                <section className="detail-card">
                  <div className="detail-card-head">
                    <strong>沉淀资产</strong>
                    <span>{selectedTaskAssets.length}</span>
                  </div>
                  <div className="detail-list">
                    {selectedTaskAssets.length === 0 ? (
                      <DetailEmpty text="该任务还没有沉淀资产" />
                    ) : (
                      selectedTaskAssets.map((asset) => (
                        <button
                          className="detail-row detail-row-button"
                          key={asset.id}
                          onClick={() => openAssetsDetail(asset.id)}
                          type="button"
                        >
                          <strong>{asset.title}</strong>
                          <span>{assetTypeLabel(asset.asset_type)}</span>
                          <p>{asset.summary || compactStateText(asset.content, 160)}</p>
                          <time>{formatDateTime(asset.created_at)}</time>
                        </button>
                      ))
                    )}
                  </div>
                </section>
              </div>
            </div>
          )}
        </DetailOverlay>
      )}

      {detailView === "discussion" && (
        <DetailOverlay title="讨论详情" subtitle={activeWorkspace?.name || "工作空间"} onClose={() => setDetailView(null)}>
          {!selectedDiscussionDetail ? (
            <DetailEmpty text="暂无讨论记录" />
          ) : (
            <div className="detail-grid">
              <div className="detail-switcher" aria-label="讨论记录">
                {state.discussionRuns.slice(0, 12).map((discussion) => (
                  <button
                    className={discussion.id === selectedDiscussionDetail.id ? "active" : ""}
                    key={discussion.id}
                    onClick={() => setDetailDiscussionId(discussion.id)}
                    type="button"
                  >
                    <strong>{discussionStatusLabel(discussion.status)}</strong>
                    <span>{compactStateText(discussion.topic, 74)}</span>
                    <time>{formatDateTime(discussion.created_at)}</time>
                  </button>
                ))}
              </div>

              <div className="detail-content">
                <section className="detail-card">
                  <div className="detail-card-head">
                    <strong>讨论主题</strong>
                    <span className={`detail-badge ${selectedDiscussionDetail.status}`}>
                      {discussionStatusLabel(selectedDiscussionDetail.status)}
                    </span>
                  </div>
                  <p className="detail-main-text">{selectedDiscussionDetail.topic}</p>
                  <dl className="detail-facts">
                    <div>
                      <dt>讨论框架</dt>
                      <dd>{discussionFrameworkMeta(selectedDiscussionDetail.discussion_framework).name}</dd>
                    </div>
                    <div>
                      <dt>组织 Agent</dt>
                      <dd>{agentById.get(selectedDiscussionDetail.organizer_agent_id || "")?.name || "讨论 Leader"}</dd>
                    </div>
                    <div>
                      <dt>轮次上限</dt>
                      <dd>{selectedDiscussionDetail.round_limit}</dd>
                    </div>
                    <div>
                      <dt>创建时间</dt>
                      <dd>{formatDateTime(selectedDiscussionDetail.created_at) || "-"}</dd>
                    </div>
                  </dl>
                </section>

                <div className="detail-subgrid">
                  <section className="detail-card">
                    <div className="detail-card-head">
                      <strong>参与 Agent</strong>
                      <span>{selectedDiscussionParticipants.length}</span>
                    </div>
                    <div className="detail-list">
                      {selectedDiscussionParticipants.length === 0 ? (
                        <DetailEmpty text="没有参与记录" />
                      ) : (
                        selectedDiscussionParticipants.map((agent) => (
                          <article className="detail-row" key={agent.agent_id}>
                            <strong>{agent.agent_name}</strong>
                            <span>{agent.rounds_used}/{agent.round_limit} 轮</span>
                            <p>{agent.agent_role} · {agent.status}</p>
                            <time>{formatDateTime(agent.last_spoke_at)}</time>
                          </article>
                        ))
                      )}
                    </div>
                  </section>

                  <section className="detail-card">
                    <div className="detail-card-head">
                      <strong>决策记录</strong>
                      <span>{selectedDiscussionDecisions.length}</span>
                    </div>
                    <div className="detail-list">
                      {selectedDiscussionDecisions.length === 0 ? (
                        <DetailEmpty text="没有决策记录" />
                      ) : (
                        selectedDiscussionDecisions.map((item) => (
                          <article className="detail-row" key={item.id}>
                            <strong>{decisionLabel(item.status)}</strong>
                            <span>{item.framework}</span>
                            <p>{item.summary || item.decision}</p>
                            <time>{formatDateTime(item.created_at)}</time>
                          </article>
                        ))
                      )}
                    </div>
                  </section>
                </div>

                <section className="detail-card">
                  <div className="detail-card-head">
                    <strong>讨论沉淀</strong>
                    <span>{selectedDiscussionAssets.length}</span>
                  </div>
                  <div className="detail-list">
                    {selectedDiscussionAssets.length === 0 ? (
                      <DetailEmpty text="该讨论还没有沉淀资产" />
                    ) : (
                      selectedDiscussionAssets.map((asset) => (
                        <button
                          className="detail-row detail-row-button"
                          key={asset.id}
                          onClick={() => openAssetsDetail(asset.id)}
                          type="button"
                        >
                          <strong>{asset.title}</strong>
                          <span>{assetTypeLabel(asset.asset_type)}</span>
                          <p>{asset.summary || compactStateText(asset.content, 160)}</p>
                          <time>{formatDateTime(asset.created_at)}</time>
                        </button>
                      ))
                    )}
                  </div>
                </section>
              </div>
            </div>
          )}
        </DetailOverlay>
      )}

      {detailView === "message" && (
        <DetailOverlay
          title={selectedMessage?.sender_name || "消息详情"}
          subtitle={
            selectedMessage
              ? `${modeLabel(selectedMessage.mode)} · ${formatDateTime(selectedMessage.created_at)}`
              : activeWorkspace?.name || "工作空间"
          }
          onClose={() => setDetailView(null)}
        >
          {!selectedMessage ? (
            <DetailEmpty text="没有找到这条消息" />
          ) : (
            <div className="detail-content single-detail">
              <section className="detail-card">
                <div className="detail-card-head">
                  <strong>完整输出</strong>
                  <div className="detail-card-actions">
                    <button
                      aria-label={
                        copiedTarget === `message-detail:${selectedMessage.id}` ? "已复制完整输出" : "复制完整输出"
                      }
                      className="message-copy"
                      onClick={() => copyOutput(stripAttachmentContext(selectedMessage.content), `message-detail:${selectedMessage.id}`)}
                      title="复制完整输出"
                      type="button"
                    >
                      {copiedTarget === `message-detail:${selectedMessage.id}` ? <Check size={14} /> : <Copy size={14} />}
                      {copiedTarget === `message-detail:${selectedMessage.id}` ? "已复制" : "复制"}
                    </button>
                    <span className="detail-badge">{modeLabel(selectedMessage.mode)}</span>
                  </div>
                </div>
                <pre className="detail-pre message-full-pre">{stripAttachmentContext(selectedMessage.content)}</pre>
                <MessageAttachmentGrid attachments={selectedMessage.attachments} onOpenImage={setImagePreviewAttachment} />
              </section>
            </div>
          )}
        </DetailOverlay>
      )}

      {detailView === "assets" && (
        <DetailOverlay title="内容资产详情" subtitle={activeWorkspace?.name || "工作空间"} onClose={() => setDetailView(null)}>
          {!selectedContentAsset ? (
            <DetailEmpty text="暂无内容资产" />
          ) : (
            <div className="detail-grid">
              <div className="detail-switcher" aria-label="内容资产列表">
                {visibleContentAssets.slice(0, 80).map((asset) => (
                  <button
                    className={asset.id === selectedContentAsset.id ? "active" : ""}
                    key={asset.id}
                    onClick={() => setDetailAssetId(asset.id)}
                    type="button"
                  >
                    <strong>{assetTypeLabel(asset.asset_type)}</strong>
                    <span>{compactStateText(asset.title, 74)}</span>
                    <time>{formatDateTime(asset.created_at)}</time>
                  </button>
                ))}
              </div>

              <div className="detail-content">
                <section className="detail-card">
                  <div className="detail-card-head">
                    <strong>{selectedContentAsset.title}</strong>
                    <span className="detail-badge">{assetTypeLabel(selectedContentAsset.asset_type)}</span>
                  </div>
                  <p className="detail-main-text">{selectedContentAsset.summary || "没有摘要"}</p>
                  <dl className="detail-facts">
                    <div>
                      <dt>范围</dt>
                      <dd>{selectedContentAsset.scope}</dd>
                    </div>
                    <div>
                      <dt>来源</dt>
                      <dd>{selectedContentAsset.source_type}</dd>
                    </div>
                    <div>
                      <dt>创建者</dt>
                      <dd>{selectedContentAsset.created_by_agent_name || selectedContentAsset.created_by_type}</dd>
                    </div>
                    <div>
                      <dt>重要度</dt>
                      <dd>{selectedContentAsset.importance}</dd>
                    </div>
                    <div>
                      <dt>创建时间</dt>
                      <dd>{formatDateTime(selectedContentAsset.created_at) || "-"}</dd>
                    </div>
                    <div>
                      <dt>更新时间</dt>
                      <dd>{formatDateTime(selectedContentAsset.updated_at) || "-"}</dd>
                    </div>
                  </dl>
                </section>

                <section className="detail-card">
                  <div className="detail-card-head">
                    <strong>完整内容</strong>
                  </div>
                  <pre className="detail-pre">{selectedContentAsset.content || selectedContentAsset.summary}</pre>
                </section>

                {Object.keys(selectedContentAssetMetadata).length > 0 && (
                  <section className="detail-card">
                    <div className="detail-card-head">
                      <strong>结构化元数据</strong>
                    </div>
                    <pre className="detail-pre detail-meta-pre">
                      {JSON.stringify(selectedContentAssetMetadata, null, 2)}
                    </pre>
                  </section>
                )}
              </div>
            </div>
          )}
        </DetailOverlay>
      )}

      {imagePreviewAttachment && (
        <div
          className="image-preview-backdrop"
          role="presentation"
          onMouseDown={() => setImagePreviewAttachment(null)}
        >
          <section
            aria-label="图片预览"
            aria-modal="true"
            className="image-preview-panel"
            role="dialog"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="image-preview-head">
              <strong>{imagePreviewAttachment.original_name || imagePreviewAttachment.filename || "图片"}</strong>
              <button aria-label="关闭图片预览" onClick={() => setImagePreviewAttachment(null)} title="关闭图片预览" type="button">
                <X size={18} />
              </button>
            </header>
            <div className="image-preview-body">
              <img
                alt={imagePreviewAttachment.original_name || imagePreviewAttachment.filename || "图片预览"}
                src={imagePreviewAttachment.url}
              />
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
