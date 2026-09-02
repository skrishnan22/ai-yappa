# Separate model working context from canonical history

Slack Agent preserves complete Invocation Snapshots and Conversation Events while presenting the model with a bounded Working Context. Older material may be represented by durable Context Summaries linked to exact source ranges and retrieved on demand, preventing context-window limits from forcing canonical history loss.
