import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-agent-team-mobile-"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

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
  const desktopPage = await app.firstWindow();
  await desktopPage.waitForSelector(".app-shell", { timeout: 20000 });
  const state = await desktopPage.evaluate(() => window.hermesTeam.bootstrap());
  const mobileUrl = state.mobileServer.url;
  assert(mobileUrl, `mobile URL missing: ${JSON.stringify(state.mobileServer)}`);

  const parsed = new URL(mobileUrl);
  const origin = parsed.origin;
  const token = parsed.searchParams.get("token") || "";
  assert(token, "mobile URL is missing token");

  const unauthorized = await fetch(`${origin}/api/mobile/status`);
  assert(unauthorized.status === 401, `expected 401 without token, got ${unauthorized.status}`);

  const authorized = await fetch(`${origin}/api/mobile/status?token=${encodeURIComponent(token)}`);
  assert(authorized.status === 200, `expected 200 with token, got ${authorized.status}`);

  const bootstrap = await fetch(`${origin}/api/team/bootstrap`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-HAT-Mobile-Token": token
    },
    body: "{}"
  });
  const bootstrapBody = await bootstrap.json();
  assert(bootstrap.status === 200, `mobile bootstrap failed: ${bootstrap.status}`);
  assert(bootstrapBody.mobileServer?.enabled, "mobile bootstrap did not return enabled server state");

  const beforeWindowCount = (await app.windows()).length;
  await app.evaluate(async ({ BrowserWindow }, url) => {
    const win = new BrowserWindow({
      show: false,
      width: 390,
      height: 844,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    await win.loadURL(url);
  }, mobileUrl);

  let pages = await app.windows();
  const deadline = Date.now() + 10000;
  while (pages.length <= beforeWindowCount && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    pages = await app.windows();
  }

  const mobilePage = pages[pages.length - 1];
  await mobilePage.waitForSelector(".app-shell.mobile-client", { timeout: 20000 });
  const metrics = await mobilePage.evaluate(() => {
    const send = document.querySelector('.composer-row button[type="submit"]')?.getBoundingClientRect();
    return {
      hasDesktopApi: Boolean(window.hermesTeam),
      className: document.querySelector(".app-shell")?.className || "",
      hasError: Boolean(document.querySelector(".error-strip")),
      bodyWidth: document.body.scrollWidth,
      innerWidth,
      sendVisible: send ? send.top >= 0 && send.bottom <= innerHeight : true,
      title: document.querySelector(".chat-head h1")?.textContent?.trim() || ""
    };
  });

  assert(!metrics.hasDesktopApi, `mobile browser window still has desktop IPC: ${JSON.stringify(metrics)}`);
  assert(!metrics.hasError, `mobile browser mode rendered an error: ${JSON.stringify(metrics)}`);
  assert(metrics.bodyWidth <= metrics.innerWidth + 2, `mobile browser horizontal overflow: ${JSON.stringify(metrics)}`);
  assert(metrics.sendVisible, `mobile send button is not visible: ${JSON.stringify(metrics)}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        tmpDir,
        mobileUrl,
        auth: {
          unauthorized: unauthorized.status,
          authorized: authorized.status,
          bootstrap: bootstrap.status
        },
        metrics
      },
      null,
      2
    )
  );
} finally {
  await app.close();
}
