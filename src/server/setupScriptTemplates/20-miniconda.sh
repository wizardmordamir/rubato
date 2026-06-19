#!/usr/bin/env bash
# Install Miniconda (if absent) and create a working Python env.
#
# Part of the rubato <-> ca "reset from scratch" setup scripts. These live OUTSIDE
# git, under ~/.rubato/setup-scripts/ — edit freely; they are yours to tweak.
# Secrets come from ~/.rubato/.env (KEY=VALUE), never hard-coded here.
set -euo pipefail

say()  { echo "▸ $*"; }
ok()   { echo "✓ $*"; }
warn() { echo "! $*" >&2; }
die()  { echo "✗ $*" >&2; exit 1; }

RUBATO_HOME="${RUBATO_HOME:-$HOME/.rubato}"
[ -f "$RUBATO_HOME/.env" ] && { set -a; . "$RUBATO_HOME/.env"; set +a; }

CONDA_DIR="${CONDA_DIR:-$HOME/miniconda3}"
CONDA_ENV="${CONDA_ENV:-ml}"          # TODO: env name
PY_VERSION="${PY_VERSION:-3.11}"      # TODO: python version

if [ ! -x "$CONDA_DIR/bin/conda" ]; then
  say "installing miniconda to $CONDA_DIR…"
  case "$(uname)-$(uname -m)" in
    Darwin-arm64)  URL="https://repo.anaconda.com/miniconda/Miniconda3-latest-MacOSX-arm64.sh" ;;
    Darwin-x86_64) URL="https://repo.anaconda.com/miniconda/Miniconda3-latest-MacOSX-x86_64.sh" ;;
    Linux-x86_64)  URL="https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh" ;;
    Linux-aarch64) URL="https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-aarch64.sh" ;;
    *) die "unsupported platform: $(uname)-$(uname -m)" ;;
  esac
  tmp="$(mktemp -t miniconda.XXXXXX)"
  curl -fsSL "$URL" -o "$tmp"
  bash "$tmp" -b -p "$CONDA_DIR"
  rm -f "$tmp"
else
  ok "miniconda already at $CONDA_DIR"
fi

# shellcheck disable=SC1091
. "$CONDA_DIR/etc/profile.d/conda.sh"
conda config --set auto_activate_base false || true

if conda env list | awk '{print $1}' | grep -qx "$CONDA_ENV"; then
  ok "conda env '$CONDA_ENV' already exists"
else
  say "creating env '$CONDA_ENV' (python $PY_VERSION)…"
  conda create -y -n "$CONDA_ENV" "python=$PY_VERSION"
fi

ok "miniconda ready — activate with:  conda activate $CONDA_ENV"
