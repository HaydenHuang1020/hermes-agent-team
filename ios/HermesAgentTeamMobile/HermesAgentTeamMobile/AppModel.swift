import Foundation
import UIKit

struct ImageDraftAttachment: Identifiable, Hashable {
  let id = UUID()
  let fileName: String
  let mimeType: String
  let dataBase64: String
  let byteSize: Int
  let width: Int?
  let height: Int?
  let previewImage: UIImage

  var uploadAttachment: ImageUploadAttachment {
    ImageUploadAttachment(
      mimeType: mimeType,
      fileName: fileName,
      dataBase64: dataBase64,
      width: width,
      height: height
    )
  }

  static func == (lhs: ImageDraftAttachment, rhs: ImageDraftAttachment) -> Bool {
    lhs.id == rhs.id
  }

  func hash(into hasher: inout Hasher) {
    hasher.combine(id)
  }
}

@MainActor
final class AppModel: ObservableObject {
  @Published var settings: ConnectionSettings
  @Published var pastedDesktopLink = ""
  @Published var teamState: TeamState?
  @Published var selectedWorkspaceId: String?
  @Published var selectedChannelId: String?
  @Published var selectedPrimaryAgentId: String?
  @Published var workspaceName = ""
  @Published var channelName = ""
  @Published var taskText = ""
  @Published var discussionText = ""
  @Published var taskImageAttachments: [ImageDraftAttachment] = []
  @Published var discussionImageAttachments: [ImageDraftAttachment] = []
  @Published var discussionFramework = "balanced_decision"
  @Published var newAgentName = ""
  @Published var newAgentRole = ""
  @Published var newAgentDescription = ""
  @Published var newAgentCoreCommand = ""
  @Published var newAgentModelProvider = ""
  @Published var newAgentModelName = ""
  @Published var newAgentKind = "task"
  @Published var newAgentRuntimeBackend = "hermes"
  @Published var editingAgentId: String?
  @Published var editingAgentCoreCommand = ""
  @Published var editingAgentModelProvider = ""
  @Published var editingAgentModelName = ""
  @Published var editingAgentRuntimeBackend = "hermes"
  @Published var dataRepairMode = "database"
  @Published var shouldCleanupProfiles = false
  @Published var diagnosticTitle = ""
  @Published var diagnosticBody = ""
  @Published var isBusy = false
  @Published var statusMessage = ""
  @Published var errorMessage: String?
  @Published var discoveredServices: [DiscoveredHermesService] = []
  @Published var isDiscoveringServices = false

