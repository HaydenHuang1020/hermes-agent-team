# Security Policy

## Supported Versions

Security updates are handled on the `main` branch.

## Reporting a Vulnerability

Please do not open a public issue with exploit details.

Preferred reporting path:

1. Use GitHub private vulnerability reporting if it is enabled for this repository.
2. If private reporting is not available, open a minimal public issue asking for a
   maintainer security contact, without including exploit details.

## Local Security Model

Hermes Agent Team is designed as a local-first tool:

- The Mac desktop app hosts the runtime.
- The iOS app connects to the Mac over the local network.
- Mobile access is protected by a generated or user-provided token.
- Runtime state is stored locally in SQLite.
- Hermes profiles are created and managed on the local machine.

Do not share:

- mobile access tokens
- local SQLite databases
- Hermes profile directories
- app support data
- logs that include credentials, personal data, or private workspace content

## Scope

Security reports are most useful when they involve:

- token exposure
- unauthorized mobile access
- unsafe profile deletion or profile reuse
- command execution boundaries
- workspace data leakage
- unsafe handling of local files or attachments
