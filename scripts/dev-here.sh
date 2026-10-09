#!/usr/bin/env bash
# Dev server for THIS checkout on the shared origin localhost:5173.
#
# Projects live in the browser's IndexedDB, per origin (host + port). Every checkout or worktree
# that serves on its own port starts with an empty project; serving them all on 5173, one at a time,
# keeps the projects. If another checkout's dev server holds 5173, it is stopped (by PID, only the
# process listening on that port), then this one starts there.
set -euo pipefail
PORT=5173
cd "$(dirname "$0")/.."
here="$(pwd -P)"

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
exec npm run dev -w @tracewise/web -- --port "$PORT" --strictPort
