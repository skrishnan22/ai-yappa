#!/bin/sh
set -eu

stopped=0

if pgrep -x ngrok >/dev/null 2>&1; then
	killall ngrok
	stopped=1
fi

if pgrep -f 'cloudflared tunnel' >/dev/null 2>&1; then
	pkill -f 'cloudflared tunnel' || true
	stopped=1
fi

if [ "$stopped" -eq 0 ]; then
	echo "No tunnel process was running."
	exit 0
fi

echo "Tunnel stopped."
