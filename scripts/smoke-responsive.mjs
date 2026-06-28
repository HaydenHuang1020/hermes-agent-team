import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-agent-team-responsive-"));
const screenshotDir = path.join(root, "output", "playwright", "responsive");
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

async function rightPaneReachability(page) {
  return page.evaluate(async () => {
    const pane = document.querySelector(".agent-pane");
    const lastStateGroup = document.querySelector(".collab-panel .state-group:last-of-type");
    const auditPanel = document.querySelector(".audit-panel");
    if (!pane || !lastStateGroup || !auditPanel) {
      return {
        ok: false,
        reason: "missing right pane, state group, or audit panel"
      };
    }

    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        height: Math.round(rect.height)
      };
    };
    const fullyVisibleInViewport = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.top >= -2 && rect.bottom <= window.innerHeight + 2;
    };
    const fullyVisibleInPane = (element) => {
      const paneRect = pane.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      return rect.top >= paneRect.top - 2 && rect.bottom <= paneRect.bottom + 2;
    };

    pane.scrollTop = 0;
    window.scrollTo(0, 0);
    lastStateGroup.scrollIntoView({ block: "end", inline: "nearest" });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const stateReachable = fullyVisibleInViewport(lastStateGroup) && fullyVisibleInPane(lastStateGroup);

    auditPanel.scrollIntoView({ block: "end", inline: "nearest" });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const auditReachable = fullyVisibleInViewport(auditPanel) && fullyVisibleInPane(auditPanel);

    const paneStyle = getComputedStyle(pane);
    return {
      ok: stateReachable && auditReachable,
      paneOverflowY: paneStyle.overflowY,
      paneScrollHeight: pane.scrollHeight,
      paneClientHeight: pane.clientHeight,
      paneScrollTop: pane.scrollTop,
      stateTitle: lastStateGroup.querySelector(".state-group-title strong")?.textContent?.trim() || "",
      stateReachable,
      auditReachable,
      stateBox: box(lastStateGroup),
      auditBox: box(auditPanel),
      viewportHeight: window.innerHeight
    };
  });
}

try {
  const page = await app.firstWindow();
  const win = await app.browserWindow(page);
  await page.waitForSelector(".app-shell", { timeout: 20000 });

  await page.evaluate(async () => {
    let state = await window.hermesTeam.createWorkspace({
      name: "超长工作空间名称用于验证窗口自适应"
    });
    state = await window.hermesTeam.bootstrap({
      workspaceId: state.activeWorkspaceId,
      channelId: state.activeChannelId
    });
    const primaryAgent = state.agents.find((agent) => agent.agent_kind === "task" && agent.is_primary);
    if (primaryAgent) {
      await window.hermesTeam.startTaskRun({
        workspaceId: state.activeWorkspaceId,
        channelId: state.activeChannelId,
        primaryAgentId: primaryAgent.id,
        objective: "验证右侧 Evidence Pack 和审计列表可以滚动查阅"
      });
      for (let index = 0; index < 8; index += 1) {
        await window.hermesTeam.runSlashCommand({
          workspaceId: state.activeWorkspaceId,
          channelId: state.activeChannelId,
          mode: "task",
          command: "/status",
          primaryAgentId: primaryAgent.id
        });
      }
    }
    await window.hermesTeam.startDiscussion({
      workspaceId: state.activeWorkspaceId,
      channelId: state.activeChannelId,
      agentIds: [],
      topic: "验证右侧 Decision Record 和协作资产可以滚动查阅",
      discussionFramework: "balanced_decision",
      roundLimit: 1
    });
  });
  await page.reload();
  await page.waitForSelector(".app-shell", { timeout: 20000 });

  const sizes = [
    { name: "wide", width: 1440, height: 900 },
    { name: "medium", width: 1120, height: 760 },
    { name: "medium-short", width: 1120, height: 560 },
    { name: "narrow", width: 860, height: 760 },
    { name: "narrow-short", width: 860, height: 560 },
    { name: "compact", width: 740, height: 720 }
  ];

  const checks = [];
  for (const size of sizes) {
    await win.evaluate((browserWindow, nextSize) => {
      browserWindow.setSize(nextSize.width, nextSize.height);
    }, size);
    await page.waitForTimeout(500);

    const metrics = await page.evaluate(() => {
      const selectors = [".workspace-rail", ".chat-pane", ".agent-pane", ".composer"];
      const boxes = selectors.map((selector) => {
        const element = document.querySelector(selector);
        const rect = element?.getBoundingClientRect();
        return {
          selector,
          left: rect ? Math.round(rect.left) : null,
          right: rect ? Math.round(rect.right) : null,
          width: rect ? Math.round(rect.width) : null,
          height: rect ? Math.round(rect.height) : null
        };
      });
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        composer: (() => {
          const element = document.querySelector(".composer");
          const rect = element?.getBoundingClientRect();
          return rect
            ? { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) }
            : null;
        })(),
        composerButton: (() => {
          const element = document.querySelector(".composer-row button");
          const rect = element?.getBoundingClientRect();
          return rect
            ? { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) }
            : null;
        })(),
        boxes
      };
    });

    const allowedWidth = metrics.innerWidth + 2;
    assert(
      metrics.documentScrollWidth <= allowedWidth && metrics.bodyScrollWidth <= allowedWidth,
      `${size.name} has horizontal overflow: ${JSON.stringify(metrics)}`
    );
    for (const box of metrics.boxes) {
      assert(box.width && box.width > 0, `${size.name} missing layout box for ${box.selector}`);
      assert(box.left !== null && box.left >= -1, `${size.name} ${box.selector} starts outside viewport`);
      assert(box.right !== null && box.right <= allowedWidth, `${size.name} ${box.selector} exceeds viewport`);
    }
    assert(metrics.composer, `${size.name} composer is missing`);
    assert(metrics.composerButton, `${size.name} composer send button is missing`);
    if (size.width > 1060) {
      assert(metrics.composer.bottom <= metrics.innerHeight + 2, `${size.name} composer is clipped vertically`);
      assert(
        metrics.composerButton.bottom <= metrics.innerHeight + 2,
        `${size.name} composer button is clipped vertically`
      );
    }

    await page.getByRole("button", { name: "任务执行" }).click();
    await page.waitForTimeout(100);
    const taskRightPane = await rightPaneReachability(page);
    assert(
      taskRightPane.ok && taskRightPane.stateTitle === "Evidence Pack",
      `${size.name} task right pane bottom is not reachable: ${JSON.stringify(taskRightPane)}`
    );

    await page.getByRole("button", { name: "多方讨论" }).click();
    await page.waitForTimeout(100);
    const discussionRightPane = await rightPaneReachability(page);
    assert(
      discussionRightPane.ok && discussionRightPane.stateTitle === "Decision Record",
      `${size.name} discussion right pane bottom is not reachable: ${JSON.stringify(discussionRightPane)}`
    );

    await page.getByRole("button", { name: "任务执行" }).click();
    await page.evaluate(() => {
      document.querySelector(".agent-pane")?.scrollTo({ top: 0 });
      window.scrollTo(0, 0);
    });

    const screenshotPath = path.join(screenshotDir, `${size.name}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    checks.push({ ...size, screenshotPath });
  }

  console.log(JSON.stringify({ ok: true, tmpDir, checks }, null, 2));
} finally {
  await app.close();
}
