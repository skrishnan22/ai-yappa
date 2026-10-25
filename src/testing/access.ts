import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export const TEST_ACCESS_ENV = {
	ACCESS_TEAM_DOMAIN: 'https://aiyappa-test.cloudflareaccess.com',
	ACCESS_AUD: 'walkthrough-test-audience',
};

export async function accessTestIdentity() {
	const keys = await generateKeyPair('RS256');
	const publicJwk = await exportJWK(keys.publicKey);
	const jwks = { keys: [{ ...publicJwk, kid: 'access-test-key', alg: 'RS256', use: 'sig' }] };

	async function token({
		issuer = TEST_ACCESS_ENV.ACCESS_TEAM_DOMAIN,
		audience = TEST_ACCESS_ENV.ACCESS_AUD,
		expiration = '1h',
		privateKey = keys.privateKey,
	}: {
		issuer?: string;
		audience?: string;
		expiration?: string;
		privateKey?: typeof keys.privateKey;
	} = {}): Promise<string> {
		const signed = await new SignJWT({ email: 'reviewer@example.com' })
			.setProtectedHeader({ alg: 'RS256', kid: 'access-test-key' })
			.setIssuer(issuer)
			.setAudience(audience)
			.setSubject('reviewer')
			.setIssuedAt()
			.setExpirationTime(expiration)
			.sign(privateKey);

		return signed;
	}

	return { jwks, token };
}
