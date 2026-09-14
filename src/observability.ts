export type SlackAdmissionEvent = {
	event_name: 'slack_admission';
	outcome: 'dispatched' | 'deduplicated' | 'refused' | 'dropped' | 'failed';
	conversation_id: string;
	slack_event_id: string;
	signal_type: 'slack.app_mention' | 'slack.message';
	decision: 'dispatch' | 'refuse-invoker' | 'no-repo' | 'drop-untracked' | 'admission-error';
	submission_id?: string;
	agent_uid?: string;
};

/** Emit only bounded, application-owned admission metadata. Never include Slack or model content. */
export function emitSemanticEvent(event: SlackAdmissionEvent): void {
	try {
		console.info({
			schema_version: 1,
			service: 'slack-agent',
			timestamp: new Date().toISOString(),
			...event,
		});
	} catch {
		// Logging is best effort and must not affect the request or agent outcome.
	}
}
