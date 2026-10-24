import {
	Arrow,
	CodePanel,
	CurvedArrow,
	FadeIn,
	FadeOut,
	GOLD,
	GREY,
	Indicate,
	Labeled,
	Rectangle,
	Scene,
	TEAL,
	Text,
	UP,
	WHITE,
	type SceneClass,
} from 'lantern';
import type { Walkthrough } from '../src/walkthroughs/format.ts';

export function walkthroughScene(doc: Walkthrough): SceneClass {
	return class extends Scene {
		override async construct(): Promise<void> {
			const title = new Text(doc.title, { fontSize: 0.4, weight: 'bold', color: WHITE });

			if (title.width() > 14) title.scale(14 / title.width());
			title.moveTo([0, 3.7]);
			this.add(title);
			const nodes = new Map<string, Labeled<Rectangle, Text>>();
			const spacing = doc.nodes.length === 4 ? 3.7 : 4;

			for (const [index, node] of doc.nodes.entries()) {
				const label = new Text(node.label, { fontSize: 0.3, color: WHITE });

				if (label.width() > 2.5) label.scale(2.5 / label.width());

				const box = new Labeled(
					new Rectangle({
						width: 3,
						height: 1,
						cornerRadius: 0.15,
						stroke: TEAL,
						fill: TEAL,
						fillOpacity: 0.12,
					}),
					label,
				);

				box.moveTo([(index - (doc.nodes.length - 1) / 2) * spacing, 1.7]);
				nodes.set(node.id, box);
				this.add(box);
			}

			for (const edge of doc.edges) {
				const from = nodes.get(edge.from);
				const to = nodes.get(edge.to);

				if (!from || !to) throw new Error('Unknown edge node');
				const distance = to.center()[0] - from.center()[0];

				const arrow =
					distance > 0 && distance < spacing + 0.01
						? new Arrow(from.shape.right(), to.shape.left(), { stroke: GREY, buff: 0.1 })
						: new CurvedArrow(from.shape.boxPoint(UP), to.shape.boxPoint(UP), {
								stroke: GREY,
								angle: 0.65,
							});

				this.add(arrow);
			}

			let code: CodePanel | undefined;
			let heading: Text | undefined;

			for (const step of doc.steps) {
				await this.step(step.name, { caption: step.caption });
				this.state = { step: step.name, activeNodes: step.activeNodes };

				for (const [id, node] of nodes)
					node.shape.setStyle({ stroke: step.activeNodes.includes(id) ? GOLD : TEAL });

				if (code) await this.play(new FadeOut(code), { runTime: 0.15 });

				if (heading) this.remove(heading);
				heading = new Text(step.name, { fontSize: 0.28, font: 'mono', color: GOLD }).moveTo([
					0, 2.8,
				]);
				this.add(heading);
				code = new CodePanel(step.code, { fontSize: 0.28, at: [0, -1.4] });

				if (code.width() > 14) code.scale(14 / code.width());
				await this.play(new FadeIn(code), { runTime: 0.35 });

				if (step.highlight !== undefined)
					await this.play(code.focus(step.highlight), { runTime: 0.25 });

				for (const id of step.activeNodes) {
					const node = nodes.get(id);

					if (node) await this.play(new Indicate(node.shape, { color: GOLD }), { runTime: 0.4 });
				}

				await this.wait(1);
			}
		}
	};
}
