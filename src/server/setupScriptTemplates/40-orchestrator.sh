#!/usr/bin/env bash
# Set up the unattended task-queue ("orchestrator") workspace + rubato config.
#
# Part of the rubato <-> ca "reset from scratch" setup scripts. These live OUTSIDE
# git, under ~/.rubato/setup-scripts/ — edit freely; they are yours to tweak.
# Secrets come from ~/.rubato/.env (KEY=VALUE), never hard-coded here.
set -euo pipefail

say()  { echo "▸ $*"; }
ok()   { echo "✓ $*"; }
warn() { echo "! $*" >&2; }
die()  { echo "✗ $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

RUBATO_HOME="${RUBATO_HOME:-$HOME/.rubato}"
[ -f "$RUBATO_HOME/.env" ] && { set -a; . "$RUBATO_HOME/.env"; set +a; }

WORKSPACE="${AGENT_WORKSPACE:-$HOME/code/workspaces/___Agent_Workspace}"  # TODO
CONFIG_JSON="$RUBATO_HOME/config.json"

say "ensuring agent workspace at $WORKSPACE"
mkdir -p "$WORKSPACE/orchestration/runs"

if [ ! -f "$WORKSPACE/TASKS.md" ]; then
  cat > "$WORKSPACE/TASKS.md" <<'EOF'
# TASKS

Status legend: [ ] ready · [~] in-progress · [b] blocked · [-] skipped · [x] done

<!-- Add tasks as `## [ ] <title>` headings. See TASKS.GUIDE.md for the markers. -->
EOF
  ok "seeded TASKS.md"
else
  ok "TASKS.md already present"
fi

# Point rubato's Orchestration page at this workspace (config orchestration.notesDir).
mkdir -p "$RUBATO_HOME"
if have jq && [ -f "$CONFIG_JSON" ]; then
  tmp="$(mktemp)"
  if jq --arg d "$WORKSPACE" '.orchestration = ((.orchestration // {}) + {notesDir: $d})' "$CONFIG_JSON" > "$tmp"; then
    mv "$tmp" "$CONFIG_JSON"
    ok "set orchestration.notesDir in config.json"
  else
    rm -f "$tmp"; warn "could not edit config.json — set orchestration.notesDir by hand"
  fi
else
  warn "set orchestration.notesDir to \"$WORKSPACE\" in $CONFIG_JSON (jq missing / no config yet)"
fi

# Optional ca <-> rubato task bridge — add these to ~/.rubato/.env to enable:
#   CA_SYNC_URL=https://your-cursedalchemy.example.com
#   CA_SYNC_API_KEY=...           # secret, env-only
#   CA_SYNC_HOST_ID=$(hostname)
if [ -n "${CA_SYNC_URL:-}" ]; then
  ok "ca-sync configured for $CA_SYNC_URL"
else
  warn "ca-sync not configured (optional — set CA_SYNC_URL + CA_SYNC_API_KEY)"
fi

ok "orchestrator workspace ready at $WORKSPACE"
