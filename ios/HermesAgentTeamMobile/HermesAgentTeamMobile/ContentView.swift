import PhotosUI
import SwiftUI
import UIKit

struct ContentView: View {
  @EnvironmentObject private var model: AppModel

  var body: some View {
    TabView {
      WorkspaceView()
        .tabItem { Label("空间", systemImage: "building.2") }

      TaskConsoleView()
        .tabItem { Label("任务", systemImage: "checklist") }

      DiscussionConsoleView()
        .tabItem { Label("讨论", systemImage: "bubble.left.and.bubble.right") }

      ManagementView()
        .tabItem { Label("管理", systemImage: "slider.horizontal.3") }

      SettingsView()
        .tabItem { Label("连接", systemImage: "antenna.radiowaves.left.and.right") }
    }
    .tint(.green)
    .overlay(alignment: .top) {
      if model.isBusy || model.errorMessage != nil || !model.statusMessage.isEmpty {
        StatusBanner()
          .padding(.horizontal)
          .padding(.top, 6)
      }
    }
    .task {
      model.startServiceDiscovery()
      await model.refresh()
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(3))
        if model.isConnected {
          await model.refresh()
        }
      }
    }
    .onOpenURL { url in
      Task {
        await model.connect(fromIncomingURL: url)
      }
    }
  }
}

private struct WorkspaceView: View {
  @EnvironmentObject private var model: AppModel

  var body: some View {
    NavigationStack {
      List {
        if !model.isConnected {
          ConnectionPrompt()
        } else {
          Section("当前连接") {
            LabeledContent("Mac", value: model.settings.serverBaseURL?.absoluteString ?? "")
            LabeledContent("Hermes", value: model.teamState?.hermesPath.isEmpty == false ? "已定位" : "待确认")
            LabeledContent("模式", value: model.teamState?.hermesMode ?? "")
            LabeledContent("频道", value: model.activeChannel?.name ?? "未选择")
          }

          Section("工作空间") {
            ForEach(model.teamState?.workspaces ?? []) { workspace in
              Button {
                Task { await model.selectWorkspace(workspace.id) }
              } label: {
                HStack {
                  VStack(alignment: .leading, spacing: 4) {
                    Text(workspace.name)
                      .font(.headline)
                    Text(workspace.id)
                      .font(.caption)
                      .foregroundStyle(.secondary)
                  }
                  Spacer()
                  if workspace.id == model.activeWorkspace?.id {
                    Image(systemName: "checkmark.circle.fill")
                      .foregroundStyle(.green)
                  }
                }
              }
            }

            HStack {
              TextField("新工作空间名称", text: $model.workspaceName)
                .textInputAutocapitalization(.never)
              Button {
                Task { await model.createWorkspace() }
              } label: {
                Image(systemName: "plus.circle.fill")
              }
              .disabled(model.isBusy)
            }
          }

          if let workspace = model.activeWorkspace {
            Section("空间操作") {
              LabeledContent("当前空间", value: workspace.name)
              Button(role: .destructive) {
                Task { await model.deleteActiveWorkspace() }
              } label: {
                Label("归档并删除当前空间", systemImage: "trash")
              }
            }
          }
        }
      }
      .navigationTitle("Hermes Agent Team")
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            Task { await model.refresh(forceBootstrap: true, showsActivity: true) }
          } label: {
            Image(systemName: "arrow.clockwise")
          }
          .disabled(model.isBusy)
        }
      }
    }
  }
}

private struct TaskConsoleView: View {
  @EnvironmentObject private var model: AppModel

  var body: some View {
    NavigationStack {
      Group {
        if !model.isConnected {
          ConnectionPrompt()
            .padding()
        } else {
          VStack(spacing: 0) {
            TaskAgentBar()
            MessageListView(
              messages: model.taskMessages,
              secondaryAgentIds: model.secondaryTaskMessageAgentIds,
              temporaryAgentIds: model.temporaryAgentIds,
              emptyTitle: "还没有任务消息",
              emptySystemImage: "checklist",
              emptyDescription: "发送第一个任务后，这里会显示 Agent 的回复。"
            )
            ConsoleInputBar(
              text: $model.taskText,
              attachments: model.taskImageAttachments,
              placeholder: "输入要交给 Agent 的任务或 /命令",
              primaryTitle: "发送",
              primarySystemImage: "paperplane.fill",
              secondaryTitle: "状态",
              secondarySystemImage: "waveform.path.ecg",
              isBusy: model.isBusy,
              isPrimaryDisabled: model.taskText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && model.taskImageAttachments.isEmpty,
              addImageData: { data in model.addTaskImageData(data) },
              removeAttachment: { attachment in model.removeTaskImageAttachment(attachment) },
              secondaryAction: {
                Task { await model.sendStatusCommand() }
              },
              primaryAction: {
                Task { await model.sendTask() }
              }
            )
          }
        }
      }
      .navigationTitle("任务")
    }
  }
}

private struct DiscussionConsoleView: View {
  @EnvironmentObject private var model: AppModel

  var body: some View {
    NavigationStack {
      Group {
        if !model.isConnected {
          ConnectionPrompt()
            .padding()
        } else {
          VStack(spacing: 0) {
            DiscussionOptionsBar()
            MessageListView(
              messages: model.discussionMessages,
              secondaryAgentIds: model.secondaryDiscussionMessageAgentIds,
              temporaryAgentIds: model.temporaryAgentIds,
              emptyTitle: "还没有讨论消息",
              emptySystemImage: "bubble.left.and.bubble.right",
              emptyDescription: "发起讨论后，这里会显示团队过程和结论。"
            )
            ConsoleInputBar(
              text: $model.discussionText,
              attachments: model.discussionImageAttachments,
              placeholder: model.activeDiscussion?.status == "needs_approval" ? "回复 Leader" : "输入讨论主题或 /命令",
              primaryTitle: "发送",
              primarySystemImage: "paperplane.fill",
              secondaryTitle: nil,
              secondarySystemImage: nil,
              isBusy: model.isBusy,
              isPrimaryDisabled: model.discussionText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && model.discussionImageAttachments.isEmpty,
              addImageData: { data in model.addDiscussionImageData(data) },
              removeAttachment: { attachment in model.removeDiscussionImageAttachment(attachment) },
              secondaryAction: nil,
              primaryAction: {
                Task { await model.sendDiscussion() }
              }
            )
          }
        }
      }
      .navigationTitle("讨论")
    }
  }
}

