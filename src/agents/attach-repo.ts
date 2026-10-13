import { defineTool, type ToolDefinition } from '@flue/runtime';
import levenshtein from 'damerau-levenshtein';
import * as v from 'valibot';
import { canonicalRepo } from '../proxy/policy.ts';

export type RepoDirectory = { list(): Promise<string[]> };

const DIRECTORY_TTL_MS = 5 * 60 * 1000;

const MAX_SUGGESTIONS = 5;

/** Per-isolate cache of the installation's repositories. A failed lookup is retried next call. */
export function cachedRepoDirectory(
	list: () => Promise<string[]>,
	now: () => number = Date.now,
): RepoDirectory {
	let cached: { names: string[]; at: number } | undefined;

	return {
		async list() {
			if (cached && now() - cached.at < DIRECTORY_TTL_MS) return cached.names;

			const names = await list();
			cached = { names, at: now() };

			return names;
		},
	};
}

function repoName(fullName: string): string {
	return fullName.split('/')[1] ?? fullName;
}

function closestRepos(wanted: string, names: string[]): string[] {
	return names
		.map((candidate) => {
			const lower = candidate.toLowerCase();

			return {
				candidate,
				steps: Math.min(
					levenshtein(wanted, lower).steps,
					levenshtein(repoName(wanted), repoName(lower)).steps,
				),
			};
		})
		.toSorted((a, b) => a.steps - b.steps || a.candidate.localeCompare(b.candidate))
		.slice(0, MAX_SUGGESTIONS)
		.map(({ candidate }) => candidate);
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
			const names = await args.directory.list();
			const match = names.find((name) => name.toLowerCase() === wanted);

			if (!match) {
				const closest = closestRepos(wanted, names);

				throw new Error(
					closest.length > 0
						? `The GitHub App cannot access ${wanted}. Closest it can access: ${closest.join(', ')}.`
						: `The GitHub App cannot access ${wanted}, and it is installed on no repositories.`,
				);
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
