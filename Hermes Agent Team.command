#!/bin/zsh
cd "$(dirname "$0")"
APP="release/mac-arm64/Hermes Agent Team.app"
if [[ -d "$APP" ]]; then
  xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
  open -n "$APP"
else
  npm start
fi
