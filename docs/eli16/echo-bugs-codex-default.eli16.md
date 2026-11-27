# Echo Bugs uses Codex for new topics

Echo's issue topics live in a separate Telegram group. Until now they inherited the agent's ordinary conversation default, which is Claude. A topic Echo created could therefore start on Codex and later restart on Claude. Asking the per-topic pin API to repair this was also refused when Justin had not posted in the topic yet. That refusal protects the rule that only a verified operator can make a sticky per-topic choice.

The fix makes issues-group topics resolve to `codex-cli` and `gpt-6.1-sol` by default. An optional `topicProfiles.groupDefaults.issues` config entry can override this policy. The choice is read whenever an issue session starts or restarts, including after Justin posts a message. Main-group conversations and Slack keep their existing defaults. A verified operator's per-topic pin still wins. The group choice is config, not a hidden operator pin, so the operator-binding rule stays intact.

Codex CLI 0.166.0 answered a subscription probe with the new model name. Version 0.156.1 refused that name. On a machine whose CLI is older, missing, or unreadable, the launch picks the already-working `gpt-6-sol` and says why in plain language. The fallback is reflected in the session model record, so a footer does not claim the model that failed to launch. The configuration stays file-owned; the API cannot change it or bypass per-topic pin rules.

A live rollout still needs a recent Codex CLI on each serving machine, followed by a fresh issue-topic restart observed in the session record and footer. The source-level tests cover the group boundary, precedence, and old-CLI fallback.
