export type MessageMode = "chat" | "notice" | "command" | "task" | "discussion" | "reply" | "system";

export interface Workspace {
  id: string;
  name: string;
  created_at: string;
}

export interface Channel {
  id: string;
  workspace_id: string;
  name: string;
  created_at: string;
}

export interface Agent {
  id: string;
  workspace_id: string;
  name: string;
  role: string;
  description: string;
  runtime_backend: "hermes" | "codex";
  core_command: string;
  model_provider: string;
  model_name: string;
  parent_agent_id: string | null;
  hermes_profile: string;
  is_primary: number;
  owned_by_app: number;
  agent_kind: "task" | "discussion";
  status: string;
  current_task: string;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_error: string;
  last_reply_at: string | null;
  is_temporary: number;
  task_run_id: string | null;
  created_by_agent_id: string | null;
  created_at: string;
  in_active_channel: number;
}

export interface Message {
  id: string;
  workspace_id: string;
  channel_id: string;
  sender_type: "human" | "agent" | "system";
  sender_id: string | null;
  sender_name: string;
  mode: MessageMode;
  target_agent_id: string | null;
  content: string;
  status: "visible" | "blocked";
  created_at: string;
  attachments?: MessageAttachment[];
}

export interface MessageAttachment {
  id: string;
  message_id: string;
  workspace_id: string;
  channel_id: string;
  kind: "image";
  mime_type: string;
  filename: string;
  original_name: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  public_path: string;
  url: string;
  created_at: string;
}

export interface ImageUploadAttachment {
  kind: "image";
  mimeType: string;
  fileName: string;
  dataBase64: string;
  width?: number | null;
  height?: number | null;
}

export interface Audit {
  id: string;
  workspace_id: string;
  channel_id: string | null;
  actor_type: string;
  actor_id: string | null;
  action: string;
  result: string;
  detail: string;
  created_at: string;
}

export interface TaskRun {
  id: string;
  workspace_id: string;
  channel_id: string;
  primary_agent_id: string;
  status: "running" | "waiting_discussion" | "awaiting_confirmation" | "cleaned" | "failed" | "stopped";
  objective: string;
  final_output: string;
  temporary_agent_count: number;
  created_at: string;
  completed_at: string | null;
  cleaned_at: string | null;
}

export interface TaskDiscussionLink {
  id: string;
  workspace_id: string;
  channel_id: string;
  task_run_id: string;
  discussion_id: string;
  requester_agent_id: string;
  status: "active" | "needs_human" | "resolved" | "timeout" | "stopped" | string;
  request_text: string;
  execution_snapshot: string;
  wait_started_at: string | null;
  expires_at: string | null;
  block_fingerprint: string;
  discuss_count: number;
  created_at: string;
  resolved_at: string | null;
}

export interface DiscussionRun {
  id: string;
  workspace_id: string;
  channel_id: string;
  topic: string;
  status: "active" | "needs_approval" | "closed";
  discussion_framework: string;
  organizer_agent_id: string | null;
  organizer_status: string;
  round_limit: number;
  created_at: string;
  closed_at: string | null;
}

export interface DiscussionAgent {
  discussion_id: string;
  agent_id: string;
  rounds_used: number;
  round_limit: number;
  status: string;
  last_spoke_at: string | null;
  workspace_id: string;
  channel_id: string;
  agent_name: string;
  agent_role: string;
  agent_status: string;
}

export interface BlackboardEntry {
  id: string;
  workspace_id: string;
  channel_id: string | null;
  key: string;
  scope: "workspace" | "task" | "discussion" | string;
  value: string;
  updated_by_type: string;
  updated_by_id: string | null;
  updated_at: string;
}

export interface RuntimeLock {
  id: string;
  workspace_id: string;
  channel_id: string | null;
  resource: string;
  owner_type: string;
  owner_id: string;
  session_id: string;
  status: "active" | "suspect" | "released" | "stale" | "failed" | "stopped" | "needs_approval" | string;
  reason: string;
  suspect_count: number;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  released_at: string | null;
}

export interface EvidenceItem {
  id: string;
  workspace_id: string;
  channel_id: string;
  task_run_id: string | null;
  agent_id: string | null;
  kind: string;
  title: string;
  content: string;
  metadata_json: string;
  created_at: string;
  agent_name?: string;
}

export interface DecisionRecord {
  id: string;
  workspace_id: string;
  channel_id: string;
  discussion_id: string;
  framework: string;
  status: "final" | "continue" | "ask_human" | string;
  summary: string;
  decision: string;
  risks: string;
  actions: string;
  needs_human: number;
  created_by_agent_id: string | null;
  created_at: string;
  agent_name?: string;
}

