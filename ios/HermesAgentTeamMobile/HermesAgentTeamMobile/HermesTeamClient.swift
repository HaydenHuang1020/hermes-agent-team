import Foundation

struct Workspace: Identifiable, Decodable, Hashable {
  let id: String
  let name: String
  let createdAt: String

  private enum CodingKeys: String, CodingKey {
    case id
    case name
    case createdAt = "created_at"
  }
}

struct Channel: Identifiable, Decodable, Hashable {
  let id: String
  let workspaceId: String
  let name: String
  let createdAt: String

  private enum CodingKeys: String, CodingKey {
    case id
    case workspaceId = "workspace_id"
    case name
    case createdAt = "created_at"
  }
}

struct Agent: Identifiable, Decodable, Hashable {
  let id: String
  let workspaceId: String
  let name: String
  let role: String
  let description: String
  let runtimeBackend: String
  let coreCommand: String
  let modelProvider: String
  let modelName: String
  let parentAgentId: String?
  let hermesProfile: String
  let isPrimary: Int
  let ownedByApp: Int
  let agentKind: String
  let status: String
  let currentTask: String
  let lastStartedAt: String?
  let lastFinishedAt: String?
  let lastError: String
  let lastReplyAt: String?
  let isTemporary: Int
  let taskRunId: String?
  let createdByAgentId: String?
  let createdAt: String
  let inActiveChannel: Int

  var isTaskPrimary: Bool {
    agentKind != "discussion" && isPrimary == 1 && inActiveChannel == 1
  }

  var canDelete: Bool {
    isPrimary == 0 || ownedByApp == 0
  }

  private enum CodingKeys: String, CodingKey {
    case id
    case workspaceId = "workspace_id"
    case name
    case role
    case description
    case runtimeBackend = "runtime_backend"
    case coreCommand = "core_command"
    case modelProvider = "model_provider"
    case modelName = "model_name"
    case parentAgentId = "parent_agent_id"
    case hermesProfile = "hermes_profile"
    case isPrimary = "is_primary"
    case ownedByApp = "owned_by_app"
    case agentKind = "agent_kind"
    case status
    case currentTask = "current_task"
    case lastStartedAt = "last_started_at"
    case lastFinishedAt = "last_finished_at"
    case lastError = "last_error"
    case lastReplyAt = "last_reply_at"
    case isTemporary = "is_temporary"
    case taskRunId = "task_run_id"
    case createdByAgentId = "created_by_agent_id"
    case createdAt = "created_at"
    case inActiveChannel = "in_active_channel"
  }
}

struct MessageAttachment: Identifiable, Decodable, Hashable {
  let id: String
  let messageId: String
  let workspaceId: String
  let channelId: String
  let kind: String
  let mimeType: String
  let filename: String
  let originalName: String
  let byteSize: Int
  let width: Int?
  let height: Int?
  let publicPath: String
  let url: String
  let createdAt: String

  private enum CodingKeys: String, CodingKey {
    case id
    case messageId = "message_id"
    case workspaceId = "workspace_id"
    case channelId = "channel_id"
    case kind
    case mimeType = "mime_type"
    case filename
    case originalName = "original_name"
    case byteSize = "byte_size"
    case width
    case height
    case publicPath = "public_path"
    case url
    case createdAt = "created_at"
  }
}

struct TeamMessage: Identifiable, Decodable, Hashable {
  let id: String
  let workspaceId: String
  let channelId: String
  let senderType: String
  let senderId: String?
  let senderName: String
  let mode: String
  let targetAgentId: String?
  let content: String
  let status: String
  let createdAt: String
  let attachments: [MessageAttachment]

