# Hermes Agent Team Mobile App Store Readiness

更新时间：2026-06-28

## 当前交付状态

- 原生 SwiftUI iOS 客户端，不是 WebView 套壳。
- Xcode 工程：`ios/HermesAgentTeamMobile/HermesAgentTeamMobile.xcodeproj`
- Bundle ID：`com.hayden.hermesagentteam.mobile`
- 最低系统：iOS 17.0
- 支持设备：iPhone、iPad
- App Icon：已接入 `Assets.xcassets/AppIcon.appiconset`
- Privacy Manifest：已接入 `PrivacyInfo.xcprivacy`
- 本地网络权限：已配置 `NSLocalNetworkUsageDescription`
- 本地 HTTP 访问：已配置 ATS `NSAllowsLocalNetworking`
- 访问令牌：Keychain 保存；Mac 服务地址：UserDefaults 保存并在 privacy manifest 中声明 required reason。

## 产品边界

手机 App 是 Hermes Agent Team 的 iOS companion app。Hermes CLI、SQLite、Agent profiles 和实际 Agent 执行仍在用户自己的 Mac 上运行；iOS App 通过同一局域网访问 Mac 桌面端暴露的带令牌本地 API。

当前原生能力：

- 自动发现 Mac 桌面端服务，或粘贴桌面端手机链接并解析 Mac 服务地址和 token。
- 手动配置 Mac 服务地址和访问令牌，令牌保存在 Keychain。
- 连接并轮询 `/api/team/bootstrap`，完整同步 TeamState。
- 查看、选择、创建、归档删除工作空间。
- 查看、选择、创建、删除频道。
- 查看任务消息，选择任务主 Agent，发送任务、`/status` 和其他任务命令。
- 确认任务完成并清理临时 Agent。
- 选择讨论框架，发起讨论，回复等待人工确认的讨论，继续讨论，批准额外轮次，关闭讨论。
- 创建任务/讨论 Agent，管理 Agent 是否加入当前频道，编辑核心命令、Provider 和模型，删除非主 Agent。
- 查看黑板、运行锁、任务讨论桥、证据、决策记录、内容资产和审计记录。
- 执行沙箱快捷动作：接管、复制命令、移除 worktree、清理沙箱。
- 执行数据健康检查、数据治理修复，并让 Mac 打开归档、备份、报告和治理根目录。
- 执行运行锁生命周期、任务讨论桥、可靠性闭环和数据治理回归诊断。

## 真机调试状态

当前已验证设备：

- 设备：`中国青年的iPhone`
- 型号：iPhone 16 Pro Max
- 系统：iOS 27.0 Beta
- 连接：有线、已配对、开发者模式已开启
- 设备 ID：`9E5A5EB0-AD0D-51DB-8BAB-E2D6AEDEDBBB`

已通过：

- `npm run build`：桌面 Web bundle / TypeScript 构建成功。
- `npm run ios:build:device`：Debug 真机包签名构建成功。
- `npm run ios:install:device`：已安装到真机，Bundle ID 为 `com.hayden.hermesagentteam.mobile`。
- `npm run ios:launch:device`：信任开发者描述文件后，已在真机启动成功。
- 真机进程：已确认 `HermesAgentTeamMobile.app/HermesAgentTeamMobile` 正在运行。
- Mac 服务握手：已记录到来自 iPhone 的 `/api/team/bootstrap` 请求，远端地址为手机局域网 IP。
- API 同步：`/api/team/bootstrap` 返回工作空间、频道、Agent、消息、讨论、黑板、内容资产和数据健康状态。
- 本地签名校验：`codesign --verify --deep --strict` 通过。

注意事项：

- 首次开发包启动前，如果 iOS 提示未信任开发者，需要在 iPhone 上进入“设置 > 通用 > VPN 与设备管理”，信任对应开发者 App 后再重新启动。
- Mac 的 iPhone 镜像当前提示蓝牙关闭；命令层已验证真机启动与进程运行。

## 本地审核命令

```bash
npm run ios:build
npm run ios:test
npm run ios:build:device
npm run ios:install:device
npm run ios:launch:device
npm run ios:archive:unsigned
plutil -lint ios/HermesAgentTeamMobile/HermesAgentTeamMobile/Info.plist
plutil -lint ios/HermesAgentTeamMobile/HermesAgentTeamMobile/PrivacyInfo.xcprivacy
```

`ios:archive:unsigned` 只验证 Release archive 可编译，不产生可上传 App Store Connect 的签名包。

## 上架前必须由 Apple Developer 账号补齐

1. 在 Xcode target 里设置真实 `DEVELOPMENT_TEAM`。
2. 确认或替换 `PRODUCT_BUNDLE_IDENTIFIER`。
3. 使用真实 Apple Distribution 证书和 App Store provisioning profile。
4. 用 `ios/HermesAgentTeamMobile/ExportOptions.AppStore.plist` 导出签名 `.ipa`。
5. 在 App Store Connect 创建 App，填写隐私问卷、分类、年龄分级、截图、描述、支持 URL 和审核备注。
6. 审核备注需要说明：本 App 是本地 Mac Hermes Agent Team 的移动控制台，测试时需要先启动 Mac 桌面端，并让 iPhone 与 Mac 位于同一网络。

## 签名归档命令模板

设置 Team 之后：

```bash
xcodebuild \
  -project "ios/HermesAgentTeamMobile/HermesAgentTeamMobile.xcodeproj" \
  -scheme HermesAgentTeamMobile \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "ios/build/HermesAgentTeamMobile.xcarchive" \
  archive

xcodebuild \
  -exportArchive \
  -archivePath "ios/build/HermesAgentTeamMobile.xcarchive" \
  -exportPath "ios/build/AppStore" \
  -exportOptionsPlist "ios/HermesAgentTeamMobile/ExportOptions.AppStore.plist"
```

## 审核风险与处理

- 本地网络权限弹窗：首次连接 Mac 服务时 iOS 会请求本地网络权限。Info.plist 已给出面向用户的用途说明。
- 局域网 HTTP：Mac 端服务是本地局域网 API，不是公网服务；ATS 已只允许 local networking，不使用全局 arbitrary loads。
- 审核可测性：App Store 审核人员无法访问用户私有 Mac 时，需要在审核备注中提供测试流程，或提供可访问的测试 Mac / TestFlight 内部说明。
- 账号签名：当前仓库不能代替 Apple Developer Team、证书、App Store Connect 元数据和最终提交权限。
