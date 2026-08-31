// Fail-fast validation of environment secrets at app bootstrap.
// Add new secrets here as they become required; keep the schema the single
// place secrets are declared. Loaded only by slack.ts, so `flue run` needs none.
import * as v from 'valibot';

const envSchema = v.object({
	SLACK_SIGNING_SECRET: v.pipe(v.string(), v.minLength(1)),
});

export const env = v.parse(envSchema, process.env);