  private enum CodingKeys: String, CodingKey {
    case id
    case workspaceId = "workspace_id"
    case channelId = "channel_id"
    case senderType = "sender_type"
    case senderId = "sender_id"
    case senderName = "sender_name"
    case mode
    case targetAgentId = "target_agent_id"
    case content
    case status
    case createdAt = "created_at"
    case attachments
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    id = try container.decode(String.self, forKey: .id)
    workspaceId = try container.decode(String.self, forKey: .workspaceId)
    channelId = try container.decode(String.self, forKey: .channelId)
    senderType = try container.decode(String.self, forKey: .senderType)
    senderId = try container.decodeIfPresent(String.self, forKey: .senderId)
    senderName = try container.decode(String.self, forKey: .senderName)
    mode = try container.decode(String.self, forKey: .mode)
    targetAgentId = try container.decodeIfPresent(String.self, forKey: .targetAgentId)
    content = try container.decode(String.self, forKey: .content)
    status = try container.decode(String.self, forKey: .status)
    createdAt = try container.decode(String.self, forKey: .createdAt)
    attachments = try container.decodeIfPresent([MessageAttachment].self, forKey: .attachments) ?? []
  }
}

struct Audit: Identifiable, Decodable, Hashable {
  let id: String
  let workspaceId: String
  let channelId: String?
  let actorType: String
  let actorId: String?
  let action: String
  let result: String
  let detail: String
  let createdAt: String

  private enum CodingKeys: String, CodingKey {
    case id
    case workspaceId = "workspace_id"
    case channelId = "channel_id"
    case actorType = "actor_type"
    case actorId = "actor_id"
    case action
    case result
    case detail
    case createdAt = "created_at"
  }
}

struct TaskRun: Identifiable, Decodable, Hashable {
  let id: String
  let workspaceId: String
  let channelId: String
  let primaryAgentId: String
  let status: String
  let objective: String
  let finalOutput: String
  let temporaryAgentCount: Int
  let createdAt: String
  let completedAt: String?
  let cleanedAt: String?

  private enum CodingKeys: String, CodingKey {
    case id
    case workspaceId = "workspace_id"
    case channelId = "channel_id"
    case primaryAgentId = "primary_agent_id"
    case status
    case objective
    case finalOutput = "final_output"
    case temporaryAgentCount = "temporary_agent_count"
    case createdAt = "created_at"
    case completedAt = "completed_at"
    case cleanedAt = "cleaned_at"
  }
}

struct TaskDiscussionLink: Identifiable, Decodable, Hashable {
  let id: String
  let workspaceId: String
  let channelId: String
  let taskRunId: String
  let discussionId: String
  let requesterAgentId: String
  let status: String
  let requestText: String
  let executionSnapshot: String
  let waitStartedAt: String?
  let expiresAt: String?
  let blockFingerprint: String
  let discussCount: Int
  let createdAt: String
  let resolvedAt: String?

  private enum CodingKeys: String, CodingKey {
    case id
    case workspaceId = "workspace_id"
    case channelId = "channel_id"
    case taskRunId = "task_run_id"
    case discussionId = "discussion_id"
    case requesterAgentId = "requester_agent_id"
    case status
    case requestText = "request_text"
    case executionSnapshot = "execution_snapshot"
    case waitStartedAt = "wait_started_at"
    case expiresAt = "expires_at"
    case blockFingerprint = "block_fingerprint"
    case discussCount = "discuss_count"
    case createdAt = "created_at"
    case resolvedAt = "resolved_at"
  }
}

struct DiscussionRun: Identifiable, Decodable, Hashable {
  let id: String
  let workspaceId: String
  let channelId: String
  let topic: String
  let status: String
  let discussionFramework: String
  let organizerAgentId: String?
  let organizerStatus: String
  let roundLimit: Int
  let createdAt: String
  let closedAt: String?

  private enum CodingKeys: String, CodingKey {
    case id
    case workspaceId = "workspace_id"
    case channelId = "channel_id"
    case topic
    case status
    case discussionFramework = "discussion_framework"
    case organizerAgentId = "organizer_agent_id"
    case organizerStatus = "organizer_status"
    case roundLimit = "round_limit"
    case createdAt = "created_at"
    case closedAt = "closed_at"
  }
}

struct DiscussionAgent: Identifiable, Decodable, Hashable {
  let discussionId: String
  let agentId: String
  let roundsUsed: Int
  let roundLimit: Int
  let status: String
  let lastSpokeAt: String?
  let workspaceId: String
  let channelId: String
  let agentName: String
  let agentRole: String
  let agentStatus: String

