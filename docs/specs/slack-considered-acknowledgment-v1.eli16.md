## ELI16 — Slack considered acknowledgment v1

### What already exists

In an explicitly opted-in Slack channel, Instar can notice a message that was not addressed to it and make one cautious judgment: should it contribute something useful, or remain silent? A single language-model gate makes that judgment. The default is silence, and any uncertainty, model failure, malformed answer, missing provider, exhausted rate limit, or low confidence also means silence. Ordinary channels remain mention-only.

### What v1 changes

This change gives that same gate one additional option. Instead of choosing only “write a reply” or “do nothing,” it chooses exactly one of three actions: speak, add a small acknowledgment reaction, or stay silent. It does not add another model call or a second classifier. The Slack adapter simply carries out the one result.

The reaction is deliberately fixed to the Slack `eyes` reaction. The model cannot invent an emoji, label the message, or call an arbitrary Slack operation. If it chooses the reaction with enough confidence, Instar reacts to the original message and does not start a conversational turn. If it chooses to speak, the existing full-response path runs. If it chooses silence—or anything goes wrong—nothing is sent.

### Why this is narrow

A reaction is a useful middle ground when a full reply would interrupt people but total silence would feel inattentive. The design remains conservative: the channel must already be opted in, the existing rate budget must be available, and the existing confidence floor still applies. Speaking also continues to require a concrete contribution.

The first version does not learn from reactions, collect social feedback, add action-specific dashboards, persist decisions, compare models, choose among emoji, or calibrate behavior. Those are explicitly separate v2 topics. This release only widens one existing closed decision and connects the new result to Slack’s already-available reaction function.

### Safety and rollback

There is still one semantic authority and one decision per eligible message. The adapter does not independently inspect the message or overrule the gate. Unknown or broken outputs become silence. A failed reaction cannot turn into a reply. Directed messages, commands, unauthorized senders, and channels that did not opt in behave as before.

Rollback is a normal code revert. No database, ledger, migration, or user state is introduced, so returning to the old speak-or-silent behavior needs no cleanup.
