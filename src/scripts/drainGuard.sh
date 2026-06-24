#!/bin/bash
# drainGuard.sh — Independent watchdog for the taskq drain.
# Runs via its own launchd job (com.taskq.drain-guard) every 2 minutes,
# INDEPENDENTLY of the drain process itself. Catches the class of failures
# where the drain crash-loops because its environment is broken (e.g. cwip
# dist wiped by a worker task, bun link reverted by bun i).
#
# Installs itself as a launchd agent when run with --install.
# Logs to ~/.taskq/drain-guard.log.

CWIP_DIR="$HOME/code/github/cwip"
RU_DIR="$HOME/code/github/rubato"
LOG="$HOME/.taskq/drain-guard.log"
BUN="/Users/curt/.bun/bin/bun"
LAUNCHD_LABEL="com.taskq.drain-guard"
PLIST_PATH="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
SCRIPT_PATH="$RU_DIR/src/scripts/drainGuard.sh"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" | tee -a "$LOG"; }

# ── Install mode ─────────────────────────────────────────────────────────────
if [ "$1" = "--install" ]; then
  cat > "$PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LAUNCHD_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$SCRIPT_PATH</string>
  </array>
  <key>StartInterval</key><integer>120</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/.taskq/drain-guard.log</string>
  <key>StandardErrorPath</key><string>$HOME/.taskq/drain-guard-err.log</string>
</dict>
</plist>
PLIST
  chmod +x "$SCRIPT_PATH"
  launchctl unload "$PLIST_PATH" 2>/dev/null
  launchctl load "$PLIST_PATH"
  echo "drain-guard installed and started (StartInterval=120s)"
  exit 0
fi

# ── Normal watchdog run ───────────────────────────────────────────────────────

FIXED=0
ISSUES=0

# 1. Check cwip dist — the drain's cwip/taskq import fails if dist is missing.
#    Worker tasks that run `bun run clean` on cwip or a worktree `bun i` can wipe it.
if [ ! -f "$CWIP_DIR/dist/services/taskq/index.js" ]; then
  ISSUES=$((ISSUES+1))
  log "ISSUE: cwip dist/services/taskq/index.js missing — rebuilding cwip"
  if (cd "$CWIP_DIR" && "$BUN" run build >> "$LOG" 2>&1); then
    log "FIX: cwip rebuilt OK"
    FIXED=$((FIXED+1))
  else
    log "ERROR: cwip rebuild failed — drain may stay broken until next check"
  fi
fi

# 2. Check bun link (cwip symlink in rubato node_modules).
#    A bare `bun i` in the rubato root reverts the link to the registry version;
#    when cwip isn't published, that breaks the import.
CWIP_LINK="$RU_DIR/node_modules/cwip"
if [ ! -L "$CWIP_LINK" ]; then
  ISSUES=$((ISSUES+1))
  log "ISSUE: $CWIP_LINK is not a symlink — relinking cwip"
  if (cd "$RU_DIR" && "$BUN" link cwip >> "$LOG" 2>&1); then
    log "FIX: bun link cwip OK"
    FIXED=$((FIXED+1))
  else
    log "ERROR: bun link cwip failed"
  fi
fi

# 3. Check drain output freshness.
#    The drain writes to watchdog.out every ~30s (each launchd tick). If the file
#    hasn't been touched in > 5 min AND there are active leases in the DB (workers
#    should be heartbeating), something is wrong.
WATCHDOG_OUT="$HOME/.taskq/watchdog.out"
if [ -f "$WATCHDOG_OUT" ]; then
  LAST_MOD=$(stat -f '%m' "$WATCHDOG_OUT" 2>/dev/null || echo 0)
  NOW_SEC=$(date +%s)
  AGE_MIN=$(( (NOW_SEC - LAST_MOD) / 60 ))

  if [ "$AGE_MIN" -gt 5 ]; then
    # Only restart if leases exist AND none have a fresh heartbeat.
    # Fresh heartbeat = worker is alive; stale watchdog.out just means no NEW tasks
    # were dispatched this cycle (all slots were busy). Restarting a healthy drain
    # creates a duplicate worker — much worse than leaving it alone.
    LEASE_COUNT=$(sqlite3 "$HOME/.taskq/taskq.sqlite" "SELECT count(*) FROM leases" 2>/dev/null || echo 0)
    FRESH_HB=$(sqlite3 "$HOME/.taskq/taskq.sqlite" \
      "SELECT count(*) FROM leases WHERE heartbeat_at > (unixepoch()*1000 - 180000)" 2>/dev/null || echo 0)
    if [ "$FRESH_HB" -gt 0 ]; then
      log "OK: drain output stale but $FRESH_HB lease(s) have fresh heartbeats — workers alive, no restart needed"
    elif [ "$LEASE_COUNT" -gt 0 ] || [ "$AGE_MIN" -gt 15 ]; then
      ISSUES=$((ISSUES+1))
      log "ISSUE: drain output stale (${AGE_MIN}min old, ${LEASE_COUNT} leases, 0 fresh heartbeats) — restarting drain"
      launchctl kickstart "gui/$(id -u)/com.taskq.drain" >> "$LOG" 2>&1 || \
        launchctl start com.taskq.drain >> "$LOG" 2>&1
      log "FIX: requested drain restart"
      FIXED=$((FIXED+1))
    fi
  fi
fi

# 4. Check for stale expired leases (tasks stuck in 'claimed' but lease expired).
#    These should be reaped by the drain on its next tick, but if drain is down
#    they can sit forever. We only log here (the drain reaper handles the fix).
STALE=$(sqlite3 "$HOME/.taskq/taskq.sqlite" \
  "SELECT count(*) FROM leases WHERE expires_at < (unixepoch()*1000 - 300000)" 2>/dev/null || echo 0)
if [ "$STALE" -gt 0 ]; then
  log "WARNING: $STALE lease(s) expired > 5 min ago (drain reaper should clean these on next tick)"
fi

if [ "$ISSUES" -eq 0 ]; then
  log "OK: drain environment healthy (cwip dist present, bun link OK)"
else
  log "SUMMARY: found=$ISSUES issues, fixed=$FIXED"
fi