  var id: String {
    "\(discussionId):\(agentId)"
  }

  private enum CodingKeys: String, CodingKey {
    case discussionId = "discussion_id"
    case agentId = "agent_id"
    case roundsUsed = "rounds_used"
    case roundLimit = "round_limit"
    case status
    case lastSpokeAt = "last_spoke_at"
    case workspaceId = "workspace_id"
    case channelId = "channel_id"
    case agentName = "agent_name"
    case agentRole = "agent_role"
    case agentStatus = "agent_status"
  }
}

struct BlackboardEntry: Identifiable, Decodable, Hashable {
  let id: String
  let workspaceId: String
  let channelId: String?
  let key: String
  let scope: String
  let value: String
  let updatedByType: String
  let updatedById: String?
  let updatedAt: String

  private enum CodingKeys: String, CodingKey {
    case id
    case workspaceId = "workspace_id"
    case channelId = "channel_id"
    case key
    case scope
    case value
    case updatedByType = "updated_by_type"
    case updatedById = "updated_by_id"
    case updatedAt = "updated_at"
  }
}

struct RuntimeLock: Identifiable, Decodable, Hashable {
  let id: String
  let workspaceId: String
  let channelId: String?
  let resource: String
  let ownerType: String
  let ownerId: String
  let sessionId: String
  let status: String
  let reason: String
  let suspectCount: Int
  let acquiredAt: String
  let heartbeatAt: String
  let expiresAt: String
  let releasedAt: String?

  private enum CodingKeys: String, CodingKey {
    case id
    case workspaceId = "workspace_id"
    case channelId = "channel_id"
    case resource
    case ownerType = "owner_type"
    case ownerId = "owner_id"
    case sessionId = "session_id"
    case status
    case reason
    case suspectCount = "suspect_count"
    case acquiredAt = "acquired_at"
    case heartbeatAt = "heartbeat_at"
    case expiresAt = "expires_at"
    case releasedAt = "released_at"
  }
}

struct EvidenceItem: Identifiable, Decodable, Hashable {
  let id: String
  let workspaceId: String
  let channelId: String
  let taskRunId: String?
  let agentId: String?
  let kind: String
  let title: String
  let content: String
  let metadataJSON: String
  let createdAt: String
  let agentName: String?

  var sandboxQuickActions: [SandboxQuickAction] {
    guard kind == "execution_sandbox_protocol", taskRunId != nil else { return [] }
    guard let data = metadataJSON.data(using: .utf8),
          let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let actions = raw["quickActions"] as? [[String: Any]] else {
      return []
    }
    return actions.compactMap { action in
      guard let id = action["id"] as? String,
            ["takeover", "copy_command", "remove_worktree", "cleanup_sandbox"].contains(id) else {
        return nil
      }
      let label = action["label"] as? String ?? id
      let command = action["command"] as? String ?? ""
      let destructive = action["destructive"] as? Bool ?? false
      return SandboxQuickAction(id: id, label: label, command: command, destructive: destructive)
    }
  }

  private enum CodingKeys: String, CodingKey {
    case id
    case workspaceId = "workspace_id"
    case channelId = "channel_id"
    case taskRunId = "task_run_id"
    case agentId = "agent_id"
    case kind
    case title
    case content
    case metadataJSON = "metadata_json"
    case createdAt = "created_at"
    case agentName = "agent_name"
  }
}

struct SandboxQuickAction: Identifiable, Hashable {
  let id: String
  let label: String
  let command: String
  let destructive: Bool
}

struct DecisionRecord: Identifiable, Decodable, Hashable {
  let id: String
  let workspaceId: String
  let channelId: String
  let discussionId: String
  let framework: String
  let status: String
  let summary: String
  let decision: String
  let risks: String
  let actions: String
  let needsHuman: Int
  let createdByAgentId: String?
  let createdAt: String
  let agentName: String?

