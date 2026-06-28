import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-agent-team-long-content-"));
const screenshotDir = path.join(root, "output", "playwright");
await fs.mkdir(screenshotDir, { recursive: true });

const app = await electron.launch({
  args: ["."],
  cwd: root,
  env: {
    ...process.env,
    HAT_HERMES_MODE: "mock",
    HAT_DATA_DIR: tmpDir,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "1"
  }
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const page = await app.firstWindow();
  await page.waitForSelector(".app-shell", { timeout: 20000 });

  await page.evaluate(async () => {
    let state = await window.hermesTeam.createWorkspace({ name: "长内容验证空间" });
    const longContent = Array.from({ length: 36 }, (_, index) =>
      `第 ${index + 1} 行：这是一段用于验证长消息不会撑坏下半部分布局的内容。`
    ).join("\n");
    const immediate = await window.hermesTeam.startDiscussion({
      workspaceId: state.activeWorkspaceId,
      channelId: state.activeChannelId,
      agentIds: [],
      topic: longContent,
      roundLimit: 2
    });
    const discussion = immediate.discussionRuns.find((item) => item.topic === longContent);
    if (!discussion) throw new Error("discussion was not created immediately");
    const humanIndex = immediate.messages.findIndex((item) => item.mode === "discussion" && item.content === longContent);
    const planningIndex = immediate.messages.findIndex((item) => item.content.includes("正在按") && item.content.includes("判断需要哪些临时讨论 Agent"));
    if (humanIndex < 0 || planningIndex < 0 || humanIndex > planningIndex) {
      throw new Error("discussion topic was not inserted before agent planning message");
    }
    if (immediate.discussionAgents.some((item) => item.discussion_id === discussion.id)) {
      throw new Error("discussion participants were created before the human topic was returned");
    }
  });

  await page.reload();
  await page.waitForSelector(".app-shell", { timeout: 20000 });
  await page.getByRole("button", { name: "多方讨论" }).click();
  await page.waitForSelector(".message.long-message", { timeout: 5000 });
  const metrics = await page.evaluate(() => {
    const message = document.querySelector(".message.long-message p");
    const composer = document.querySelector(".composer");
    const auditText = document.querySelector(".audit-item p");
    const messageRect = message?.getBoundingClientRect();
    const composerRect = composer?.getBoundingClientRect();
    return {
      messageClientHeight: message?.clientHeight || 0,
      messageScrollHeight: message?.scrollHeight || 0,
      messageBottom: messageRect ? Math.round(messageRect.bottom) : null,
      composerTop: composerRect ? Math.round(composerRect.top) : null,
      composerBottom: composerRect ? Math.round(composerRect.bottom) : null,
      viewportHeight: window.innerHeight,
      auditMaxHeight: auditText ? getComputedStyle(auditText).maxHeight : ""
    };
  });

  assert(metrics.messageScrollHeight > metrics.messageClientHeight, "long message is not internally scrollable");
  assert(metrics.composerTop !== null && metrics.composerBottom !== null, "composer is missing");
  assert(metrics.composerBottom <= metrics.viewportHeight + 2, "composer is pushed below viewport");
  assert(metrics.messageBottom !== null && metrics.messageBottom <= metrics.composerTop, "long message overlaps composer");

  await page.getByRole("button", { name: "展开全文" }).first().click();
  await page.getByRole("dialog").getByText("完整输出").waitFor({ timeout: 5000 });
  const expandedMetrics = await page.evaluate(() => {
    const panel = document.querySelector(".detail-panel");
    const pre = document.querySelector(".message-full-pre");
    return {
      panelVisible: Boolean(panel),
      preClientHeight: pre?.clientHeight || 0,
      preScrollHeight: pre?.scrollHeight || 0,
      includesLongLine: Boolean(pre?.textContent?.includes("第 36 行"))
    };
  });
  assert(expandedMetrics.panelVisible, "expanded message dialog did not open");
  assert(expandedMetrics.preClientHeight > metrics.messageClientHeight, "expanded message view is not larger than card view");
  assert(expandedMetrics.includesLongLine, "expanded message view does not include the full content");
  await page.getByRole("button", { name: "复制完整输出" }).click();
  await page.getByRole("button", { name: "已复制完整输出" }).waitFor({ timeout: 3000 });

  const screenshotPath = path.join(screenshotDir, "smoke-long-content.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(JSON.stringify({ ok: true, tmpDir, screenshotPath, metrics, expandedMetrics }, null, 2));
} finally {
  await app.close();
}
