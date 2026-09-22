import {
	extend,
	getCloudflareContext,
	getDurableObjectIdentity,
	type ExtensionClass,
} from '@flue/runtime/cloudflare';
import {
	hasPendingRunCardDelivery,
	registerRunCardRetryScheduler,
	registerRunCardSql,
	runScheduledRunCardRetry,
} from '../channels/run-card-delivery.ts';

const RETRY_SECONDS = 30;

export const cloudflare = extend({
	base: (Base) => {
		const AgentBase: ExtensionClass = Base;
		return class extends AgentBase {
			async onStart() {
				const instanceId = register(async () => {
					await this.schedule(RETRY_SECONDS, 'retryRunCards', 'retry', {
						idempotent: true,
					});
				});
				if (!hasPendingRunCardDelivery(instanceId)) return;
				await this.schedule(RETRY_SECONDS, 'retryRunCards', 'retry', {
					idempotent: true,
				});
			}

			async retryRunCards() {
				const instanceId = register(async () => {
					await this.schedule(RETRY_SECONDS, 'retryRunCards', 'retry', {
						idempotent: true,
					});
				});
				const token = getCloudflareContext().env.SLACK_BOT_TOKEN;
				await runScheduledRunCardRetry(
					instanceId,
					typeof token === 'string' ? token : undefined,
					async () => {
						await this.schedule(RETRY_SECONDS, 'retryRunCards', 'retry', {
							idempotent: false,
						});
					},
				);
			}
		};
	},
});

function register(schedule: () => Promise<void>): string {
	const instanceId = getDurableObjectIdentity().name;
	registerRunCardSql(instanceId, getCloudflareContext().storage.sql);
	registerRunCardRetryScheduler(instanceId, schedule);
	return instanceId;
}
