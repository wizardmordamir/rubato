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
BUN="$HOME/.bun/bin/bun"
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
CWIP_DIST="$CWIP_DIR/dist/services/taskq/index.js"
# Stale = dist older than cwip's newest source commit (an engine fix landed but dist
# wasn't rebuilt). The promotion gate normally rebuilds on promote; this is the
# independent backstop. Rebuild only — never restart the drain here (it would strand
# in-flight workers); the drain loads fresh dist on its next natural restart.
CWIP_SRC_T=$(git -C "$CWIP_DIR" log -1 --format=%ct 2>/dev/null || echo 0)
CWIP_DIST_T=$(stat -f '%m' "$CWIP_DIST" 2>/dev/null || echo 0)
if [ ! -f "$CWIP_DIST" ]; then
  ISSUES=$((ISSUES+1))
  log "ISSUE: cwip dist/services/taskq/index.js missing — rebuilding cwip"
  if (cd "$CWIP_DIR" && "$BUN" run build >> "$LOG" 2>&1); then
    log "FIX: cwip rebuilt OK"; FIXED=$((FIXED+1))
  else
    log "ERROR: cwip rebuild failed — drain may stay broken until next check"
  fi
elif [ "$CWIP_DIST_T" -gt 0 ] && [ "$CWIP_SRC_T" -gt "$CWIP_DIST_T" ]; then
  ISSUES=$((ISSUES+1))
  log "ISSUE: cwip dist STALE (source newer than dist) — rebuilding so engine fixes reach the next drain restart"
  if (cd "$CWIP_DIR" && "$BUN" run build >> "$LOG" 2>&1); then
    log "FIX: cwip dist rebuilt (drain picks it up on next restart)"; FIXED=$((FIXED+1))
  else
    log "ERROR: cwip rebuild failed"
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
RUBATO_DEV_PLIST="$HOME/Library/LaunchAgents/com.taskq.rubato-dev.plist"
if [ -f "$HOME/.taskq/.rubato-dev.disabled" ]; then
  log "NOTE: orch UI intentionally OFF (kill-switch .rubato-dev.disabled set) — skipping UI check"
else
  UI_BODY=$(curl -s --max-time 6 "$TASKQ_UI/api/taskq" 2>/dev/null)
  if ! printf '%s' "$UI_BODY" | grep -q '"tasks"'; then
    ISSUES=$((ISSUES+1))
    if ! curl -s -o /dev/null --max-time 5 "$TASKQ_UI/" 2>/dev/null; then
      # Server DOWN. launchd KeepAlive should auto-restart it; this is the backstop.
      if launchctl list com.taskq.rubato-dev >/dev/null 2>&1; then
        log "ISSUE: orch UI ($TASKQ_UI) DOWN — kickstarting com.taskq.rubato-dev"
        launchctl kickstart -k "gui/$(id -u)/com.taskq.rubato-dev" >> "$LOG" 2>&1 \
          && { log "FIX: restarted rubato dev server"; FIXED=$((FIXED+1)); }
      elif [ -f "$RUBATO_DEV_PLIST" ]; then
        log "ISSUE: orch UI DOWN + agent unloaded — loading com.taskq.rubato-dev"
        launchctl load "$RUBATO_DEV_PLIST" >> "$LOG" 2>&1 \
          && { log "FIX: loaded rubato dev agent"; FIXED=$((FIXED+1)); }
      else
        log "ISSUE: orch UI DOWN and no rubato-dev agent installed"
        ensure_heal_task "heal-taskq-ui-down" "Orch UI down: rubato dev server on :5175 not responding" "ru" \
          "localhost:5175 is not responding and no com.taskq.rubato-dev launchd agent exists to restart it. The owner cannot see orch status. Install/repair the auto-restart agent (~/.taskq/rubatoDev.sh + com.taskq.rubato-dev.plist)."
      fi
    else
      log "ISSUE: orch UI ($TASKQ_UI) up but /api/taskq returned no board data — API/DB path broken"
      ensure_heal_task "heal-taskq-ui-api" "Orch UI API broken: /api/taskq returns no board data" "ru" \
        "localhost:5175 responds but GET /api/taskq does not return a tasks board. The taskq API/DB read path is broken (the owner sees no orch data). Diagnose taskqRoutes + the ~/.taskq DB read and fix."
    fi
  fi