private struct ManagementView: View {
  @EnvironmentObject private var model: AppModel

  var body: some View {
    NavigationStack {
      List {
        if !model.isConnected {
          ConnectionPrompt()
        } else {
          ChannelManagementSection()
          AgentCreateSection()
          AgentManagementSection()
          DataGovernanceSection()
          RuntimeAndEvidenceSection()
          TeamRecordsSection()
          DiagnosticsSection()
        }
      }
      .navigationTitle("管理")
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            Task { await model.refresh(forceBootstrap: true, showsActivity: true) }
          } label: {
            Image(systemName: "arrow.clockwise")
          }
          .disabled(model.isBusy)
        }
      }
    }
  }
}

private struct ChannelManagementSection: View {
  @EnvironmentObject private var model: AppModel

  var body: some View {
    Section("频道") {
      ForEach(model.activeWorkspaceChannels) { channel in
        HStack {
          Button {
            Task { await model.selectChannel(channel.id) }
          } label: {
            HStack {
              VStack(alignment: .leading, spacing: 3) {
                Text(channel.name)
                  .font(.headline)
                Text(channel.id)
                  .font(.caption2)
                  .foregroundStyle(.secondary)
              }
              Spacer()
              if channel.id == model.activeChannel?.id {
                Image(systemName: "checkmark.circle.fill")
                  .foregroundStyle(.green)
              }
            }
          }
          if model.activeWorkspaceChannels.count > 1 {
            Button(role: .destructive) {
              Task { await model.deleteChannel(channel) }
            } label: {
              Image(systemName: "trash")
            }
            .buttonStyle(.borderless)
          }
        }
      }

      HStack {
        TextField("新频道名称", text: $model.channelName)
          .textInputAutocapitalization(.never)
        Button {
          Task { await model.createChannel() }
        } label: {
          Label("创建", systemImage: "plus.circle")
        }
        .disabled(model.isBusy || model.channelName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
  }
}

private struct AgentCreateSection: View {
  @EnvironmentObject private var model: AppModel

  var body: some View {
    Section("新建 Agent") {
      Picker("类型", selection: $model.newAgentKind) {
        Text("任务").tag("task")
        Text("讨论").tag("discussion")
      }
      .pickerStyle(.segmented)

      Picker("底层后端", selection: $model.newAgentRuntimeBackend) {
        Text("Hermes").tag("hermes")
        Text("Codex").tag("codex")
      }
      .pickerStyle(.segmented)

      TextField("名称", text: $model.newAgentName)
        .textInputAutocapitalization(.never)
      TextField("角色", text: $model.newAgentRole)
      TextField("描述", text: $model.newAgentDescription, axis: .vertical)
        .lineLimit(2...4)
      TextField("核心命令", text: $model.newAgentCoreCommand, axis: .vertical)
        .lineLimit(2...6)

      ModelFields(provider: $model.newAgentModelProvider, modelName: $model.newAgentModelName)

      Button {
        Task { await model.createAgent() }
      } label: {
        Label("创建 Agent", systemImage: "person.badge.plus")
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .disabled(model.isBusy)
    }
  }
}

private struct AgentManagementSection: View {
  @EnvironmentObject private var model: AppModel

  var body: some View {
    Section("Agent") {
      if model.activeAgents.isEmpty {
        Label("当前空间没有 Agent", systemImage: "person.2.slash")
          .foregroundStyle(.secondary)
      } else {
        ForEach(model.activeAgents) { agent in
          AgentManagementRow(agent: agent)
        }
      }
    }
  }
}

private struct AgentManagementRow: View {
  @EnvironmentObject private var model: AppModel
  let agent: Agent

  var isEditing: Bool {
    model.editingAgentId == agent.id
  }

  var body: some View {
    DisclosureGroup {
      VStack(alignment: .leading, spacing: 10) {
        LabeledContent("角色", value: agent.role)
        LabeledContent("类型", value: agent.agentKind == "discussion" ? "讨论" : "任务")
        LabeledContent("后端", value: agent.runtimeBackend == "codex" ? "Codex" : "Hermes")
        LabeledContent("状态", value: agent.status)
        LabeledContent(agent.runtimeBackend == "codex" ? "Runtime" : "Profile", value: agent.hermesProfile)

        if !agent.currentTask.isEmpty {
          Text(agent.currentTask)
            .font(.footnote)
            .foregroundStyle(.secondary)
        }

        Toggle(isOn: Binding(
          get: { agent.inActiveChannel == 1 },
          set: { _ in Task { await model.toggleAgentChannel(agent) } }
        )) {
          Label("加入当前频道", systemImage: "number")
        }
        .disabled(model.isBusy)

        if isEditing {
          Picker("底层后端", selection: $model.editingAgentRuntimeBackend) {
            Text("Hermes").tag("hermes")
            Text("Codex").tag("codex")
          }
          .pickerStyle(.segmented)
          TextField("核心命令", text: $model.editingAgentCoreCommand, axis: .vertical)
            .lineLimit(2...8)
          ModelFields(provider: $model.editingAgentModelProvider, modelName: $model.editingAgentModelName)
          HStack {
            Button {
              model.editingAgentId = nil
            } label: {
              Label("取消", systemImage: "xmark.circle")
            }
            Spacer()
            Button {
              Task { await model.saveAgentConfig(agent) }
            } label: {
              Label("保存", systemImage: "checkmark.circle")
            }
            .buttonStyle(.borderedProminent)
          }
        } else {
          LabeledContent("模型", value: "\(agent.modelProvider) / \(agent.modelName)")
          Button {
            model.prepareAgentEdit(agent)
          } label: {
            Label("编辑模型与核心命令", systemImage: "slider.horizontal.3")
          }
        }

        if agent.canDelete {
          Button(role: .destructive) {
            Task { await model.deleteAgent(agent) }
          } label: {
            Label("删除 Agent", systemImage: "trash")
          }
          .disabled(model.isBusy)
        }
      }
      .padding(.vertical, 6)
    } label: {
      HStack {
        Image(systemName: agent.agentKind == "discussion" ? "bubble.left.and.bubble.right" : "person.crop.circle.badge.checkmark")
          .foregroundStyle(agent.inActiveChannel == 1 ? .green : .secondary)
          .frame(width: 24)
        VStack(alignment: .leading, spacing: 3) {
          Text(agent.name)
            .font(.headline)
          Text(agent.role)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        Spacer()
        Text(agent.status)
          .font(.caption2)
          .foregroundStyle(.secondary)
      }
    }
  }
}

private struct ModelFields: View {
  @EnvironmentObject private var model: AppModel
  @Binding var provider: String
  @Binding var modelName: String

  var body: some View {
    if model.modelOptions.isEmpty {
      TextField("模型 Provider", text: $provider)
        .textInputAutocapitalization(.never)
      TextField("模型名称", text: $modelName)
        .textInputAutocapitalization(.never)
    } else {
      Picker("模型", selection: modelBinding) {
        ForEach(model.modelOptions, id: \.self) { option in
          Text(option.label).tag("\(option.provider)|\(option.model)")
        }
      }
      .pickerStyle(.menu)
    }
  }

  private var modelBinding: Binding<String> {
    Binding(
      get: { "\(provider)|\(modelName)" },
      set: { value in
        let parts = value.split(separator: "|", maxSplits: 1).map(String.init)
        provider = parts.first ?? provider
        modelName = parts.count > 1 ? parts[1] : modelName
      }
    )
  }
}

private struct DataGovernanceSection: View {
  @EnvironmentObject private var model: AppModel

  var body: some View {
    Section("数据治理") {
      if let report = model.teamState?.dataHealth {
        LabeledContent("状态", value: "\(report.status) · \(report.issueCount) 个问题")
        LabeledContent("空间 / Agent", value: "\(report.counts.workspaces) / \(report.counts.agents)")
        LabeledContent("孤儿数据", value: "\(report.counts.orphanRows)")
        LabeledContent("外键失败", value: "\(report.counts.foreignKeyFailures)")
        LabeledContent("备份", value: "\(report.counts.backupFiles) 个")
        LabeledContent("最新报告", value: report.lastReportPath.isEmpty ? "未生成" : report.lastReportPath)
          .font(.footnote)
      }

      Button {
        Task { await model.refreshDataHealth() }
      } label: {
        Label("检查数据健康", systemImage: "stethoscope")
      }

      Picker("修复范围", selection: $model.dataRepairMode) {
        Text("数据库").tag("database")
        Text("Profile").tag("profiles")
        Text("全部").tag("all")
      }
      Toggle("清理孤立 Profile", isOn: $model.shouldCleanupProfiles)
      Button {
        Task { await model.repairDataHealth() }
      } label: {
        Label("执行修复", systemImage: "cross.case")
      }
      .disabled(model.isBusy || model.teamState?.dataHealth.canRepair == false)

      HStack {
        Button("归档") { Task { await model.openDataGovernancePath(kind: "profile_archive") } }
        Button("备份") { Task { await model.openDataGovernancePath(kind: "backups") } }
        Button("报告") { Task { await model.openDataGovernancePath(kind: "reports") } }
        Button("根目录") { Task { await model.openDataGovernancePath(kind: "root") } }
      }
      .buttonStyle(.bordered)
    }
  }
}

private struct RuntimeAndEvidenceSection: View {
  @EnvironmentObject private var model: AppModel

  var body: some View {
    Section("运行时与证据") {
      if let locks = model.teamState?.runtimeLocks, !locks.isEmpty {
        DisclosureGroup("运行锁 \(locks.count)") {
          ForEach(locks.prefix(12)) { lock in
            VStack(alignment: .leading, spacing: 4) {
              LabeledContent(lock.resource, value: lock.status)
              Text(lock.reason)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(3)
            }
          }
        }
      }

      if let links = model.teamState?.taskDiscussionLinks, !links.isEmpty {
        DisclosureGroup("任务讨论桥 \(links.count)") {
          ForEach(links.prefix(12)) { link in
            VStack(alignment: .leading, spacing: 4) {
              LabeledContent(link.status, value: "\(link.discussCount) 次")
              Text(link.requestText)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(3)
            }
          }
        }
      }

      if model.latestSandboxEvidence.isEmpty {
        Label("当前没有可执行沙箱动作", systemImage: "shippingbox")
          .foregroundStyle(.secondary)
      } else {
        ForEach(model.latestSandboxEvidence.prefix(8)) { item in
          VStack(alignment: .leading, spacing: 8) {
            Text(item.title)
              .font(.headline)
            Text(item.content)
              .font(.caption)
              .foregroundStyle(.secondary)
              .lineLimit(4)
            if let taskRunId = item.taskRunId {
              ForEach(item.sandboxQuickActions) { action in
                Button(role: action.destructive ? .destructive : nil) {
                  Task { await model.runSandboxQuickAction(taskRunId: taskRunId, action: action) }
                } label: {
                  Label(action.label, systemImage: action.destructive ? "trash" : "terminal")
                }
                .disabled(model.isBusy)
              }
            }
          }
        }
      }
    }
  }
}

private struct TeamRecordsSection: View {
  @EnvironmentObject private var model: AppModel

  var body: some View {
    Section("记录") {
      RecordDisclosure(
        title: "黑板",
        systemImage: "pinboard",
        count: model.teamState?.blackboardEntries.count ?? 0
      ) {
        ForEach((model.teamState?.blackboardEntries ?? []).prefix(20)) { entry in
          RecordText(title: entry.key, subtitle: entry.scope, bodyText: entry.value)
        }
      }

      RecordDisclosure(
        title: "内容资产",
        systemImage: "doc.richtext",
        count: model.teamState?.contentAssets.count ?? 0
      ) {
        ForEach((model.teamState?.contentAssets ?? []).prefix(20)) { asset in
          RecordText(title: asset.title, subtitle: asset.assetType, bodyText: asset.summary.isEmpty ? asset.content : asset.summary)
        }
      }

      RecordDisclosure(
        title: "证据",
        systemImage: "checkmark.seal",
        count: model.teamState?.evidenceItems.count ?? 0
      ) {
        ForEach((model.teamState?.evidenceItems ?? []).prefix(20)) { item in
          RecordText(title: item.title, subtitle: item.kind, bodyText: item.content)
        }
      }

      RecordDisclosure(
        title: "决策",
        systemImage: "arrow.triangle.branch",
        count: model.teamState?.decisionRecords.count ?? 0
      ) {
        ForEach((model.teamState?.decisionRecords ?? []).prefix(20)) { record in
          RecordText(title: record.status, subtitle: record.framework, bodyText: record.decision.isEmpty ? record.summary : record.decision)
        }
      }

      RecordDisclosure(
        title: "审计",
        systemImage: "list.bullet.clipboard",
        count: model.teamState?.audits.count ?? 0
      ) {
        ForEach((model.teamState?.audits ?? []).prefix(30)) { audit in
          RecordText(title: audit.action, subtitle: audit.result, bodyText: audit.detail)
        }
      }
    }
  }
}

private struct DiagnosticsSection: View {
  @EnvironmentObject private var model: AppModel

  var body: some View {
    Section("诊断测试") {
      Button { Task { await model.runDiagnostic("runtime") } } label: {
        Label("运行锁生命周期", systemImage: "lock.rotation")
      }
      Button { Task { await model.runDiagnostic("bridge") } } label: {
        Label("任务讨论桥可靠性", systemImage: "point.3.connected.trianglepath.dotted")
      }
      Button { Task { await model.runDiagnostic("closure") } } label: {
        Label("可靠性闭环", systemImage: "checkmark.arrow.trianglehead.counterclockwise")
      }
      Button { Task { await model.runDiagnostic("data") } } label: {
        Label("数据治理回归", systemImage: "externaldrive.badge.checkmark")
      }

      if !model.diagnosticBody.isEmpty {
        VStack(alignment: .leading, spacing: 6) {
          Text(model.diagnosticTitle)
            .font(.headline)
          Text(model.diagnosticBody)
            .font(.caption.monospaced())
            .textSelection(.enabled)
        }
      }
    }
  }
}

private struct RecordDisclosure<Content: View>: View {
  let title: String
  let systemImage: String
  let count: Int
  @ViewBuilder let content: () -> Content

  var body: some View {
    DisclosureGroup {
      if count == 0 {
        Label("暂无记录", systemImage: systemImage)
          .foregroundStyle(.secondary)
      } else {
        content()
      }
    } label: {
      Label("\(title) \(count)", systemImage: systemImage)
    }
  }
}

private struct RecordText: View {
  let title: String
  let subtitle: String
  let bodyText: String

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack {
        Text(title)
          .font(.subheadline.weight(.semibold))
          .lineLimit(1)
        Spacer()
        Text(subtitle)
          .font(.caption2)
          .foregroundStyle(.secondary)
      }
      if !bodyText.isEmpty {
        Text(bodyText)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(5)
          .textSelection(.enabled)
      }
    }
    .padding(.vertical, 4)
  }
}

private struct TaskAgentBar: View {
  @EnvironmentObject private var model: AppModel

  var body: some View {
    VStack(spacing: 10) {
      HStack {
        Label("主 Agent", systemImage: "person.badge.key")
          .font(.subheadline.weight(.semibold))
        Spacer()
        Picker("主 Agent", selection: Binding(
          get: { model.selectedPrimaryAgentId ?? model.selectedPrimaryAgent?.id ?? "" },
          set: { model.selectedPrimaryAgentId = $0 }
        )) {
          ForEach(model.taskPrimaryAgents) { agent in
            Text("\(agent.name) · \(agent.role)").tag(agent.id)
          }
        }
        .labelsHidden()
        .pickerStyle(.menu)
      }

      if let task = model.pendingCleanupTask {
        Button {
          Task { await model.confirmTaskCleanup() }
        } label: {
          Label("确认完成并清理临时 Agent", systemImage: "checkmark.seal")
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .disabled(model.isBusy || task.id.isEmpty)
      }
    }
    .padding(.horizontal)
    .padding(.vertical, 10)
    .background(.bar)
  }
}

private struct DiscussionOptionsBar: View {
  @EnvironmentObject private var model: AppModel

  private let frameworks = [
    ("balanced_decision", "平衡决策"),
    ("daci_decision", "DACI"),
    ("rapid_decision", "RAPID"),
    ("delphi_consensus", "Delphi"),
    ("six_hats", "六顶思考帽"),
    ("premortem_risk", "Pre-mortem"),
    ("red_team", "Red Team"),
    ("double_diamond", "Double Diamond")
  ]

  var body: some View {
    VStack(spacing: 8) {
      HStack {
        Label("讨论框架", systemImage: "square.stack.3d.up")
          .font(.subheadline.weight(.semibold))
        Spacer()
        Picker("讨论框架", selection: $model.discussionFramework) {
          ForEach(frameworks, id: \.0) { framework in
            Text(framework.1).tag(framework.0)
          }
        }
        .labelsHidden()
        .pickerStyle(.menu)
      }

      if let activeDiscussion = model.activeDiscussion {
        HStack {
          VStack(alignment: .leading, spacing: 2) {
            Text(activeDiscussion.topic)
              .font(.footnote.weight(.semibold))
              .lineLimit(1)
            Text("\(activeDiscussion.status) · \(model.activeDiscussionAgents.count) 个 Agent")
              .font(.caption2)
              .foregroundStyle(.secondary)
          }
          Spacer()
          Button {
            Task { await model.continueDiscussion() }
          } label: {
            Image(systemName: "play.circle")
          }
          .disabled(model.isBusy || activeDiscussion.status != "active")
          Button {
            Task { await model.approveDiscussionRounds() }
          } label: {
            Image(systemName: "plus.circle")
          }
          .disabled(model.isBusy || activeDiscussion.status == "closed")
          Button(role: .destructive) {
            Task { await model.closeDiscussion() }
          } label: {
            Image(systemName: "xmark.circle")
          }
          .disabled(model.isBusy || activeDiscussion.status == "closed")
        }
      }
    }
    .padding(.horizontal)
    .padding(.vertical, 10)
    .background(.bar)
  }
}

private struct ConsoleInputBar: View {
  @Binding var text: String
  let attachments: [ImageDraftAttachment]
  let placeholder: String
  let primaryTitle: String
  let primarySystemImage: String
  let secondaryTitle: String?
  let secondarySystemImage: String?
  let isBusy: Bool
  let isPrimaryDisabled: Bool
  let addImageData: (Data) -> Void
  let removeAttachment: (ImageDraftAttachment) -> Void
  let secondaryAction: (() -> Void)?
  let primaryAction: () -> Void

  @State private var selectedPhoto: PhotosPickerItem?
  @FocusState private var isFocused: Bool

  var body: some View {
    VStack(spacing: 10) {
      if !attachments.isEmpty {
        DraftImageStrip(attachments: attachments, removeAttachment: removeAttachment)
      }

      TextField(placeholder, text: $text, axis: .vertical)
        .lineLimit(2...6)
        .textInputAutocapitalization(.sentences)
        .focused($isFocused)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 8))
        .overlay(
          RoundedRectangle(cornerRadius: 8)
            .stroke(Color(.separator).opacity(isFocused ? 0.55 : 0.25))
        )

      HStack {
        PhotosPicker(selection: $selectedPhoto, matching: .images, photoLibrary: .shared()) {
          Label("图片", systemImage: "photo")
        }
        .buttonStyle(.bordered)
        .disabled(isBusy || attachments.count >= 4)

        if let secondaryTitle, let secondarySystemImage, let secondaryAction {
          Button {
            isFocused = false
            secondaryAction()
          } label: {
            Label(secondaryTitle, systemImage: secondarySystemImage)
          }
          .buttonStyle(.bordered)
          .disabled(isBusy)
        }

        Spacer()

        Button {
          isFocused = false
          primaryAction()
        } label: {
          Label(primaryTitle, systemImage: primarySystemImage)
        }
        .buttonStyle(.borderedProminent)
        .disabled(isBusy || isPrimaryDisabled)
      }
    }
    .padding(.horizontal)
    .padding(.top, 10)
    .padding(.bottom, 8)
    .background(.bar)
    .onChange(of: selectedPhoto) { _, item in
      guard let item else { return }
      Task {
        if let data = try? await item.loadTransferable(type: Data.self) {
          await MainActor.run {
            addImageData(data)
          }
        }
        await MainActor.run {
          selectedPhoto = nil
        }
      }
    }
  }
}

private struct DraftImageStrip: View {
  let attachments: [ImageDraftAttachment]
  let removeAttachment: (ImageDraftAttachment) -> Void

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(attachments) { attachment in
          HStack(spacing: 7) {
            Image(uiImage: attachment.previewImage)
              .resizable()
              .scaledToFill()
              .frame(width: 44, height: 44)
              .clipShape(RoundedRectangle(cornerRadius: 8))
            Text(attachment.fileName)
              .font(.caption.weight(.semibold))
              .lineLimit(1)
              .frame(maxWidth: 120, alignment: .leading)
            Button {
              removeAttachment(attachment)
            } label: {
              Image(systemName: "xmark.circle.fill")
                .imageScale(.medium)
            }
            .buttonStyle(.plain)
          }
          .padding(6)
          .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 8))
        }
      }
      .padding(.vertical, 2)
    }
  }
}