  private enum CodingKeys: String, CodingKey {
    case id
    case workspaceId = "workspace_id"
    case channelId = "channel_id"
    case discussionId = "discussion_id"
    case framework
    case status
    case summary
    case decision
    case risks
    case actions
    case needsHuman = "needs_human"
    case createdByAgentId = "created_by_agent_id"
    case createdAt = "created_at"
    case agentName = "agent_name"
  }
}

struct ContentAsset: Identifiable, Decodable, Hashable {
  let id: String
  let workspaceId: String
  let channelId: String?
  let sourceType: String
  let sourceId: String
  let assetType: String
  let scope: String
  let title: String
  let summary: String
  let content: String
  let metadataJSON: String
  let createdByType: String
  let createdById: String?
  let importance: Int
  let createdAt: String
  let updatedAt: String
  let createdByAgentName: String?

  private enum CodingKeys: String, CodingKey {
    case id
    case workspaceId = "workspace_id"
    case channelId = "channel_id"
    case sourceType = "source_type"
    case sourceId = "source_id"
    case assetType = "asset_type"
    case scope
    case title
    case summary
    case content
    case metadataJSON = "metadata_json"
    case createdByType = "created_by_type"
    case createdById = "created_by_id"
    case importance
    case createdAt = "created_at"
    case updatedAt = "updated_at"
    case createdByAgentName = "created_by_agent_name"
  }
}

struct HermesModelOption: Decodable, Hashable {
  let provider: String
  let model: String
  let label: String
  let source: String
  let isDefault: Bool
}

struct HermesModelState: Decodable, Hashable {
  let defaultProvider: String
  let defaultModel: String
  let configPath: String
  let cachePath: String
  let options: [HermesModelOption]
  let updatedAt: String
  let warning: String
}

struct RuntimeLockCounts: Decodable, Hashable {
  let released: Int
  let stale: Int
  let failed: Int
  let active: Int
  let suspect: Int
}

struct DataHealthCounts: Decodable, Hashable {
  let workspaces: Int
  let agents: Int
  let profileCheckEnabled: Bool
  let managedProfilesOnDisk: Int
  let foreignKeyFailures: Int
  let orphanRows: Int
  let missingProfileAgents: Int
  let orphanManagedProfiles: Int
  let releasedLockOverflow: Int
  let backupFiles: Int
  let backupBytes: Int
  let goldenBackupPresent: Bool
  let runtimeLocks: RuntimeLockCounts

  private enum CodingKeys: String, CodingKey {
    case workspaces
    case agents
    case profileCheckEnabled = "profile_check_enabled"
    case managedProfilesOnDisk = "managed_profiles_on_disk"
    case foreignKeyFailures = "foreign_key_failures"
    case orphanRows = "orphan_rows"
    case missingProfileAgents = "missing_profile_agents"
    case orphanManagedProfiles = "orphan_managed_profiles"
    case releasedLockOverflow = "released_lock_overflow"
    case backupFiles = "backup_files"
    case backupBytes = "backup_bytes"
    case goldenBackupPresent = "golden_backup_present"
    case runtimeLocks = "runtime_locks"
  }
}

struct DataRepairControl: Decodable, Hashable {
  let inFlight: Bool
  let cooldownMs: Int
  let cooldownSeconds: Int
  let cooldownUntil: String
  let backupRetentionCount: Int
  let goldenBackupPath: String
  let backupDir: String
  let profileArchiveDir: String

  private enum CodingKeys: String, CodingKey {
    case inFlight = "in_flight"
    case cooldownMs = "cooldown_ms"
    case cooldownSeconds = "cooldown_seconds"
    case cooldownUntil = "cooldown_until"
    case backupRetentionCount = "backup_retention_count"
    case goldenBackupPath = "golden_backup_path"
    case backupDir = "backup_dir"
    case profileArchiveDir = "profile_archive_dir"
  }
}

struct DataHealthReport: Decodable, Hashable {
  let version: String
  let generatedAt: String
  let status: String
  let issueCount: Int
  let dbPath: String
  let hermesProfilesDir: String
  let counts: DataHealthCounts
  let orphanCounts: [String: Int]
  let foreignKeyFailures: [[String: JSONValue]]
  let missingProfileAgents: [[String: JSONValue]]
  let orphanManagedProfiles: [[String: JSONValue]]
  let canRepair: Bool
  let lastReportPath: String
  let repairControl: DataRepairControl

