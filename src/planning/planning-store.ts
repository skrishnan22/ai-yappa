import type { PlanningStore } from './decision-log.ts';

// The skill whose activation starts a Planning Session.
export const PLANNING_SKILL = 'grill-me';

// Set once per isolate by the Worker entry (`src/cloudflare.ts`). Unset under
// `flue run`, which has no D1, so the Coworker mounts no planning tools there.
let current: PlanningStore | undefined;

export function setPlanningStore(store: PlanningStore | undefined): void {
	current = store;
}

export function planningStore(): PlanningStore | undefined {
	return current;
}