private struct SettingsView: View {
  @EnvironmentObject private var model: AppModel
  @State private var serverText = ""
  @State private var tokenText = ""

  var body: some View {
    NavigationStack {
      List {
        Section("连接状态") {
          LabeledContent("Mac", value: model.settings.serverBaseURL?.absoluteString ?? "未设置")
          LabeledContent("令牌", value: model.settings.token.isEmpty ? "未保存" : "已保存")
          LabeledContent("同步", value: model.isBusy ? "同步中" : (model.isConnected ? "已连接" : "待测试"))
          if let server = model.teamState?.mobileServer {
            LabeledContent("发现", value: server.discovery?.enabled == true ? "已开启" : "未开启")
            if !server.warning.isEmpty {
              Text(server.warning)
                .font(.caption)
                .foregroundStyle(.orange)
            }
          }
        }

        Section("自动发现") {
          if model.discoveredServices.isEmpty {
            Label(model.isDiscoveringServices ? "正在搜索附近 Mac" : "未发现 Mac 服务", systemImage: "dot.radiowaves.left.and.right")
              .foregroundStyle(.secondary)
          } else {
            ForEach(model.discoveredServices) { service in
              DiscoveredServiceRow(service: service, isBusy: model.isBusy) {
                Task {
                  await model.connectToDiscoveredService(service)
                  await MainActor.run {
                    syncFieldsFromModel()
                  }
                }
              }
            }
          }

          Button {
            model.retryServiceDiscovery()
          } label: {
            Label("重新搜索", systemImage: "arrow.clockwise")
          }
        }

        Section("桌面链接") {
          TextField("粘贴桌面端复制的手机链接", text: $model.pastedDesktopLink, axis: .vertical)
            .lineLimit(2...4)
            .textInputAutocapitalization(.never)
            .keyboardType(.URL)
          HStack {
            Button {
              if let paste = UIPasteboard.general.string {
                model.pastedDesktopLink = paste
              }
            } label: {
              Label("粘贴", systemImage: "doc.on.clipboard")
            }

            Spacer()

            Button {
              model.usePastedDesktopLink()
              syncFieldsFromModel()
              Task { await model.saveConnectionAndRefresh() }
            } label: {
              Label("连接", systemImage: "link")
            }
            .buttonStyle(.borderedProminent)
          }
        }

        Section("手动连接") {
          TextField("http://Mac-IP:18788", text: $serverText)
            .textInputAutocapitalization(.never)
            .keyboardType(.URL)
          SecureField("访问令牌", text: $tokenText)
          Button {
            model.updateConnection(serverText: serverText, token: tokenText)
            Task { await model.saveConnectionAndRefresh() }
          } label: {
            Label("保存并测试", systemImage: "checkmark.circle")
          }
          .disabled(model.isBusy)
        }

        Section("安全") {
          ChecklistRow(done: true, title: "令牌保存在钥匙串")
          ChecklistRow(done: true, title: "仅连接已授权的 Mac 地址")
          ChecklistRow(done: model.isConnected, title: "当前连接已验证")
        }
      }
      .navigationTitle("连接")
      .onAppear {
        syncFieldsFromModel()
        model.startServiceDiscovery()
      }
      .onChange(of: model.settings) {
        syncFieldsFromModel()
      }
    }
  }

