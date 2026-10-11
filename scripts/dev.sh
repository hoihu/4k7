#!/usr/bin/env bash
# Development: the app from source with hot reload (Vite) on localhost:5173, plus the local server
# from source (restarts when its code changes), in one terminal. Ctrl-C stops both.
#
# Projects live in the browser's IndexedDB, per origin (host + port). Every checkout or worktree
# that serves on its own port starts with an empty project; serving them all on 5173, one at a time,
# keeps the projects. If another checkout's dev server holds 5173, it is stopped (by PID, only the
# process listening on that port), then this one starts there.
set -euo pipefail
PORT="${FOURK7_DEV_PORT:-5173}"
cd "$(dirname "$0")/.."
here="$(pwd -P)"

# A fresh worktree has no node_modules. Install first, so the other checkout's server keeps
# running if the install fails.
if [ ! -x node_modules/.bin/vite ]; then
  echo "Installing dependencies in $here"
  npm install --no-audit --no-fund
fi

pid="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
if [ -n "$pid" ]; then
  owner="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
  case "$owner" in
    "$here"|"$here"/*) echo "Port $PORT is already served from this checkout (pid $pid)."; exit 0 ;;
  esac
  echo "Stopping the dev server of $owner (pid $pid) on port $PORT"
  kill "$pid"
  for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
  if kill -0 "$pid" 2>/dev/null; then echo "pid $pid did not stop; leaving it alone." >&2; exit 1; fi
fi

echo "Serving $here on http://localhost:$PORT"
# vite and the server run directly (not through npm), so stopping this script stops them
(cd apps/web && exec ../../node_modules/.bin/vite --port "$PORT" --strictPort) &
vite=$!
server=
trap 'kill $vite $server 2>/dev/null' EXIT
trap 'exit 130' INT TERM
# its app link opens the dev server
FOURK7_APP_URL="http://localhost:$PORT" node --watch tools/server/src/main.ts --serve &
server=$!
wait "$vite"
