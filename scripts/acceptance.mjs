import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const appMode = process.env.HAT_ACCEPTANCE_APP_MODE === "dev" ? "dev" : "packaged";
const executablePath = path.join(
  root,
  "release",
  "mac-arm64",
  "Hermes Agent Team.app",
  "Contents",
  "MacOS",
  "Hermes Agent Team"
);

async function launchApp(env) {
  const userDataDir = env.HAT_DATA_DIR
    ? path.join(env.HAT_DATA_DIR, "electron-user-data")
    : path.join(os.tmpdir(), `hat-electron-user-data-${Date.now()}`);
  if (appMode === "dev") {
    return electron.launch({
      args: [".", `--user-data-dir=${userDataDir}`],
      cwd: root,
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
        ...env
      }
    });
  }
  try {
    await fs.access(executablePath);
  } catch {
    throw new Error("Packaged acceptance requires release/mac-arm64. Run `npm run pack:mac` before `npm run acceptance:packaged`.");
  }
  return electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataDir}`],
    env: {
      HOME: process.env.HOME,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      ...env
    }
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(page, fn, timeoutMs = 60000, arg = undefined) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await page.evaluate(fn, arg);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("waitFor timed out");
}

async function runMockAcceptance() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hat-acceptance-mock-"));
  const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const appSource = await fs.readFile(path.join(root, "src", "App.tsx"), "utf8");
  const builderConfig = await fs.readFile(path.join(root, "electron-builder.yml"), "utf8");
  await fs.access(path.join(root, "build", "icon.icns"));
  assert(packageJson.author, "package.json must declare an author to avoid release metadata warnings");
  assert(builderConfig.includes("icon: build/icon.icns"), "electron-builder mac config must declare build/icon.icns");
  assert(
    packageJson.scripts?.["release:check"]?.includes("pack:mac") &&
      packageJson.scripts?.["release:check"]?.includes("acceptance:packaged"),
    "release:check must gate release with pack:mac and acceptance:packaged"
  );
  assert(
    appSource.includes("window.confirm") && appSource.includes("action.destructive"),
    "destructive sandbox actions must require UI confirmation"
  );
  assert(
    appSource.includes("repairMode") &&
      appSource.includes("修复profile") &&
      appSource.includes("全部修复"),
    "data health UI must expose clear database/profile/all repair actions"
  );
  const app = await launchApp({
    HAT_DATA_DIR: tmpDir,
    HAT_HERMES_MODE: "mock",
    HAT_MOCK_AGENT_ACTIONS: "1",
    HAT_MOCK_AGENT_DELAY_MS: "1200",
    HAT_MOCK_CONTEXT_ASSERTIONS: "1",
    HAT_TEST_HOOKS: "1"
  });
  try {
    const page = await app.firstWindow({ timeout: 180000 });
    await page.waitForSelector(".app-shell", { timeout: 20000 });

    const result = await page.evaluate(async () => {
      let state = await window.hermesTeam.bootstrap({});

      state = await window.hermesTeam.createWorkspace({ name: "验收空间 A" });
      const workspaceA = state.workspaces.find((item) => item.name === "验收空间 A");
      const channelA = state.channels.find((item) => item.workspace_id === workspaceA.id);
      let primary = state.agents.find(
        (agent) => agent.workspace_id === workspaceA.id && agent.agent_kind === "task" && agent.is_primary === 1
      );
      const discussionLead = state.agents.find(
        (agent) => agent.workspace_id === workspaceA.id && agent.agent_kind === "discussion" && agent.is_primary === 1
      );

      await window.hermesTeam.createWorkspace({ name: "验收空间 B" });
      state = await window.hermesTeam.bootstrap({ workspaceId: workspaceA.id, channelId: channelA.id });
      state = await window.hermesTeam.updateAgentConfig({
        agentId: primary.id,
        channelId: channelA.id,
        coreCommand: "验收底层命令：先确认目标、约束和交付物。",
        modelName: "mock-primary-model"
      });
      primary = state.agents.find((agent) => agent.id === primary.id);

      state = await window.hermesTeam.createAgent({
        workspaceId: workspaceA.id,
        channelId: channelA.id,
        name: "手动下级",
        role: "Sub Agent",
        description: "验收用手动下级",
        parentAgentId: primary.id
      });
      const manualChild = state.agents.find((agent) => agent.name === "手动下级");

      let directChildBlocked = false;
      try {
        await window.hermesTeam.startTaskRun({
          workspaceId: workspaceA.id,
          channelId: channelA.id,
          primaryAgentId: manualChild.id,
          objective: "越权命令应被拦截"
        });
      } catch {
        directChildBlocked = true;
      }

      await window.hermesTeam.startTaskRun({
        workspaceId: workspaceA.id,
        channelId: channelA.id,
        primaryAgentId: primary.id,
        objective: "请创建并委派一个自动研究员"
      });

      return {
        workspaceId: workspaceA.id,
        channelId: channelA.id,
        workspaceCount: state.workspaces.length,
        primaryId: primary.id,
        autoTaskLeadName: primary.name,
        autoDiscussionLeadId: discussionLead?.id || null,
        autoDiscussionLeadName: discussionLead?.name || "",
        primaryCoreCommand: primary.core_command,
        primaryModelName: primary.model_name,
        manualChildId: manualChild.id,
        directChildBlocked
      };
    });

    assert(result.workspaceCount >= 2, "multiple workspaces were not created");
    assert(result.primaryId && result.autoTaskLeadName, "task lead agent was not auto-created");
    assert(result.autoDiscussionLeadId && result.autoDiscussionLeadName, "discussion leader agent was not auto-created");
    assert(result.primaryCoreCommand.includes("验收底层命令"), "primary agent core command was not updated");
    assert(result.primaryModelName === "mock-primary-model", "primary agent model was not updated");
    assert(result.manualChildId, "manual child agent was not created");
    assert(result.directChildBlocked, "human direct command to child was not blocked");

    const delegated = await waitFor(page, (scope) =>
      window.hermesTeam.bootstrap({ workspaceId: scope.workspaceId, channelId: scope.channelId }).then((state) => {
        const autoChild = state.agents.find((agent) => agent.name === "自动研究员");
        const delegatedCommand = state.messages.find(
          (message) => message.sender_type === "agent" && message.mode === "task" && message.content.includes("CHILD_DELEGATION_OK")
        );
        const childReply = autoChild
          ? state.messages.find((message) => message.sender_type === "agent" && message.sender_id === autoChild.id)
          : null;
        const taskRun = state.taskRuns.find((task) => task.status === "awaiting_confirmation");
        const taskEvidenceItems = taskRun
          ? state.evidenceItems.filter((item) => item.task_run_id === taskRun.id)
          : [];
	        const agentReplyEvidence = taskEvidenceItems.find((item) => item.kind === "agent_reply");
	        const agentReplyMetadata = agentReplyEvidence ? JSON.parse(agentReplyEvidence.metadata_json || "{}") : {};
	        const blackboardSchema = state.blackboardEntries.find((item) => item.key === "blackboard_schema");
	        const structuredBlackboard = state.blackboardEntries.find((item) => item.key === "blackboard:v0.1");
	        const structuredBlackboardValue = structuredBlackboard ? JSON.parse(structuredBlackboard.value || "{}") : {};
	        return autoChild && delegatedCommand && childReply && taskRun
	          ? {
              autoChildId: autoChild.id,
              autoChildTemporary: autoChild.is_temporary === 1,
              autoChildCoreCommand: autoChild.core_command,
              autoChildModelName: autoChild.model_name,
              delegatedCommandId: delegatedCommand.id,
              childReplyId: childReply.id,
              taskRunId: taskRun.id,
              temporaryAgentCount: taskRun.temporary_agent_count,
              evidenceKinds: taskEvidenceItems.map((item) => item.kind),
              agentReplyExecution: agentReplyMetadata.execution || null,
	              agentReplyPrompt: agentReplyMetadata.prompt || null,
	              agentReplyOutput: agentReplyMetadata.output || null,
		              blackboardKeys: state.blackboardEntries.map((item) => item.key),
		              blackboardSchemaValue: blackboardSchema?.value || "",
		              structuredBlackboardFacts: structuredBlackboardValue.facts || [],
              structuredBlackboardLocks: structuredBlackboardValue.locks || [],
		              structuredBlackboardOutputs: structuredBlackboardValue.outputs || [],
              runtimeLocks: state.runtimeLocks,
		              contentAssetTypes: state.contentAssets.map((item) => item.asset_type),
	              teamStatePath: state.teamStatePath,
	              contentArchivePath: state.contentArchivePath
            }
          : null;
      }),
      60000,
      { workspaceId: result.workspaceId, channelId: result.channelId }
    );

    assert(delegated.autoChildId, "primary agent did not create an automatic child");
    assert(delegated.autoChildTemporary, "automatic child was not marked temporary");
    assert(
      delegated.autoChildCoreCommand.includes("结构化研究") && delegated.autoChildModelName === "mock-research-model",
      "primary agent-created child did not keep core command and model preference"
    );
    assert(delegated.delegatedCommandId, "primary agent did not delegate to child");
    assert(delegated.childReplyId, "child agent did not reply to parent delegation");
    assert(delegated.temporaryAgentCount >= 1, "task run did not count temporary agents");
    assert(delegated.evidenceKinds.includes("task_start"), "task start was not recorded in Evidence Pack");
    assert(delegated.evidenceKinds.includes("create_agent"), "agent creation was not recorded in Evidence Pack");
    assert(delegated.evidenceKinds.includes("delegate"), "delegation was not recorded in Evidence Pack");
    assert(delegated.evidenceKinds.includes("agent_reply"), "agent reply was not recorded in Evidence Pack");
    assert(delegated.agentReplyExecution?.engine === "hermes", "agent reply evidence did not record execution engine");
    assert(delegated.agentReplyExecution?.profile, "agent reply evidence did not record profile");
    assert(delegated.agentReplyPrompt?.sha256, "agent reply evidence did not record prompt hash");
    assert(delegated.agentReplyOutput?.chars > 0, "agent reply evidence did not record output length");
	    assert(delegated.blackboardKeys.includes("current_task"), "current task was not written to Blackboard");
	    assert(delegated.blackboardKeys.includes("blackboard_schema"), "Blackboard schema was not written");
	    assert(delegated.blackboardKeys.includes("blackboard:v0.1"), "structured Blackboard state was not written");
	    assert(
	      ["facts", "assumptions", "decisions", "risks", "open_questions", "locks", "outputs"].every((field) =>
	        delegated.blackboardSchemaValue.includes(field)
	      ),
	      "Blackboard schema did not include required fields"
	    );
		    assert(delegated.structuredBlackboardFacts.length > 0, "structured Blackboard did not record task facts");
        assert(
          delegated.runtimeLocks.some(
            (lock) => lock.owner_type === "task_run" && lock.owner_id === delegated.taskRunId && lock.status === "released"
          ),
          "task runtime lock was not released after task result"
        );
		    assert(delegated.structuredBlackboardOutputs.length > 0, "structured Blackboard did not record task outputs");
	    assert(delegated.contentAssetTypes.includes("human_task_request"), "human task request was not saved as a content asset");
    assert(delegated.contentAssetTypes.includes("task_agent_output"), "task agent output was not saved as a content asset");
    assert(delegated.contentAssetTypes.includes("task_final_output"), "task final output was not saved as a content asset");
    assert(delegated.teamStatePath, "team_state path was not returned");
    assert(delegated.contentArchivePath, "content archive path was not returned");
    await fs.access(delegated.teamStatePath);
    await fs.access(delegated.contentArchivePath);

    const lockLifecycle = await page.evaluate((scope) => {
      if (!window.hermesTeam.testRuntimeLockLifecycle) return null;
      return window.hermesTeam.testRuntimeLockLifecycle({
        workspaceId: scope.workspaceId,
        channelId: scope.channelId
      });
    }, result);
    assert(lockLifecycle, "runtime lock lifecycle test hook was unavailable");
    assert(
      lockLifecycle.statuses.join(">").includes("active>suspect>active>suspect>stale"),
      `runtime lock lifecycle did not use suspect/grace before stale: ${lockLifecycle.statuses.join(">")}`
    );
    assert(lockLifecycle.riskCount >= 2, "runtime lock suspect/reap events were not audited");

    const bridgeReliability = await page.evaluate((scope) => {
      if (!window.hermesTeam.testTaskDiscussionBridgeReliability) return null;
      return window.hermesTeam.testTaskDiscussionBridgeReliability({
        workspaceId: scope.workspaceId,
        channelId: scope.channelId,
        primaryAgentId: scope.primaryId
      });
    }, result);
    assert(bridgeReliability, "task discussion bridge reliability test hook was unavailable");
    assert(bridgeReliability.timedOutCount >= 1, "waiting discussion watchdog did not reap timed-out link");
    assert(bridgeReliability.linkStatus === "timeout", "waiting discussion link was not marked timeout");
    assert(
      bridgeReliability.taskStatus === "awaiting_confirmation" &&
        bridgeReliability.taskFinalOutput.includes("讨论求助超时"),
      "waiting discussion timeout did not wake task into fallback confirmation"
    );
    assert(bridgeReliability.timeoutEvidence, "waiting discussion timeout was not recorded in Evidence Pack");
	    assert(bridgeReliability.driftDetected, "discussion wakeup drift validator did not detect changed snapshot");
	    assert(bridgeReliability.duplicateBlocked, "block fingerprint did not identify repeated blocker");
	    assert(bridgeReliability.discussCount === 1 && bridgeReliability.countLimitWouldBlock, "discussion help count guard was not observable");

	    const reliabilityClosure = await page.evaluate((scope) => {
	      if (!window.hermesTeam.testReliabilityClosure) return null;
	      return window.hermesTeam.testReliabilityClosure({
	        workspaceId: scope.workspaceId,
	        channelId: scope.channelId,
	        primaryAgentId: scope.primaryId
	      });
	    }, result);
	    assert(reliabilityClosure, "reliability closure test hook was unavailable");
	    assert(reliabilityClosure.oscillationStatus === "stale", "lock oscillation guard did not force stale release");
		    assert(
		      reliabilityClosure.oscillationSuspectCount > 3,
		      "lock oscillation guard did not count repeated suspect entries"
		    );
	    assert(
	      reliabilityClosure.decayedStatus === "suspect" && reliabilityClosure.decayedSuspectCount === 1,
	      "lock suspect decay did not reset old oscillation count"
	    );
		    assert(reliabilityClosure.snapshotWithinLimit, "execution snapshot exceeded the 50KB hard limit");
		    assert(reliabilityClosure.snapshotExcludedNodeModules, "execution snapshot did not exclude node_modules paths");
		    assert(reliabilityClosure.takeoverEvidence, "sandbox takeover quick action did not write evidence");
	    assert(reliabilityClosure.copyCommandEvidence, "sandbox copy-command fallback did not write evidence");
		    assert(
		      reliabilityClosure.quickActions.some((action) => action.id === "takeover") &&
	        reliabilityClosure.quickActions.some((action) => action.id === "copy_command") &&
		        reliabilityClosure.quickActions.some((action) => action.id === "cleanup_sandbox"),
		      "sandbox protocol did not expose quick actions"
		    );
	    assert(
	      reliabilityClosure.gcExemptPreserved && reliabilityClosure.gcExemptSkipped,
	      "sandbox GC did not preserve an awaiting-confirmation sandbox"
	    );
	    assert(reliabilityClosure.gcPruned >= 1 && reliabilityClosure.gcPathRemoved, "sandbox GC did not prune stale sandbox");

	    const dataGovernance = await page.evaluate((scope) => {
	      if (!window.hermesTeam.testDataGovernance) return null;
	      return window.hermesTeam.testDataGovernance({
	        workspaceId: scope.workspaceId,
	        channelId: scope.channelId
	      });
	    }, result);
	    assert(dataGovernance, "data governance test hook was unavailable");
	    assert(dataGovernance.beforeOrphanRows > 0, "data governance did not detect injected orphan rows");
	    assert(dataGovernance.beforeForeignKeyFailures > 0, "data governance did not detect foreign key failures");
	    assert(dataGovernance.repairMode === "database", "data governance DB repair did not use explicit database mode");
	    assert(dataGovernance.backupExists && dataGovernance.backupPath, "data governance did not create a rollback backup");
	    assert(dataGovernance.backupSizeBytes > 0, "data governance backup was empty");
	    assert(dataGovernance.backupQuickCheck === "ok", "data governance backup did not pass SQLite quick_check");
	    assert(dataGovernance.backupRetentionOk, "data governance backup rotation did not enforce retention");
	    assert(dataGovernance.goldenBackupExists && dataGovernance.goldenBackupPath, "data governance did not preserve a golden backup");
	    assert(dataGovernance.backupIntegrityRejected, "data governance did not reject an unreadable or empty backup");
	    assert(dataGovernance.sqliteConnectionRejected, "data governance did not reject a corrupted SQLite backup");
	    assert(dataGovernance.repairCooldownBlocked, "data governance repair cooldown was not enforced");
	    assert(dataGovernance.persistedCooldownBlocked, "data governance repair cooldown was not persisted across memory reset");
	    assert(
	      dataGovernance.diskFullMessage.includes("磁盘空间不足"),
	      "data governance did not translate disk-full errors into a user-facing diagnostic"
	    );
	    assert(dataGovernance.profileArchiveDirExists, "data governance profile archive directory was not created");
	    const archiveOpen = await page.evaluate(() => window.hermesTeam.openDataGovernancePath({ kind: "profile_archive", dryRun: true }));
	    assert(
	      archiveOpen?.ok && archiveOpen.path === dataGovernance.profileArchiveDir,
	      "data governance archive directory open action did not resolve the profile archive directory"
	    );
	    assert(dataGovernance.deletedTotal > 0, "data governance repair did not delete orphan rows");
	    assert(dataGovernance.afterOrphanRows === 0, "data governance repair left orphan rows");
	    assert(dataGovernance.afterForeignKeyFailures === 0, "data governance repair left foreign key failures");

	    const cleanup = await page.evaluate(async (scope) => {
      let state = await window.hermesTeam.bootstrap({ workspaceId: scope.workspaceId, channelId: scope.channelId });
      const taskRun = state.taskRuns.find((task) => task.id === scope.taskRunId);
      if (!taskRun) throw new Error("task run not found");
      state = await window.hermesTeam.confirmTaskCleanup({ taskRunId: taskRun.id });
      const currentTaskState = state.blackboardEntries.find((item) => item.key === "current_task");
      return {
        autoChildGone: !state.agents.some((agent) => agent.name === "自动研究员"),
        manualChildStillExists: state.agents.some((agent) => agent.id === scope.manualChildId),
        outputRetained: state.messages.some((message) => message.sender_name === "自动研究员"),
        taskCleaned: state.taskRuns.some((task) => task.id === taskRun.id && task.status === "cleaned"),
        cleanupEvidence: state.evidenceItems.some((item) => item.task_run_id === taskRun.id && item.kind === "task_cleanup"),
        currentTaskCleaned: currentTaskState?.value.includes("cleaned") || false
      };
    }, { workspaceId: result.workspaceId, channelId: result.channelId, taskRunId: delegated.taskRunId, manualChildId: result.manualChildId });
    assert(cleanup.autoChildGone, "temporary task agent was not cleaned");
    assert(cleanup.manualChildStillExists, "long-term manual child was deleted during cleanup");
    assert(cleanup.outputRetained, "temporary agent output was not retained after cleanup");
	    assert(cleanup.taskCleaned, "task run was not marked cleaned");
	    assert(cleanup.cleanupEvidence, "task cleanup was not recorded in Evidence Pack");
	    assert(cleanup.currentTaskCleaned, "Blackboard current task was not marked cleaned");

    await page.evaluate(async (scope) => {
      await window.hermesTeam.startTaskRun({
        workspaceId: scope.workspaceId,
        channelId: scope.channelId,
        primaryAgentId: scope.primaryId,
        objective: "CODE_SANDBOX_PROTOCOL_CHECK 修改 Electron runtime"
      });
    }, result);

    const sandboxTask = await waitFor(page, (scope) =>
      window.hermesTeam.bootstrap({ workspaceId: scope.workspaceId, channelId: scope.channelId }).then((state) => {
        const taskRun = state.taskRuns.find((task) => task.objective === "CODE_SANDBOX_PROTOCOL_CHECK 修改 Electron runtime");
        if (!taskRun || taskRun.status !== "awaiting_confirmation") return null;
        const sandboxEvidence = state.evidenceItems.find(
          (item) => item.task_run_id === taskRun.id && item.kind === "execution_sandbox_protocol"
        );
        const sandboxMeta = sandboxEvidence ? JSON.parse(sandboxEvidence.metadata_json || "{}") : {};
        const sandboxBlackboard = state.blackboardEntries.find((item) => item.key === `task:${taskRun.id}:execution_sandbox`);
        return sandboxEvidence && sandboxBlackboard
          ? {
              taskRunId: taskRun.id,
              sandboxPath: sandboxMeta.sandboxPath || "",
              protocolPath: sandboxMeta.protocolPath || "",
              worktreePath: sandboxMeta.worktreePath || "",
              evidenceContent: sandboxEvidence.content
            }
          : null;
      }),
      60000,
      { workspaceId: result.workspaceId, channelId: result.channelId }
    );
    assert(sandboxTask.sandboxPath.includes("task_sandboxes"), "sandbox path was not created under task_sandboxes");
    assert(sandboxTask.worktreePath.includes("worktree"), "sandbox protocol did not include a recommended worktree path");
    assert(sandboxTask.evidenceContent.includes("Suggested Commands"), "sandbox protocol did not include takeover commands");
    await fs.access(sandboxTask.protocolPath);
    await page.evaluate((scope) => window.hermesTeam.confirmTaskCleanup({ taskRunId: scope.taskRunId }), sandboxTask);

	    await page.evaluate(async (scope) => {
	      await window.hermesTeam.startTaskRun({
	        workspaceId: scope.workspaceId,
	        channelId: scope.channelId,
	        primaryAgentId: scope.primaryId,
	        objective: "TASK_DISCUSSION_HELP_CHECK"
	      });
	    }, result);

	    const taskDiscussionHelp = await waitFor(page, (scope) =>
	      window.hermesTeam.bootstrap({ workspaceId: scope.workspaceId, channelId: scope.channelId }).then((state) => {
	        const taskRun = state.taskRuns.find((task) => task.objective === "TASK_DISCUSSION_HELP_CHECK");
	        if (!taskRun || taskRun.status !== "awaiting_confirmation") return null;
	        const evidenceKinds = state.evidenceItems
	          .filter((item) => item.task_run_id === taskRun.id)
	          .map((item) => item.kind);
	        const link = state.taskDiscussionLinks.find((item) => item.task_run_id === taskRun.id);
	        const linkSnapshot = link ? JSON.parse(link.execution_snapshot || "{}") : {};
	        const discussion = link
	          ? state.discussionRuns.find((item) => item.id === link.discussion_id)
	          : state.discussionRuns.find((item) => item.topic.includes("TASK_DISCUSSION_HELP_CHECK"));
	        const decisionRecord = discussion
	          ? state.decisionRecords.find((record) => record.discussion_id === discussion.id)
	          : null;
	        const resumed = state.messages.some((message) => message.content.includes("TASK_DISCUSSION_HELP_RESULT"));
	        const used = state.messages.some((message) => message.content.includes("TASK_DISCUSSION_HELP_USED"));
	        const taskHelpBlackboard = state.blackboardEntries.find((item) => item.key === `task:${taskRun.id}:discussion_help`);
	        return link && discussion && decisionRecord && resumed && used
	          ? {
	              taskRunStatus: taskRun.status,
	              finalOutput: taskRun.final_output,
	              evidenceKinds,
	              linkStatus: link.status,
	              linkExpiresAt: link.expires_at || "",
	              linkFingerprint: link.block_fingerprint || "",
		              linkDiscussCount: Number(link.discuss_count || 0),
		              linkSnapshot,
		              discussionStatus: discussion.status,
		              decisionStatus: decisionRecord.status,
		              usedDiscussionHelpResult: used,
		              hasTaskHelpBlackboard: Boolean(taskHelpBlackboard)
		            }
	          : null;
	      }),
	      90000,
	      { workspaceId: result.workspaceId, channelId: result.channelId }
		    );
		    assert(taskDiscussionHelp.taskRunStatus === "awaiting_confirmation", "task discussion help did not resume task");
		    assert(taskDiscussionHelp.usedDiscussionHelpResult, "task lead did not use discussion help result");
	    assert(taskDiscussionHelp.evidenceKinds.includes("discussion_help_request"), "discussion help request was not recorded");
	    assert(taskDiscussionHelp.evidenceKinds.includes("discussion_help_result"), "discussion help result was not recorded");
	    assert(taskDiscussionHelp.evidenceKinds.includes("discussion_help_resume"), "discussion help resume was not recorded");
	    assert(taskDiscussionHelp.linkStatus === "resolved", "task discussion link was not resolved");
	    assert(taskDiscussionHelp.linkExpiresAt, "task discussion link did not keep expires_at");
	    assert(taskDiscussionHelp.linkFingerprint, "task discussion link did not keep block fingerprint");
	    assert(taskDiscussionHelp.linkDiscussCount === 1, "task discussion link did not keep discuss count");
	    assert(taskDiscussionHelp.linkSnapshot.git && taskDiscussionHelp.linkSnapshot.blocker, "task discussion link did not keep execution snapshot");
	    assert(taskDiscussionHelp.discussionStatus === "closed", "task help discussion did not close");
	    assert(taskDiscussionHelp.decisionStatus === "final", "task help discussion did not produce final decision");
	    assert(taskDiscussionHelp.hasTaskHelpBlackboard, "task discussion help was not written to Blackboard");

	    const discussionSetup = await page.evaluate(async (scope) => {
      let state = await window.hermesTeam.bootstrap({ workspaceId: scope.workspaceId, channelId: scope.channelId });
      let taskAgentRejected = false;
      try {
        await window.hermesTeam.startDiscussion({
          workspaceId: state.activeWorkspaceId,
          channelId: state.activeChannelId,
          agentIds: [scope.primaryId, scope.manualChildId],
          topic: "任务 Agent 不应进入讨论",
          roundLimit: 2
        });
      } catch {
        taskAgentRejected = true;
      }

      state = await window.hermesTeam.createAgent({
        workspaceId: state.activeWorkspaceId,
        channelId: state.activeChannelId,
        name: "讨论顾问 A",
        role: "Market Perspective",
        description: "验收用讨论 Agent A",
        agentKind: "discussion"
      });
      const discussionA = state.agents.find((agent) => agent.name === "讨论顾问 A");

      state = await window.hermesTeam.createAgent({
        workspaceId: state.activeWorkspaceId,
        channelId: state.activeChannelId,
        name: "讨论顾问 B",
        role: "Risk Perspective",
        description: "验收用讨论 Agent B",
        agentKind: "discussion"
      });
      const discussionB = state.agents.find((agent) => agent.name === "讨论顾问 B");

      await window.hermesTeam.startDiscussion({
        workspaceId: state.activeWorkspaceId,
        channelId: state.activeChannelId,
        agentIds: [discussionA.id, discussionB.id],
        topic: "比较两个产品路线的风险与机会",
        discussionFramework: "premortem_risk",
        roundLimit: 2
      });
      return {
        taskAgentRejected,
        discussionAgentIds: [discussionA.id, discussionB.id]
      };
    }, result);
    assert(discussionSetup.taskAgentRejected, "task agents were allowed into discussion");
    assert(discussionSetup.discussionAgentIds.length === 2, "discussion agents were not created");

	    const concurrentStart = await waitFor(page, (scope) =>
	      window.hermesTeam.bootstrap({ workspaceId: scope.workspaceId, channelId: scope.channelId }).then((state) => {
	        const running = state.agents.filter(
	          (agent) => scope.discussionAgentIds.includes(agent.id) && agent.status === "running"
	        );
          const discussion = state.discussionRuns.find((item) => item.topic === "比较两个产品路线的风险与机会");
          const activeLock = discussion
            ? state.runtimeLocks.some(
                (lock) =>
                  lock.owner_type === "discussion_run" &&
                  lock.owner_id === discussion.id &&
                  lock.status === "active"
              )
            : false;
	        return running.length === scope.discussionAgentIds.length && activeLock;
	      }),
      3000,
      {
        workspaceId: result.workspaceId,
        channelId: result.channelId,
        discussionAgentIds: discussionSetup.discussionAgentIds
      }
    );
    assert(concurrentStart, "discussion agents did not start concurrently");

    const organizedDiscussion = await waitFor(page, (scope) =>
      window.hermesTeam.bootstrap({ workspaceId: scope.workspaceId, channelId: scope.channelId }).then((state) => {
        const discussion = state.discussionRuns.find((item) => item.topic === "比较两个产品路线的风险与机会");
        if (!discussion) return null;
        const frameworkMessage = state.messages.find((message) =>
          message.content.includes("Pre-mortem 风险")
        );
        const participants = state.discussionAgents.filter((item) => item.discussion_id === discussion.id);
        const organizer = state.agents.find((agent) => agent.id === discussion.organizer_agent_id);
        const organizerReply = state.messages.find(
          (message) => message.sender_id === discussion.organizer_agent_id && message.content.includes("阶段性汇总")
        );
        const decisionRecord = state.decisionRecords.find((record) => record.discussion_id === discussion.id);
        const temporaryDiscussionAgents = state.agents.filter(
          (agent) => agent.agent_kind === "discussion" && agent.is_temporary === 1
        );
        const discussionAgents = scope.discussionAgentIds.map((agentId) =>
          state.agents.find((agent) => agent.id === agentId)
        );
        return participants.length === 2 &&
          participants.every((item) => item.rounds_used >= 1) &&
          discussion.discussion_framework === "premortem_risk" &&
          frameworkMessage &&
          discussion.status === "closed" &&
          discussion.organizer_status === "final" &&
          discussion.organizer_agent_id &&
          organizerReply &&
          decisionRecord &&
          organizer &&
          organizer.agent_kind === "discussion" &&
          organizer.is_primary === 1 &&
          organizer.is_temporary === 0 &&
          temporaryDiscussionAgents.length === 0
          ? {
              discussionId: discussion.id,
              discussionFramework: discussion.discussion_framework,
              decisionStatus: decisionRecord.status,
              decisionFramework: decisionRecord.framework,
              participants,
	              organizerId: discussion.organizer_agent_id,
	              organizerPersistent: true,
              noActiveDiscussionLock: !state.runtimeLocks.some(
                (lock) =>
                  lock.owner_type === "discussion_run" &&
                  lock.owner_id === discussion.id &&
                  lock.status === "active"
              ),
	              contentAssetTypes: state.contentAssets.map((item) => item.asset_type),
              discussionAgentsIndependent: discussionAgents.every(
                (agent) => agent && agent.agent_kind === "discussion" && agent.is_temporary === 0
              )
            }
          : null;
      }),
      60000,
      {
        workspaceId: result.workspaceId,
        channelId: result.channelId,
        discussionAgentIds: discussionSetup.discussionAgentIds
      }
    );
    assert(organizedDiscussion.discussionId, "discussion organizer did not complete discussion");
    assert(organizedDiscussion.discussionFramework === "premortem_risk", "discussion framework was not persisted");
    assert(organizedDiscussion.decisionStatus === "final", "discussion Decision Record was not finalized");
	    assert(organizedDiscussion.decisionFramework === "Pre-mortem 风险预演", "discussion Decision Record did not keep framework");
	    assert(organizedDiscussion.organizerId && organizedDiscussion.organizerPersistent, "discussion leader was not kept persistent");
      assert(organizedDiscussion.noActiveDiscussionLock, "discussion runtime lock was not released after final decision");
    assert(
      organizedDiscussion.contentAssetTypes.includes("human_discussion_topic") &&
        organizedDiscussion.contentAssetTypes.includes("discussion_agent_output") &&
        organizedDiscussion.contentAssetTypes.includes("discussion_decision"),
      "discussion content was not saved as content assets"
    );
    assert(organizedDiscussion.discussionAgentsIndependent, "discussion agents were not kept independent");

    await page.evaluate(async (scope) => {
      await window.hermesTeam.startTaskRun({
        workspaceId: scope.workspaceId,
        channelId: scope.channelId,
        primaryAgentId: scope.primaryId,
        objective: "TASK_PRIVACY_CHECK TASK_VISIBLE_TO_DISCUSSION"
      });
    }, result);

    const taskPrivacy = await waitFor(page, (scope) =>
      window.hermesTeam.bootstrap({ workspaceId: scope.workspaceId, channelId: scope.channelId }).then((state) => ({
        clean: state.messages.some((message) => message.content.includes("TASK_CONTEXT_CLEAN")),
        leaked: state.messages.some((message) => message.content.includes("PRIVACY_LEAK"))
      })).then((result) => (result.clean || result.leaked ? result : null)),
      60000,
      { workspaceId: result.workspaceId, channelId: result.channelId }
    );
    assert(taskPrivacy.clean && !taskPrivacy.leaked, "task agent saw discussion-only context");

    await page.evaluate(async (scope) => {
      await window.hermesTeam.startDiscussion({
        workspaceId: scope.workspaceId,
        channelId: scope.channelId,
        agentIds: scope.discussionAgentIds,
        topic: "DISCUSSION_CAN_SEE_TASK_CHECK",
        roundLimit: 1
      });
    }, {
      workspaceId: result.workspaceId,
      channelId: result.channelId,
      discussionAgentIds: discussionSetup.discussionAgentIds
    });

    const discussionVisibility = await waitFor(page, (scope) =>
      window.hermesTeam.bootstrap({ workspaceId: scope.workspaceId, channelId: scope.channelId }).then((state) => ({
        seesTask: state.messages.some((message) => message.content.includes("DISCUSSION_CONTEXT_SEES_TASK")),
        missingTask: state.messages.some((message) => message.content.includes("DISCUSSION_CONTEXT_MISSING_TASK"))
      })).then((result) => (result.seesTask || result.missingTask ? result : null)),
      60000,
      { workspaceId: result.workspaceId, channelId: result.channelId }
    );
	    assert(
	      discussionVisibility.seesTask && !discussionVisibility.missingTask,
	      "discussion agent could not see task context"
	    );

    await waitFor(page, (scope) =>
      window.hermesTeam.bootstrap({ workspaceId: scope.workspaceId, channelId: scope.channelId }).then((state) => {
        const discussion = state.discussionRuns.find((item) => item.topic === "DISCUSSION_CAN_SEE_TASK_CHECK");
        return discussion?.status === "closed";
      }),
      60000,
      { workspaceId: result.workspaceId, channelId: result.channelId }
    );

    const agentContextDiscussion = await page.evaluate(async (scope) => {
      await window.hermesTeam.startDiscussion({
        workspaceId: scope.workspaceId,
        channelId: scope.channelId,
        agentIds: scope.discussionAgentIds,
        topic: "DISCUSSION_AGENT_CONTEXT_CHECK",
        roundLimit: 2
      });
      const state = await window.hermesTeam.bootstrap({ workspaceId: scope.workspaceId, channelId: scope.channelId });
      const discussion = state.discussionRuns.find((item) => item.topic === "DISCUSSION_AGENT_CONTEXT_CHECK");
      return { discussionId: discussion?.id || null };
    }, {
      workspaceId: result.workspaceId,
      channelId: result.channelId,
      discussionAgentIds: discussionSetup.discussionAgentIds
    });
    assert(agentContextDiscussion.discussionId, "discussion agent context check did not start");

    const agentContextFirstRound = await waitFor(page, (scope) =>
      window.hermesTeam.bootstrap({ workspaceId: scope.workspaceId, channelId: scope.channelId }).then((state) => {
        const participants = state.discussionAgents.filter((item) => item.discussion_id === scope.discussionId);
        const hasMarker = state.messages.some((message) =>
          message.content.includes("DISCUSSION_AGENT_CONTEXT_MARKER")
        );
        return participants.length === 2 && participants.every((item) => item.rounds_used >= 1) && hasMarker;
      }),
      60000,
      {
        workspaceId: result.workspaceId,
        channelId: result.channelId,
        discussionId: agentContextDiscussion.discussionId
      }
    );
    assert(agentContextFirstRound, "discussion first round did not create agent context marker");

    const agentContextSecondRound = await waitFor(page, (scope) =>
      window.hermesTeam.bootstrap({ workspaceId: scope.workspaceId, channelId: scope.channelId }).then((state) => {
        const participants = state.discussionAgents.filter((item) => item.discussion_id === scope.discussionId);
        const seesAgent = state.messages.some((message) =>
          message.content.includes("DISCUSSION_AGENT_CONTEXT_SEES_AGENT")
        );
        return participants.length === 2 && participants.every((item) => item.rounds_used >= 2) && seesAgent;
      }),
      60000,
      {
        workspaceId: result.workspaceId,
        channelId: result.channelId,
        discussionId: agentContextDiscussion.discussionId
      }
    );
	    assert(agentContextSecondRound, "discussion agent could not see prior agent messages");

    await waitFor(page, (scope) =>
      window.hermesTeam.bootstrap({ workspaceId: scope.workspaceId, channelId: scope.channelId }).then((state) => {
        const discussion = state.discussionRuns.find((item) => item.id === scope.discussionId);
        return discussion?.status === "closed";
      }),
      60000,
      {
        workspaceId: result.workspaceId,
        channelId: result.channelId,
        discussionId: agentContextDiscussion.discussionId
      }
    );

    const forcedDiscussion = await page.evaluate(async (scope) => {
      await window.hermesTeam.startDiscussion({
        workspaceId: scope.workspaceId,
        channelId: scope.channelId,
        agentIds: scope.discussionAgentIds,
        topic: "FORCE_CONTINUE_AT_LIMIT",
        roundLimit: 4
      });
      const state = await window.hermesTeam.bootstrap({ workspaceId: scope.workspaceId, channelId: scope.channelId });
      const discussion = state.discussionRuns.find((item) => item.topic === "FORCE_CONTINUE_AT_LIMIT");
      return { discussionId: discussion?.id || null };
    }, {
      workspaceId: result.workspaceId,
      channelId: result.channelId,
      discussionAgentIds: discussionSetup.discussionAgentIds
    });
    assert(forcedDiscussion.discussionId, "force convergence discussion did not start");

    const forcedConvergence = await waitFor(page, (scope) =>
      window.hermesTeam.bootstrap({ workspaceId: scope.workspaceId, channelId: scope.channelId }).then((state) => {
        const discussion = state.discussionRuns.find((item) => item.id === scope.discussionId);
        if (!discussion || discussion.status !== "closed") return null;
        const participants = state.discussionAgents.filter((item) => item.discussion_id === discussion.id);
        const decisionRecords = state.decisionRecords.filter((record) => record.discussion_id === discussion.id);
        const decisionRecord = decisionRecords.find((record) => record.status === "final") || decisionRecords[0];
        const forcedMessage = state.messages.some((message) => message.content.includes("系统要求 Leader 输出降级 Decision Record"));
        const activeLock = state.runtimeLocks.some(
          (lock) =>
            lock.owner_type === "discussion_run" &&
            lock.owner_id === discussion.id &&
            lock.status === "active"
        );
        return {
          participantsAtLimit: participants.length >= 2 && participants.every((item) => item.rounds_used >= 4),
          decisionStatus: decisionRecord?.status || "",
          decisionSummary: decisionRecord?.summary || "",
          decisionText: decisionRecord?.decision || "",
          forcedMessage,
          activeLock
        };
      }),
      60000,
      {
        workspaceId: result.workspaceId,
        channelId: result.channelId,
        discussionId: forcedDiscussion.discussionId
      }
    );
    assert(forcedConvergence.participantsAtLimit, "force convergence discussion did not reach round limit");
    assert(forcedConvergence.decisionStatus === "final", "force convergence did not produce final Decision Record");
    assert(forcedConvergence.forcedMessage, "force convergence system message was not written");
    assert(
      `${forcedConvergence.decisionSummary}\n${forcedConvergence.decisionText}`.includes("Safe Log") &&
        `${forcedConvergence.decisionSummary}\n${forcedConvergence.decisionText}`.includes("接管命令") &&
        `${forcedConvergence.decisionSummary}\n${forcedConvergence.decisionText}`.includes("回滚命令"),
      "force convergence Decision Record did not include Safe Log takeover/rollback fields"
    );
    assert(!forcedConvergence.activeLock, "force convergence left an active discussion lock");

    const slashChecks = await page.evaluate(async (scope) => {
      let state = await window.hermesTeam.runSlashCommand({
        workspaceId: scope.workspaceId,
        channelId: scope.channelId,
        mode: "task",
        command: "/status",
        primaryAgentId: scope.primaryId
      });
      const hasStatus = state.messages.some((message) => message.content.includes("命令 /status"));
      state = await window.hermesTeam.startTaskRun({
        workspaceId: scope.workspaceId,
        channelId: scope.channelId,
        primaryAgentId: scope.primaryId,
        objective: "ACCEPTANCE_STOP_TASK"
      });
      state = await window.hermesTeam.runSlashCommand({
        workspaceId: scope.workspaceId,
        channelId: scope.channelId,
        mode: "task",
        command: "/stop",
        primaryAgentId: scope.primaryId
      });
      await new Promise((resolve) => setTimeout(resolve, 1800));
      state = await window.hermesTeam.bootstrap({ workspaceId: scope.workspaceId, channelId: scope.channelId });
      return {
        hasStatus,
        stoppedTask: state.taskRuns.some(
          (task) => task.objective === "ACCEPTANCE_STOP_TASK" && task.status === "stopped"
        ),
        noRunningAgents: state.agents.every((agent) => agent.status !== "running"),
        noLateStopReply: !state.messages.some(
          (message) =>
            message.sender_type === "agent" &&
            message.created_at > state.taskRuns.find((task) => task.objective === "ACCEPTANCE_STOP_TASK")?.created_at &&
            message.content.includes("已收到。我会按当前层级处理这个任务。")
        )
      };
    }, result);
    assert(slashChecks.hasStatus, "slash /status did not write a command result");
    assert(slashChecks.stoppedTask, "slash /stop did not mark running task stopped");
    assert(slashChecks.noRunningAgents, "slash /stop left agents running");
    assert(slashChecks.noLateStopReply, "slash /stop allowed a late agent reply");

    return {
      ok: true,
      tmpDir,
      checks: [
        "workspace",
        "release_packaged_gate",
        "release_metadata_author_icon",
        "workspace_default_stream",
        "workspace_auto_task_and_discussion_leads",
        "manual_agents",
        "agent_config_update",
        "task_primary_permission",
	        "task_temp_agent_create_delegate_cleanup",
	        "task_discussion_help_bridge",
	        "task_discussion_agent_isolation",
        "discussion_agents_parallel_start",
        "task_context_hides_discussion",
        "discussion_context_sees_task",
        "discussion_context_sees_agent_messages",
        "discussion_leader_persistent",
        "discussion_leader_auto_summary",
	        "discussion_leader_auto_continue",
        "discussion_force_convergence",
        "runtime_locks_suspect_grace",
        "waiting_discussion_timeout",
        "discussion_wakeup_snapshot_restore",
	        "discussion_wakeup_drift_detected",
	        "block_fingerprint_prevents_loop",
	        "runtime_lock_oscillation_guard",
	        "runtime_lock_suspect_decay",
	        "execution_snapshot_io_trim",
	        "sandbox_gc_handoff_exemption",
	        "sandbox_gc_prune",
	        "sandbox_takeover_quick_action",
	        "sandbox_copy_command_fallback",
	        "sandbox_destructive_confirm",
	        "data_health_orphan_detection",
	        "data_health_repair_backup",
	        "data_health_backup_rotation",
	        "data_health_backup_integrity_gate",
	        "data_health_sqlite_backup_quick_check",
	        "data_health_golden_backup_preserved",
	        "data_health_repair_cooldown",
	        "data_health_repair_cooldown_persisted",
	        "data_health_disk_full_diagnostic",
	        "data_health_open_profile_archive",
	        "data_health_all_repair_ui",
	        "task_execution_sandbox_protocol",
	        "blackboard_state_snapshot",
        "task_evidence_pack",
        "discussion_decision_record",
        "content_assets_archive",
        "slash_status",
        "slash_stop"
      ]
    };
  } finally {
    await app.close();
  }
}

async function runLiveAcceptance() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hat-acceptance-live-"));
  const app = await launchApp({ HAT_DATA_DIR: tmpDir });
  let createdProfiles = [];
  try {
    const page = await app.firstWindow({ timeout: 180000 });
    await page.waitForSelector(".app-shell", { timeout: 180000 });

    const created = await page.evaluate(async () => {
      const initial = await window.hermesTeam.bootstrap({});
      if (initial.workspaces.length !== 0) throw new Error("live acceptance fresh launch created an unexpected default workspace");
      const state = await window.hermesTeam.createWorkspace({ name: "Live 验收空间" });
      const taskAgent = state.agents.find(
        (item) => item.workspace_id === state.activeWorkspaceId && item.agent_kind === "task" && item.is_primary === 1
      );
      const discussionLeader = state.agents.find(
        (item) =>
          item.workspace_id === state.activeWorkspaceId && item.agent_kind === "discussion" && item.is_primary === 1
      );
      if (!taskAgent || !discussionLeader) throw new Error("auto lead agents were not created");
      return {
        workspaceId: state.activeWorkspaceId,
        channelId: state.activeChannelId,
        agentId: taskAgent.id,
        discussionLeaderId: discussionLeader.id,
        profile: taskAgent.hermes_profile,
        discussionProfile: discussionLeader.hermes_profile,
        hermesPath: state.hermesPath
      };
    });
    createdProfiles = [created.profile, created.discussionProfile];
    assert(created.profile !== created.discussionProfile, "task lead and discussion leader must use different Hermes profiles");

    const profileDir = path.join(process.env.HOME, ".hermes", "profiles", created.profile);
    const discussionProfileDir = path.join(process.env.HOME, ".hermes", "profiles", created.discussionProfile);
    const marker = JSON.parse(await fs.readFile(path.join(profileDir, ".hermes-agent-team.json"), "utf8"));
    assert(marker.isolation?.profile === "new independent Hermes profile", "isolation marker invalid");
    const discussionMarker = JSON.parse(
      await fs.readFile(path.join(discussionProfileDir, ".hermes-agent-team.json"), "utf8")
    );
    assert(
      discussionMarker.agentConfig?.agentKind === "discussion",
      "discussion leader marker did not record discussion kind"
    );

    const liveRun = await page.evaluate(async (created) => {
      await window.hermesTeam.startTaskRun({
        workspaceId: created.workspaceId,
        channelId: created.channelId,
        primaryAgentId: created.agentId,
        objective: "只回复 HAT_ACCEPTANCE_LIVE_OK，并在动作 JSON 中使用空 actions。"
      });
      let state = null;
      let hasReply = false;
      let hasTaskResult = false;
      for (let i = 0; i < 90; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        state = await window.hermesTeam.bootstrap({
          workspaceId: created.workspaceId,
          channelId: created.channelId
        });
        hasReply = state.messages.some(
          (message) => message.sender_type === "agent" && message.sender_id === created.agentId
        );
        hasTaskResult = state.taskRuns.some((task) => ["awaiting_confirmation", "failed"].includes(task.status));
        if (hasReply && hasTaskResult) break;
      }
      if (!state) {
        state = await window.hermesTeam.bootstrap({
          workspaceId: created.workspaceId,
          channelId: created.channelId
        });
      }
      const taskRun = state.taskRuns.find((task) => ["awaiting_confirmation", "failed"].includes(task.status));
      if (taskRun) await window.hermesTeam.confirmTaskCleanup({ taskRunId: taskRun.id });
      return { hasReply, hasTaskResult };
    }, created);
    assert(liveRun.hasReply, "live agent did not reply");
    assert(liveRun.hasTaskResult, "live task did not reach a result state");

    const liveConfigUpdate = await page.evaluate(async (created) => {
      let state = await window.hermesTeam.updateAgentConfig({
        agentId: created.agentId,
        channelId: created.channelId,
        coreCommand: "LIVE_ACCEPTANCE_CORE_COMMAND",
        modelName: "live-marker-model"
      });
      state = await window.hermesTeam.updateAgentConfig({
        agentId: created.discussionLeaderId,
        channelId: created.channelId,
        coreCommand: "LIVE_ACCEPTANCE_DISCUSSION_LEADER_COMMAND",
        modelName: "live-discussion-model"
      });
      const agent = state.agents.find((item) => item.id === created.agentId);
      const discussionLeader = state.agents.find((item) => item.id === created.discussionLeaderId);
      return {
        coreCommand: agent?.core_command || "",
        modelName: agent?.model_name || "",
        discussionCoreCommand: discussionLeader?.core_command || "",
        discussionModelName: discussionLeader?.model_name || ""
      };
    }, created);
    assert(liveConfigUpdate.coreCommand === "LIVE_ACCEPTANCE_CORE_COMMAND", "live agent core command was not updated");
    assert(liveConfigUpdate.modelName === "live-marker-model", "live agent model was not updated");
    assert(
      liveConfigUpdate.discussionCoreCommand === "LIVE_ACCEPTANCE_DISCUSSION_LEADER_COMMAND",
      "live discussion leader core command was not updated"
    );
    assert(liveConfigUpdate.discussionModelName === "live-discussion-model", "live discussion leader model was not updated");
    const updatedMarker = JSON.parse(await fs.readFile(path.join(profileDir, ".hermes-agent-team.json"), "utf8"));
    assert(updatedMarker.agentConfig?.coreCommand === "LIVE_ACCEPTANCE_CORE_COMMAND", "live marker core command was not updated");
    assert(updatedMarker.agentConfig?.modelName === "live-marker-model", "live marker model was not updated");
    const updatedDiscussionMarker = JSON.parse(
      await fs.readFile(path.join(discussionProfileDir, ".hermes-agent-team.json"), "utf8")
    );
    assert(
      updatedDiscussionMarker.agentConfig?.coreCommand === "LIVE_ACCEPTANCE_DISCUSSION_LEADER_COMMAND",
      "live discussion marker core command was not updated"
    );
    assert(
      updatedDiscussionMarker.agentConfig?.modelName === "live-discussion-model",
      "live discussion marker model was not updated"
    );

    await page.evaluate(async (created) => {
      await window.hermesTeam.deleteWorkspace({ workspaceId: created.workspaceId });
    }, created);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const postDelete = await page.evaluate(async () => window.hermesTeam.bootstrap({}));
    assert(postDelete.workspaces.length === 0, "workspace was not removed after delete");
    assert(postDelete.agents.length === 0, "agents were not removed after workspace delete");
    for (const profile of createdProfiles) {
      const currentDir = path.join(process.env.HOME, ".hermes", "profiles", profile);
      try {
        await fs.access(currentDir);
        throw new Error(`profile was not deleted: ${profile}`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }

    return {
      ok: true,
      tmpDir,
      profile: created.profile,
      discussionProfile: created.discussionProfile,
      hermesPath: created.hermesPath,
      checks: [
        "auto_task_and_discussion_leads",
        "independent_profile",
        "marker",
        "live_reply",
        "agent_config_update",
        "marker_config_update",
        "delete_cleanup"
      ]
    };
  } finally {
    await app.close();
    for (const profile of createdProfiles) {
      const profileDir = path.join(process.env.HOME, ".hermes", "profiles", profile);
      try {
        await fs.access(profileDir);
        console.error(`WARNING: live acceptance profile still exists: ${profile}`);
      } catch {
        // already deleted
      }
    }
  }
}

const mock = await runMockAcceptance();
const live = await runLiveAcceptance();
console.log(JSON.stringify({ ok: true, mock, live }, null, 2));
