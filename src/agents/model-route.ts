import { openCodeGoModelSpecifier } from './opencode-go-catalog.ts';

/** Deployment Model Route shown on the Live Run Card and passed to `useModel`. */
export const coworkerModelSpecifier = openCodeGoModelSpecifier;

/**
 * Reasoning effort for Coworker. Flue defaults to `medium` when omitted;
 * keep this explicit so Slack display and the harness stay aligned.
 */
export const coworkerThinkingLevel = 'medium' as const;

export type CoworkerThinkingLevel = typeof coworkerThinkingLevel;
