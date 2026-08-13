#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
PID_FILE="$SCRIPT_DIR/app_dev.pid"

cd "$SCRIPT_DIR"
chmod +x "$SCRIPT_DIR/start.sh" "$SCRIPT_DIR/stop.sh" 2>/dev/null || true

if [[ ! -f "$PID_FILE" ]]; then
    echo "qq-farm-bot is not running: $PID_FILE does not exist."
    exit 0
fi

app_pid="$(tr -d '[:space:]' < "$PID_FILE")"
if [[ ! "$app_pid" =~ ^[0-9]+$ ]]; then
    echo "Invalid PID file; removing $PID_FILE."
    rm -f "$PID_FILE"
    exit 1
fi

if ! kill -0 "$app_pid" 2>/dev/null; then
    echo "qq-farm-bot is not running; removing stale PID file."
    rm -f "$PID_FILE"
    exit 0
fi

# ---- Collect child PIDs (best-effort, cross-platform) ----
declare -a process_tree=()

collect_process_tree() {
    local parent_pid="$1"
    local child_pid
    local children=""

    # Try pgrep first (Linux / most Git Bash installations)
    if command -v pgrep >/dev/null 2>&1; then
        children="$(pgrep -P "$parent_pid" 2>/dev/null || true)"
    # Fallback: ps + awk (works in Git Bash on Windows)
    elif command -v ps >/dev/null 2>&1; then
        children="$(ps -o pid=,ppid= 2>/dev/null | awk -v ppid="$parent_pid" '$2 == ppid { print $1 }' || true)"
    fi

    # Recurse into children
    if [ -n "$children" ]; then
        for child_pid in $children; do
            [ -n "$child_pid" ] || continue
            collect_process_tree "$child_pid"
        done
    fi

    process_tree+=("$parent_pid")
}

collect_process_tree "$app_pid"

# ---- Graceful shutdown (SIGTERM) ----
echo "Stopping qq-farm-bot (PID $app_pid)..."
kill -TERM "${process_tree[@]}" 2>/dev/null || true

# Wait up to 15 seconds for the process to exit
for i in $(seq 1 30); do
    if ! kill -0 "$app_pid" 2>/dev/null; then
        rm -f "$PID_FILE"
        echo "Stopped qq-farm-bot."
        exit 0
    fi
    sleep 0.5 2>/dev/null || sleep 1
done

# ---- Force kill (SIGKILL) ----
echo "Graceful shutdown timed out; forcing qq-farm-bot to stop."
kill -KILL "${process_tree[@]}" 2>/dev/null || true

# Wait a few more seconds for SIGKILL to take effect
for i in $(seq 1 10); do
    if ! kill -0 "$app_pid" 2>/dev/null; then
        rm -f "$PID_FILE"
        echo "Stopped qq-farm-bot."
        exit 0
    fi
    sleep 0.5 2>/dev/null || sleep 1
done

rm -f "$PID_FILE"
echo "Warning: process $app_pid may still be running."
