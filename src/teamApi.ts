import type { HermesTeamApi } from "./types";

const mobileTokenStorageKey = "hat.mobileToken";

function readMobileToken() {
  const params = new URLSearchParams(window.location.search);
  const tokenFromUrl = params.get("token") || "";
  if (tokenFromUrl) {
    window.localStorage.setItem(mobileTokenStorageKey, tokenFromUrl);
    params.delete("token");
    const nextQuery = params.toString();
    const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}${window.location.hash}`;
    window.history.replaceState({}, document.title, nextUrl);
    return tokenFromUrl;
  }
  return window.localStorage.getItem(mobileTokenStorageKey) || "";
}

async function callMobileApi(method: string, payload?: unknown) {
  const response = await fetch(`/api/team/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-HAT-Mobile-Token": readMobileToken()
    },
    body: JSON.stringify(payload || {})
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(String(body?.error || `手机端请求失败：${response.status}`));
  }
  return body;
}

const mobileHermesTeam: HermesTeamApi = {
  bootstrap: (payload) => callMobileApi("bootstrap", payload),
  refreshDataHealth: (payload) => callMobileApi("refresh-data-health", payload),
  repairDataHealth: (payload) => callMobileApi("repair-data-health", payload),
  openDataGovernancePath: (payload) => callMobileApi("open-data-governance-path", payload),
  createWorkspace: (payload) => callMobileApi("create-workspace", payload),
  deleteWorkspace: (payload) => callMobileApi("delete-workspace", payload),
  createChannel: (payload) => callMobileApi("create-channel", payload),
  deleteChannel: (payload) => callMobileApi("delete-channel", payload),
  createAgent: (payload) => callMobileApi("create-agent", payload),
  deleteAgent: (payload) => callMobileApi("delete-agent", payload),
  setAgentChannel: (payload) => callMobileApi("set-agent-channel", payload),
  updateAgentConfig: (payload) => callMobileApi("update-agent-config", payload),
  startTaskRun: (payload) => callMobileApi("start-task-run", payload),
  sendChannelMessage: (payload) => callMobileApi("send-channel-message", payload),
  runSlashCommand: (payload) => callMobileApi("run-slash-command", payload),
  confirmTaskCleanup: (payload) => callMobileApi("confirm-task-cleanup", payload),
  runSandboxQuickAction: (payload) => callMobileApi("run-sandbox-quick-action", payload),
  startDiscussion: (payload) => callMobileApi("start-discussion", payload),
  respondDiscussion: (payload) => callMobileApi("respond-discussion", payload),
  continueDiscussion: (payload) => callMobileApi("continue-discussion", payload),
  approveDiscussionRounds: (payload) => callMobileApi("approve-discussion-rounds", payload),
  closeDiscussion: (payload) => callMobileApi("close-discussion", payload),
  testRuntimeLockLifecycle: (payload) => callMobileApi("test-runtime-lock-lifecycle", payload),
  testTaskDiscussionBridgeReliability: (payload) => callMobileApi("test-task-discussion-bridge-reliability", payload),
  testReliabilityClosure: (payload) => callMobileApi("test-reliability-closure", payload),
  testDataGovernance: (payload) => callMobileApi("test-data-governance", payload)
};

export const isMobileWebClient = !window.hermesTeam;
export const teamApi = window.hermesTeam || mobileHermesTeam;
