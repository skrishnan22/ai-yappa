import type { FlueInstrumentation, FlueObservation } from '@flue/runtime';
import * as v from 'valibot';
import { PLANNING_SKILL, planningStore } from './planning-store.ts';

export function createPlanningStartup(): FlueInstrumentation {
	const planningStarts = new Map<string, () => Promise<void>>();

	return {
		key: Symbol.for('ai-yappa.planning-startup'),
		observe(event, context) {
			if (!isPlanningActivation(event) || planningStarts.has(context.id)) return;
			const store = planningStore();

			if (!store) return;

			let pending: Promise<void> | undefined;
			// Observation only marks the work; execution starts and awaits it below.
			planningStarts.set(context.id, () => {
				pending ??= store.sessions.start(context.id, new Date().toISOString()).finally(() => {
					planningStarts.delete(context.id);
				});

				return pending;
			});
		},
		async interceptor(_operation, context, next) {
			const start = context.instanceId ? planningStarts.get(context.instanceId) : undefined;

			if (start) await start();

			const result = await next();

			return result;
		},
		dispose() {
			planningStarts.clear();
		},
	};
}

const activateSkillArgsSchema = v.object({ name: v.string() });

export function isPlanningActivation(event: FlueObservation): boolean {
	return (
		event.type === 'tool_start' &&
		event.toolName === 'activate_skill' &&
		v.is(activateSkillArgsSchema, event.args) &&
		event.args.name === PLANNING_SKILL
	);
}
