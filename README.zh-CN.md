# Hermes Agent Team

[English](README.md) | 中文

用于协调 Hermes Agent 团队的本地优先桌面端与 iOS 控制台。

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![Platform: macOS and iOS](https://img.shields.io/badge/platform-macOS%20%7C%20iOS-blue.svg)
![Status: alpha](https://img.shields.io/badge/status-alpha-orange.svg)

Hermes Agent Team 在你的 Mac 上运行 Agent runtime，用本地 SQLite 保存工作空间状态，
并提供一个桌面应用和一个带令牌保护的 iOS companion app。

> 状态：早期开源版本。当前版本适合本地实验和验证，但 API、数据模型和打包流程仍在演进中。

## 它能做什么

- 为工作空间内的 Agent 创建隔离的 Hermes profile。
- 区分任务执行 Agent 和讨论 Agent。
- 协调任务委派、Evidence Pack、Decision Record、runtime locks 和审计日志。
- 提供本地 Electron 桌面端来管理工作空间。
- 提供 iOS companion app 来控制同一台 Mac 上托管的 runtime。
- 使用本地 SQLite 保存应用状态。

## 为什么要做

很多 Agent 工具把协作简化成聊天记录。Hermes Agent Team 试验的是更偏执行系统的模式：

1. 人类用户拥有工作空间并发出正式命令。
2. 主任务 Agent 拆解工作，并在需要时委派给临时 Agent。
3. 独立的讨论 Leader 可以组织讨论，但不污染任务执行链路。
4. 事实、假设、决策、风险和输出沉淀在聊天流之外的共享状态里。

## 当前边界

- Mac 仍然是真实运行时和数据源；iOS app 是控制台，不是独立 runtime。
- 桌面端默认是未签名的本地构建。
- 真实 Agent 执行依赖本机已安装的 `hermes` CLI。
- 手机端访问由本地令牌保护，但整体设计面向可信局域网。
- 仓库不会包含本地数据库、runtime profiles、打包产物和密钥。

## 快速开始

前置条件：

- macOS
- Node.js 和 npm
- 本机 `hermes` CLI，用于真实 runtime
- Xcode，用于 iOS 构建

安装并验证：

```bash
npm install
npm run verify
```

以开发模式运行桌面端：

```bash
npm run dev
```

构建桌面端资源：

```bash
npm run build
```

打包未签名 macOS app：

```bash
npm run pack:mac
open "release/mac-arm64/Hermes Agent Team.app"
```

构建并测试 iOS companion app：

```bash
npm run ios:build
npm run ios:test
```

## 项目结构

| 路径 | 用途 |
| --- | --- |
| `electron/` | Electron 主进程和 preload bridge |
| `src/` | React 桌面端与移动 Web UI |
| `ios/HermesAgentTeamMobile/` | 原生 iOS companion app |
| `scripts/` | Smoke、acceptance 和 contract 检查脚本 |
| `docs/` | 架构、协议、schema 和详细参考文档 |
| `build/` | 打包使用的源图标 |

## 文档

- [Architecture](docs/ARCHITECTURE.md)
- [Operating Protocol](docs/OPERATING_PROTOCOL.md)
- [Blackboard Schema](docs/BLACKBOARD_SCHEMA.md)
- [Product Requirements](docs/PRD.md)
- [Detailed Reference](docs/REFERENCE.md)
- [iOS App Store Readiness](ios/HermesAgentTeamMobile/APP_STORE_READINESS.md)

## 验证

核心检查：

```bash
npm run verify
npm run smoke
npm run smoke:mobile
npm run acceptance:dev
```

发布相关检查：

```bash
npm run pack:mac
npm run acceptance:packaged
npm run ios:archive:unsigned
```

完整验证矩阵见 [Detailed Reference](docs/REFERENCE.md)。

## 贡献

欢迎贡献，尤其是可靠性、文档、打包和 runtime 隔离方面的改进。
请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

请不要提交本地 runtime 数据、生成产物、移动端 token、Hermes profiles 或个人工作空间数据库。

## 安全

如果你认为发现了安全问题，请不要在公开 issue 中贴出漏洞细节。
请查看 [SECURITY.md](SECURITY.md)。

## License

MIT. See [LICENSE](LICENSE).
