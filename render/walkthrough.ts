import { indexScene, renderAt, SnapshotSink } from 'lantern';
import * as v from 'valibot';
import { walkthroughSchema } from '../src/walkthroughs/format.ts';
import { visualRoot } from './visual.ts';
import { walkthroughScene } from './walkthrough-scene.ts';

window.renderVisual = async (source) => {
	const doc = v.parse(walkthroughSchema, JSON.parse(source));
	const Scene = walkthroughScene(doc);
	const index = await indexScene(Scene);
	const root = visualRoot();
	root.replaceChildren();

	for (const [i, step] of index.steps.entries()) {
		const sink = new SnapshotSink({ width: 600, background: '#10141c' });
		await renderAt(Scene, Math.max(step.t0, (step.t1 ?? index.duration) - 0.001), sink);
		const tile = document.createElement('figure');
		tile.dataset.step = step.name;
		// SVG is serialized by the trusted Lantern engine; all model text becomes glyph paths.
		tile.innerHTML = sink.svg;
		const caption = document.createElement('figcaption');
		caption.textContent = `${i + 1}. ${step.name} — ${doc.steps[i]?.caption ?? ''}`;
		tile.append(caption);
		root.append(tile);

		if (caption.scrollHeight > caption.clientHeight)
			throw new Error(`Caption for ${step.name} is too long for the preview. Shorten it.`);
	}
};