  private func syncFieldsFromModel() {
    serverText = model.settings.serverBaseURL?.absoluteString ?? ""
    tokenText = model.settings.token
  }
}

private struct DiscoveredServiceRow: View {
  let service: DiscoveredHermesService
  let isBusy: Bool
  let connect: () -> Void

  var body: some View {
    HStack(alignment: .center, spacing: 12) {
      Image(systemName: "desktopcomputer")
        .font(.title3)
        .foregroundStyle(.green)
        .frame(width: 30)

      VStack(alignment: .leading, spacing: 4) {
        Text(service.name)
          .font(.headline)
          .lineLimit(1)
        Text(service.endpointText)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
        Text("令牌 \(service.tokenPreview)")
          .font(.caption2)
          .foregroundStyle(.secondary)
      }

      Spacer(minLength: 8)

      Button(action: connect) {
        Text("连接")
      }
      .buttonStyle(.borderedProminent)
      .disabled(isBusy || service.token.isEmpty)
    }
    .padding(.vertical, 4)
  }
}

private struct MessageListView: View {
  let messages: [TeamMessage]
  let secondaryAgentIds: Set<String>
  let temporaryAgentIds: Set<String>
  let emptyTitle: String
  let emptySystemImage: String
  let emptyDescription: String

  private var visibleMessages: [TeamMessage] {
    Array(messages.suffix(80))
  }

