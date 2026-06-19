#!/usr/bin/env bash
# Clone + provision cursedalchemy (ca, the multi-user sibling) from scratch.
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

CODE_DIR="${CODE_DIR:-$HOME/code/github}"                                # TODO
CA_REPO="${CA_REPO:-git@github.com:youruser/cursedalchemy.git}"          # TODO
CA_DIR="$CODE_DIR/cursedalchemy"

have git || die "git is required"
have bun || die "bun is required — install from https://bun.sh"

mkdir -p "$CODE_DIR"
if [ ! -d "$CA_DIR/.git" ]; then
  say "cloning cursedalchemy → $CA_DIR"
  git clone "$CA_REPO" "$CA_DIR"
else
  ok "cursedalchemy already cloned at $CA_DIR"
fi

cd "$CA_DIR"
say "installing deps + provisioning…"
if [ -f package.json ] && grep -q '"setup"' package.json; then
  bun run setup
else
  bun install
fi
bun link cwip 2>/dev/null || warn "cwip not linked (link it if a build needs newer exports)"

# cursedalchemy is multi-user — its env/db live in ITS OWN .env, not ~/.rubato/.env.
if [ ! -f .env ]; then
  if [ -f .env.example ]; then cp .env.example .env && ok "seeded .env from .env.example";
  else warn "create cursedalchemy's .env (see its README)"; fi
fi

ok "cursedalchemy ready at $CA_DIR — see its README / CLAUDE.md to run it"
