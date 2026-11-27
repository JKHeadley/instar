# Ask-links escalation side-effects review

- Off by default through `toneGate.askLinksEscalation.enabled`. With the flag off, the three routes return 404 before opening storage. With it on, callers still need the normal API authentication and an explicit intent header.
- A confirmed finding requires an existing delivered agent-authored Telegram reply. The caller supplies the semantic confirmation that the reply broke the rule. The first trial supports ask-links only.
- One local SQLite ledger keeps findings distinct by rule, topic and delivered message. Duplicate reports and unconfirmed observations leave the count alone. A draft override is durable and scoped to the rule, topic and exact draft hash. Raw drafts are discarded and saved reasons pass through the normal secret scrubber.
- The draft check checks section and link shape on a caller-classified ask. It does not attempt live link verification. It provides an advisory result through the review tool. No outbound sender is changed.
- The ledger is machine-local. This draft does not aggregate findings across agents or machines. Turning off the setting suspends the routes while retaining the audit record.