  private let defaults: UserDefaults
  private let serverURLDefaultsKey = "HermesTeam.serverBaseURL"
  private let tokenAccount = "mobile-access-token"
  private let maxImageAttachmentCount = 4
  private let maxImageAttachmentBytes = 6 * 1024 * 1024
  private var serviceDiscovery: HermesServiceDiscovery?
  private var autoConnectedServiceId: String?
  private var statusClearTask: Task<Void, Never>?

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    let storedURL = defaults.string(forKey: serverURLDefaultsKey).flatMap(URL.init(string:))
    let storedToken = KeychainStore.read(tokenAccount)
    self.settings = ConnectionSettings(serverBaseURL: storedURL, token: storedToken)
  }

  func addTaskImageData(_ data: Data) {
    addImageData(data, mode: "task")
  }

  func addDiscussionImageData(_ data: Data) {
    addImageData(data, mode: "discussion")
  }

  func removeTaskImageAttachment(_ attachment: ImageDraftAttachment) {
    taskImageAttachments.removeAll { $0.id == attachment.id }
  }

  func removeDiscussionImageAttachment(_ attachment: ImageDraftAttachment) {
    discussionImageAttachments.removeAll { $0.id == attachment.id }
  }

  private func addImageData(_ data: Data, mode: String) {
    let count = mode == "task" ? taskImageAttachments.count : discussionImageAttachments.count
    guard count < maxImageAttachmentCount else {
      errorMessage = "最多一次发送 \(maxImageAttachmentCount) 张图片。"
      return
    }
    do {
      let draft = try makeImageDraft(data)
      let text = mode == "task" ? taskText : discussionText
      if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
         count == 0,
         !isBusy,
         activeWorkspace != nil,
         activeChannelId != nil {
        Task {
          await sendDirectImageMessage(mode: mode, attachment: draft.uploadAttachment)
        }
        return
      }
      if mode == "task" {
        taskImageAttachments.append(draft)
      } else {
        discussionImageAttachments.append(draft)
      }
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func makeImageDraft(_ data: Data) throws -> ImageDraftAttachment {
    guard let image = UIImage(data: data) else {
      throw HermesTeamClientError.server("无法读取这张图片。")
    }
    let encoded = [0.82, 0.68, 0.52, 0.38]
      .compactMap { image.jpegData(compressionQuality: $0) }
      .first { $0.count <= maxImageAttachmentBytes }
    guard let encoded else {
      throw HermesTeamClientError.server("图片超过 6MB，请裁剪后再发送。")
    }
    guard encoded.count <= maxImageAttachmentBytes else {
      throw HermesTeamClientError.server("单张图片不能超过 6MB。")
    }
    let scale = image.scale == 0 ? 1 : image.scale
    return ImageDraftAttachment(
      fileName: "ios-image-\(Int(Date().timeIntervalSince1970)).jpg",
      mimeType: "image/jpeg",
      dataBase64: encoded.base64EncodedString(),
      byteSize: encoded.count,
      width: Int(image.size.width * scale),
      height: Int(image.size.height * scale),
      previewImage: image
    )
  }

  private func sendDirectImageMessage(mode: String, attachment: ImageUploadAttachment) async {
    guard let workspace = activeWorkspace, let channelId = activeChannelId else { return }
    await perform("正在发送图片") {
      let next = try await self.client.sendChannelMessage(
        workspaceId: workspace.id,
        channelId: channelId,
        mode: mode,
        content: "",
        attachments: [attachment]
      )
      self.apply(next)
      self.setStatusMessage("图片已发送。")
    }
  }

  var isConnected: Bool {
    teamState != nil && settings.isComplete
  }

  var activeWorkspace: Workspace? {
    guard let state = teamState else { return nil }
    let id = selectedWorkspaceId ?? state.activeWorkspaceId
    return state.workspaces.first { $0.id == id } ?? state.workspaces.first
  }

  var activeWorkspaceChannels: [Channel] {
    guard let workspace = activeWorkspace else { return [] }
    return teamState?.channels.filter { $0.workspaceId == workspace.id } ?? []
  }

  var activeChannel: Channel? {
    let channels = activeWorkspaceChannels
    let id = selectedChannelId ?? teamState?.activeChannelId
    return channels.first { $0.id == id } ?? channels.first
  }

  var activeChannelId: String? {
    activeChannel?.id
  }

  var taskPrimaryAgents: [Agent] {
    teamState?.agents.filter(\.isTaskPrimary) ?? []
  }

  var selectedPrimaryAgent: Agent? {
    let agents = taskPrimaryAgents
    if let selectedPrimaryAgentId, let agent = agents.first(where: { $0.id == selectedPrimaryAgentId }) {
      return agent
    }
    return agents.first
  }

  var activeAgents: [Agent] {
    teamState?.agents ?? []
  }

  var temporaryAgentIds: Set<String> {
    Set(activeAgents.filter { $0.isTemporary == 1 }.map(\.id))
  }

  var taskMessages: [TeamMessage] {
    (teamState?.messages ?? []).filter { $0.mode != "discussion" }
  }

  var discussionMessages: [TeamMessage] {
    teamState?.messages ?? []
  }

  var secondaryTaskMessageAgentIds: Set<String> {
    let primaryIds = Set(taskPrimaryAgents.map(\.id))
    let historicalPrimaryIds = Set((teamState?.taskRuns ?? []).map(\.primaryAgentId))
    let mainIds = primaryIds.union(historicalPrimaryIds)
    return Set(activeAgents.filter { !mainIds.contains($0.id) || $0.isTemporary == 1 }.map(\.id))
  }

  var secondaryDiscussionMessageAgentIds: Set<String> {
    let leadIds = Set(activeAgents.filter { $0.agentKind == "discussion" && $0.isPrimary == 1 }.map(\.id))
    let organizerIds = Set((teamState?.discussionRuns ?? []).compactMap(\.organizerAgentId))
    let mainIds = leadIds.union(organizerIds)
    return Set(activeAgents.filter { !mainIds.contains($0.id) || $0.isTemporary == 1 }.map(\.id))
  }

  var activeDiscussion: DiscussionRun? {
    teamState?.discussionRuns.first { $0.status != "closed" }
  }

  var activeDiscussionAgents: [DiscussionAgent] {
    guard let discussionId = activeDiscussion?.id else { return [] }
    return teamState?.discussionAgents.filter { $0.discussionId == discussionId } ?? []
  }

  var pendingCleanupTask: TaskRun? {
    teamState?.taskRuns.first { $0.status == "awaiting_confirmation" || $0.status == "failed" }
  }

  var latestSandboxEvidence: [EvidenceItem] {
    (teamState?.evidenceItems ?? []).filter { !$0.sandboxQuickActions.isEmpty }
  }

  var modelOptions: [HermesModelOption] {
    teamState?.hermesModelState.options ?? []
  }

  func usePastedDesktopLink() {
    do {
      guard !pastedDesktopLink.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        throw HermesTeamClientError.server("请先粘贴桌面端手机链接，或使用自动发现。")
      }
      let parsed = try Self.parseDesktopLink(pastedDesktopLink)
      settings = parsed
      try persistSettings()
      setStatusMessage("已保存 Mac 服务地址。")
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func startServiceDiscovery() {
    guard serviceDiscovery == nil else { return }
    let discovery = HermesServiceDiscovery()
    discovery.onStateChange = { [weak self] isSearching in
      Task { @MainActor in
        self?.isDiscoveringServices = isSearching
      }
    }
    discovery.onUpdate = { [weak self] services in
      Task { @MainActor in
        self?.handleDiscoveredServices(services)
      }
    }
    serviceDiscovery = discovery
    discovery.start()
  }

  func retryServiceDiscovery() {
    serviceDiscovery?.stop()
    serviceDiscovery = nil
    discoveredServices = []
    autoConnectedServiceId = nil
    startServiceDiscovery()
  }

  func connectToDiscoveredService(_ service: DiscoveredHermesService) async {
    guard let baseURL = service.baseURL else {
      errorMessage = "发现到 Mac，但服务地址不可用。"
      return
    }
    guard !service.token.isEmpty else {
      errorMessage = "发现到 Mac，但缺少访问令牌。请在桌面端重启 Hermes Agent Team。"
      return
    }
    settings = ConnectionSettings(serverBaseURL: baseURL, token: service.token)
    do {
      try persistSettings()
      setStatusMessage("已发现 Mac，正在同步。", autoDismiss: false)
      errorMessage = nil
      await refresh(forceBootstrap: true, showsActivity: true)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func connect(fromIncomingURL url: URL) async {
    do {
      settings = try Self.parseConnectionURL(url)
      try persistSettings()
      setStatusMessage("已收到 Mac 服务链接，正在同步。", autoDismiss: false)
      errorMessage = nil
      await refresh(forceBootstrap: true, showsActivity: true)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func updateConnection(serverText: String, token: String) {
    let normalizedServer = Self.normalizedServerURL(serverText)
    settings = ConnectionSettings(serverBaseURL: normalizedServer, token: token.trimmingCharacters(in: .whitespacesAndNewlines))
  }

  func saveConnectionAndRefresh() async {
    do {
      try persistSettings()
      await refresh(forceBootstrap: true, showsActivity: true)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func refresh(forceBootstrap: Bool = false, showsActivity: Bool = false) async {
    guard settings.isComplete else {
      if forceBootstrap || showsActivity {
        errorMessage = "请先填写 Mac 服务地址和访问令牌。"
      }
      return
    }
    if showsActivity {
      await perform("正在同步 Hermes Team") {
        let next = try await self.client.bootstrap(workspaceId: self.selectedWorkspaceId, channelId: self.selectedChannelId)
        self.apply(next)
        self.setStatusMessage("已连接 Mac Hermes 服务。")
      }
      return
    }
    do {
      let next = try await client.bootstrap(workspaceId: selectedWorkspaceId, channelId: selectedChannelId)
      apply(next)
      errorMessage = nil
    } catch {
      if teamState == nil || forceBootstrap {
        errorMessage = error.localizedDescription
      }
    }
  }

  func selectWorkspace(_ workspaceId: String) async {
    selectedWorkspaceId = workspaceId
    selectedChannelId = nil
    selectedPrimaryAgentId = nil
    await refresh(forceBootstrap: true, showsActivity: true)
  }

  func selectChannel(_ channelId: String) async {
    selectedChannelId = channelId
    selectedPrimaryAgentId = nil
    await refresh(forceBootstrap: true, showsActivity: true)
  }

  func createWorkspace() async {
    let name = workspaceName.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty else {
      errorMessage = "请填写工作空间名称。"
      return
    }
    await perform("正在创建工作空间") {
      let next = try await self.client.createWorkspace(name: name)
      self.workspaceName = ""
      self.apply(next)
    }
  }

  func deleteActiveWorkspace() async {
    guard let workspace = activeWorkspace else { return }
    await perform("正在删除工作空间") {
      let next = try await self.client.deleteWorkspace(workspaceId: workspace.id)
      self.selectedWorkspaceId = nil
      self.selectedChannelId = nil
      self.apply(next)
    }
  }

  func createChannel() async {
    let name = channelName.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let workspace = activeWorkspace, !name.isEmpty else {
      errorMessage = "请先选择空间并填写频道名称。"
      return
    }
    await perform("正在创建频道") {
      let next = try await self.client.createChannel(workspaceId: workspace.id, name: name)
      self.channelName = ""
      self.apply(next)
    }
  }

  func deleteChannel(_ channel: Channel) async {
    guard let workspace = activeWorkspace else { return }
    await perform("正在删除频道") {
      let next = try await self.client.deleteChannel(workspaceId: workspace.id, channelId: channel.id)
      self.selectedChannelId = nil
      self.apply(next)
    }
  }

  func createAgent() async {
    guard let workspace = activeWorkspace, let channelId = activeChannelId else {
      errorMessage = "请先选择空间和频道。"
      return
    }
    let name = newAgentName.trimmingCharacters(in: .whitespacesAndNewlines)
    let role = newAgentRole.trimmingCharacters(in: .whitespacesAndNewlines)
    let description = newAgentDescription.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty, !role.isEmpty else {
      errorMessage = "请填写 Agent 名称和角色。"
      return
    }
    let coreCommand = newAgentCoreCommand.trimmingCharacters(in: .whitespacesAndNewlines)
    let runtimeBackend = newAgentRuntimeBackend == "codex" ? "codex" : "hermes"
    let modelProvider = runtimeBackend == "codex" ? newAgentModelProvider.trimmingCharacters(in: .whitespacesAndNewlines) : fallbackModelProvider(newAgentModelProvider)
    let modelName = runtimeBackend == "codex" ? newAgentModelName.trimmingCharacters(in: .whitespacesAndNewlines) : fallbackModelName(newAgentModelName)
    await perform("正在创建 Agent") {
      let next = try await self.client.createAgent(
        workspaceId: workspace.id,
        channelId: channelId,
        name: name,
        role: role,
        description: description,
        coreCommand: coreCommand,
        modelProvider: modelProvider,
        modelName: modelName,
        runtimeBackend: runtimeBackend,
        agentKind: self.newAgentKind
      )
      self.newAgentName = ""
      self.newAgentRole = ""
      self.newAgentDescription = ""
      self.newAgentCoreCommand = ""
      self.apply(next)
    }
  }

  func prepareAgentEdit(_ agent: Agent) {
    editingAgentId = agent.id
    editingAgentCoreCommand = agent.coreCommand
    editingAgentModelProvider = agent.modelProvider
    editingAgentModelName = agent.modelName
    editingAgentRuntimeBackend = agent.runtimeBackend == "codex" ? "codex" : "hermes"
  }

  func saveAgentConfig(_ agent: Agent) async {
    guard let channelId = activeChannelId else { return }
    let runtimeBackend = editingAgentRuntimeBackend == "codex" ? "codex" : "hermes"
    await perform("正在保存 Agent 配置") {
      let next = try await self.client.updateAgentConfig(
        agentId: agent.id,
        channelId: channelId,
        coreCommand: self.editingAgentCoreCommand.trimmingCharacters(in: .whitespacesAndNewlines),
        modelProvider: runtimeBackend == "codex" ? self.editingAgentModelProvider.trimmingCharacters(in: .whitespacesAndNewlines) : self.fallbackModelProvider(self.editingAgentModelProvider),
        modelName: runtimeBackend == "codex" ? self.editingAgentModelName.trimmingCharacters(in: .whitespacesAndNewlines) : self.fallbackModelName(self.editingAgentModelName),
        runtimeBackend: runtimeBackend
      )
      self.editingAgentId = nil
      self.apply(next)
    }
  }

  func toggleAgentChannel(_ agent: Agent) async {
    guard let channelId = activeChannelId else { return }
    await perform(agent.inActiveChannel == 1 ? "正在移出频道" : "正在加入频道") {
      let next = try await self.client.setAgentChannel(agentId: agent.id, channelId: channelId, enabled: agent.inActiveChannel == 0)
      self.apply(next)
    }
  }

  func deleteAgent(_ agent: Agent) async {
    guard let workspace = activeWorkspace, let channelId = activeChannelId else { return }
    await perform("正在删除 Agent") {
      let next = try await self.client.deleteAgent(workspaceId: workspace.id, channelId: channelId, agentId: agent.id)
      self.apply(next)
    }
  }

  func sendTask() async {
    let text = taskText.trimmingCharacters(in: .whitespacesAndNewlines)
    let attachments = taskImageAttachments.map(\.uploadAttachment)
    guard let workspace = activeWorkspace, let channelId = activeChannelId, (!text.isEmpty || !attachments.isEmpty) else {
      return
    }
    if text.hasPrefix("/") && !attachments.isEmpty {
      errorMessage = "命令不能附带图片，请先移除图片或改用普通任务发送。"
      return
    }
    let primaryAgentId = selectedPrimaryAgent?.id
    await perform(text.isEmpty && !attachments.isEmpty ? "正在发送图片到桌面端" : "正在发送任务") {
      let next: TeamState
      if text.hasPrefix("/") {
        next = try await self.client.runSlashCommand(
          workspaceId: workspace.id,
          channelId: channelId,
          mode: "task",
          command: text,
          primaryAgentId: primaryAgentId
        )
      } else if text.isEmpty && !attachments.isEmpty {
        next = try await self.client.sendChannelMessage(
          workspaceId: workspace.id,
          channelId: channelId,
          mode: "task",
          content: "",
          attachments: attachments
        )
      } else {
        guard let primaryAgentId else {
          throw HermesTeamClientError.server("当前空间没有可用任务主 Agent。")
        }
        next = try await self.client.startTaskRun(
          workspaceId: workspace.id,
          channelId: channelId,
          primaryAgentId: primaryAgentId,
          objective: text,
          attachments: attachments
        )
      }
      self.taskText = ""
      self.taskImageAttachments = []
      self.apply(next)
    }
  }

  func sendStatusCommand() async {
    taskImageAttachments = []
    taskText = "/status"
    await sendTask()
  }

  func confirmTaskCleanup() async {
    guard let taskRun = pendingCleanupTask else { return }
    await perform("正在确认清理") {
      let next = try await self.client.confirmTaskCleanup(taskRunId: taskRun.id)
      self.apply(next)
    }
  }

  func runSandboxQuickAction(taskRunId: String, action: SandboxQuickAction) async {
    await perform("正在执行沙箱动作") {
      let next = try await self.client.runSandboxQuickAction(taskRunId: taskRunId, action: action.id)
      self.apply(next)
      self.setStatusMessage(action.destructive ? "沙箱动作已执行。" : "沙箱动作已记录。")
    }
  }

  func sendDiscussion() async {
    let text = discussionText.trimmingCharacters(in: .whitespacesAndNewlines)
    let attachments = discussionImageAttachments.map(\.uploadAttachment)
    guard let workspace = activeWorkspace, let channelId = activeChannelId, (!text.isEmpty || !attachments.isEmpty) else {
      return
    }
    if text.hasPrefix("/") && !attachments.isEmpty {
      errorMessage = "命令不能附带图片，请先移除图片或改用普通讨论发送。"
      return
    }
    await perform(text.isEmpty && !attachments.isEmpty ? "正在发送图片到桌面端" : "正在发送讨论") {
      let next: TeamState
      if text.hasPrefix("/") {
        next = try await self.client.runSlashCommand(
          workspaceId: workspace.id,
          channelId: channelId,
          mode: "discussion",
          command: text,
          primaryAgentId: nil
        )
      } else if text.isEmpty && !attachments.isEmpty {
        next = try await self.client.sendChannelMessage(
          workspaceId: workspace.id,
          channelId: channelId,
          mode: "discussion",
          content: "",
          attachments: attachments
        )
      } else if let activeDiscussion = self.activeDiscussion, activeDiscussion.status == "needs_approval" {
        next = try await self.client.respondDiscussion(discussionId: activeDiscussion.id, content: text, attachments: attachments)
      } else {
        next = try await self.client.startDiscussion(
          workspaceId: workspace.id,
          channelId: channelId,
          topic: text,
          framework: self.discussionFramework,
          attachments: attachments
        )
      }
      self.discussionText = ""
      self.discussionImageAttachments = []
      self.apply(next)
    }
  }

  func continueDiscussion() async {
    guard let discussion = activeDiscussion else { return }
    await perform("正在推进讨论") {
      let next = try await self.client.continueDiscussion(discussionId: discussion.id)
      self.apply(next)
    }
  }

  func approveDiscussionRounds(extraRounds: Int = 1) async {
    guard let discussion = activeDiscussion else { return }
    await perform("正在批准继续讨论") {
      let next = try await self.client.approveDiscussionRounds(discussionId: discussion.id, extraRounds: extraRounds)
      self.apply(next)
    }
  }

  func closeDiscussion() async {
    guard let discussion = activeDiscussion else { return }
    await perform("正在关闭讨论") {
      let next = try await self.client.closeDiscussion(discussionId: discussion.id)
      self.apply(next)
    }
  }

  func refreshDataHealth() async {
    await perform("正在检查数据治理") {
      let next = try await self.client.refreshDataHealth(workspaceId: self.activeWorkspace?.id, channelId: self.activeChannelId)
      self.apply(next)
    }
  }

  func repairDataHealth() async {
    await perform("正在修复数据治理") {
      let next = try await self.client.repairDataHealth(
        workspaceId: self.activeWorkspace?.id,
        channelId: self.activeChannelId,
        repairMode: self.dataRepairMode,
        cleanupProfiles: self.shouldCleanupProfiles
      )
      self.apply(next)
    }
  }

  func openDataGovernancePath(kind: String) async {
    await perform("正在让 Mac 打开目录") {
      let result = try await self.client.openDataGovernancePath(kind: kind)
      self.setStatusMessage(result.ok ? "Mac 已准备目录：\(result.path)" : "Mac 未能打开目录。")
    }
  }

  func runDiagnostic(_ kind: String) async {
    guard let workspace = activeWorkspace, let channelId = activeChannelId else {
      errorMessage = "请先连接并选择空间。"
      return
    }
    await perform("正在执行诊断") {
      let result: DiagnosticResult
      switch kind {
      case "runtime":
        result = try await self.client.testRuntimeLockLifecycle(workspaceId: workspace.id, channelId: channelId)
        self.diagnosticTitle = "运行锁测试"
      case "bridge":
        result = try await self.client.testTaskDiscussionBridgeReliability(
          workspaceId: workspace.id,
          channelId: channelId,
          primaryAgentId: self.selectedPrimaryAgent?.id
        )
        self.diagnosticTitle = "任务讨论桥测试"
      case "closure":
        result = try await self.client.testReliabilityClosure(
          workspaceId: workspace.id,
          channelId: channelId,
          primaryAgentId: self.selectedPrimaryAgent?.id
        )
        self.diagnosticTitle = "可靠性闭环测试"
      default:
        result = try await self.client.testDataGovernance(workspaceId: workspace.id, channelId: channelId)
        self.diagnosticTitle = "数据治理测试"
      }
      self.diagnosticBody = self.formatDiagnostic(result)
    }
  }

  private var client: HermesTeamClient {
    HermesTeamClient(settings: settings)
  }

  private func perform(_ status: String, operation: @escaping () async throws -> Void) async {
    isBusy = true
    setStatusMessage(status, autoDismiss: false)
    errorMessage = nil
    defer { isBusy = false }
    do {
      try await operation()
      scheduleStatusClear()
    } catch is CancellationError {
      return
    } catch {
      statusMessage = ""
      errorMessage = error.localizedDescription
    }
  }

  private func setStatusMessage(_ message: String, autoDismiss: Bool = true) {
    statusClearTask?.cancel()
    statusMessage = message
    if autoDismiss {
      scheduleStatusClear()
    }
  }

  private func scheduleStatusClear() {
    let message = statusMessage
    guard !message.isEmpty else { return }
    statusClearTask?.cancel()
    statusClearTask = Task { [weak self] in
      try? await Task.sleep(for: .seconds(2))
      guard !Task.isCancelled else { return }
      await MainActor.run {
        if self?.statusMessage == message {
          self?.statusMessage = ""
        }
      }
    }
  }

  private func apply(_ state: TeamState) {
    teamState = state
    if selectedWorkspaceId == nil || !state.workspaces.contains(where: { $0.id == selectedWorkspaceId }) {
      selectedWorkspaceId = state.activeWorkspaceId ?? state.workspaces.first?.id
    }
    if selectedChannelId == nil || !state.channels.contains(where: { $0.id == selectedChannelId }) {
      selectedChannelId = state.activeChannelId ?? activeWorkspaceChannels.first?.id
    }
    if selectedPrimaryAgentId == nil || !taskPrimaryAgents.contains(where: { $0.id == selectedPrimaryAgentId }) {
      selectedPrimaryAgentId = taskPrimaryAgents.first?.id
    }
    if newAgentModelProvider.isEmpty {
      newAgentModelProvider = state.hermesModelState.defaultProvider
    }
    if newAgentModelName.isEmpty {
      newAgentModelName = state.hermesModelState.defaultModel
    }
    if let editingAgentId, !state.agents.contains(where: { $0.id == editingAgentId }) {
      self.editingAgentId = nil
    }
  }

  private func fallbackModelProvider(_ value: String) -> String {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmed.isEmpty { return trimmed }
    return teamState?.hermesModelState.defaultProvider ?? "openai"
  }

  private func fallbackModelName(_ value: String) -> String {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmed.isEmpty { return trimmed }
    return teamState?.hermesModelState.defaultModel ?? "gpt-5"
  }

  private func formatDiagnostic(_ result: DiagnosticResult) -> String {
    result
      .sorted { $0.key < $1.key }
      .map { key, value in
        let text = value.displayText
        let shortText = text.count > 500 ? "\(text.prefix(500))..." : text
        return "\(key): \(shortText)"
      }
      .joined(separator: "\n")
  }

  private func handleDiscoveredServices(_ services: [DiscoveredHermesService]) {
    discoveredServices = services
    guard !isConnected, services.count == 1, let service = services.first else { return }
    guard service.id != autoConnectedServiceId, !service.token.isEmpty else { return }
    autoConnectedServiceId = service.id
    Task {
      await connectToDiscoveredService(service)
    }
  }

  private func persistSettings() throws {
    guard let serverBaseURL = settings.serverBaseURL else {
      throw HermesTeamClientError.invalidServerURL
    }
    let token = settings.token.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !token.isEmpty else {
      throw HermesTeamClientError.server("请填写访问令牌，或使用自动发现。")
    }
    settings = ConnectionSettings(serverBaseURL: serverBaseURL, token: token)
    defaults.set(serverBaseURL.absoluteString, forKey: serverURLDefaultsKey)
    try KeychainStore.write(token, account: tokenAccount)
  }

  nonisolated static func parseDesktopLink(_ rawValue: String) throws -> ConnectionSettings {
    let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let url = URL(string: value), let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
      throw HermesTeamClientError.invalidServerURL
    }
    let token = components.queryItems?.first(where: { $0.name == "token" })?.value ?? ""
    guard !token.isEmpty else {
      throw HermesTeamClientError.server("桌面端手机链接缺少 token。")
    }
    guard let scheme = components.scheme, let host = components.host else {
      throw HermesTeamClientError.invalidServerURL
    }
    var baseComponents = URLComponents()
    baseComponents.scheme = scheme
    baseComponents.host = host
    baseComponents.port = components.port
    guard let baseURL = baseComponents.url else {
      throw HermesTeamClientError.invalidServerURL
    }
    return ConnectionSettings(serverBaseURL: baseURL, token: token)
  }

  nonisolated static func parseConnectionURL(_ url: URL) throws -> ConnectionSettings {
    if url.scheme == "http" || url.scheme == "https" {
      return try parseDesktopLink(url.absoluteString)
    }
    guard url.scheme == "hermesagentteam",
          let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
      throw HermesTeamClientError.invalidServerURL
    }
    let items = components.queryItems ?? []
    if let wrappedURL = items.first(where: { $0.name == "url" })?.value {
      return try parseDesktopLink(wrappedURL)
    }
    let server = items.first(where: { $0.name == "server" })?.value ?? ""
    let token = items.first(where: { $0.name == "token" })?.value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard let serverBaseURL = normalizedServerURL(server) else {
      throw HermesTeamClientError.invalidServerURL
    }
    guard !token.isEmpty else {
      throw HermesTeamClientError.server("桌面端手机链接缺少 token。")
    }
    return ConnectionSettings(serverBaseURL: serverBaseURL, token: token)
  }

  nonisolated static func normalizedServerURL(_ rawValue: String) -> URL? {
    let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    if let url = URL(string: trimmed), url.scheme != nil {
      return url
    }
    return URL(string: "http://\(trimmed)")
  }
}
