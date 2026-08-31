# Use Flue channels and defer Chat SDK

V1 uses `@flue/slack` and Slack's official Web API behind an application-owned Channel Adapter boundary. This follows Flue's native admission model and avoids duplicating subscriptions, locks, queues, and history in Chat SDK; future providers such as Google Chat should be added as separate Flue Channel Adapters before reconsidering a universal chat abstraction.
