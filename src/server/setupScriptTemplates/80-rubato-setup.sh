#!/usr/bin/env bash
# Clone + provision rubato (this toolbox) from scratch.
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

CODE_DIR="${CODE_DIR:-$HOME/code/github}"                          # TODO: where repos live
RUBATO_REPO="${RUBATO_REPO:-git@github.com:youruser/rubato.git}"   # TODO
RUBATO_DIR="$CODE_DIR/rubato"

have git || die "git is required"
have bun || die "bun is required — install from https://bun.sh"

mkdir -p "$CODE_DIR"
if [ ! -d "$RUBATO_DIR/.git" ]; then
  say "cloning rubato → $RUBATO_DIR"
  git clone "$RUBATO_REPO" "$RUBATO_DIR"
else
  ok "rubato already cloned at $RUBATO_DIR"
fi

cd "$RUBATO_DIR"
say "installing deps (root + ui)…"
bun run setup
# cwip is bun-linked to the local sibling checkout while it's mid-upgrade:
bun link cwip 2>/dev/null || warn "cwip not linked (link/publish it if a build needs newer exports)"

say "installing shell commands…"
bun run src/scripts/setup-aliases.ts || warn "rubato-setup failed — run it by hand"

mkdir -p "$RUBATO_HOME"
[ -f "$RUBATO_HOME/.env" ] || { touch "$RUBATO_HOME/.env"; ok "created $RUBATO_HOME/.env (add secrets here)"; }

ok "rubato ready at $RUBATO_DIR — open a new shell, then:  rubato list"
