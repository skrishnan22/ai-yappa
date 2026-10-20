import { expect, test } from 'vitest';
import { publicOrigin } from './visual-runtime.ts';

test.each([
	{ config: {}, expected: undefined },
	{ config: { PUBLIC_ORIGIN: ' https://agent.example/path ' }, expected: 'https://agent.example' },
	{ config: { TUNNEL_HOSTNAME: 'dev.example' }, expected: 'https://dev.example' },
	{ config: { PUBLIC_ORIGIN: 'https://' }, expected: undefined },
	{ config: { TUNNEL_HOSTNAME: 'not a hostname' }, expected: undefined },
])('resolves the optional visual origin safely: $config', ({ config, expected }) => {
	expect(publicOrigin(config)).toBe(expected);
});
