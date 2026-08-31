import { cloudflare } from '@cloudflare/vite-plugin';
import { flue, flueWorkerConfig } from '@flue/vite';
import { defineConfig, loadEnv } from 'vite';

function hostnameFromEnv(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	try {
		return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname;
	} catch {
		return trimmed;
	}
}

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), '');
	const tunnelHost = hostnameFromEnv(env.TUNNEL_HOSTNAME);

	return {
		plugins: [flue({ providers: ['opencode-go'] }), cloudflare({ config: flueWorkerConfig() })],
		server: {
			allowedHosts: [
				'.trycloudflare.com',
				'.ngrok.app',
				'.ngrok.dev',
				'.ngrok-free.app',
				'.ngrok-free.dev',
				'.ngrok.io',
				'.ts.net',
				...(tunnelHost ? [tunnelHost] : []),
			],
		},
	};
});
