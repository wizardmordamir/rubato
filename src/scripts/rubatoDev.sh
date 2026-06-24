#!/bin/bash
# rubatoDev.sh — runs the rubato dev stack (rubato-serve API :4747 + Vite UI, lands on
# :5175 while ca's vites hold 5173/5174) under launchd KeepAlive, so the owner's orch
# board at localhost:5175/taskq survives a crash while they're away.
#
# KILL SWITCH (the UI on/off toggle writes this file):
#   touch ~/.taskq/.rubato-dev.disabled   -> launchd stops it + won't relaunch
#   rm    ~/.taskq/.rubato-dev.disabled   -> launchd brings it back
# (the plist's KeepAlive.PathState enforces this; this guard is belt-and-suspenders)
exec >> "$HOME/.taskq/rubato-dev.log" 2>&1
if [ -f "$HOME/.taskq/.rubato-dev.disabled" ]; then
  echo "[$(date '+%F %T')] disabled flag present — not starting"; sleep 5; exit 0
fi
echo "[$(date '+%F %T')] starting rubato dev stack…"
cd "$HOME/code/github/rubato" || exit 1
export PATH="$HOME/.bun/bin:$HOME/.nvm/versions/node/v20.12.2/bin:/usr/local/bin:/usr/bin:/bin"
exec "$HOME/.bun/bin/bun" run dev
