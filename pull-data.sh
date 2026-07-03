#!/bin/bash
# NEO TODO data mirror
# タスクデータの真実のソースは GitHub (neo-morohashi/neo-todo)。
# PWA が Contents API で直接書き込むため、ローカルの ~/AI Dev/neo-todo-data
# は pull しない限り古くなる。毎日 03:00 に launchd
# (com.neotodo.data-pull) がこのスクリプトで同期し、ローカル控えを保つ。
# ログは worktree を汚さないよう .git/pull.log に置く（最新200行のみ保持）。

set -euo pipefail

DATA_REPO="/Users/neo/AI Dev/neo-todo-data"
LOG="$DATA_REPO/.git/pull.log"

cd "$DATA_REPO"
if git pull --ff-only --quiet 2>>"$LOG"; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') pull ok: $(git log -1 --pretty='%h %s')" >> "$LOG"
else
  echo "$(date '+%Y-%m-%d %H:%M:%S') pull FAILED (exit $?)" >> "$LOG"
  exit 1
fi

tail -n 200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
