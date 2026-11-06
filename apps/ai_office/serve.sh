#!/usr/bin/env bash
# Keep AI Office running in the background, detached from any terminal or app
# session, and restart it if it exits.  Usage: ./serve.sh start|stop|status
# With OFFICE_DOMAIN set (env or apps/ai_office/.env), Caddy also serves it over
# HTTPS on that domain for remote access. With CAMOFOX_DIR set to a camofox-browser
# checkout, that browser server is started and stopped with it.
set -euo pipefail
cd "$(dirname "$0")/../.."
PIDFILE=apps/ai_office/.serve.pid
LOG=apps/ai_office/server.log
CADDYFILE=apps/ai_office/Caddyfile
CAMOFOX_PIDFILE=apps/ai_office/.camofox.pid
CAMOFOX_LOG=apps/ai_office/camofox.log

from_env() { [[ -f apps/ai_office/.env ]] && sed -n "s/^$1=//p" apps/ai_office/.env | tr -d '"'"'" | tail -1; }
OFFICE_DOMAIN=${OFFICE_DOMAIN:-$(from_env OFFICE_DOMAIN || true)}
CAMOFOX_DIR=${CAMOFOX_DIR:-$(from_env CAMOFOX_DIR || true)}
export OFFICE_DOMAIN

running() { [[ -f $1 ]] && kill -0 "$(cat "$1")" 2>/dev/null; }

# Stops a restart loop started below and whatever it is running.
stop_loop() {
  if running "$1"; then
    loop=$(cat "$1")
    kill -STOP "$loop"            # freeze the loop so it can't restart its child
    pkill -P "$loop" || true
    kill -9 "$loop" || true
  fi
  rm -f "$1"
}

case "${1:-start}" in
  start)
    if running "$PIDFILE"; then echo "already running (pid $(cat "$PIDFILE"))"; else
      nohup bash -c 'while true; do .venv/bin/python apps/ai_office/server.py; echo "[serve] exited $?, restarting in 3s"; sleep 3; done' \
        >>"$LOG" 2>&1 </dev/null &
      loop=$!
      echo "$loop" >"$PIDFILE"
      caffeinate -is -w "$loop" &     # keep the Mac awake while the server runs
      echo "started (pid $loop), log: $LOG"
    fi
    if [[ -n $CAMOFOX_DIR ]] && ! running "$CAMOFOX_PIDFILE"; then
      # Loopback only, no crash reports sent out.
      nohup bash -c 'cd "$0" && while true; do CAMOFOX_BIND_HOST=127.0.0.1 CAMOFOX_CRASH_REPORT_ENABLED=false \
        CAMOFOX_LOCALE=ko-KR CAMOFOX_TIMEZONE=Asia/Seoul node server.js; echo "[serve] exited $?, restarting in 3s"; sleep 3; done' \
        "$CAMOFOX_DIR" >>"$CAMOFOX_LOG" 2>&1 </dev/null &
      echo $! >"$CAMOFOX_PIDFILE"
      echo "camofox started (pid $!), log: $CAMOFOX_LOG"
    fi
    if [[ -n $OFFICE_DOMAIN ]]; then
      caddy start --config "$CADDYFILE" --adapter caddyfile >>"$LOG" 2>&1 \
        && echo "https://$OFFICE_DOMAIN" || echo "caddy failed to start, see $LOG"
    fi
    ;;
  stop)
    stop_loop "$PIDFILE"
    stop_loop "$CAMOFOX_PIDFILE"
    if [[ -n $OFFICE_DOMAIN ]]; then caddy stop >/dev/null 2>&1 || true; fi
    echo "stopped"
    ;;
  status)
    if running "$PIDFILE"; then echo "running (pid $(cat "$PIDFILE"))"; else echo "not running"; fi
    if running "$CAMOFOX_PIDFILE"; then echo "camofox running (pid $(cat "$CAMOFOX_PIDFILE"))"; fi
    if [[ -n $OFFICE_DOMAIN ]]; then echo "domain: https://$OFFICE_DOMAIN"; fi
    ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