export interface ContentAsset {
  id: string;
  workspace_id: string;
  channel_id: string | null;
  source_type: string;
  source_id: string;
  asset_type: string;
  scope: "workspace" | "task" | "discussion" | string;
  title: string;
  summary: string;
  content: string;
  metadata_json: string;
  created_by_type: string;
  created_by_id: string | null;
  importance: number;
  created_at: string;
  updated_at: string;
  created_by_agent_name?: string;
}

export interface HermesModelOption {
  provider: string;
  model: string;
  label: string;
  source: "config" | "provider_cache" | "current";
  isDefault: boolean;
}

export interface HermesModelState {
  defaultProvider: string;
  defaultModel: string;
  configPath: string;
  cachePath: string;
  options: HermesModelOption[];
  updatedAt: string;
  warning: string;
}

export interface DataHealthReport {
  version: string;
  generated_at: string;
  status: "ok" | "warn" | "critical" | string;
  issue_count: number;
  db_path: string;
  hermes_profiles_dir: string;
  counts: {
    workspaces: number;
    agents: number;
    profile_check_enabled: boolean;
    managed_profiles_on_disk: number;
    foreign_key_failures: number;
    orphan_rows: number;
    missing_profile_agents: number;
    orphan_managed_profiles: number;
    released_lock_overflow: number;
    backup_files: number;
    backup_bytes: number;
    golden_backup_present: boolean;
    runtime_locks: {
      released: number;
      stale: number;
      failed: number;
      active: number;
      suspect: number;
    };
  };
  orphan_counts: Record<string, number>;
  foreign_key_failures: Array<Record<string, unknown>>;
  missing_profile_agents: Array<Record<string, unknown>>;
  orphan_managed_profiles: Array<Record<string, unknown>>;
  can_repair: boolean;
  last_report_path: string;
  repair_control: {
    in_flight: boolean;
    cooldown_ms: number;
    cooldown_seconds: number;
    cooldown_until: string;
    backup_retention_count: number;
    golden_backup_path: string;
    backup_dir: string;
    profile_archive_dir: string;
  };
}

export interface MobileServerState {
  enabled: boolean;
  host: string;
  port: number;
  url: string;
  tokenPreview: string;
  warning: string;
}

export interface TeamState {
  workspaces: Workspace[];
  channels: Channel[];
  agents: Agent[];
  messages: Message[];
  messageAttachments: MessageAttachment[];
  audits: Audit[];
  taskRuns: TaskRun[];
  discussionRuns: DiscussionRun[];
  discussionAgents: DiscussionAgent[];
  blackboardEntries: BlackboardEntry[];
  runtimeLocks: RuntimeLock[];
  taskDiscussionLinks: TaskDiscussionLink[];
  evidenceItems: EvidenceItem[];
  decisionRecords: DecisionRecord[];
  contentAssets: ContentAsset[];
  activeWorkspaceId: string | null;
  activeChannelId: string | null;
  teamStatePath: string;
  contentArchivePath: string;
  dbFilePath: string;
  hermesPath: string;
  hermesMode: "live" | "mock";
  hermesModelState: HermesModelState;
  dataHealth: DataHealthReport;
  mobileServer: MobileServerState;
}

