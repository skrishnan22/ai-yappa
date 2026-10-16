import { describe, expect, test } from 'vitest';
import { ensureParagraphBreaks } from './slack-text.ts';

describe('ensureParagraphBreaks', () => {
	test('splits one-line prose at sentence boundaries', () => {
		const text =
			'Deploying at 04:00 UTC and completing by 05:30, the rollout has now reached every region. Quiet hours held across all clusters and no alert fired during the window. Monitoring shows the new build with zero regressions so far.';

		expect(ensureParagraphBreaks(text)).toBe(
			'Deploying at 04:00 UTC and completing by 05:30, the rollout has now reached every region.\n\nQuiet hours held across all clusters and no alert fired during the window.\n\nMonitoring shows the new build with zero regressions so far.',
		);
	});

	test('leaves multi-line text untouched', () => {
		const text = 'First line\nsecond line\n\nthird paragraph';
		expect(ensureParagraphBreaks(text)).toBe(text);
	});

	test('does not split on decimals, abbreviations, or single initials', () => {
		const text =
			'The price moved from $5.27 to $6.00, and U.S. markets closed higher after the Fed announcement. J. R. Smith confirmed the numbers on Thursday.';

		expect(ensureParagraphBreaks(text)).toBe(
			'The price moved from $5.27 to $6.00, and U.S. markets closed higher after the Fed announcement.\n\nJ. R. Smith confirmed the numbers on Thursday.',
		);
	});

	test('leaves a single long sentence unchanged', () => {
		const text =
			'The deployment is complete and every region is now serving the new build with no regressions detected during the quiet-hours window so far.';

		expect(ensureParagraphBreaks(text)).toBe(text);
	});

	test('splits before an emoji-started sentence', () => {
		const text =
			'The core services are all healthy and the new version is fully rolled out to production. ✅ We are shipping the release notes to every channel now.';

		expect(ensureParagraphBreaks(text)).toBe(
			'The core services are all healthy and the new version is fully rolled out to production.\n\n✅ We are shipping the release notes to every channel now.',
		);
	});

	test('does not split short fragments', () => {
		const text = 'Ok. Done. That is all.';
		expect(ensureParagraphBreaks(text)).toBe(text);
	});
});
