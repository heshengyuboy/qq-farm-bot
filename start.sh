#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
PID_FILE="$SCRIPT_DIR/app_dev.pid"
LOG_FILE="$SCRIPT_DIR/app_dev.log"

cd "$SCRIPT_DIR"

# Running through `bash start.sh` does not require execute permission. Once
# started, make both lifecycle scripts directly executable for later use.
chmod +x "$SCRIPT_DIR/start.sh" "$SCRIPT_DIR/stop.sh" 2>/dev/null || true

if [[ -f "$PID_FILE" ]]; then
    existing_pid="$(tr -d '[:space:]' < "$PID_FILE")"
    if [[ "$existing_pid" =~ ^[0-9]+$ ]] && kill -0 "$existing_pid" 2>/dev/null; then
        echo "qq-farm-bot is already running with PID $existing_pid."
        exit 0
    fi
    rm -f "$PID_FILE"
fi

pnpm run install:all

if command -v setsid >/dev/null 2>&1; then
    nohup setsid pnpm run dev > "$LOG_FILE" 2>&1 &
else
    nohup pnpm run dev > "$LOG_FILE" 2>&1 &
fi

app_pid="$!"
echo "$app_pid" > "$PID_FILE"

echo "Started qq-farm-bot with PID $app_pid. Logs: $LOG_FILE"
