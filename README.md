# Hermes Agent Team

Local-first desktop and iOS control surface for coordinating a team of Hermes agents.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![Platform: macOS and iOS](https://img.shields.io/badge/platform-macOS%20%7C%20iOS-blue.svg)
![Status: alpha](https://img.shields.io/badge/status-alpha-orange.svg)

Hermes Agent Team runs the agent runtime on your Mac, keeps workspace state in a local
SQLite database, and exposes both a desktop app and a token-protected iOS companion app.

> Status: early-stage open source release. The app is useful for local experimentation,
> but the API, data model, and packaging flow are still evolving.

## What It Does

- Creates isolated Hermes profiles for workspace agents.
- Separates task execution agents from discussion agents.
- Coordinates task handoff, evidence packs, discussion records, runtime locks, and audit logs.
- Provides a local Electron desktop app for workspace management.
- Provides an iOS companion app for controlling the same Mac-hosted runtime.
- Stores app state locally in SQLite under the app support directory.

## Why It Exists

Most agent tools treat collaboration as a chat transcript. Hermes Agent Team experiments
with a more operational model:

1. A human owns the workspace and gives commands.
2. A primary task agent decomposes work and can delegate to temporary agents.
3. A separate discussion leader can coordinate debate without polluting task execution.
4. Shared state, decisions, risks, and outputs are captured outside the raw chat stream.

## Current Boundaries

- The Mac remains the source of truth. The iOS app is a control surface, not a standalone runtime.
- The desktop build is unsigned by default.
- Hermes CLI must be installed locally for real agent execution.
- Mobile access is protected by a local token, but the app is designed for trusted local networks.
- This repository excludes local databases, runtime profiles, packaged builds, and secrets.

## Quick Start

Prerequisites:

- macOS
- Node.js and npm
- Local `hermes` CLI for real runtime use
- Xcode for iOS builds

Install and validate:

```bash
npm install
npm run verify
```

Run the desktop app in development:

```bash
npm run dev
```

Build the desktop assets:

```bash
npm run build
```

Package the unsigned macOS app:

```bash
npm run pack:mac
open "release/mac-arm64/Hermes Agent Team.app"
```

Build and test the iOS companion app:

```bash
npm run ios:build
npm run ios:test
```

## Project Layout

| Path | Purpose |
| --- | --- |
| `electron/` | Electron main process and preload bridge |
| `src/` | React desktop/mobile web UI |
| `ios/HermesAgentTeamMobile/` | Native iOS companion app |
| `scripts/` | Smoke, acceptance, and contract checks |
| `docs/` | Architecture, protocol, schema, and detailed reference docs |
| `build/` | Source icons used by packaging |

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Operating Protocol](docs/OPERATING_PROTOCOL.md)
- [Blackboard Schema](docs/BLACKBOARD_SCHEMA.md)
- [Product Requirements](docs/PRD.md)
- [Detailed Reference](docs/REFERENCE.md)
- [iOS App Store Readiness](ios/HermesAgentTeamMobile/APP_STORE_READINESS.md)

## Verification

Core checks:

```bash
npm run verify
npm run smoke
npm run smoke:mobile
npm run acceptance:dev
```

Release-oriented checks:

```bash
npm run pack:mac
npm run acceptance:packaged
npm run ios:archive:unsigned
```

The full validation matrix is documented in [Detailed Reference](docs/REFERENCE.md).

## Contributing

Contributions are welcome, especially around reliability, documentation, packaging,
and runtime isolation. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

Please do not commit local runtime data, generated builds, mobile tokens, Hermes profiles,
or personal workspace databases.

## Security

If you believe you found a security issue, do not open a public issue with exploit details.
See [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