  private enum CodingKeys: String, CodingKey {
    case version
    case generatedAt = "generated_at"
    case status
    case issueCount = "issue_count"
    case dbPath = "db_path"
    case hermesProfilesDir = "hermes_profiles_dir"
    case counts
    case orphanCounts = "orphan_counts"
    case foreignKeyFailures = "foreign_key_failures"
    case missingProfileAgents = "missing_profile_agents"
    case orphanManagedProfiles = "orphan_managed_profiles"
    case canRepair = "can_repair"
    case lastReportPath = "last_report_path"
    case repairControl = "repair_control"
  }
}

struct MobileDiscoveryState: Decodable, Hashable {
  let enabled: Bool
  let serviceType: String
  let warning: String
}

struct MobileServerState: Decodable, Hashable {
  let enabled: Bool
  let host: String
  let port: Int
  let url: String
  let tokenPreview: String
  let warning: String
  let discovery: MobileDiscoveryState?
  let lastTeamRequest: [String: JSONValue]?
}

struct TeamState: Decodable, Hashable {
  let workspaces: [Workspace]
  let channels: [Channel]
  let agents: [Agent]
  let messages: [TeamMessage]
  let messageAttachments: [MessageAttachment]
  let audits: [Audit]
  let taskRuns: [TaskRun]
  let discussionRuns: [DiscussionRun]
  let discussionAgents: [DiscussionAgent]
  let blackboardEntries: [BlackboardEntry]
  let runtimeLocks: [RuntimeLock]
  let taskDiscussionLinks: [TaskDiscussionLink]
  let evidenceItems: [EvidenceItem]
  let decisionRecords: [DecisionRecord]
  let contentAssets: [ContentAsset]
  let activeWorkspaceId: String?
  let activeChannelId: String?
  let teamStatePath: String
  let contentArchivePath: String
  let dbFilePath: String
  let hermesPath: String
  let hermesMode: String
  let hermesModelState: HermesModelState
  let dataHealth: DataHealthReport
  let mobileServer: MobileServerState?

  private enum CodingKeys: String, CodingKey {
    case workspaces
    case channels
    case agents
    case messages
    case messageAttachments
    case audits
    case taskRuns
    case discussionRuns
    case discussionAgents
    case blackboardEntries
    case runtimeLocks
    case taskDiscussionLinks
    case evidenceItems
    case decisionRecords
    case contentAssets
    case activeWorkspaceId
    case activeChannelId
    case teamStatePath
    case contentArchivePath
    case dbFilePath
    case hermesPath
    case hermesMode
    case hermesModelState
    case dataHealth
    case mobileServer
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    workspaces = try container.decode([Workspace].self, forKey: .workspaces)
    channels = try container.decode([Channel].self, forKey: .channels)
    agents = try container.decode([Agent].self, forKey: .agents)
    messages = try container.decode([TeamMessage].self, forKey: .messages)
    messageAttachments = try container.decodeIfPresent([MessageAttachment].self, forKey: .messageAttachments) ?? []
    audits = try container.decode([Audit].self, forKey: .audits)
    taskRuns = try container.decode([TaskRun].self, forKey: .taskRuns)
    discussionRuns = try container.decode([DiscussionRun].self, forKey: .discussionRuns)
    discussionAgents = try container.decode([DiscussionAgent].self, forKey: .discussionAgents)
    blackboardEntries = try container.decode([BlackboardEntry].self, forKey: .blackboardEntries)
    runtimeLocks = try container.decode([RuntimeLock].self, forKey: .runtimeLocks)
    taskDiscussionLinks = try container.decode([TaskDiscussionLink].self, forKey: .taskDiscussionLinks)
    evidenceItems = try container.decode([EvidenceItem].self, forKey: .evidenceItems)
    decisionRecords = try container.decode([DecisionRecord].self, forKey: .decisionRecords)
    contentAssets = try container.decode([ContentAsset].self, forKey: .contentAssets)
    activeWorkspaceId = try container.decodeIfPresent(String.self, forKey: .activeWorkspaceId)
    activeChannelId = try container.decodeIfPresent(String.self, forKey: .activeChannelId)
    teamStatePath = try container.decode(String.self, forKey: .teamStatePath)
    contentArchivePath = try container.decode(String.self, forKey: .contentArchivePath)
    dbFilePath = try container.decode(String.self, forKey: .dbFilePath)
    hermesPath = try container.decode(String.self, forKey: .hermesPath)
    hermesMode = try container.decode(String.self, forKey: .hermesMode)
    hermesModelState = try container.decode(HermesModelState.self, forKey: .hermesModelState)
    dataHealth = try container.decode(DataHealthReport.self, forKey: .dataHealth)
    mobileServer = try container.decodeIfPresent(MobileServerState.self, forKey: .mobileServer)
  }
}

