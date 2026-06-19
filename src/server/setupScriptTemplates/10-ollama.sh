#!/usr/bin/env bash
# Install the Ollama runtime and pull the local models you use.
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

# Space-separated model list — override OLLAMA_MODELS in ~/.rubato/.env.
MODELS="${OLLAMA_MODELS:-llama3.1 qwen2.5-coder nomic-embed-text}"   # TODO: your models

if ! have ollama; then
  say "installing ollama…"
  if [ "$(uname)" = "Darwin" ]; then
    if have brew; then brew install ollama; else
      die "install Homebrew, or download Ollama from https://ollama.com/download"
    fi
  else
    curl -fsSL https://ollama.com/install.sh | sh
  fi
else
  ok "ollama already installed ($(ollama --version 2>/dev/null | head -1))"
fi

# Make sure the daemon is reachable (macOS app / brew services, or Linux systemd).
if ! curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  say "starting ollama daemon…"
  (ollama serve >/dev/null 2>&1 &) || warn "could not auto-start — start Ollama manually"
  sleep 2
fi

for m in $MODELS; do
  say "pulling model: $m"
  ollama pull "$m" || warn "failed to pull $m (continuing)"
done

ok "ollama ready — models: $MODELS"
