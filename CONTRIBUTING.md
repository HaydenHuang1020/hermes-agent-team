# Contributing

Thanks for considering a contribution to Hermes Agent Team.

This project is still early, so the best contributions are focused, easy to review,
and backed by a local verification command.

## Development Setup

```bash
npm install
npm run verify
npm run dev
```

For iOS work:

```bash
npm run ios:build
npm run ios:test
```

## Pull Request Checklist

- Keep changes scoped to one concern.
- Add or update tests when behavior changes.
- Run `npm run verify` before opening a pull request.
- For Electron runtime changes, run at least one smoke or acceptance check.
- For iOS changes, run `npm run ios:build` or `npm run ios:test`.
- Do not commit secrets, local databases, packaged builds, generated profile data, or `.env` files.

## Repository Boundaries

Generated and local-only content should stay out of version control:

- `node_modules/`
- `dist/`
- `release/`
- `output/`
- `ios/DerivedData/`
- `ios/build/`
- local app support data
- Hermes profiles and runtime logs

## Code Style

Follow the style already present in the touched files. Prefer small functions,
explicit state transitions, and clear runtime checks over broad rewrites.

## Reporting Issues

When filing a bug, include:

- macOS version
- Node.js version
- Hermes CLI version, if relevant
- steps to reproduce
- expected behavior
- actual behavior
- screenshots or logs with secrets removed

## Conduct

All participants are expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