export interface HermesTeamApi {
  bootstrap(payload?: { workspaceId?: string | null; channelId?: string | null }): Promise<TeamState>;
  refreshDataHealth(payload?: { workspaceId?: string | null; channelId?: string | null }): Promise<TeamState>;
  repairDataHealth(payload: {
    workspaceId?: string | null;
    channelId?: string | null;
    repairMode?: "database" | "profiles" | "all";
    cleanupProfiles?: boolean;
  }): Promise<TeamState>;
  openDataGovernancePath(payload: {
    kind?: "profile_archive" | "backups" | "reports" | "root";
    dryRun?: boolean;
  }): Promise<{ ok: boolean; path: string }>;
  createWorkspace(payload: { name: string }): Promise<TeamState>;
  deleteWorkspace(payload: { workspaceId: string }): Promise<TeamState>;
  createChannel(payload: { workspaceId: string; name: string }): Promise<TeamState>;
  deleteChannel(payload: { workspaceId: string; channelId: string }): Promise<TeamState>;
  createAgent(payload: {
    workspaceId: string;
    channelId: string;
    name: string;
    role: string;
    description: string;
    coreCommand?: string;
    modelProvider?: string;
    modelName?: string;
    runtimeBackend?: "hermes" | "codex";
    agentKind?: "task" | "discussion";
    parentAgentId?: string | null;
  }): Promise<TeamState>;
  deleteAgent(payload: { workspaceId: string; channelId: string; agentId: string }): Promise<TeamState>;
  setAgentChannel(payload: { agentId: string; channelId: string; enabled: boolean }): Promise<TeamState>;
  updateAgentConfig(payload: {
    agentId: string;
    channelId: string;
    coreCommand: string;
    modelProvider: string;
    modelName: string;
    runtimeBackend?: "hermes" | "codex";
  }): Promise<TeamState>;
  startTaskRun(payload: {
    workspaceId: string;
    channelId: string;
    primaryAgentId: string;
    objective: string;
    attachments?: ImageUploadAttachment[];
  }): Promise<TeamState>;
  sendChannelMessage(payload: {
    workspaceId: string;
    channelId: string;
    mode?: "chat" | "task" | "discussion";
    content?: string;
    attachments?: ImageUploadAttachment[];
  }): Promise<TeamState>;
  runSlashCommand(payload: {
    workspaceId: string;
    channelId: string;
    mode: "task" | "discussion";
    command: string;
    primaryAgentId?: string | null;
    agentIds?: string[];
  }): Promise<TeamState>;
  confirmTaskCleanup(payload: { taskRunId: string }): Promise<TeamState>;
  runSandboxQuickAction(payload: {
    taskRunId: string;
    action: "takeover" | "copy_command" | "remove_worktree" | "cleanup_sandbox";
  }): Promise<TeamState>;
  startDiscussion(payload: {
    workspaceId: string;
    channelId: string;
    agentIds: string[];
    topic: string;
    discussionFramework?: string;
    roundLimit?: number;
    attachments?: ImageUploadAttachment[];
  }): Promise<TeamState>;
  respondDiscussion(payload: { discussionId: string; content: string; attachments?: ImageUploadAttachment[] }): Promise<TeamState>;
  continueDiscussion(payload: { discussionId: string }): Promise<TeamState>;
  approveDiscussionRounds(payload: { discussionId: string; extraRounds?: number }): Promise<TeamState>;
  closeDiscussion(payload: { discussionId: string }): Promise<TeamState>;
  testRuntimeLockLifecycle?(payload: { workspaceId: string; channelId?: string | null }): Promise<{
    lockId: string;
    resource: string;
    statuses: string[];
    riskCount: number;
  }>;
  testTaskDiscussionBridgeReliability?(payload: {
    workspaceId: string;
    channelId: string;
    primaryAgentId?: string | null;
  }): Promise<{
    timedOutCount: number;
    taskStatus: string;
    taskFinalOutput: string;
    linkStatus: string;
    timeoutEvidence: boolean;
    driftDetected: boolean;
    driftChanges: string[];
    duplicateBlocked: boolean;
    blockFingerprint: string;
    discussCount: number;
    countLimitWouldBlock: boolean;
  }>;
  testReliabilityClosure?(payload: {
    workspaceId: string;
    channelId: string;
    primaryAgentId?: string | null;
  }): Promise<{
    oscillationStatus: string;
    oscillationSuspectCount: number;
    decayedStatus: string;
    decayedSuspectCount: number;
    lockStatuses: string[];
    snapshotBytes: number;
    snapshotWithinLimit: boolean;
    snapshotExcludedNodeModules: boolean;
    snapshotMeta: Record<string, unknown> | null;
    takeoverEvidence: boolean;
    copyCommandEvidence: boolean;
    quickActions: Array<{ id: string; label: string; command: string; destructive: boolean }>;
    gcExemptPreserved: boolean;
    gcExemptSkipped: boolean;
    gcPruned: number;
    gcPathRemoved: boolean;
    sandboxPath: string;
  }>;
  testDataGovernance?(payload: {
    workspaceId: string;
    channelId: string;
  }): Promise<{
    beforeStatus: string;
    beforeOrphanRows: number;
    beforeForeignKeyFailures: number;
    afterStatus: string;
    afterOrphanRows: number;
    afterForeignKeyFailures: number;
    repairMode: string;
    backupPath: string;
    backupSizeBytes: number;
    backupQuickCheck: string;
    backupExists: boolean;
    backupRetentionCount: number;
    backupRetentionLimit: number;
    backupRetentionOk: boolean;
    goldenBackupPath: string;
    goldenBackupExists: boolean;
    backupIntegrityRejected: boolean;
    sqliteConnectionRejected: boolean;
    repairCooldownBlocked: boolean;
    persistedCooldownBlocked: boolean;
    diskFullMessage: string;
    deletedTotal: number;
    profileArchiveDir: string;
    profileArchiveDirExists: boolean;
    reportPath: string;
  }>;
}
