#!/usr/bin/env bash
# Idiot-proof installer for macOS / Linux.
# - Picks the best available Python (>=3.9)
# - Builds a virtualenv
# - Installs deps
# - Pre-fetches ML model so app stays offline after install
# - Installs autostart (macOS LaunchAgent) so server runs every login
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "============================================="
echo " Passport Photo Editor — installer"
echo " dir: $DIR"
echo "============================================="

# 1. Find the newest python >= 3.9
PY=""
for cand in python3.12 python3.11 python3.10 python3.9 python3 python; do
  if command -v "$cand" >/dev/null 2>&1; then
    V="$("$cand" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null || echo "")"
    case "$V" in
      3.9|3.10|3.11|3.12|3.13) PY="$cand"; PY_VER="$V"; break ;;
    esac
  fi
done

if [ -z "$PY" ]; then
  echo
  echo "ERROR: No Python >= 3.9 found on this Mac."
  echo "       Please install Python from https://www.python.org/downloads/"
  echo "       (download the latest installer, run it, then double-click install.command again)"
  exit 1
fi
echo "==> using $PY (Python $PY_VER)"

# 2. (re)create venv
if [ -d venv ]; then
  EXISTING_VER="$(venv/bin/python -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null || echo "")"
  if [ "$EXISTING_VER" != "$PY_VER" ]; then
    echo "==> existing venv is Python $EXISTING_VER, rebuilding for $PY_VER"
    rm -rf venv
  fi
fi
if [ ! -d venv ]; then
  echo "==> creating virtualenv"
  "$PY" -m venv venv
fi
# shellcheck disable=SC1091
source venv/bin/activate

# 3. deps
echo "==> upgrading pip / wheel"
pip install --upgrade pip wheel >/dev/null
echo "==> installing python packages (a few minutes; downloads ~500MB)"
pip install -r requirements.txt

# 4. pre-fetch rembg model (so app is fully offline afterward)
echo "==> pre-fetching background-removal model (~170MB, one time)"
python - <<'PY'
from rembg import new_session
new_session('u2net')
print("rembg model ready")
PY

# 5. self-test imports
echo "==> verifying imports"
python - <<'PY'
import flask, PIL, numpy, cv2, rembg, onnxruntime
print("imports OK")
PY

# 6. macOS autostart (LaunchAgent)
if [ "$(uname)" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.passporteditor.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.passporteditor</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$DIR/start.sh</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>StandardOutPath</key><string>$DIR/server.log</string>
  <key>StandardErrorPath</key><string>$DIR/server.err.log</string>
</dict>
</plist>
EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "==> autostart installed: $PLIST"
fi

echo
echo "============================================="
echo " DONE. Launching now…"
echo "============================================="
exec bash "$DIR/start.sh"
