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
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-agent-team-packaged-"));
const userDataDir = path.join(tmpDir, "electron-user-data");

await fs.access(executablePath);

const app = await electron.launch({
  executablePath,
  args: [`--user-data-dir=${userDataDir}`],
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
  await page.getByText("Hermes Team").waitFor({ timeout: 5000 });
  console.log(
    JSON.stringify(
      {
        ok: true,
        executablePath,
        tmpDir,
        check: "packaged_app_loaded"
      },
      null,
      2
    )
  );
} finally {
  await app.close();
}
