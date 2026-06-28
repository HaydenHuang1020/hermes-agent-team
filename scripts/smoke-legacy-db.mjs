import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import initSqlJs from "sql.js";

const root = process.cwd();
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-agent-team-legacy-db-"));

async function launchOnce() {
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
  const page = await app.firstWindow();
  await page.waitForSelector(".app-shell", { timeout: 20000 });
  await page.evaluate(() => window.hermesTeam.bootstrap({}));
  await app.close();
}

await launchOnce();

const dbPath = path.join(tmpDir, "team.sqlite");
const SQL = await initSqlJs({ locateFile: (file) => path.join(root, "node_modules", "sql.js", "dist", file) });
const db = new SQL.Database(await fs.readFile(dbPath));

db.run("PRAGMA foreign_keys = OFF");
db.run(
  `INSERT INTO messages
    (id, workspace_id, channel_id, sender_type, sender_id, sender_name, mode, target_agent_id, content, status, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [
    "legacy_orphan_message",
    "missing_legacy_workspace",
    "missing_legacy_channel",
    "human",
    null,
    "Hayden",
    "task",
    null,
    "旧版本残留的孤儿消息，不能阻断应用启动。",
    "visible",
    new Date().toISOString()
  ]
);
await fs.writeFile(dbPath, Buffer.from(db.export()));
db.close();

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

try {
  const page = await app.firstWindow();
  await page.waitForSelector(".app-shell", { timeout: 20000 });
  const state = await page.evaluate(() => window.hermesTeam.bootstrap({}));
  if (state.workspaces.length !== 0) throw new Error("legacy db smoke should not auto-create a workspace");
  const created = await page.evaluate(() => window.hermesTeam.createWorkspace({ name: "旧库兼容空间" }));
  if (!created.workspaces.some((workspace) => workspace.name === "旧库兼容空间")) {
    throw new Error("legacy db smoke could not create a workspace after empty launch");
  }
  if (!created.agents.some((agent) => agent.agent_kind === "task" && agent.is_primary === 1)) {
    throw new Error("legacy db smoke did not create task lead after explicit workspace creation");
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        tmpDir,
        check: "empty_launch_and_legacy_orphan_message_do_not_block_workspace_creation"
      },
      null,
      2
    )
  );
} finally {
  await app.close();
}
