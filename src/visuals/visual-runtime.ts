import type { ArtifactStore } from './artifact-store.ts';
import type { RenderVisual } from './visual-tools.ts';

export type VisualRuntime = {
	/** Renders source in Browser Run against this Worker's `/render/` templates. */
	render: RenderVisual;
	artifacts: ArtifactStore;
};

// Set once per isolate by the Worker entry (`src/cloudflare.ts`). Unset under
// `flue run` and when the deployment has no Browser Run binding, R2 bucket,
// or public origin, so the Coworker mounts no visual tools there.
let current: VisualRuntime | undefined;

export function setVisualRuntime(runtime: VisualRuntime | undefined): void {
	current = runtime;
}

export function visualRuntime(): VisualRuntime | undefined {
	return current;
}

/**
 * The origin Browser Run loads templates from: `PUBLIC_ORIGIN`, else the dev
 * tunnel host, since Browser Run cannot reach `localhost`.
 */
export function publicOrigin({
	PUBLIC_ORIGIN,
	TUNNEL_HOSTNAME,
}: {
	PUBLIC_ORIGIN?: string;
	TUNNEL_HOSTNAME?: string;
}): string | undefined {
	const configured = PUBLIC_ORIGIN?.trim() || TUNNEL_HOSTNAME?.trim();

	if (!configured) return undefined;

	return new URL(configured.includes('://') ? configured : `https://${configured}`).origin;
}
