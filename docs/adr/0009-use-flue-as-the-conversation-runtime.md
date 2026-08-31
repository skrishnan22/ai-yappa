# Use Flue as the conversation runtime

Slack Agent maps each Slack thread to one Flue conversation and relies on Flue's Cloudflare runtime for its Durable Object, canonical stream, Submission Queue, alarm-driven execution, terminal outcomes, and recovery. Application code owns Slack policy, presentation, workspace fingerprints, and the remote Sandbox adapter rather than duplicating Flue's orchestration or persistence machinery.