struct ImageUploadAttachment {
  let kind = "image"
  let mimeType: String
  let fileName: String
  let dataBase64: String
  let width: Int?
  let height: Int?

  var payload: [String: Any] {
    var value: [String: Any] = [
      "kind": kind,
      "mimeType": mimeType,
      "fileName": fileName,
      "dataBase64": dataBase64
    ]
    if let width { value["width"] = width }
    if let height { value["height"] = height }
    return value
  }
}

struct ConnectionSettings: Equatable {
  var serverBaseURL: URL?
  var token: String

  var isComplete: Bool {
    serverBaseURL != nil && !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }
}

struct OpenDataGovernancePathResult: Decodable, Hashable {
  let ok: Bool
  let path: String
}

enum JSONValue: Decodable, Hashable {
  case string(String)
  case number(Double)
  case bool(Bool)
  case object([String: JSONValue])
  case array([JSONValue])
  case null

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([String: JSONValue].self) {
      self = .object(value)
    } else if let value = try? container.decode([JSONValue].self) {
      self = .array(value)
    } else {
      throw DecodingError.dataCorruptedError(in: container, debugDescription: "不支持的 JSON 值。")
    }
  }

  var displayText: String {
    switch self {
    case .string(let value):
      return value
    case .number(let value):
      if value.rounded() == value {
        return String(Int(value))
      }
      return String(value)
    case .bool(let value):
      return value ? "true" : "false"
    case .object(let values):
      return values
        .sorted { $0.key < $1.key }
        .map { "\($0.key): \($0.value.displayText)" }
        .joined(separator: ", ")
    case .array(let values):
      return values.map(\.displayText).joined(separator: ", ")
    case .null:
      return "null"
    }
  }
}

typealias DiagnosticResult = [String: JSONValue]

enum HermesTeamClientError: LocalizedError {
  case invalidServerURL
  case invalidResponse
  case server(String)

  var errorDescription: String? {
    switch self {
    case .invalidServerURL:
      "Mac 服务地址无效。"
    case .invalidResponse:
      "Mac 服务返回无效响应。"
    case .server(let message):
      message
    }
  }
}

struct HermesTeamClient {
  var settings: ConnectionSettings
  var urlSession: URLSession = .shared

  func bootstrap(workspaceId: String? = nil, channelId: String? = nil) async throws -> TeamState {
    var payload: [String: Any] = [:]
    if let workspaceId { payload["workspaceId"] = workspaceId }
    if let channelId { payload["channelId"] = channelId }
    return try await post("bootstrap", payload: payload)
  }

  func refreshDataHealth(workspaceId: String?, channelId: String?) async throws -> TeamState {
    var payload: [String: Any] = [:]
    if let workspaceId { payload["workspaceId"] = workspaceId }
    if let channelId { payload["channelId"] = channelId }
    return try await post("refresh-data-health", payload: payload)
  }

