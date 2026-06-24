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
DB="$HOME/.taskq/taskq.sqlite"
LAUNCHD_LABEL="com.taskq.drain-guard"
PLIST_PATH="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
# The script runs from a STABLE location (not a per-checkout path), so re-installing
# never repoints the plist at a worktree that might not have it.
SCRIPT_PATH="$HOME/.taskq/drainGuard.sh"
# The drain agent this guard backstops, and the orch UI the owner watches.
DRAIN_LABEL="com.taskq.drain"
DRAIN_PLIST="$HOME/Library/LaunchAgents/$DRAIN_LABEL.plist"
SELF_HEALER_LABEL="com.taskq.drain-guard"   # this guard's own agent (for the mutual check note)
TASKQ_UI="http://localhost:5175"            # rubato serves the /taskq orch dashboard here

ts() { date '+%Y-%m-%d %H:%M:%S'; }
# Write ONLY to the file. The launchd plist's StandardOutPath also points at a log,
# so teeing to stdout would double every line. Builds/launchctl below redirect to $LOG directly.
log() { echo "[$(ts)] $*" >> "$LOG"; }

# Idempotently file a heal task so the orch fixes a code-level break (e.g. /taskq white-screen).
# No duplicate while an open one exists. Slug is fixed so re-detections collapse onto one task.
ensure_heal_task() {  # $1=slug  $2=title  $3=repo  $4=note
  local existing
  existing=$(sqlite3 "$DB" "SELECT count(*) FROM tasks WHERE slug='$1' AND status IN ('ready','claimed','on_hold')" 2>/dev/null || echo 1)
  if [ "$existing" = "0" ]; then
    sqlite3 "$DB" "INSERT INTO tasks (slug,title,note,status,model,think,repo,noop_ok,ord) VALUES ('$1','$2','$4','ready','sonnet','medium','$3',0,-320)" 2>/dev/null \
      && log "FIX: filed heal task '$1' (orch will repair)"
  fi
}

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
  <key>StandardOutPath</key><string>$HOME/.taskq/drain-guard.launchd.log</string>
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

# 4. Stale expired leases — but ONLY warn when it's actionable. A group-queued
#    member's lease legitimately "expires" while it waits its turn (the active
#    member heartbeats), so a raw expired-count warns on normal operation. Only
#    flag when leases are expired AND nothing has a fresh heartbeat (drain looks dead).
STALE=$(sqlite3 "$DB" "SELECT count(*) FROM leases WHERE expires_at < (unixepoch()*1000 - 300000)" 2>/dev/null || echo 0)
FRESH_ANY=$(sqlite3 "$DB" "SELECT count(*) FROM leases WHERE heartbeat_at > (unixepoch()*1000 - 180000)" 2>/dev/null || echo 0)
if [ "$STALE" -gt 0 ] && [ "$FRESH_ANY" -eq 0 ]; then
  log "WARNING: $STALE lease(s) expired and NO fresh heartbeats — drain may be stuck (freshness check above handles restart)"
fi

# 5. MUTUAL CHECK — keep the DRAIN agent itself loaded (not just running).
#    `launchctl kickstart` only works if the agent is LOADED; if it was unloaded
#    (bootout, manual unload, login glitch) nothing restarts the drain. Reload it.
if ! launchctl list "$DRAIN_LABEL" >/dev/null 2>&1; then
  ISSUES=$((ISSUES+1))
  log "ISSUE: $DRAIN_LABEL agent is NOT loaded — reloading its plist"
  if [ -f "$DRAIN_PLIST" ] && launchctl load "$DRAIN_PLIST" >> "$LOG" 2>&1; then
    log "FIX: reloaded $DRAIN_LABEL"; FIXED=$((FIXED+1))
  else
    log "ERROR: could not load $DRAIN_PLIST"
  fi
fi

# 6. MUTUAL CHECK — the in-orch self-healer task must still exist + be a live
#    recurring task (the reciprocal watcher: it re-loads THIS guard if unloaded).
#    If it was deleted/disabled, file a heal task to recreate it.
HEALER=$(sqlite3 "$DB" "SELECT count(*) FROM tasks WHERE slug='orch-self-healer' AND is_saved=1 AND recur_interval_ms IS NOT NULL" 2>/dev/null || echo 1)
if [ "$HEALER" = "0" ]; then
  ISSUES=$((ISSUES+1))
  log "ISSUE: orch-self-healer task missing/disabled — the reciprocal watcher is gone"
  ensure_heal_task "heal-orch-self-healer" "Recreate the orch-self-healer recurring task (watchdog gone)" "ru" \
    "The orch-self-healer recurring task is missing or no longer recurring. Recreate it as a saved recurring task (recur_interval_ms=1200000) that audits drain+cwip+bun-link+UI and reloads com.taskq.drain-guard if unloaded. See ~/.taskq notes."
fi

# 7. ORCH UI HEALTH — the owner watches localhost:5175/taskq to see if the orch is OK.
#    A green HTTP 200 on /taskq is NOT enough (a white-screen still returns 200), so we
#    assert the BOARD API returns real task data. (White-screen render detection is the
#    self-healer's deeper job; here we catch a dead server / dead API / empty board fast.)
UI_BODY=$(curl -s --max-time 6 "$TASKQ_UI/api/taskq" 2>/dev/null)
if ! printf '%s' "$UI_BODY" | grep -q '"tasks"'; then
  ISSUES=$((ISSUES+1))
  # Is the port even up?
  if ! curl -s -o /dev/null --max-time 5 "$TASKQ_UI/" 2>/dev/null; then
    log "ISSUE: orch UI ($TASKQ_UI) is DOWN — the rubato dev server isn't responding"
    ensure_heal_task "heal-taskq-ui-down" "Orch UI down: rubato dev server on :5175 not responding" "ru" \
      "localhost:5175 is not responding, so the owner cannot see orch status. The rubato dev server (bun run dev) is not running. Restart it; if it keeps dying, make it resilient (launchd-managed or auto-restart). Until then the orch board is invisible to the owner."
  else
    log "ISSUE: orch UI ($TASKQ_UI) up but /api/taskq returned no board data — API/DB path broken"
    ensure_heal_task "heal-taskq-ui-api" "Orch UI API broken: /api/taskq returns no board data" "ru" \
      "localhost:5175 responds but GET /api/taskq does not return a tasks board. The taskq API/DB read path is broken (the owner sees no orch data). Diagnose taskqRoutes + the ~/.taskq DB read and fix."
  fi
fi

if [ "$ISSUES" -eq 0 ]; then
  log "OK: drain environment healthy (cwip dist present, bun link OK)"
else
  log "SUMMARY: found=$ISSUES issues, fixed=$FIXED"
fi
