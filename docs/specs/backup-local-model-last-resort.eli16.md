# A local model as the last resort, in plain English

Your agent thinks by calling an AI provider. If you only have one subscription and that provider goes down or you run out of quota, your agent stops. A second subscription helps, but it's one more outside service, and the goal is that no agent depends on any of them.

This plan is for a small AI model that runs on the agent's own computer. It wouldn't be as capable, so it would only be used when nothing else works. Even then, your agent could still answer you, tell you what's wrong, and do simple work.

Nothing is built yet. This is a placeholder that keeps the work on the list, with Echo as its owner.

The plan still has to decide:

- which model to use, and what to do on computers too small to run one
- how to make sure it never takes over when a real provider is working
- what it isn't trusted to decide, because it's weaker
- how the agent installs it without asking you to do anything

It's finished when someone can switch off every provider, watch the agent keep answering, and the catalog stops listing this as a gap.
