#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
APP_NAME="Hermes Agent Team"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUNDLE="$ROOT_DIR/release/mac-arm64/$APP_NAME.app"
APP_BINARY="$APP_BUNDLE/Contents/MacOS/$APP_NAME"

stop_existing() {
  pkill -f "$APP_BINARY" >/dev/null 2>&1 || true
}

build_app() {
  (cd "$ROOT_DIR" && npm run pack:mac)
}

open_app() {
  xattr -dr com.apple.quarantine "$APP_BUNDLE" >/dev/null 2>&1 || true
  /usr/bin/open -n "$APP_BUNDLE"
}

verify_window() {
  local window_count="0"
  for _ in {1..30}; do
    if ! pgrep -f "$APP_BINARY" >/dev/null; then
      sleep 1
      continue
    fi
    window_count="$(osascript -e 'tell application "System Events" to tell process "Hermes Agent Team" to get count of windows' 2>/dev/null || echo 0)"
    if [[ "${window_count:-0}" -ge 1 ]]; then
      return 0
    fi
    sleep 1
  done
  if ! pgrep -f "$APP_BINARY" >/dev/null; then
    echo "Hermes Agent Team did not start." >&2
    exit 1
  fi
  echo "Hermes Agent Team started but no window was created within 30 seconds." >&2
  exit 1
}

case "$MODE" in
  run|--run)
    stop_existing
    build_app
    open_app
    verify_window
    ;;
  verify|--verify)
    stop_existing
    open_app
    verify_window
    ;;
  logs|--logs)
    stop_existing
    open_app
    /usr/bin/log stream --info --style compact --predicate 'process == "Hermes Agent Team"'
    ;;
  debug|--debug)
    stop_existing
    lldb -- "$APP_BINARY"
    ;;
  *)
    echo "usage: $0 [run|--verify|--logs|--debug]" >&2
    exit 2
    ;;
esac
