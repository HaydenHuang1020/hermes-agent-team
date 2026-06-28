import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-agent-team-"));
const screenshotDir = path.join(root, "output", "playwright");
await fs.mkdir(screenshotDir, { recursive: true });

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const app = await electron.launch({
  args: ["."],
  cwd: root,
  env: {
    ...process.env,
    HAT_HERMES_MODE: "mock",
    HAT_MOCK_AGENT_DELAY_MS: "5000",
    HAT_DATA_DIR: tmpDir,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "1"
  }
});

try {
  const page = await app.firstWindow();
  const browserLogs = [];
  page.on("console", (message) => browserLogs.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => browserLogs.push(`pageerror: ${error.message}`));
  try {
    await page.waitForSelector(".app-shell", { timeout: 20000 });
  } catch (error) {
    const debugPath = path.join(screenshotDir, "smoke-electron-debug.png");
    await page.screenshot({ path: debugPath, fullPage: true }).catch(() => undefined);
    console.error(
      JSON.stringify(
        {
          ok: false,
          url: page.url(),
          title: await page.title().catch(() => ""),
          debugPath,
          browserLogs
        },
        null,
        2
      )
    );
    throw error;
  }

  const initialState = await page.evaluate(() => window.hermesTeam.bootstrap({}));
  if (
    initialState.workspaces.length !== 0 ||
    initialState.channels.length !== 0 ||
    initialState.agents.length !== 0 ||
    initialState.messages.length !== 0
  ) {
    throw new Error("fresh launch must not create a default workspace, channel, agent, or message");
  }
  await page.getByText("请先创建工作空间").waitFor({ timeout: 5000 });
  await page.locator(".agent-pane").getByText("暂无 Agent").waitFor({ timeout: 5000 });

  await page.getByTitle("创建工作空间").click();
  await page.getByText("请先填写工作空间名称").waitFor({ timeout: 5000 });
  await page.getByText("需要填写工作空间名称").waitFor({ timeout: 5000 });
  const emptyCreateState = await page.evaluate(() => ({
    workspaceCount: document.querySelectorAll(".workspace-list .workspace").length,
    focusedPlaceholder: document.activeElement?.getAttribute("placeholder") || ""
  }));
  if (emptyCreateState.workspaceCount !== 0) {
    throw new Error("empty workspace name click created a workspace");
  }
  if (emptyCreateState.focusedPlaceholder !== "输入工作空间名称") {
    throw new Error("empty workspace name validation did not focus the name input");
  }

  await page.getByPlaceholder("输入工作空间名称").fill("测试公司");
  await page.getByTitle("创建工作空间").click();
  await page.getByRole("button", { name: "测试公司" }).waitFor({ timeout: 5000 });
  const visibleAfterCreate = await page.evaluate(
    () => document.visibilityState === "visible" && Boolean(document.querySelector(".app-shell"))
  );
  if (!visibleAfterCreate) {
    throw new Error("app shell was not visible after workspace creation");
  }
  await page.locator(".collab-panel").getByText("Runtime Locks").waitFor({ timeout: 5000 });

  await page.locator(".agent-list").getByText("项目经理 Agent").waitFor({ timeout: 5000 });
  await page.getByLabel("编辑 项目经理 Agent 的底层命令和模型").click();
  await page.getByLabel("项目经理 Agent 底层要求 AGENTS.md").fill("项目经理必须先确认目标和约束。");
  const selectedModel = await page.getByLabel("项目经理 Agent 模型").evaluate((select) => {
    const options = Array.from(select.options);
    const firstRealOption = options.find((option) => option.value);
    if (!firstRealOption) throw new Error("Hermes model selector did not expose any model options");
    select.value = firstRealOption.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return firstRealOption.textContent?.replace(/（Hermes 默认）$/, "").trim() || "";
  });
  await page.getByRole("button", { name: "保存" }).click();
  await page.locator(".agent-list").getByText("底层：项目经理必须先确认目标和约束。").waitFor({ timeout: 5000 });
  await page
    .locator(".agent-list")
    .getByText(new RegExp(`模型：.*${escapeRegExp(selectedModel.split(" · ")[0])}`))
    .waitFor({ timeout: 5000 });

  await page.evaluate(async () => {
    let state = await window.hermesTeam.bootstrap({});
    const workspace = state.workspaces.find((item) => item.name === "测试公司");
    if (!workspace) throw new Error("smoke could not find workspace");
    state = await window.hermesTeam.bootstrap({ workspaceId: workspace.id });
    const channel = state.channels.find((item) => item.workspace_id === workspace.id) || state.channels[0];
    const primary = state.agents.find(
      (agent) => agent.workspace_id === workspace.id && agent.agent_kind === "task" && agent.is_primary === 1
    );
    if (!channel || !primary) throw new Error("smoke could not find auto primary agent");
    await window.hermesTeam.createAgent({
      workspaceId: workspace.id,
      channelId: channel.id,
      name: "研究员",
      role: "Research Agent",
      description: "负责资料研究。",
      parentAgentId: primary.id,
      agentKind: "task"
    });
  });
  await page.locator(".agent-list").getByText("研究员").waitFor({ timeout: 5000 });

  const codexRuntimeResult = await page.evaluate(async () => {
    let state = await window.hermesTeam.bootstrap({});
    const workspace = state.workspaces.find((item) => item.name === "测试公司");
    if (!workspace) throw new Error("smoke could not find workspace for Codex runtime");
    state = await window.hermesTeam.bootstrap({ workspaceId: workspace.id });
    const channel = state.channels.find((item) => item.workspace_id === workspace.id) || state.channels[0];
    if (!channel) throw new Error("smoke could not find channel for Codex runtime");
    state = await window.hermesTeam.createAgent({
      workspaceId: workspace.id,
      channelId: channel.id,
      name: "Codex 项目经理",
      role: "Codex Project Manager",
      description: "验证 Codex 后端执行。",
      runtimeBackend: "codex",
      modelProvider: "",
      modelName: "",
      agentKind: "task"
    });
    const codexAgent = state.agents.find((agent) => agent.name === "Codex 项目经理");
    if (!codexAgent || codexAgent.runtime_backend !== "codex") return null;
    await window.hermesTeam.startTaskRun({
      workspaceId: workspace.id,
      channelId: channel.id,
      primaryAgentId: codexAgent.id,
      objective: "CODEX_BACKEND_RUNTIME_CHECK"
    });
    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const latest = await window.hermesTeam.bootstrap({ workspaceId: workspace.id, channelId: channel.id });
      const evidence = latest.evidenceItems.find(
        (item) => item.agent_id === codexAgent.id && item.kind === "agent_reply" && item.metadata_json.includes("\"engine\":\"codex\"")
      );
      const task = latest.taskRuns.find((item) => item.objective === "CODEX_BACKEND_RUNTIME_CHECK");
      if (evidence && task?.status === "awaiting_confirmation") {
        return {
          agentId: codexAgent.id,
          runtimeBackend: codexAgent.runtime_backend,
          runtimeId: codexAgent.hermes_profile,
          taskStatus: task.status
        };
      }
    }
    return null;
  });
  if (!codexRuntimeResult || codexRuntimeResult.runtimeBackend !== "codex" || !codexRuntimeResult.runtimeId.startsWith("codex")) {
    throw new Error("Codex backend agent did not create and execute through the Codex runtime");
  }

  const directImageMessage = await page.evaluate(async () => {
    const initial = await window.hermesTeam.bootstrap({});
    const workspace = initial.workspaces.find((item) => item.name === "测试公司");
    if (!workspace) throw new Error("smoke could not find workspace for direct image message");
    const state = await window.hermesTeam.bootstrap({ workspaceId: workspace.id });
    const channel = state.channels.find((item) => item.workspace_id === workspace.id) || state.channels[0];
    if (!channel) throw new Error("smoke could not find channel for direct image message");
    const mobileUrl = new URL(state.mobileServer.url);
    const mobileOrigin = mobileUrl.origin;
    const mobileToken = mobileUrl.searchParams.get("token");
    if (!mobileToken) throw new Error("mobile server token missing from state");
    const taskRunCountBefore = state.taskRuns.length;
    const response = await fetch(`${mobileOrigin}/api/team/send-channel-message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-HAT-Mobile-Token": mobileToken
      },
      body: JSON.stringify({
        workspaceId: workspace.id,
        channelId: channel.id,
        mode: "task",
        content: "",
        attachments: [
          {
            kind: "image",
            mimeType: "image/png",
            fileName: "direct-mobile-image.png",
            dataBase64:
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
          }
        ]
      })
    });
    if (!response.ok) throw new Error(`mobile direct image send failed: ${response.status}`);
    const next = await response.json();
    const message = next.messages.find((item) =>
      (item.attachments || []).some((attachment) => attachment.original_name === "direct-mobile-image.png")
    );
    if (!message) return null;
    return {
      messageId: message.id,
      content: message.content,
      taskRunDelta: next.taskRuns.length - taskRunCountBefore,
      attachmentCount: (message.attachments || []).length
    };
  });
  if (!directImageMessage || directImageMessage.attachmentCount !== 1 || directImageMessage.taskRunDelta !== 0) {
    throw new Error("direct image message did not attach exactly one image without starting a task");
  }
  if (directImageMessage.content.includes("本机路径") || directImageMessage.content.includes("图片附件")) {
    throw new Error("direct image message leaked agent attachment context into user-facing content");
  }
  await page.locator('.message-attachment[title="direct-mobile-image.png"] img').waitFor({ timeout: 8000 });

  const desktopImageReceivedByMobile = await page.evaluate(async () => {
    const initial = await window.hermesTeam.bootstrap({});
    const workspace = initial.workspaces.find((item) => item.name === "测试公司");
    if (!workspace) throw new Error("smoke could not find workspace for mobile image receive");
    const state = await window.hermesTeam.bootstrap({ workspaceId: workspace.id });
    const channel = state.channels.find((item) => item.workspace_id === workspace.id) || state.channels[0];
    if (!channel) throw new Error("smoke could not find channel for mobile image receive");
    const mobileUrl = new URL(state.mobileServer.url);
    const mobileOrigin = mobileUrl.origin;
    const mobileToken = mobileUrl.searchParams.get("token");
    if (!mobileToken) throw new Error("mobile server token missing from state");
    await window.hermesTeam.sendChannelMessage({
      workspaceId: workspace.id,
      channelId: channel.id,
      mode: "task",
      content: "",
      attachments: [
        {
          kind: "image",
          mimeType: "image/png",
          fileName: "direct-mac-image.png",
          dataBase64:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
        }
      ]
    });
    const response = await fetch(`${mobileOrigin}/api/team/bootstrap`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-HAT-Mobile-Token": mobileToken
      },
      body: JSON.stringify({ workspaceId: workspace.id, channelId: channel.id })
    });
    if (!response.ok) throw new Error(`mobile bootstrap failed: ${response.status}`);
    const mobileState = await response.json();
    const mobileMessage = mobileState.messages.find((item) =>
      (item.attachments || []).some((attachment) => attachment.original_name === "direct-mac-image.png")
    );
    const attachment = mobileMessage?.attachments?.find((item) => item.original_name === "direct-mac-image.png");
    if (!attachment?.url) return null;
    const imageResponse = await fetch(attachment.url);
    const bytes = await imageResponse.arrayBuffer();
    return {
      messageId: mobileMessage.id,
      contentType: imageResponse.headers.get("content-type") || "",
      byteLength: bytes.byteLength
    };
  });
  if (
    !desktopImageReceivedByMobile ||
    !desktopImageReceivedByMobile.contentType.includes("image/png") ||
    desktopImageReceivedByMobile.byteLength <= 0
  ) {
    throw new Error("mobile API could not receive and fetch a desktop-sent image attachment");
  }

  await page.getByRole("button", { name: "任务执行" }).click();
  await page.getByPlaceholder("描述要完成的具体任务").fill("请安排团队整理一个今日执行清单。");
  await page.getByTitle("启动任务").click();
  await page.locator(".agent-status.running").getByText("运行中").first().waitFor({ timeout: 9000 });
  await page.waitForFunction(async () => {
    const initial = await window.hermesTeam.bootstrap({});
    const workspace = initial.workspaces.find((item) => item.name === "测试公司");
    if (!workspace) return false;
    const state = await window.hermesTeam.bootstrap({ workspaceId: workspace.id });
    return state.runtimeLocks.some((lock) => lock.owner_type === "task_run" && lock.status === "active");
  }, null, { timeout: 5000 });
  await page.waitForFunction(async () => {
    const initial = await window.hermesTeam.bootstrap({});
    const workspace = initial.workspaces.find((item) => item.name === "测试公司");
    if (!workspace) return false;
    const state = await window.hermesTeam.bootstrap({ workspaceId: workspace.id });
    const task = state.taskRuns.find((item) => item.objective === "请安排团队整理一个今日执行清单。");
    return (
      task &&
      ["awaiting_confirmation", "failed"].includes(task.status) &&
      state.messages.some((message) => message.sender_type === "agent") &&
      state.evidenceItems.some((item) => item.kind === "task_start") &&
      state.evidenceItems.some((item) => item.kind === "team_activation_decision") &&
      state.evidenceItems.some((item) => item.kind === "agent_reply") &&
      state.blackboardEntries.some((item) => item.key === "current_task") &&
      state.blackboardEntries.some((item) => item.key === "task_activation") &&
      Boolean(state.teamStatePath)
    );
  }, null, { timeout: 16000 });
  await page.locator(".collab-panel").getByText("Evidence Pack").waitFor({ timeout: 5000 });
  await page.locator(".agent-status.ready").getByText("空闲").first().waitFor({ timeout: 9000 });
  await page.getByRole("button", { name: "任务详情" }).click();
  await page.getByRole("dialog").getByText("任务需求").waitFor({ timeout: 5000 });
  await page.getByRole("dialog").getByText("证据包").waitFor({ timeout: 5000 });
  await page.waitForFunction(
    () => document.querySelector('[role="dialog"]')?.textContent?.includes("执行细节"),
    null,
    { timeout: 8000 }
  );
  await page.getByLabel("关闭详情").click();

  await page.getByPlaceholder("描述要完成的具体任务").fill("AGENT_IMAGE_ATTACHMENT_CHECK");
  await page.getByTitle("启动任务").click();
  let generatedImagePayload = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    generatedImagePayload = await page.evaluate(async () => {
      const initial = await window.hermesTeam.bootstrap({});
      const workspace = initial.workspaces.find((item) => item.name === "测试公司");
      if (!workspace) return null;
      const state = await window.hermesTeam.bootstrap({ workspaceId: workspace.id });
      const task = state.taskRuns.find((item) => item.objective === "AGENT_IMAGE_ATTACHMENT_CHECK");
      const message = state.messages.find((item) => {
        if (item.sender_type !== "agent") return false;
        return state.messageAttachments.some((attachment) => attachment.message_id === item.id && attachment.mime_type === "image/png");
      });
      const attachments = message ? state.messageAttachments.filter((item) => item.message_id === message.id) : [];
      return task?.status === "awaiting_confirmation" && message && attachments.some((item) => item.mime_type === "image/png")
        ? { messageId: message.id, attachmentCount: attachments.length, content: message.content }
        : null;
    });
    if (generatedImagePayload) break;
    await page.waitForTimeout(500);
  }
  if (!generatedImagePayload) {
    throw new Error("agent generated visual artifact was not attached as a message image");
  }
  if (/图片源文件|\/Users\/|\.html|\.png/i.test(generatedImagePayload.content || "")) {
    throw new Error("agent generated image message still exposed image paths or links instead of a chat image");
  }
  await page.locator(".message-attachment img").last().waitFor({ timeout: 8000 });
  await page.locator(".message-attachment").last().click();
  await page.getByRole("dialog", { name: "图片预览" }).waitFor({ timeout: 5000 });
  await page.locator(".image-preview-body img").waitFor({ timeout: 5000 });
  await page.getByLabel("关闭图片预览").click();
  const generatedImageFilenameVisible = await page.locator(".message-list").getByText(/agent-image-check|\.png|\.html/i).count();
  if (generatedImageFilenameVisible > 0) {
    throw new Error("agent generated image was displayed as a filename/link instead of an image bubble");
  }

  await page.locator(".composer .command-trigger").click();
  await page.locator(".command-palette").getByText("/help").waitFor({ timeout: 3000 });
  await page.getByPlaceholder("描述要完成的具体任务").fill("/status");
  await page.locator(".command-palette").getByText("/status").waitFor({ timeout: 3000 });
  await page.keyboard.press("Meta+Enter");
  await page.getByText("命令 /status").waitFor({ timeout: 5000 });

  const replyCountBeforeStop = await page.evaluate(async () => {
    const initial = await window.hermesTeam.bootstrap({});
    const workspace = initial.workspaces.find((item) => item.name === "测试公司");
    const state = await window.hermesTeam.bootstrap({ workspaceId: workspace.id });
    return state.messages.filter((message) => message.sender_type === "agent").length;
  });
  await page.getByPlaceholder("描述要完成的具体任务").fill("STOP_LONG_RUNNING_TASK");
  await page.getByTitle("启动任务").click();
  await page.locator(".agent-status.running").getByText("运行中").first().waitFor({ timeout: 9000 });
  await page.getByPlaceholder("描述要完成的具体任务").fill("/stop");
  await page.keyboard.press("Meta+Enter");
  await page.getByText("命令 /stop").waitFor({ timeout: 5000 });
  await page.waitForFunction(async () => {
    const state = await window.hermesTeam.bootstrap({});
    return (
      state.agents.every((agent) => agent.status !== "running") &&
      state.taskRuns.some((task) => task.objective === "STOP_LONG_RUNNING_TASK" && task.status === "stopped")
    );
  }, null, { timeout: 5000 });
  await page.waitForTimeout(5600);
  const replyCountAfterStop = await page.evaluate(async () => {
    const initial = await window.hermesTeam.bootstrap({});
    const workspace = initial.workspaces.find((item) => item.name === "测试公司");
    const state = await window.hermesTeam.bootstrap({ workspaceId: workspace.id });
    return state.messages.filter((message) => message.sender_type === "agent").length;
  });
  if (replyCountAfterStop !== replyCountBeforeStop) {
    throw new Error("/stop allowed a late agent reply");
  }

  const blockedResult = await page.evaluate(async () => {
    const initial = await window.hermesTeam.bootstrap({});
    const workspace = initial.workspaces.find((item) => item.name === "测试公司");
    if (!workspace) throw new Error("smoke could not find workspace");
    const withWorkspace = await window.hermesTeam.bootstrap({ workspaceId: workspace.id });
    const channel = withWorkspace.channels.find((item) => item.workspace_id === workspace.id) || withWorkspace.channels[0];
    if (!channel) throw new Error("smoke could not find channel");
    const state = await window.hermesTeam.bootstrap({ workspaceId: workspace.id, channelId: channel.id });
    const child = state.agents.find((agent) => agent.name === "研究员");
    if (!child || !state.activeWorkspaceId || !state.activeChannelId) {
      throw new Error("smoke could not find child agent");
    }
    let blocked = false;
    try {
      await window.hermesTeam.startTaskRun({
        workspaceId: state.activeWorkspaceId,
        channelId: state.activeChannelId,
        primaryAgentId: child.id,
        objective: "这是一条应被拦截的越级命令。"
      });
    } catch {
      blocked = true;
    }
    return {
      blockedTask: blocked
    };
  });

  if (!blockedResult.blockedTask) {
    throw new Error("permission block check failed");
  }

  await page.evaluate(async () => {
    const initial = await window.hermesTeam.bootstrap({});
    const workspace = initial.workspaces.find((item) => item.name === "测试公司");
    if (!workspace) throw new Error("smoke could not find workspace for visibility check");
    const withWorkspace = await window.hermesTeam.bootstrap({ workspaceId: workspace.id });
    const channel = withWorkspace.channels.find((item) => item.workspace_id === workspace.id) || withWorkspace.channels[0];
    if (!channel) throw new Error("smoke could not find channel for visibility check");
    let state = await window.hermesTeam.bootstrap({ workspaceId: workspace.id, channelId: channel.id });
    state = await window.hermesTeam.createAgent({
      workspaceId: state.activeWorkspaceId,
      channelId: state.activeChannelId,
      name: "讨论员",
      role: "Discussion Agent",
      description: "用于界面隔离验收。",
      agentKind: "discussion"
    });
    const discussionAgent = state.agents.find((agent) => agent.name === "讨论员" && agent.agent_kind === "discussion");
    if (!discussionAgent) throw new Error("smoke could not create discussion agent");
    await window.hermesTeam.startDiscussion({
      workspaceId: state.activeWorkspaceId,
      channelId: state.activeChannelId,
      agentIds: [discussionAgent.id],
      topic: "DISCUSSION_UI_SECRET",
      roundLimit: 1
    });
  });

  await page.reload();
  await page.waitForSelector(".app-shell", { timeout: 20000 });
  await page.getByRole("button", { name: "测试公司" }).click();
  await page.getByRole("button", { name: "任务执行" }).click();
  await page.waitForTimeout(500);
  const taskSecretCount = await page.locator(".message-list").getByText("DISCUSSION_UI_SECRET").count();
  const taskDiscussionAgentCount = await page.locator(".agent-list").getByText("讨论员").count();
  const taskDiscussionCreateMessageCount = await page
    .locator(".message-list")
    .getByText("已创建并验证独立 Hermes Agent：讨论员")
    .count();
  const taskDiscussionAuditCount = await page.locator(".audit-list").getByText("讨论员").count();
  if (taskSecretCount !== 0) {
    throw new Error("task view leaked discussion message");
  }
  if (taskDiscussionAgentCount !== 0) {
    throw new Error("task view leaked discussion agent");
  }
  if (taskDiscussionCreateMessageCount !== 0) {
    throw new Error("task view leaked discussion agent creation system message");
  }
  if (taskDiscussionAuditCount !== 0) {
    throw new Error("task view leaked discussion audit item");
  }

  await page.getByRole("button", { name: "多方讨论" }).click();
  await page.waitForTimeout(500);
  const discussionSecretCount = await page.locator(".message-list").getByText("DISCUSSION_UI_SECRET").count();
  const discussionTaskMessageCount = await page
    .locator(".message-list")
    .getByText("请安排团队整理一个今日执行清单。")
    .count();
  const discussionTaskAgentCount = await page.locator(".agent-list").getByText("项目经理 Agent").count();
  const discussionAgentCount = await page.locator(".agent-list").getByText("讨论员").count();
  if (discussionSecretCount === 0) {
    throw new Error("discussion view did not show discussion message");
  }
  if (discussionTaskMessageCount === 0) {
    throw new Error("discussion view did not show task message");
  }
  if (discussionTaskAgentCount !== 0) {
    throw new Error("discussion view leaked task agent");
  }
  if (discussionAgentCount === 0) {
    throw new Error("discussion view did not show discussion agent");
  }

  await page.waitForFunction(async () => {
    const state = await window.hermesTeam.bootstrap({});
    const workspace = state.workspaces.find((item) => item.name === "测试公司");
    if (!workspace) return false;
    const withWorkspace = await window.hermesTeam.bootstrap({ workspaceId: workspace.id });
    const channel = withWorkspace.channels.find((item) => item.workspace_id === workspace.id) || withWorkspace.channels[0];
    if (!channel) return false;
    const current = await window.hermesTeam.bootstrap({ workspaceId: workspace.id, channelId: channel.id });
    return current.agents
      .filter((agent) => agent.agent_kind === "discussion")
      .every((agent) => agent.status !== "running");
  }, null, { timeout: 12000 });

  await page.evaluate(async () => {
    const initial = await window.hermesTeam.bootstrap({});
    const workspace = initial.workspaces.find((item) => item.name === "测试公司");
    if (!workspace) throw new Error("smoke could not find workspace for multi discussion");
    const withWorkspace = await window.hermesTeam.bootstrap({ workspaceId: workspace.id });
    const channel = withWorkspace.channels.find((item) => item.workspace_id === workspace.id) || withWorkspace.channels[0];
    if (!channel) throw new Error("smoke could not find channel for multi discussion");
    let state = await window.hermesTeam.bootstrap({ workspaceId: workspace.id, channelId: channel.id });
    for (const discussion of state.discussionRuns.filter((item) => item.status !== "closed")) {
      state = await window.hermesTeam.closeDiscussion({ discussionId: discussion.id });
    }
    for (const name of ["讨论员 B", "讨论员 C"]) {
      state = await window.hermesTeam.createAgent({
        workspaceId: state.activeWorkspaceId,
        channelId: state.activeChannelId,
        name,
        role: "Discussion Agent",
        description: "用于多 Agent 讨论验收。",
        agentKind: "discussion"
      });
    }
  });

  await page.reload();
  await page.waitForSelector(".app-shell", { timeout: 20000 });
  await page.getByRole("button", { name: "测试公司" }).click();
  await page.locator(".chat-head h1").getByText("测试公司").waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "多方讨论" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".participant.active").length >= 3, null, {
    timeout: 5000
  });
  await page.getByPlaceholder("输入讨论主题或新的讨论背景").fill("UI_MULTI_AGENT_DISCUSSION");
  await page.keyboard.press("Meta+Enter");

  const multiDiscussionStarted = await page.waitForFunction(async () => {
    const initial = await window.hermesTeam.bootstrap({});
    const workspace = initial.workspaces.find((item) => item.name === "测试公司");
    if (!workspace) return false;
    const withWorkspace = await window.hermesTeam.bootstrap({ workspaceId: workspace.id });
    const channel = withWorkspace.channels.find((item) => item.workspace_id === workspace.id) || withWorkspace.channels[0];
    if (!channel) return false;
    const state = await window.hermesTeam.bootstrap({ workspaceId: workspace.id, channelId: channel.id });
    const discussion = state.discussionRuns.find((item) => item.topic === "UI_MULTI_AGENT_DISCUSSION");
    if (!discussion) return false;
    return state.discussionAgents.filter((item) => item.discussion_id === discussion.id).length >= 3;
  }, null, { timeout: 5000 });
  if (!multiDiscussionStarted) {
    throw new Error("command return did not start multi-agent discussion");
  }

  await page.waitForFunction(async () => {
    const initial = await window.hermesTeam.bootstrap({});
    const workspace = initial.workspaces.find((item) => item.name === "测试公司");
    if (!workspace) return false;
    const withWorkspace = await window.hermesTeam.bootstrap({ workspaceId: workspace.id });
    const channel = withWorkspace.channels.find((item) => item.workspace_id === workspace.id) || withWorkspace.channels[0];
    if (!channel) return false;
    const state = await window.hermesTeam.bootstrap({ workspaceId: workspace.id, channelId: channel.id });
    const discussion = state.discussionRuns.find((item) => item.topic === "UI_MULTI_AGENT_DISCUSSION");
    if (!discussion) return false;
    const participantIds = state.discussionAgents
      .filter((item) => item.discussion_id === discussion.id)
      .map((item) => item.agent_id);
    const participantAgents = state.agents.filter((agent) => participantIds.includes(agent.id));
    return participantAgents.length >= 3 && participantAgents.every((agent) => agent.status === "running");
  }, null, { timeout: 7000 });

  const allDiscussionAgentsSpoke = await page.waitForFunction(async () => {
    const initial = await window.hermesTeam.bootstrap({});
    const workspace = initial.workspaces.find((item) => item.name === "测试公司");
    if (!workspace) return false;
    const withWorkspace = await window.hermesTeam.bootstrap({ workspaceId: workspace.id });
    const channel = withWorkspace.channels.find((item) => item.workspace_id === workspace.id) || withWorkspace.channels[0];
    if (!channel) return false;
    const state = await window.hermesTeam.bootstrap({ workspaceId: workspace.id, channelId: channel.id });
    const discussion = state.discussionRuns.find((item) => item.topic === "UI_MULTI_AGENT_DISCUSSION");
    if (!discussion) return false;
    const participants = state.discussionAgents.filter((item) => item.discussion_id === discussion.id);
    return participants.length >= 3 && participants.every((item) => item.rounds_used >= 1);
  }, null, { timeout: 20000 });
  if (!allDiscussionAgentsSpoke) {
    throw new Error("not all selected discussion agents spoke");
  }

  await page.reload();
  await page.waitForSelector(".app-shell", { timeout: 20000 });
  await page.getByRole("button", { name: "测试公司" }).click();
  await page.getByRole("button", { name: "多方讨论" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".message.agent .mention").length > 0, null, { timeout: 7000 });
  const mentionCount = await page.locator(".message.agent .mention").count();
  if (mentionCount === 0) {
    throw new Error("agent replies did not render mention markup");
  }
  const visibleMessageCount = await page.locator(".message-list article.message").count();
  const visibleCopyCount = await page.locator(".message-list article.message .message-copy").count();
  if (visibleMessageCount === 0 || visibleCopyCount !== visibleMessageCount) {
    throw new Error("not every visible discussion output has a copy button");
  }
  const firstAgentCopy = page.locator(".message.agent .message-copy:visible").first();
  await firstAgentCopy.click();
  await page.locator(".message.agent .message-copy").filter({ hasText: "已复制" }).first().waitFor({ timeout: 3000 });
  await page.getByRole("button", { name: "讨论详情" }).click();
  await page.getByRole("dialog").getByText("讨论主题").waitFor({ timeout: 5000 });
  await page.getByRole("dialog").getByText("决策记录", { exact: true }).waitFor({ timeout: 5000 });
  await page.getByLabel("关闭详情").click();

  await page
    .locator(".state-group")
    .filter({ hasText: "Content Assets" })
    .getByRole("button", { name: "详情" })
    .click();
  await page.getByRole("dialog").getByText("内容资产详情").waitFor({ timeout: 5000 });
  await page.getByRole("dialog").getByText("完整内容").waitFor({ timeout: 5000 });
  await page.getByLabel("关闭详情").click();

  await page.getByPlaceholder("输入讨论主题或新的讨论背景").fill("/help");
  await page.keyboard.press("Meta+Enter");
  await page.getByText("命令 /help").waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "任务执行" }).click();
  await page.waitForTimeout(500);
  const taskHelpLeakCount = await page.locator(".message-list").getByText("命令 /help").count();
  if (taskHelpLeakCount !== 0) {
    throw new Error("task view leaked discussion slash command result");
  }

  const screenshotPath = path.join(screenshotDir, "smoke-electron.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });

  console.log(
    JSON.stringify(
      {
        ok: true,
        tmpDir,
        screenshotPath,
        checks: [
          "fresh_launch_has_no_workspace",
          "empty_workspace_prompt_visible",
          "empty_workspace_name_validation",
          "workspace_created",
          "app_shell_visible_after_workspace_creation",
          "workspace_default_stream",
          "workspace_auto_task_lead_created",
	          "runtime_locks_panel_visible",
	          "agent_config_edit_visible",
	          "child_agent_created",
	          "codex_backend_agent_created_and_executed",
	          "ios_to_mac_direct_image_message_visible_without_task_run",
          "mac_to_ios_direct_image_message_fetchable",
          "primary_command_replied",
          "team_activation_decision_recorded",
          "agent_running_status_visible",
          "task_runtime_lock_active",
          "agent_ready_status_visible",
          "task_detail_view_opened",
          "agent_generated_image_attachment",
          "message_image_preview_opens",
          "human_direct_child_task_blocked",
          "task_view_hides_discussion_messages",
          "task_view_hides_discussion_agents",
          "task_view_hides_discussion_system_messages",
          "task_view_hides_discussion_audits",
          "discussion_view_shows_task_messages",
          "discussion_view_hides_task_agents",
          "discussion_agents_default_all_selected",
          "command_return_starts_discussion",
          "all_selected_discussion_agents_running_together",
          "all_selected_discussion_agents_spoke",
          "mentions_rendered",
          "discussion_outputs_copy_buttons_visible",
          "discussion_output_copy_feedback",
          "discussion_detail_view_opened",
          "content_asset_detail_view_opened",
          "slash_status_visible",
          "slash_stop_cancels_agent_run",
          "discussion_slash_command_hidden_from_task"
        ]
      },
      null,
      2
    )
  );
} finally {
  await app.close();
}
