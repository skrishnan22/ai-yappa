#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT/.tunnel.pid"

if [ ! -f "$PID_FILE" ]; then
	echo "No project tunnel process was recorded."
	exit 0
fi

PID="$(sed -n '1p' "$PID_FILE")"
case "$PID" in
	'' | *[!0-9]*)
		echo "Ignoring invalid tunnel pid file."
		rm -f "$PID_FILE"
		exit 0
		;;
esac

if ! kill -0 "$PID" 2>/dev/null; then
	echo "The recorded tunnel process is no longer running."
	rm -f "$PID_FILE"
	exit 0
fi

COMMAND="$(ps -p "$PID" -o comm= 2>/dev/null | awk '{$1=$1; print}')"
case "$COMMAND" in
	ngrok | */ngrok) ;;
	*)
		echo "Refusing to stop pid $PID because it is not ngrok."
		rm -f "$PID_FILE"
		exit 1
		;;
esac

kill "$PID"
rm -f "$PID_FILE"
echo "Tunnel stopped."
