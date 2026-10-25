import type { MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export type AccessEnv = {
	ACCESS_TEAM_DOMAIN?: string;
	ACCESS_AUD?: string;
};

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function accessConfiguration({
	ACCESS_TEAM_DOMAIN,
	ACCESS_AUD,
}: AccessEnv): { issuer: string; audience: string } | undefined {
	const audience = ACCESS_AUD?.trim();

	if (!ACCESS_TEAM_DOMAIN || !audience) return undefined;

	try {
		const url = new URL(ACCESS_TEAM_DOMAIN);

		if (
			url.protocol !== 'https:' ||
			!url.hostname.endsWith('.cloudflareaccess.com') ||
			url.pathname !== '/' ||
			url.port ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		)
			return undefined;

		return { issuer: url.origin, audience };
	} catch {
		return undefined;
	}
}

export function requireAccess(): MiddlewareHandler<{ Bindings: AccessEnv }> {
	return async (c, next) => {
		c.header('Cache-Control', 'private, no-store');
		const configuration = accessConfiguration(c.env ?? {});

		if (!configuration) return c.text('Private app authentication is not configured.', 503);
		const token = c.req.header('Cf-Access-Jwt-Assertion');

		if (!token) return c.text('Authentication required.', 401);

		try {
			let keys = keySets.get(configuration.issuer);

			if (!keys) {
				keys = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', configuration.issuer));
				keySets.set(configuration.issuer, keys);
			}

			await jwtVerify(token, keys, {
				issuer: configuration.issuer,
				audience: configuration.audience,
				algorithms: ['RS256'],
				requiredClaims: ['exp', 'sub'],
			});
		} catch {
			return c.text('Authentication required.', 401);
		}

		await next();
		c.header('Cache-Control', 'private, no-store');

		return c.res;
	};
}