  var body: some View {
    Group {
      if visibleMessages.isEmpty {
        ContentUnavailableView(
          emptyTitle,
          systemImage: emptySystemImage,
          description: Text(emptyDescription)
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        ScrollViewReader { proxy in
          ScrollView {
            LazyVStack(spacing: 10) {
              ForEach(visibleMessages) { message in
                if message.senderType == "agent", let senderId = message.senderId, secondaryAgentIds.contains(senderId) {
                  SecondaryAgentMessageBubble(
                    message: message,
                    agentLabel: temporaryAgentIds.contains(senderId) ? "临时 Agent" : "副 Agent"
                  )
                    .id(message.id)
                } else if message.senderType == "agent" {
                  PrimaryAgentMessageBubble(message: message)
                    .id(message.id)
                } else {
                  MessageBubble(message: message)
                    .id(message.id)
                }
              }
            }
            .padding(.horizontal)
            .padding(.vertical, 12)
          }
          .scrollDismissesKeyboard(.interactively)
          .background(Color(.systemGroupedBackground))
          .onAppear {
            scrollToLatest(with: proxy)
          }
          .onChange(of: visibleMessages.last?.id) {
            scrollToLatest(with: proxy)
          }
        }
      }
    }
  }

  private func scrollToLatest(with proxy: ScrollViewProxy) {
    guard let lastId = visibleMessages.last?.id else { return }
    DispatchQueue.main.async {
      withAnimation(.easeOut(duration: 0.2)) {
        proxy.scrollTo(lastId, anchor: .bottom)
      }
    }
  }
}

private struct SecondaryAgentMessageBubble: View {
  let message: TeamMessage
  let agentLabel: String

