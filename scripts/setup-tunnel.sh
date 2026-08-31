#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
HOSTNAME="${1:-}"

write_hostname() {
	host="$1"
	if [ -f "$ROOT/.env" ] && grep -q '^TUNNEL_HOSTNAME=' "$ROOT/.env"; then
		TMP="$(mktemp)"
		awk -v host="$host" '
			BEGIN { done = 0 }
			/^TUNNEL_HOSTNAME=/ { print "TUNNEL_HOSTNAME=" host; done = 1; next }
			{ print }
			END { if (!done) print "TUNNEL_HOSTNAME=" host }
		' "$ROOT/.env" > "$TMP"
		mv "$TMP" "$ROOT/.env"
	elif [ -f "$ROOT/.env" ]; then
		printf '\nTUNNEL_HOSTNAME=%s\n' "$host" >> "$ROOT/.env"
	else
		printf 'TUNNEL_HOSTNAME=%s\n' "$host" > "$ROOT/.env"
	fi
}

if ! command -v ngrok >/dev/null 2>&1; then
	echo "ngrok is not on PATH. Install with: brew install ngrok/ngrok/ngrok"
	exit 1
fi

if ! ngrok config check >/dev/null 2>&1; then
	echo "ngrok has no authtoken yet."
	echo "Create a free account, copy the token from https://dashboard.ngrok.com/get-started/your-authtoken"
	echo "then run: ngrok config add-authtoken <token>"
	echo "Do not paste the token into chat."
	exit 1
fi

if [ -n "$HOSTNAME" ]; then
	HOSTNAME="${HOSTNAME#https://}"
	HOSTNAME="${HOSTNAME#http://}"
	HOSTNAME="${HOSTNAME%/}"
	case "$HOSTNAME" in
		*.ngrok-free.app | *.ngrok-free.dev) ;;
		*.ngrok.app | *.ngrok.dev | *.ngrok.pizza)
			echo "$HOSTNAME needs a paid ngrok plan."
			echo "Omit the hostname to use the free assigned domain instead."
			exit 1
			;;
		*)
			echo "Pass nothing, or your assigned *.ngrok-free.app host from https://dashboard.ngrok.com/domains"
			exit 1
			;;
	esac
else
	if ! command -v curl >/dev/null 2>&1; then
		echo "curl is required to discover the free ngrok domain, or pass it:"
		echo "  npm run tunnel:setup -- your-assigned-name.ngrok-free.app"
		exit 1
	fi

	WEB_ADDR="127.0.0.1:$((4050 + $$ % 40))"
	LOG="$(mktemp)"
	ngrok http 9 --url 'https://' --web-addr "$WEB_ADDR" --log=stdout --log-format=json >"$LOG" 2>&1 &
	NGROK_PID=$!
	cleanup() {
		kill "$NGROK_PID" 2>/dev/null || true
		wait "$NGROK_PID" 2>/dev/null || true
		rm -f "$LOG"
	}
	trap cleanup EXIT INT TERM

	HOSTNAME=""
	i=0
	while [ "$i" -lt 40 ]; do
		if tunnels="$(curl -sf "http://${WEB_ADDR}/api/tunnels" 2>/dev/null)"; then
			HOSTNAME="$(TUNNELS_JSON="$tunnels" node -e '
const data = JSON.parse(process.env.TUNNELS_JSON || "{}");
const tunnel = (data.tunnels || []).find((item) => typeof item.public_url === "string" && item.public_url.startsWith("https://"));
if (tunnel) process.stdout.write(new URL(tunnel.public_url).hostname);
')"
			if [ -n "$HOSTNAME" ]; then
				break
			fi
		fi
		i=$((i + 1))
		sleep 0.25
	done

	trap - EXIT INT TERM
	cleanup

	if [ -z "$HOSTNAME" ]; then
		echo "Could not read the free assigned domain from ngrok."
		echo "Open https://dashboard.ngrok.com/domains and run:"
		echo "  npm run tunnel:setup -- your-assigned-name.ngrok-free.app"
		exit 1
	fi
fi

write_hostname "$HOSTNAME"

echo
echo "Free ngrok assigned host is $HOSTNAME"
echo "That name stays on this ngrok account. You cannot pick it on the free plan."
echo "Slack Events URL: https://${HOSTNAME}/channels/slack/events"
echo
echo "Then, in two terminals:"
echo "  npm run dev"
echo "  npm run tunnel"
echo
echo "Stop with: npm run tunnel:stop"
