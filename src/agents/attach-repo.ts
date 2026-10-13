import { defineTool, type ToolDefinition } from '@flue/runtime';
import levenshtein from 'damerau-levenshtein';
import * as v from 'valibot';
import { canonicalRepo } from '../proxy/policy.ts';

/**
 * The GitHub App installation, as `attach_repo` sees it. `find` is the exact
 * check on every call; `list` runs only on a miss, to suggest names.
 */
export type RepoDirectory = {
	find(repo: string): Promise<string | undefined>;
	list(): Promise<string[]>;
};

const MAX_SUGGESTIONS = 5;

function repoName(fullName: string): string {
	return fullName.split('/')[1] ?? fullName;
}

// A suggestion must be within a third of the requested name's length (at least
// two edits), so a typo finds its repo and an unrelated request finds none.
function suggestionLimit(wanted: string): number {
	return Math.max(2, Math.floor(repoName(wanted).length / 3));
}

function closestRepos(wanted: string, names: string[]): string[] {
	const limit = suggestionLimit(wanted);

	return names
		.flatMap((candidate) => {
			const lower = candidate.toLowerCase();

			// Whole name for a typo; repo name alone for the right repo under another owner.
			const steps = Math.min(
				levenshtein(wanted, lower).steps,
				levenshtein(repoName(wanted), repoName(lower)).steps,
			);

			return steps <= limit ? [{ candidate, steps }] : [];
		})
		.toSorted((a, b) => a.steps - b.steps || a.candidate.localeCompare(b.candidate))
		.slice(0, MAX_SUGGESTIONS)
		.map(({ candidate }) => candidate);
}

function refusal(wanted: string, names: string[]): string {
	if (names.length === 0) {
		return `The GitHub App cannot access ${wanted}, and it is installed on no repositories.`;
	}

	const closest = closestRepos(wanted, names);

	if (closest.length === 0) {
		return `The GitHub App cannot access ${wanted}, and no repository it can access has a similar name.`;
	}

	return `The GitHub App cannot access ${wanted}. Closest it can access: ${closest.join(', ')}.`;
}

/**
 * The one repository a conversation works on. Code checks it against the
 * GitHub App installation; the model only names it.
 */
export function attachRepoTool(args: {
	directory: RepoDirectory;
	attach: (repoUrl: string) => void;
}): ToolDefinition {
	return defineTool({
		name: 'attach_repo',
		description:
			'Attach the GitHub repository this conversation works on, as owner/name or a github.com URL. Call it before any code or GitHub work. A thread has one repository and cannot change it. If the repository is ambiguous, ask the user instead of guessing.',
		input: v.object({ repo: v.pipe(v.string(), v.minLength(1)) }),
		async run({ data }) {
			const wanted = canonicalRepo(data.repo).toLowerCase();
			const match = await args.directory.find(wanted);

			if (!match) {
				const names = await args.directory.list();
				throw new Error(refusal(wanted, names));
			}

			const repoUrl = `https://github.com/${match}.git`;
			args.attach(repoUrl);

			return {
				output: {
					attached: repoUrl,
					note: 'The workspace for this repository attaches before your next step.',
				},
			};
		},
	});
}
