import type { Button, KnownBlock } from '@slack/web-api';
import * as v from 'valibot';
import {
	actions,
	blocks,
	button,
	clip,
	context,
	escapeMrkdwn,
	section,
} from '../channels/block-kit.ts';
import type { Automation } from './automation.ts';

export const AUTOMATION_ACTION = {
	pause: 'automation_pause',
	resume: 'automation_resume',
	runNow: 'automation_run_now',
	edit: 'automation_edit',
	delete: 'automation_delete',
} as const;

export type AutomationActionId = (typeof AUTOMATION_ACTION)[keyof typeof AUTOMATION_ACTION];

export const AUTOMATION_MODAL = 'automation_modal';

// Where a button was drawn, so its handler knows what to redraw: a run
// header, the automation's card, or an ephemeral list or DM (reply in text).
export type Surface = 'header' | 'card' | 'list';

const buttonValueSchema = v.pipe(
	v.string(),
	v.parseJson(),
	v.object({ id: v.string(), surface: v.picklist(['header', 'card', 'list']) }),
);

export function buttonValue(id: string, surface: Surface): string {
	return JSON.stringify({ id, surface });
}

export function parseButtonValue(value: string): { id: string; surface: Surface } | undefined {
	const result = v.safeParse(buttonValueSchema, value);

	return result.success ? result.output : undefined;
}

export type Rendered = { text: string; blocks: KnownBlock[] };

type Extra = 'runNow' | 'edit' | 'delete';

const LABELS = {
	pause: 'Pause',
	resume: 'Resume',
	runNow: 'Run now',
	edit: 'Edit',
	delete: 'Delete',
} as const;

// Pause or Resume for the status, then the extras; none once deleted.
export function manageButtons({
	automation,
	surface,
	extras,
}: {
	automation: Automation;
	surface: Surface;
	extras: Extra[];
}): Button[] {
	const { status } = automation;

	if (status === 'deleted') return [];

	const toggle: ('pause' | 'resume')[] =
		status === 'active' ? ['pause'] : status === 'paused' || status === 'blocked' ? ['resume'] : [];

	return [...toggle, ...extras].map((action) =>
		button({
			actionId: AUTOMATION_ACTION[action],
			text: LABELS[action],
			value: buttonValue(automation.id, surface),
			style: action === 'delete' ? 'danger' : undefined,
		}),
	);
}

// What a fire posts: an agent run's top-level header (its ts becomes the
// run's thread), or the reminder itself.
export function runMessage(automation: Automation): Rendered {
	const owner = `<@${automation.ownerUserId}>`;
	const title = escapeMrkdwn(automation.title);
	const buttons = actions(...manageButtons({ automation, surface: 'header', extras: ['edit'] }));

	if (automation.kind === 'reminder') {
		const mention = automation.scope === 'personal' ? `${owner} ` : '';
		const lead = `${mention}⏰ ${escapeMrkdwn(automation.prompt)}`;

		return {
			text: clip(lead, 2900),
			blocks: blocks(section(lead), context(`Reminder · ${title} · by ${owner}`), buttons),
		};
	}

	const lead = `⏰ *${title}* · automation by ${owner}`;

	return { text: clip(lead, 2900), blocks: blocks(section(lead), buttons) };
}

// A DM to the owner about their automation, with Resume when it has stopped.
export function ownerNotice({
	automation,
	message,
}: {
	automation: Automation;
	message: string;
}): Rendered {
	const buttons = actions(...manageButtons({ automation, surface: 'list', extras: [] }));

	return { text: clip(message, 2900), blocks: blocks(section(message), buttons) };
}
