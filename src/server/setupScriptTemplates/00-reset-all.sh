#!/usr/bin/env bash
# Reset everything — run all setup stages in order (or just the ones you name).
#
# Part of the rubato <-> ca "reset from scratch" setup scripts. These live OUTSIDE
# git, under ~/.rubato/setup-scripts/ — edit freely; they are yours to tweak.
# Secrets come from ~/.rubato/.env (KEY=VALUE), never hard-coded here.
set -euo pipefail

say()  { echo "▸ $*"; }
ok()   { echo "✓ $*"; }
warn() { echo "! $*" >&2; }
die()  { echo "✗ $*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Stage name -> script file, in run order. Add/remove freely.
STAGES=(
  "ollama:10-ollama.sh"
  "conda:20-miniconda.sh"
  "fooocus:30-fooocus.sh"
  "orchestrator:40-orchestrator.sh"
  "ses:50-aws-ses.sh"
  "ec2:60-aws-ec2.sh"
  "cloudflare:70-cloudflare.sh"
  "rubato:80-rubato-setup.sh"
  "ca:81-ca-setup.sh"
)

usage() {
  echo "Usage: $(basename "$0") [all | <stage> ...]"
  echo "Stages (in order):"
  for s in "${STAGES[@]}"; do echo "  - ${s%%:*}"; done
}

run_stage() {
  local want="$1" name file
  for s in "${STAGES[@]}"; do
    name="${s%%:*}"; file="${s##*:}"
    if [ "$name" = "$want" ]; then
      if [ -f "$SCRIPT_DIR/$file" ]; then
        say "── stage: $name ($file) ──"
        bash "$SCRIPT_DIR/$file" || die "stage '$name' failed"
        ok "stage '$name' done"
      else
        warn "skipping '$name' — $file not found next to this script"
      fi
      return 0
    fi
  done
  die "unknown stage: $want (try: $(basename "$0") all)"
}

[ $# -eq 0 ] && { usage; exit 0; }

if [ "$1" = "all" ]; then
  for s in "${STAGES[@]}"; do run_stage "${s%%:*}"; done
else
  for want in "$@"; do run_stage "$want"; done
fi

ok "reset-all complete"
