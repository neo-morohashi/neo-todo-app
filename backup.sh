#!/bin/bash
# NEO TODO daily backup
# Backs up /Users/neo/tasks/ to /Users/neo/tasks-backup/YYYY-MM-DD/
# Keeps last 30 days

SRC="/Users/neo/tasks"
DEST_ROOT="/Users/neo/tasks-backup"
DATE=$(date +%Y-%m-%d)
DEST="$DEST_ROOT/$DATE"

mkdir -p "$DEST"
rsync -a --exclude='.git' "$SRC/" "$DEST/"

# Remove backups older than 30 days (keep newest 30)
dirs=$(find "$DEST_ROOT" -maxdepth 1 -type d -name "????-??-??" | sort)
count=$(echo "$dirs" | grep -c .)
if [ "$count" -gt 30 ]; then
  echo "$dirs" | head -n $(($count - 30)) | xargs rm -rf
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') Backup done: $DEST" >> "$DEST_ROOT/backup.log"