  private var displayContent: String {
    stripAttachmentContext(message.content)
  }

  var body: some View {
    HStack(alignment: .bottom) {
      DisclosureGroup {
        VStack(alignment: .leading, spacing: 8) {
          Text(displayContent)
            .font(.body)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)

          MessageAttachmentStrip(attachments: message.attachments)

          if message.status != "visible" {
            Text(message.status)
              .font(.caption)
              .foregroundStyle(.red)
          }
        }
        .padding(.top, 8)
      } label: {
        VStack(alignment: .leading, spacing: 6) {
          HStack(spacing: 8) {
            Text(message.senderName)
              .font(.subheadline.weight(.semibold))
              .lineLimit(1)
            Text(agentLabel)
              .font(.caption)
              .foregroundStyle(.secondary)
            Text(message.mode)
              .font(.caption)
              .foregroundStyle(.secondary)
          }

          Text(compactMessagePreview(displayContent))
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(2)
        }
      }
      .padding(10)
      .background(Color(.tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 8))
      .overlay(
        RoundedRectangle(cornerRadius: 8)
          .stroke(Color(.separator).opacity(0.28), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
      )

      Spacer(minLength: 34)
    }
  }
}

private struct PrimaryAgentMessageBubble: View {
  let message: TeamMessage

  private var focusedContent: FocusedMessageContent {
    focusMessageContent(stripAttachmentContext(message.content))
  }

  var body: some View {
    HStack(alignment: .bottom) {
      VStack(alignment: .leading, spacing: 8) {
        HStack(spacing: 8) {
          Text(message.senderName)
            .font(.subheadline.weight(.semibold))
            .lineLimit(1)
          Text("主 Agent")
            .font(.caption)
            .foregroundStyle(.secondary)
          Text(message.mode)
            .font(.caption)
            .foregroundStyle(.secondary)
        }

        Text(focusedContent.conclusion)
          .font(.body.weight(focusedContent.hasConclusion ? .semibold : .regular))
          .foregroundStyle(focusedContent.hasConclusion ? .primary : .secondary)
          .textSelection(.enabled)
          .fixedSize(horizontal: false, vertical: true)

        MessageAttachmentStrip(attachments: message.attachments)

        if !focusedContent.process.isEmpty {
          DisclosureGroup {
            Text(focusedContent.process)
              .font(.body)
              .foregroundStyle(.secondary)
              .textSelection(.enabled)
              .fixedSize(horizontal: false, vertical: true)
              .padding(.top, 6)
          } label: {
            Label("查看非结论内容", systemImage: "doc.text.magnifyingglass")
              .font(.caption.weight(.semibold))
          }
        }

        if message.status != "visible" {
          Text(message.status)
            .font(.caption)
            .foregroundStyle(.red)
        }
      }
      .padding(10)
      .background(Color.green.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
      .overlay(
        RoundedRectangle(cornerRadius: 8)
          .stroke(Color.green.opacity(0.26))
      )

      Spacer(minLength: 34)
    }
  }
}

private struct MessageBubble: View {
  let message: TeamMessage

  private var isUserMessage: Bool {
    message.senderType == "human" || message.senderType == "user"
  }

  private var displayContent: String {
    stripAttachmentContext(message.content)
  }

  var body: some View {
    HStack(alignment: .bottom) {
      if isUserMessage {
        Spacer(minLength: 44)
      }

      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 8) {
          Text(message.senderName)
            .font(.subheadline.weight(.semibold))
          Text(message.mode)
            .font(.caption)
            .foregroundStyle(.secondary)
        }

        Text(displayContent)
          .font(.body)
          .textSelection(.enabled)
          .fixedSize(horizontal: false, vertical: true)

        MessageAttachmentStrip(attachments: message.attachments)

        if message.status != "visible" {
          Text(message.status)
            .font(.caption)
            .foregroundStyle(.red)
        }
      }
      .padding(10)
      .background(
        isUserMessage ? Color.green.opacity(0.16) : Color(.secondarySystemGroupedBackground),
        in: RoundedRectangle(cornerRadius: 8)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 8)
          .stroke(Color(.separator).opacity(0.22))
      )

      if !isUserMessage {
        Spacer(minLength: 34)
      }
    }
  }
}

private struct MessageAttachmentStrip: View {
  let attachments: [MessageAttachment]
  @State private var previewAttachment: MessageAttachment?

