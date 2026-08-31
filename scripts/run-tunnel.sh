#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
PORT="${TUNNEL_PORT:-5173}"

if ! command -v ngrok >/dev/null 2>&1; then
	echo "ngrok is not on PATH. Install with: brew install ngrok/ngrok/ngrok"
	exit 1
fi

HOSTNAME=""
if [ -f "$ROOT/.env" ]; then
	HOSTNAME="$(awk -F= '/^TUNNEL_HOSTNAME=/ { sub(/^TUNNEL_HOSTNAME=/, ""); gsub(/^[ \t"\047]+|[ \t"\047]+$/, ""); print; exit }' "$ROOT/.env")"
	HOSTNAME="${HOSTNAME#https://}"
	HOSTNAME="${HOSTNAME#http://}"
	HOSTNAME="${HOSTNAME%/}"
fi

# https:// with no host is the account's assigned free domain, which is stable.
if [ -z "$HOSTNAME" ]; then
	echo "TUNNEL_HOSTNAME is unset. Binding the free assigned domain."
	echo "Run npm run tunnel:setup afterward so Slack gets the exact URL."
	exec ngrok http "$PORT" --url 'https://'
fi

exec ngrok http "$PORT" --url "https://${HOSTNAME}"
