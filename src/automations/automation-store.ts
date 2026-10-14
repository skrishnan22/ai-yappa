import type { AutomationStore } from './automation.ts';

// Set once per isolate by the Worker entry (`src/cloudflare.ts`). Unset under
// `flue run`, which has no D1, so the Coworker mounts no automation tools there.
let current: AutomationStore | undefined;

export function setAutomationStore(store: AutomationStore | undefined): void {
	current = store;
}

export function automationStore(): AutomationStore | undefined {
	return current;
}