  private var imageAttachments: [MessageAttachment] {
    attachments.filter { $0.kind == "image" && !$0.url.isEmpty }
  }

  var body: some View {
    if !imageAttachments.isEmpty {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          ForEach(imageAttachments) { attachment in
            Button {
              previewAttachment = attachment
            } label: {
              AsyncImage(url: URL(string: attachment.url)) { phase in
                switch phase {
                case .success(let image):
                  image
                    .resizable()
                    .scaledToFit()
                case .failure:
                  Image(systemName: "photo")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                case .empty:
                  ProgressView()
                @unknown default:
                  Image(systemName: "photo")
                    .foregroundStyle(.secondary)
                }
              }
              .frame(width: 176, height: 124)
              .background(Color(.tertiarySystemGroupedBackground))
              .clipShape(RoundedRectangle(cornerRadius: 10))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(attachment.originalName.isEmpty ? attachment.filename : attachment.originalName)
          }
        }
      }
      .sheet(item: $previewAttachment) { attachment in
        ImagePreviewSheet(attachment: attachment)
      }
    }
  }
}

private struct ImagePreviewSheet: View {
  let attachment: MessageAttachment
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ZStack {
        Color.black.ignoresSafeArea()
        AsyncImage(url: URL(string: attachment.url)) { phase in
          switch phase {
          case .success(let image):
            image
              .resizable()
              .scaledToFit()
              .padding()
          case .failure:
            VStack(spacing: 12) {
              Image(systemName: "photo")
                .font(.largeTitle)
              Text("图片加载失败")
                .font(.headline)
            }
            .foregroundStyle(.white.opacity(0.82))
          case .empty:
            ProgressView()
              .tint(.white)
          @unknown default:
            Image(systemName: "photo")
              .font(.largeTitle)
              .foregroundStyle(.white.opacity(0.82))
          }
        }
      }
      .navigationTitle(attachment.originalName.isEmpty ? "图片" : attachment.originalName)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("关闭") {
            dismiss()
          }
        }
      }
    }
  }
}

private func stripAttachmentContext(_ value: String) -> String {
  let marker = "\n【图片附件】"
  let base: String
  if let range = value.range(of: marker) {
    base = String(value[..<range.lowerBound])
  } else {
    base = value
  }
  return stripVisualReferences(base).trimmingCharacters(in: .whitespacesAndNewlines)
}

private func stripVisualReferences(_ value: String) -> String {
  var text = value
  let patterns = [
    #"!\[[^\]]*\]\([^\)]*\.(?:png|jpe?g|webp|gif|svg|html?)(?:\?[^\)]*)?\)"#,
    #"\[[^\]]*\]\([^\)]*\.(?:png|jpe?g|webp|gif|svg|html?)(?:\?[^\)]*)?\)"#,
    #"(?:图片|图像|视觉产物|源文件|文件|路径|链接|输出)?\s*(?:源文件|文件|路径|链接|输出)?\s*[:：]?\s*[\`'"]?(?:[ab](?=/Users/)|~|/)[^\n\r"'\`<>|]*?\.(?:png|jpe?g|webp|gif|svg|html?)[\`'"]?"#
  ]
  for pattern in patterns {
    text = text.replacingOccurrences(of: pattern, with: "", options: [.regularExpression, .caseInsensitive])
  }
  return text
    .split(separator: "\n", omittingEmptySubsequences: false)
    .map { String($0).trimmingCharacters(in: .whitespaces) }
    .filter { !$0.isEmpty }
    .joined(separator: "\n")
}

private func compactMessagePreview(_ value: String, limit: Int = 120) -> String {
  let text = value
    .split(whereSeparator: \.isWhitespace)
    .joined(separator: " ")
    .trimmingCharacters(in: .whitespacesAndNewlines)
  guard !text.isEmpty else { return "空输出" }
  if text.count <= limit { return text }
  return "\(text.prefix(limit))..."
}

private struct FocusedMessageContent {
  let conclusion: String
  let process: String
  let hasConclusion: Bool
}

private let finalConclusionMarkers = [
  "推荐结论",
  "最终结论",
  "最终答案",
  "最终输出",
  "结论建议",
  "决策结论",
  "Final Answer",
  "Final Output",
  "Conclusion",
  "Decision",
  "结论",
  "Final"
]

