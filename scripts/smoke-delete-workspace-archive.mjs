import { _electron as electron } from "playwright";
import initSqlJs from "sql.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-agent-team-delete-archive-"));

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

async function queryCount(sql, params = []) {
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(root, "node_modules", "sql.js", "dist", file)
  });
  const db = new SQL.Database(await fs.readFile(path.join(tmpDir, "team.sqlite")));
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    stmt.step();
    return Number(stmt.getAsObject().count || 0);
  } finally {
    stmt.free();
    db.close();
  }
}

try {
  const page = await app.firstWindow();
  await page.waitForSelector(".app-shell", { timeout: 20000 });

  const created = await page.evaluate(async () => {
    let state = await window.hermesTeam.createWorkspace({ name: "删除归档空间" });
    state = await window.hermesTeam.bootstrap({
      workspaceId: state.activeWorkspaceId,
      channelId: state.activeChannelId
    });
    const primary = state.agents.find((agent) => agent.agent_kind === "task" && agent.is_primary);
    if (!primary || !state.activeWorkspaceId || !state.activeChannelId) {
      throw new Error("delete archive smoke could not find primary agent");
    }
    await window.hermesTeam.startTaskRun({
      workspaceId: state.activeWorkspaceId,
      channelId: state.activeChannelId,
      primaryAgentId: primary.id,
      objective: "DELETE_ARCHIVE_TASK_OBJECTIVE"
    });
    await window.hermesTeam.startDiscussion({
      workspaceId: state.activeWorkspaceId,
      channelId: state.activeChannelId,
      agentIds: [],
      topic: "DELETE_ARCHIVE_DISCUSSION_TOPIC",
      discussionFramework: "balanced_decision",
      roundLimit: 1
    });
    return {
      workspaceId: state.activeWorkspaceId,
      channelId: state.activeChannelId
    };
  });

  await page.waitForFunction(
    async ({ workspaceId, channelId }) => {
      const state = await window.hermesTeam.bootstrap({ workspaceId, channelId });
      return (
        state.taskRuns.some((task) => task.objective === "DELETE_ARCHIVE_TASK_OBJECTIVE") &&
        state.discussionRuns.some((discussion) => discussion.topic === "DELETE_ARCHIVE_DISCUSSION_TOPIC") &&
        state.contentAssets.some((asset) => asset.asset_type === "human_task_request") &&
        state.contentAssets.some((asset) => asset.asset_type === "human_discussion_topic")
      );
    },
    created,
    { timeout: 12000 }
  );

  await page.evaluate(async ({ workspaceId }) => {
    await window.hermesTeam.deleteWorkspace({ workspaceId });
  }, created);

  const postDeleteState = await page.evaluate(async () => window.hermesTeam.bootstrap({}));
  assert(
    !postDeleteState.workspaces.some((workspace) => workspace.id === created.workspaceId),
    "deleted workspace is still visible"
  );

  const archiveDir = path.join(tmpDir, "deleted_workspace_archive");
  const archiveNames = await fs.readdir(archiveDir);
  const archiveName = archiveNames.find((name) => name.startsWith(`${created.workspaceId}-`));
  assert(archiveName, "deleted workspace archive file was not created");
  const archivePath = path.join(archiveDir, archiveName);
  const archive = JSON.parse(await fs.readFile(archivePath, "utf8"));

  assert(archive.archive_type === "deleted_workspace", "archive type is wrong");
  assert(archive.workspace?.id === created.workspaceId, "archive workspace snapshot is missing");
  assert(
    archive.task_runs.some((task) => task.objective === "DELETE_ARCHIVE_TASK_OBJECTIVE"),
    "archive did not keep task run"
  );
  assert(
    archive.discussion_runs.some((discussion) => discussion.topic === "DELETE_ARCHIVE_DISCUSSION_TOPIC"),
    "archive did not keep discussion run"
  );
  assert(archive.agents.length >= 2, "archive did not keep agent snapshots");
  const taskLead = archive.agents.find((agent) => agent.agent_kind === "task" && Number(agent.is_primary) === 1);
  const discussionLead = archive.agents.find((agent) => agent.agent_kind === "discussion" && Number(agent.is_primary) === 1);
  assert(taskLead?.hermes_profile && discussionLead?.hermes_profile, "archive did not keep both lead profiles");
  assert(taskLead.hermes_profile !== discussionLead.hermes_profile, "workspace lead agents did not use independent profiles");
  assert(archive.messages.length >= 2, "archive did not keep message history");
  assert(archive.files?.content_archive_path, "archive did not keep content archive path");

  const workspaceRows = await queryCount("SELECT COUNT(*) AS count FROM workspaces WHERE id = ?", [created.workspaceId]);
  const agentRows = await queryCount("SELECT COUNT(*) AS count FROM agents WHERE workspace_id = ?", [created.workspaceId]);
  assert(workspaceRows === 0, "deleted workspace row still exists in database");
  assert(agentRows === 0, "deleted workspace agents still exist in database");

  console.log(
    JSON.stringify(
      {
        ok: true,
        tmpDir,
        archivePath,
        counts: archive.counts
      },
      null,
      2
    )
  );
} finally {
  await app.close();
}
