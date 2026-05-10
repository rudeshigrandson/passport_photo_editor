#!/usr/bin/env bash
# Starts the local server and opens the web page. Run by LaunchAgent at login,
# or manually any time.
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

PORT="${PORT:-5005}"
URL="http://127.0.0.1:$PORT"

if [ ! -d venv ]; then
  echo "venv missing. Run ./install.sh first." >&2
  exit 1
fi
# shellcheck disable=SC1091
source venv/bin/activate

# If already running on the port, just open the browser
if curl -fsS "$URL/api/health" >/dev/null 2>&1; then
  echo "server already up"
else
  echo "starting server on $URL"
  nohup python server.py >>"$DIR/server.log" 2>>"$DIR/server.err.log" &
  # wait until healthy (max ~20s)
  for _ in $(seq 1 40); do
    sleep 0.5
    curl -fsS "$URL/api/health" >/dev/null 2>&1 && break
  done
fi

case "$(uname)" in
  Darwin) open "$URL" ;;
  Linux)  xdg-open "$URL" >/dev/null 2>&1 || true ;;
  MINGW*|MSYS*|CYGWIN*) start "$URL" ;;
  *) echo "Open $URL in your browser." ;;
esac
