#!/usr/bin/env bash
# Clone Fooocus (a Stable-Diffusion image UI) and set up its conda env.
# Requires miniconda — run 20-miniconda.sh first.
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

CONDA_DIR="${CONDA_DIR:-$HOME/miniconda3}"
FOOOCUS_DIR="${FOOOCUS_DIR:-$HOME/Fooocus}"        # TODO: where to install
FOOOCUS_ENV="${FOOOCUS_ENV:-fooocus}"
FOOOCUS_REPO="${FOOOCUS_REPO:-https://github.com/lllyasviel/Fooocus.git}"

have git || die "git is required"
[ -x "$CONDA_DIR/bin/conda" ] || die "miniconda not found at $CONDA_DIR — run 20-miniconda.sh first"
# shellcheck disable=SC1091
. "$CONDA_DIR/etc/profile.d/conda.sh"

if [ ! -d "$FOOOCUS_DIR/.git" ]; then
  say "cloning Fooocus → $FOOOCUS_DIR"
  git clone "$FOOOCUS_REPO" "$FOOOCUS_DIR"
else
  say "updating Fooocus in $FOOOCUS_DIR"
  git -C "$FOOOCUS_DIR" pull --ff-only || warn "could not fast-forward; leaving as-is"
fi

if ! conda env list | awk '{print $1}' | grep -qx "$FOOOCUS_ENV"; then
  say "creating conda env '$FOOOCUS_ENV' (python 3.10, per Fooocus)…"
  conda create -y -n "$FOOOCUS_ENV" python=3.10
fi

say "installing Fooocus requirements…"
conda run -n "$FOOOCUS_ENV" python -m pip install --upgrade pip
if [ -f "$FOOOCUS_DIR/requirements_versions.txt" ]; then
  conda run -n "$FOOOCUS_ENV" python -m pip install -r "$FOOOCUS_DIR/requirements_versions.txt"
else
  warn "no requirements_versions.txt in $FOOOCUS_DIR — check the Fooocus README"
fi

ok "Fooocus ready — launch with:"
echo "    conda activate $FOOOCUS_ENV && python '$FOOOCUS_DIR/entry_with_update.py'"
