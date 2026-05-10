#!/usr/bin/env bash
# Removes the LaunchAgent. Leaves files & venv intact.
set -e
PLIST="$HOME/Library/LaunchAgents/com.passporteditor.plist"
if [ -f "$PLIST" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "LaunchAgent removed."
else
  echo "No LaunchAgent found."
fi