  func repairDataHealth(workspaceId: String?, channelId: String?, repairMode: String, cleanupProfiles: Bool) async throws -> TeamState {
    var payload: [String: Any] = [
      "repairMode": repairMode,
      "cleanupProfiles": cleanupProfiles
    ]
    if let workspaceId { payload["workspaceId"] = workspaceId }
    if let channelId { payload["channelId"] = channelId }
    return try await post("repair-data-health", payload: payload)
  }

  func openDataGovernancePath(kind: String) async throws -> OpenDataGovernancePathResult {
    try await post("open-data-governance-path", payload: ["kind": kind])
  }

  func createWorkspace(name: String) async throws -> TeamState {
    try await post("create-workspace", payload: ["name": name])
  }

  func deleteWorkspace(workspaceId: String) async throws -> TeamState {
    try await post("delete-workspace", payload: ["workspaceId": workspaceId])
  }

  func createChannel(workspaceId: String, name: String) async throws -> TeamState {
    try await post("create-channel", payload: ["workspaceId": workspaceId, "name": name])
  }

  func deleteChannel(workspaceId: String, channelId: String) async throws -> TeamState {
    try await post("delete-channel", payload: ["workspaceId": workspaceId, "channelId": channelId])
  }

  func createAgent(
    workspaceId: String,
    channelId: String,
    name: String,
    role: String,
    description: String,
    coreCommand: String,
    modelProvider: String,
    modelName: String,
    runtimeBackend: String,
    agentKind: String
  ) async throws -> TeamState {
    try await post(
      "create-agent",
      payload: [
        "workspaceId": workspaceId,
        "channelId": channelId,
        "name": name,
        "role": role,
        "description": description,
        "coreCommand": coreCommand,
        "modelProvider": modelProvider,
        "modelName": modelName,
        "runtimeBackend": runtimeBackend,
        "agentKind": agentKind
      ]
    )
  }

  func deleteAgent(workspaceId: String, channelId: String, agentId: String) async throws -> TeamState {
    try await post("delete-agent", payload: ["workspaceId": workspaceId, "channelId": channelId, "agentId": agentId])
  }

  func setAgentChannel(agentId: String, channelId: String, enabled: Bool) async throws -> TeamState {
    try await post("set-agent-channel", payload: ["agentId": agentId, "channelId": channelId, "enabled": enabled])
  }

  func updateAgentConfig(agentId: String, channelId: String, coreCommand: String, modelProvider: String, modelName: String, runtimeBackend: String) async throws -> TeamState {
    try await post(
      "update-agent-config",
      payload: [
        "agentId": agentId,
        "channelId": channelId,
        "coreCommand": coreCommand,
        "modelProvider": modelProvider,
        "modelName": modelName,
        "runtimeBackend": runtimeBackend
      ]
    )
  }

  func startTaskRun(
    workspaceId: String,
    channelId: String,
    primaryAgentId: String,
    objective: String,
    attachments: [ImageUploadAttachment] = []
  ) async throws -> TeamState {
    try await post(
      "start-task-run",
      payload: [
        "workspaceId": workspaceId,
        "channelId": channelId,
        "primaryAgentId": primaryAgentId,
        "objective": objective,
        "attachments": attachments.map(\.payload)
      ]
    )
  }

  func sendChannelMessage(
    workspaceId: String,
    channelId: String,
    mode: String,
    content: String,
    attachments: [ImageUploadAttachment] = []
  ) async throws -> TeamState {
    try await post(
      "send-channel-message",
      payload: [
        "workspaceId": workspaceId,
        "channelId": channelId,
        "mode": mode,
        "content": content,
        "attachments": attachments.map(\.payload)
      ]
    )
  }

  func runSlashCommand(workspaceId: String, channelId: String, mode: String, command: String, primaryAgentId: String?) async throws -> TeamState {
    var payload: [String: Any] = [
      "workspaceId": workspaceId,
      "channelId": channelId,
      "mode": mode,
      "command": command
    ]
    if let primaryAgentId { payload["primaryAgentId"] = primaryAgentId }
    return try await post("run-slash-command", payload: payload)
  }

  func confirmTaskCleanup(taskRunId: String) async throws -> TeamState {
    try await post("confirm-task-cleanup", payload: ["taskRunId": taskRunId])
  }

