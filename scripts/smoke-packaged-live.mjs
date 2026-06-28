import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const executablePath = path.join(
  root,
  "release",
  "mac-arm64",
  "Hermes Agent Team.app",
  "Contents",
  "MacOS",
  "Hermes Agent Team"
);
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-agent-team-live-"));
const userDataDir = path.join(tmpDir, "electron-user-data");

await fs.access(executablePath);

const app = await electron.launch({
  executablePath,
  args: [`--user-data-dir=${userDataDir}`],
  env: {
    HOME: process.env.HOME,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HAT_DATA_DIR: tmpDir,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "1"
  }
});

try {
  const page = await app.firstWindow({ timeout: 180000 });
  await page.waitForSelector(".app-shell", { timeout: 180000 });
  const createdAgent = await page.evaluate(async () => {
    const initial = await window.hermesTeam.bootstrap({});
    if (initial.workspaces.length !== 0) throw new Error("live smoke fresh launch created an unexpected default workspace");
    const state = await window.hermesTeam.createWorkspace({ name: "Live Smoke 空间" });
    const agent = state.agents.find(
      (item) => item.workspace_id === state.activeWorkspaceId && item.agent_kind === "task" && item.is_primary === 1
    );
    const discussionLeader = state.agents.find(
      (item) =>
        item.workspace_id === state.activeWorkspaceId && item.agent_kind === "discussion" && item.is_primary === 1
    );
    if (!agent || !discussionLeader) throw new Error("live smoke lead agents were not created");
    return {
      workspaceId: state.activeWorkspaceId,
      channelId: state.activeChannelId,
      agentId: agent.id,
      discussionLeaderId: discussionLeader.id,
      hermesPath: state.hermesPath,
      profile: agent.hermes_profile,
      discussionProfile: discussionLeader.hermes_profile
    };
  });

  const markerPath = path.join(
    process.env.HOME,
    ".hermes",
    "profiles",
    createdAgent.profile,
    ".hermes-agent-team.json"
  );
  const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  if (marker.isolation?.profile !== "new independent Hermes profile") {
    throw new Error("profile isolation marker is missing or invalid");
  }
  const discussionMarkerPath = path.join(
    process.env.HOME,
    ".hermes",
    "profiles",
    createdAgent.discussionProfile,
    ".hermes-agent-team.json"
  );
  const discussionMarker = JSON.parse(await fs.readFile(discussionMarkerPath, "utf8"));
  if (discussionMarker.agentConfig?.agentKind !== "discussion") {
    throw new Error("discussion leader marker is missing or invalid");
  }

  const result = await page.evaluate(async (createdAgent) => {
    await window.hermesTeam.startTaskRun({
      workspaceId: createdAgent.workspaceId,
      channelId: createdAgent.channelId,
      primaryAgentId: createdAgent.agentId,
      objective: "只回复 HAT_APP_LIVE_OK，并在动作 JSON 中使用空 actions。"
    });
    let hasReply = false;
    let taskReady = false;
    for (let i = 0; i < 45; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const latest = await window.hermesTeam.bootstrap({
        workspaceId: createdAgent.workspaceId,
        channelId: createdAgent.channelId
      });
      hasReply = latest.messages.some(
        (message) => message.sender_type === "agent" && message.sender_id === createdAgent.agentId
      );
      taskReady = latest.taskRuns.some((task) => ["awaiting_confirmation", "failed"].includes(task.status));
      if (hasReply && taskReady) break;
    }

    const latest = await window.hermesTeam.bootstrap({
      workspaceId: createdAgent.workspaceId,
      channelId: createdAgent.channelId
    });
    const taskRun = latest.taskRuns.find((task) => ["awaiting_confirmation", "failed"].includes(task.status));
    if (taskRun) {
      await window.hermesTeam.confirmTaskCleanup({ taskRunId: taskRun.id });
    }

    const updated = await window.hermesTeam.updateAgentConfig({
      agentId: createdAgent.agentId,
      channelId: createdAgent.channelId,
      coreCommand: "LIVE_SMOKE_CORE_COMMAND",
      modelName: "live-smoke-marker-model"
    });
    const agent = updated.agents.find((item) => item.id === createdAgent.agentId);

    return {
      hermesPath: createdAgent.hermesPath,
      profile: createdAgent.profile,
      hasReply,
      coreCommand: agent?.core_command || "",
      modelName: agent?.model_name || ""
    };
  }, createdAgent);

  if (!result.hasReply) {
    throw new Error("live smoke agent did not reply");
  }
  if (result.coreCommand !== "LIVE_SMOKE_CORE_COMMAND" || result.modelName !== "live-smoke-marker-model") {
    throw new Error("live smoke agent config update did not persist");
  }
  const updatedMarker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  if (
    updatedMarker.agentConfig?.coreCommand !== "LIVE_SMOKE_CORE_COMMAND" ||
    updatedMarker.agentConfig?.modelName !== "live-smoke-marker-model"
  ) {
    throw new Error("live smoke marker config update did not persist");
  }

  await page.evaluate(async (createdAgent) => {
    await window.hermesTeam.deleteWorkspace({
      workspaceId: createdAgent.workspaceId
    });
  }, createdAgent);
  for (const profile of [createdAgent.profile, createdAgent.discussionProfile]) {
    const profileDir = path.join(process.env.HOME, ".hermes", "profiles", profile);
    try {
      await fs.access(profileDir);
      throw new Error(`profile was not deleted: ${profile}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        executablePath,
        tmpDir,
        isolationMarker: markerPath,
        ...result
      },
      null,
      2
    )
  );
} finally {
  await app.close();
}
