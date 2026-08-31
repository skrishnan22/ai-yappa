# Use Git as the portable workspace checkpoint

Slack Agent uses provider-managed filesystem persistence for fast resume but not for correctness. Source changes are durably pushed as Code Checkpoints on the Agent Conversation's Working Branch, allowing a replacement Sandbox to clone and rebuild the Execution Workspace even when provider storage expires or resets; provider snapshots remain optional accelerators.
