import { DomSink, indexScene, renderAt, SnapshotSink, type SceneIndex } from 'lantern';
import * as v from 'valibot';
import { sourceUrl, walkthroughSchema } from '../src/walkthroughs/format.ts';
import { walkthroughScene } from './walkthrough-scene.ts';

function element<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	text = '',
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	node.textContent = text;

	return node;
}

class Interrupted extends Error {}

async function mount(): Promise<void> {
	const root = document.getElementById('walkthrough');
	const data = document.getElementById('walkthrough-data');

	if (!root || !data) throw new Error('Missing walkthrough data');
	const doc = v.parse(walkthroughSchema, JSON.parse(data.textContent ?? ''));
	const Scene = walkthroughScene(doc);
	const index: SceneIndex = await indexScene(Scene);
	const stage = element('div');
	stage.className = 'stage';
	stage.setAttribute('role', 'img');
	stage.setAttribute('aria-label', doc.title);
	const caption = element('p');
	caption.className = 'caption';
	caption.setAttribute('aria-live', 'polite');
	const source = element('a');
	source.className = 'source';
	source.target = '_blank';
	source.rel = 'noreferrer';

	const provenance = element(
		'p',
		`${doc.repository} · ${doc.baseSha.slice(0, 7)} → ${doc.headSha.slice(0, 7)}`,
	);

	provenance.className = 'provenance';
	const previous = element('button', '← Previous');
	const play = element('button', 'Play');
	const next = element('button', 'Next →');
	const controls = element('div');
	controls.className = 'controls';
	controls.append(previous, play, next);
	const steps = element('nav');
	steps.className = 'steps';
	steps.setAttribute('aria-label', 'Walkthrough steps');

	const buttons = doc.steps.map((step, i) => {
		const button = element('button', `${i + 1}. ${step.name}`);
		button.addEventListener('click', () => {
			void select(i).catch(showError);
		});
		steps.append(button);

		return button;
	});

	const disclaimer = element(
		'p',
		'Authored explanation of the source change, not a live execution or test result. Links are unlisted and viewable by anyone who has the URL.',
	);

	disclaimer.className = 'disclaimer';
	root.replaceChildren(
		element('h1', doc.title),
		provenance,
		stage,
		caption,
		source,
		controls,
		steps,
		disclaimer,
	);
	let generation = 0;
	let current = 0;
	let time = 0;
	let playing = false;

	function update(i: number): void {
		current = i;
		const step = doc.steps[i];

		if (!step) return;
		caption.textContent = step.caption;
		source.textContent = step.source ? `${step.source.path}:${step.source.line} ↗` : '';

		if (step.source) source.href = sourceUrl({ ...doc, source: step.source });
		else source.removeAttribute('href');
		buttons.forEach((button, j) => button.setAttribute('aria-current', i === j ? 'step' : 'false'));
		previous.disabled = i === 0;
		next.disabled = i === doc.steps.length - 1;
		const url = new URL(location.href);
		url.searchParams.set('step', step.name);
		history.replaceState(null, '', url);
	}

	async function select(i: number): Promise<void> {
		const mark = index.steps[i];

		if (!mark) return;
		const run = ++generation;
		playing = false;
		play.textContent = 'Play';
		const sink = new SnapshotSink({ width: 1280, background: '#10141c' });
		await renderAt(Scene, Math.max(mark.t0, (mark.t1 ?? index.duration) - 0.001), sink);

		if (run !== generation) return;
		// Trusted Lantern serialization turns model text into glyph paths, never HTML.
		stage.innerHTML = sink.svg;
		time = mark.t0;
		update(i);
	}

	async function animate(): Promise<void> {
		const run = ++generation;
		playing = true;
		play.textContent = 'Pause';
		stage.replaceChildren();
		const dom = new DomSink(stage, { background: '#10141c' });

		const playback = new Scene(
			{
				async frame(scene, dt) {
					if (run !== generation) throw new Interrupted();

					if (scene.time + 1e-9 < time) return;
					time = scene.time;
					await dom.frame(scene, dt);
				},
				async stepBegin(_scene, step) {
					if (run !== generation) throw new Interrupted();
					const i = doc.steps.findIndex((item) => item.name === step.name);

					if (i >= 0) update(i);
				},
			},
			{ skipUntil: time, fps: 30 },
		);

		try {
			await playback.run();
		} catch (error) {
			if (!(error instanceof Interrupted)) throw error;
		}

		if (run === generation) {
			playing = false;
			play.textContent = 'Replay';
			time = 0;
		}
	}

	previous.addEventListener('click', () => {
		void select(current - 1).catch(showError);
	});
	next.addEventListener('click', () => {
		void select(current + 1).catch(showError);
	});
	play.addEventListener('click', () => {
		if (playing) {
			generation++;
			playing = false;
			play.textContent = 'Play';
		} else void animate().catch(showError);
	});
	document.addEventListener('keydown', (event) => {
		if (event.target instanceof HTMLButtonElement || event.target instanceof HTMLAnchorElement)
			return;

		if (event.key === 'ArrowLeft') previous.click();

		if (event.key === 'ArrowRight') next.click();

		if (event.key === ' ') {
			event.preventDefault();
			play.click();
		}
	});

	const linked = doc.steps.findIndex(
		(step) => step.name === new URLSearchParams(location.search).get('step'),
	);

	await select(linked < 0 ? 0 : linked);
}

function showError(error: Error): void {
	const root = document.getElementById('walkthrough');

	if (root) {
		const message = element('p', `Walkthrough unavailable: ${error.message}`);
		message.className = 'error';
		message.setAttribute('role', 'alert');
		root.append(message);
	}
}

void mount().catch(showError);