  func runSandboxQuickAction(taskRunId: String, action: String) async throws -> TeamState {
    try await post("run-sandbox-quick-action", payload: ["taskRunId": taskRunId, "action": action])
  }

  func startDiscussion(
    workspaceId: String,
    channelId: String,
    topic: String,
    framework: String,
    agentIds: [String] = [],
    roundLimit: Int = 1,
    attachments: [ImageUploadAttachment] = []
  ) async throws -> TeamState {
    try await post(
      "start-discussion",
      payload: [
        "workspaceId": workspaceId,
        "channelId": channelId,
        "agentIds": agentIds,
        "topic": topic,
        "discussionFramework": framework,
        "roundLimit": roundLimit,
        "attachments": attachments.map(\.payload)
      ]
    )
  }

  func respondDiscussion(discussionId: String, content: String, attachments: [ImageUploadAttachment] = []) async throws -> TeamState {
    try await post(
      "respond-discussion",
      payload: [
        "discussionId": discussionId,
        "content": content,
        "attachments": attachments.map(\.payload)
      ]
    )
  }

  func continueDiscussion(discussionId: String) async throws -> TeamState {
    try await post("continue-discussion", payload: ["discussionId": discussionId])
  }

  func approveDiscussionRounds(discussionId: String, extraRounds: Int) async throws -> TeamState {
    try await post("approve-discussion-rounds", payload: ["discussionId": discussionId, "extraRounds": extraRounds])
  }

  func closeDiscussion(discussionId: String) async throws -> TeamState {
    try await post("close-discussion", payload: ["discussionId": discussionId])
  }

  func testRuntimeLockLifecycle(workspaceId: String, channelId: String?) async throws -> DiagnosticResult {
    var payload: [String: Any] = ["workspaceId": workspaceId]
    if let channelId { payload["channelId"] = channelId }
    return try await post("test-runtime-lock-lifecycle", payload: payload)
  }

  func testTaskDiscussionBridgeReliability(workspaceId: String, channelId: String, primaryAgentId: String?) async throws -> DiagnosticResult {
    var payload: [String: Any] = ["workspaceId": workspaceId, "channelId": channelId]
    if let primaryAgentId { payload["primaryAgentId"] = primaryAgentId }
    return try await post("test-task-discussion-bridge-reliability", payload: payload)
  }

  func testReliabilityClosure(workspaceId: String, channelId: String, primaryAgentId: String?) async throws -> DiagnosticResult {
    var payload: [String: Any] = ["workspaceId": workspaceId, "channelId": channelId]
    if let primaryAgentId { payload["primaryAgentId"] = primaryAgentId }
    return try await post("test-reliability-closure", payload: payload)
  }

  func testDataGovernance(workspaceId: String, channelId: String) async throws -> DiagnosticResult {
    try await post("test-data-governance", payload: ["workspaceId": workspaceId, "channelId": channelId])
  }

  private func post<T: Decodable>(_ method: String, payload: [String: Any]) async throws -> T {
    guard let baseURL = settings.serverBaseURL else {
      throw HermesTeamClientError.invalidServerURL
    }
    let endpoint = baseURL.appending(path: "api/team/\(method)")
    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue(settings.token, forHTTPHeaderField: "X-HAT-Mobile-Token")
    request.timeoutInterval = 20
    request.httpBody = try JSONSerialization.data(withJSONObject: payload)

    let (data, response) = try await urlSession.data(for: request)
    guard let httpResponse = response as? HTTPURLResponse else {
      throw HermesTeamClientError.invalidResponse
    }
    if !(200..<300).contains(httpResponse.statusCode) {
      if let errorPayload = try? JSONDecoder().decode(ServerError.self, from: data) {
        throw HermesTeamClientError.server(errorPayload.error)
      }
      throw HermesTeamClientError.server("Mac 服务请求失败：HTTP \(httpResponse.statusCode)")
    }
    return try JSONDecoder().decode(T.self, from: data)
  }
}

private struct ServerError: Decodable {
  let error: String
}