fi

# 8. CRASH-FAILURE RECOVERY — a crashed / timed-out / token-exhausted worker must NEVER
#    permanently park a task at needs_owner: that stalls the whole dep-chain and needs the
#    owner. Re-queue tasks that failed for a TRANSIENT reason, BOUNDED so a task that
#    repeatedly kills workers escalates to an investigate task instead of looping forever.
CRASH_IDS=$(sqlite3 "$DB" "SELECT id FROM tasks WHERE status IN ('failed') AND (hold_disposition='needs_owner' OR hold_disposition IS NULL) AND (note LIKE '%lease expired%' OR note LIKE '%worker crashed%' OR note LIKE '%stopped heartbeating%' OR note LIKE '%exited 143%')" 2>/dev/null)
for tid in $CRASH_IDS; do
  [ -z "$tid" ] && continue
  # count prior auto-requeues by this guard (marker is 14 chars: '[auto-requeued')
  RQ=$(sqlite3 "$DB" "SELECT (length(note)-length(replace(note,'[auto-requeued','')))/14 FROM tasks WHERE id=$tid" 2>/dev/null || echo 0)
  if [ "${RQ:-0}" -lt 3 ]; then
    sqlite3 "$DB" "UPDATE tasks SET status='ready', hold_disposition=NULL, attempts=0, recur_next_at=NULL, note=COALESCE(note,'')||char(10)||'[auto-requeued by drain-guard $(ts) — transient worker crash, retry $((RQ+1))]', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=$tid" 2>/dev/null \
      && { ISSUES=$((ISSUES+1)); FIXED=$((FIXED+1)); log "FIX: re-queued crash-failed task #$tid (transient crash, retry $((RQ+1))/3)"; }
  else
    # Repeatedly kills workers — stop looping; file ONE investigate task instead.
    SLUG=$(sqlite3 "$DB" "SELECT slug FROM tasks WHERE id=$tid" 2>/dev/null)
    ensure_heal_task "investigate-crasher-$tid" "Task #$tid ($SLUG) keeps crashing workers — investigate/split" "ru" \
      "Task #$tid ($SLUG) has crash-failed and been auto-requeued 3+ times (worker keeps dying: OOM / too large / token-exhaustion / a hard error). Do NOT just re-run it. Diagnose WHY the worker dies, then either split it into smaller tasks, fix the underlying error, or right-size its model/budget. The original is left failed so it stops consuming retries."
    log "WARNING: task #$tid crash-failed 3+ times — filed investigate task (no more blind retries)"
  fi
done

# 9. Clean stale crash / false-done notes off DONE tasks. The engine's applyFailure
#    OVERWRITES a task's note with the failure reason on a worker crash; when a retry
#    then completes, that misleading note is left on the done task (confuses the owner
#    reviewing the board). Cosmetic-only here; the ROOT fix is the applyFailure engine
#    change (task fu-engine-preserve-note) so the spec is never destroyed in the first place.
CLEANED=$(sqlite3 "$DB" "UPDATE tasks SET note='Completed and landed. (Stale crash/false-done note cleared — it was a transient engine artifact, not the final outcome; see the completion record.)' WHERE status='done' AND (note LIKE 'lease expired (worker crashed%' OR note LIKE 'False-done:%' OR note='claude -p exited 143'); SELECT changes();" 2>/dev/null || echo 0)
if [ "${CLEANED:-0}" -gt 0 ]; then log "FIX: cleared stale crash/false-done note off $CLEANED completed task(s)"; fi

if [ "$ISSUES" -eq 0 ]; then
  log "OK: drain environment healthy (cwip dist present, bun link OK)"
else
  log "SUMMARY: found=$ISSUES issues, fixed=$FIXED"
fi
