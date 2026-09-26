import { hasOpenAICodexCredential, openAICodexModelSpecifier } from './openai-codex-route.ts';
import { openCodeGoModelSpecifier } from './opencode-go-catalog.ts';

/**
 * Deployment Model Route shown on the Live Run Card and passed to `useModel`:
 * the ChatGPT subscription when a Codex credential is configured, otherwise
 * OpenCode Go.
 */
export function resolveCoworkerModelSpecifier(
	env: { OPENAI_CODEX_ACCESS_TOKEN?: string } = process.env,
): string {
	return hasOpenAICodexCredential(env) ? openAICodexModelSpecifier : openCodeGoModelSpecifier;
}

/**
 * Reasoning effort for Coworker. Flue defaults to `medium` when omitted;
 * keep this explicit so Slack display and the harness stay aligned.
 */
export const coworkerThinkingLevel = 'medium' as const;

export type CoworkerThinkingLevel = typeof coworkerThinkingLevel;
