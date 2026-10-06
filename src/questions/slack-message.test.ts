import * as v from 'valibot';
import { expect, test } from 'vitest';
import { renderQuestionMessage } from './slack-message.ts';
import type { OpenQuestion, Vote } from './store.ts';

test('large vote lists retain complete tallies and bounded plain-text voter detail', () => {
	const question: OpenQuestion = {
		id: 'q1',
		conversationId: 'conversation',
		channelId: 'C1',
		threadTs: '1.2',
		title: '<!channel>',
		recommendation: 'Use D1.',
		createdAt: '2026-10-04T00:00:00.000Z',
		status: 'open',
		kind: 'choice',
		choices: [
			{ id: 'A', label: 'KV' },
			{ id: 'B', label: 'D1' },
		],
	};

	const votes: Vote[] = Array.from({ length: 25 }, (_, index) => ({
		questionId: 'q1',
		userId: `U${index}`,
		userName: `<!here>${'x'.repeat(73)}`,
		choiceId: index < 21 ? 'B' : 'A',
		updatedAt: question.createdAt,
	}));

	const message = renderQuestionMessage(question, votes);
	expect(message.text).toContain('Votes: A: 4 · B: 21');
	expect(message.text).toContain('+5 more voters');
	expect(message.text).not.toContain('<!');

	const footer = v.parse(
		v.object({ elements: v.array(v.object({ type: v.literal('plain_text'), text: v.string() })) }),
		message.blocks.find((block) => block.type === 'context'),
	);

	for (const element of footer.elements) {
		expect(element.text.length).toBeLessThanOrEqual(2000);
	}
});
