#!/usr/bin/env bash
# Keep AI Office running in the background, detached from any terminal or app
# session, and restart it if it exits.  Usage: ./serve.sh start|stop|status
# With OFFICE_DOMAIN set (env or apps/ai_office/.env), Caddy also serves it over
# HTTPS on that domain for remote access.
set -euo pipefail
cd "$(dirname "$0")/../.."
PIDFILE=apps/ai_office/.serve.pid
LOG=apps/ai_office/server.log
CADDYFILE=apps/ai_office/Caddyfile

if [[ -z ${OFFICE_DOMAIN:-} && -f apps/ai_office/.env ]]; then
  OFFICE_DOMAIN=$(sed -n 's/^OFFICE_DOMAIN=//p' apps/ai_office/.env | tr -d '"'"'" | tail -1)
fi
export OFFICE_DOMAIN=${OFFICE_DOMAIN:-}

running() { [[ -f $PIDFILE ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

case "${1:-start}" in
  start)
    if running; then echo "already running (pid $(cat "$PIDFILE"))"; else
      nohup bash -c 'while true; do .venv/bin/python apps/ai_office/server.py; echo "[serve] exited $?, restarting in 3s"; sleep 3; done' \
        >>"$LOG" 2>&1 </dev/null &
      loop=$!
      echo "$loop" >"$PIDFILE"
      caffeinate -is -w "$loop" &     # keep the Mac awake while the server runs
      echo "started (pid $loop), log: $LOG"
    fi
    if [[ -n $OFFICE_DOMAIN ]]; then
      caddy start --config "$CADDYFILE" --adapter caddyfile >>"$LOG" 2>&1 \
        && echo "https://$OFFICE_DOMAIN" || echo "caddy failed to start, see $LOG"
    fi
    ;;
  stop)
    if running; then
      loop=$(cat "$PIDFILE")
      kill -STOP "$loop"            # freeze the loop so it can't restart the server
      pkill -P "$loop" || true
      kill -9 "$loop" || true
    fi
    rm -f "$PIDFILE"
    if [[ -n $OFFICE_DOMAIN ]]; then caddy stop >/dev/null 2>&1 || true; fi
    echo "stopped"
    ;;
  status)
    if running; then echo "running (pid $(cat "$PIDFILE"))"; else echo "not running"; fi
    if [[ -n $OFFICE_DOMAIN ]]; then echo "domain: https://$OFFICE_DOMAIN"; fi
    ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
