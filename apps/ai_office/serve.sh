#!/usr/bin/env bash
# Keep AI Office running in the background, detached from any terminal or app
# session, and restart it if it exits.  Usage: ./serve.sh start|stop|status
set -euo pipefail
cd "$(dirname "$0")/../.."
PIDFILE=apps/ai_office/.serve.pid
LOG=apps/ai_office/server.log

running() { [[ -f $PIDFILE ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

case "${1:-start}" in
  start)
    if running; then echo "already running (pid $(cat "$PIDFILE"))"; exit 0; fi
    nohup bash -c 'while true; do .venv/bin/python apps/ai_office/server.py; echo "[serve] exited $?, restarting in 3s"; sleep 3; done' \
      >>"$LOG" 2>&1 </dev/null &
    echo $! >"$PIDFILE"
    echo "started (pid $!), log: $LOG"
    ;;
  stop)
    if running; then
      loop=$(cat "$PIDFILE")
      kill -STOP "$loop"            # freeze the loop so it can't restart the server
      pkill -P "$loop" || true
      kill -9 "$loop" || true
    fi
    rm -f "$PIDFILE"
    echo "stopped"
    ;;
  status)
    if running; then echo "running (pid $(cat "$PIDFILE"))"; else echo "not running"; fi
    ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
