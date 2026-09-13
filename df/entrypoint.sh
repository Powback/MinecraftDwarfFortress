#!/usr/bin/env bash
# Boot Dwarf Fortress headless with DFHack, exposing RemoteFortressReader on :5000.
#
# MODE=run    (default) — auto-load a fort (if one exists) and serve RPC.
# MODE=embark           — also start a VNC server on :5900 so you can create and
#                         save a fort once, through any VNC viewer, no local DF needed.
set -euo pipefail

DF_DIR="${DF_DIR:-/opt/df}"
MODE="${MODE:-run}"
AUTO_LOAD="${AUTO_LOAD:-1}"
SAVE_DIR="$DF_DIR/data/save"

cd "$DF_DIR"

# --- virtual display -------------------------------------------------------
export DISPLAY=:99
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp &
XVFB_PID=$!
sleep 2

if [ "$MODE" = "embark" ]; then
  echo "[df] MODE=embark — VNC on :5900, noVNC (browser) on :6080/vnc.html"
  x11vnc -display :99 -forever -shared -nopw -quiet -bg
  # serve noVNC web client -> proxy to the local VNC server
  websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/websockify.log 2>&1 &
fi

# --- init tweaks for headless operation ------------------------------------
INIT="$DF_DIR/data/init/init.txt"
if [ -f "$INIT" ]; then
  sed -i \
    -e 's/\[PRINT_MODE:[^]]*\]/[PRINT_MODE:2D]/' \
    -e 's/\[SOUND:[^]]*\]/[SOUND:NO]/' \
    -e 's/\[INTRO:[^]]*\]/[INTRO:NO]/' \
    -e 's/\[FPS_CAP:[^]]*\]/[FPS_CAP:20]/' \
    -e 's/\[G_FPS_CAP:[^]]*\]/[G_FPS_CAP:10]/' \
    "$INIT" || true
fi

# --- auto-load the first save (runs at the DFHack title screen) -------------
# DFHack r8 executes dfhack-config/init/dfhack.init at startup (title screen),
# which is where `load-save` works. We append (idempotently) our load-save line.
DFHACK_INIT="$DF_DIR/dfhack-config/init/dfhack.init"
if [ "$MODE" = "run" ] && [ "$AUTO_LOAD" = "1" ]; then
  mkdir -p "$(dirname "$DFHACK_INIT")"   # dir doesn't exist until DFHack's first run
  touch "$DFHACK_INIT"
  # strip any prior autoload line we added, then re-add for the current save
  grep -v '^load-save ' "$DFHACK_INIT" > "$DFHACK_INIT.tmp" 2>/dev/null || true
  mv -f "$DFHACK_INIT.tmp" "$DFHACK_INIT" 2>/dev/null || true
  REGION="$(ls -1 "$SAVE_DIR" 2>/dev/null | grep -E '^region' | head -n1 || true)"
  if [ -n "$REGION" ]; then
    echo "[df] auto-loading save: $REGION (via $DFHACK_INIT)"
    echo "load-save $REGION" >> "$DFHACK_INIT"
  else
    echo "[df] no save found in $SAVE_DIR — DF will sit at the title screen."
    echo "[df] Create one with:  MODE=embark docker compose up df"
  fi
fi

echo "[df] launching DFHack (RemoteFortressReader RPC on :5000)…"
exec ./dfhack