private func focusMessageContent(_ value: String) -> FocusedMessageContent {
  let normalized = value
    .replacingOccurrences(of: "\r\n", with: "\n")
    .replacingOccurrences(of: "\r", with: "\n")
    .trimmingCharacters(in: .whitespacesAndNewlines)
  guard !normalized.isEmpty else {
    return FocusedMessageContent(conclusion: "空输出", process: "", hasConclusion: false)
  }

  if let organizerReason = extractOrganizerDecisionReason(normalized) {
    let process = normalized
      .replacingOccurrences(of: #"```hermes-discussion-organizer[\s\S]*?```"#, with: "", options: .regularExpression)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return FocusedMessageContent(conclusion: organizerReason, process: process, hasConclusion: true)
  }

  let lines = normalized.components(separatedBy: "\n")
  for index in stride(from: lines.count - 1, through: 0, by: -1) {
    guard let rest = finalMarkerRest(lines[index]) else { continue }
    var endIndex = lines.count
    if index + 1 < lines.count {
      for cursor in (index + 1)..<lines.count {
        if cursor > index + 1 && isSectionHeading(lines[cursor]) {
          endIndex = cursor
          break
        }
      }
    }
    let after = lines[(index + 1)..<endIndex].joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    let cleanedRest = rest.range(of: #"^[（(][^）)]*[）)]$"#, options: .regularExpression) == nil ? rest : ""
    let conclusion = cleanConclusionText([cleanedRest, after]
      .filter { !$0.isEmpty }
      .joined(separator: "\n")
    )
    guard !conclusion.isEmpty, !isGenericDecisionText(conclusion) else { continue }
    let process = (Array(lines.prefix(index)) + Array(lines.suffix(lines.count - endIndex)))
      .joined(separator: "\n")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return FocusedMessageContent(conclusion: conclusion, process: process, hasConclusion: true)
  }

  let blocks = paragraphBlocks(normalized)
  if blocks.count > 1 && (normalized.count > 520 || lines.count > 8), let last = blocks.last {
    let lastMeaningfulBlock = cleanConclusionText(last)
    if !lastMeaningfulBlock.isEmpty && hasConclusionSignal(lastMeaningfulBlock) {
      return FocusedMessageContent(
        conclusion: lastMeaningfulBlock,
        process: blocks.dropLast().joined(separator: "\n\n"),
        hasConclusion: true
      )
    }
    return FocusedMessageContent(
      conclusion: "主 Agent 尚未给出可识别的最终结论，非结论内容已折叠。",
      process: normalized,
      hasConclusion: false
    )
  }

  if lines.count > 8 {
    let lastLines = cleanConclusionText(lines.suffix(6).joined(separator: "\n"))
    if !lastLines.isEmpty && hasConclusionSignal(lastLines) {
      let process = lines.dropLast(6).joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
      return FocusedMessageContent(conclusion: lastLines, process: process, hasConclusion: true)
    }
    return FocusedMessageContent(
      conclusion: "主 Agent 尚未给出可识别的最终结论，非结论内容已折叠。",
      process: normalized,
      hasConclusion: false
    )
  }

  return FocusedMessageContent(conclusion: normalized, process: "", hasConclusion: true)
}

private func paragraphBlocks(_ value: String) -> [String] {
  value
    .components(separatedBy: "\n\n")
    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    .filter { !$0.isEmpty && !isDividerBlock($0) }
}

private func isDividerBlock(_ value: String) -> Bool {
  let compact = value.filter { !$0.isWhitespace }
  guard !compact.isEmpty else { return false }
  return compact.allSatisfy { "=-_*`~#─━".contains($0) }
}

private func isSectionHeading(_ value: String) -> Bool {
  let normalized = normalizedHeadingLine(value)
  if value.range(of: #"^\s*(?:#{1,6}\s*)?(?:\d+[\.)、]|[一二三四五六七八九十]+[、.])\s+"#, options: .regularExpression) != nil {
    return true
  }
  return normalized.range(
    of: #"^(risks?|actions?|next actions?|confidence|needs hayden|是否需要|风险|下一步|行动|置信度|细节分歧|分歧)"#,
    options: [.regularExpression, .caseInsensitive]
  ) != nil
}

private func cleanConclusionText(_ value: String) -> String {
  value
    .components(separatedBy: "\n")
    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    .filter { !$0.isEmpty && !isDividerBlock($0) && !$0.hasPrefix("```") }
    .joined(separator: "\n")
    .trimmingCharacters(in: .whitespacesAndNewlines)
}

private func isGenericDecisionText(_ value: String) -> Bool {
  let text = value
    .split(whereSeparator: \.isWhitespace)
    .joined(separator: " ")
    .trimmingCharacters(in: .whitespacesAndNewlines)
  return text.isEmpty ||
    text.range(
      of: #"^(已有足够结论|已有阶段性结论|组织决策 JSON 解析失败.*|mock discussion complete)$"#,
      options: [.regularExpression, .caseInsensitive]
    ) != nil
}

private func hasConclusionSignal(_ value: String) -> Bool {
  value.range(
    of: #"(建议|推荐|结论|因此|总之|应当|必须|可以直接|核心价值|Recommendation|Conclusion|Therefore|Recommend)"#,
    options: [.regularExpression, .caseInsensitive]
  ) != nil
}

private func extractOrganizerDecisionReason(_ value: String) -> String? {
  guard let regex = try? NSRegularExpression(
    pattern: #"```hermes-discussion-organizer\s*([\s\S]*?)```"#,
    options: [.caseInsensitive]
  ) else {
    return nil
  }
  let range = NSRange(value.startIndex..<value.endIndex, in: value)
  let matches = regex.matches(in: value, range: range)
  for match in matches.reversed() {
    guard match.numberOfRanges > 1,
          let jsonRange = Range(match.range(at: 1), in: value),
          let data = String(value[jsonRange]).trimmingCharacters(in: .whitespacesAndNewlines).data(using: .utf8),
          let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      continue
    }
    let reason = cleanConclusionText(String(describing: raw["reason"] ?? ""))
    if !reason.isEmpty && !isGenericDecisionText(reason) {
      return reason
    }
  }
  return nil
}

private func normalizedHeadingLine(_ value: String) -> String {
  var text = value.trimmingCharacters(in: .whitespacesAndNewlines)
  while let first = text.first, "#-* >•0123456789.)".contains(first) {
    text.removeFirst()
    text = text.trimmingCharacters(in: .whitespacesAndNewlines)
  }
  if text.hasPrefix("**") {
    text.removeFirst(2)
  }
  if text.hasSuffix("**") {
    text.removeLast(2)
  }
  return text.trimmingCharacters(in: .whitespacesAndNewlines)
}

private func finalMarkerRest(_ value: String) -> String? {
  let normalized = normalizedHeadingLine(value)
  for marker in finalConclusionMarkers {
    if normalized.compare(marker, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame {
      return ""
    }
    guard normalized.range(of: marker, options: [.caseInsensitive, .diacriticInsensitive])?.lowerBound == normalized.startIndex else {
      continue
    }
    let rest = String(normalized.dropFirst(marker.count)).trimmingCharacters(in: .whitespacesAndNewlines)
    guard let first = rest.first else { return "" }
    if rest.range(of: #"^[（(][^）)]*[）)]$"#, options: .regularExpression) != nil {
      return rest
    }
    if ":：-—–".contains(first) {
      return String(rest.dropFirst()).trimmingCharacters(in: .whitespacesAndNewlines)
    }
  }
  return nil
}

private struct ConnectionPrompt: View {
  var body: some View {
    ContentUnavailableView(
      "连接 Mac",
      systemImage: "antenna.radiowaves.left.and.right",
      description: Text("先到连接页粘贴桌面端手机链接。")
    )
  }
}

private struct StatusBanner: View {
  @EnvironmentObject private var model: AppModel

  var body: some View {
    HStack(spacing: 10) {
      if model.isBusy {
        ProgressView()
      } else if model.errorMessage != nil {
        Image(systemName: "exclamationmark.triangle.fill")
          .foregroundStyle(.red)
      } else {
        Image(systemName: "checkmark.circle.fill")
          .foregroundStyle(.green)
      }
      Text(model.errorMessage ?? model.statusMessage)
        .font(.footnote.weight(.semibold))
        .lineLimit(2)
      Spacer()
    }
    .padding(12)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
    .shadow(radius: 12, y: 4)
  }
}

private struct ChecklistRow: View {
  let done: Bool
  let title: String

  var body: some View {
    Label(title, systemImage: done ? "checkmark.circle.fill" : "circle")
      .foregroundStyle(done ? .primary : .secondary)
  }
}
