# Post-drive transcript auditor - ELI16

> The one-line version: after a supervised drive, the agent can scan the actual topic transcript for user-experience mistakes and file each finding into the framework issue ledger with stable dedupe keys.

## The problem in one breath

The apprenticeship loop already had rules telling agents to watch the user's experience, but rules written only in prose were easy to miss. The UX-blindspot arc proved that duplicate delivery notices, resend asks, restart chatter, and empty status updates could happen in front of the operator without becoming durable findings. This change turns that duty into a repeatable audit over the transcript itself.

## What already exists

- **Topic message history** already records recent Telegram messages for a topic and exposes them through the local server.
- **The framework issue ledger** already stores issue observations with dedupe keys, severity, evidence pointers, and framework buckets.
- **The operator-seat UX cycle gate** already requires apprenticeship cycle records to say what the operator experienced, but it does not itself scan raw transcripts.

## What this adds

This adds a small command for post-drive audits. Given one or more topic ids and a time window, it reads the topic messages, filters to that window, classifies four UX antipatterns, prints a structured report, and writes each finding to the framework issue ledger. The four classes are duplicate notices or deliveries, asks of the user to resend or retry, internal infrastructure noise, and content-free progress updates.

## The new pieces

- **Transcript classifier** - a pure, deterministic analyzer that looks at message text, sender direction, timestamps, and repeated notice shapes. It produces findings only; it does not block messages or change runtime behavior.
- **Audit runner** - reads message history for each topic, calls the classifier, and files observations through the existing ledger write path. A dry-run mode prints the report without writing.
- **Ledger citation persistence** - the ledger already accepted a related-spec citation, but new issues were not storing it. This change persists that citation so findings can point back to Observation Needs Structure and the UX-blindspot arc instead of losing the reason in chat.

## The safeguards

**Stable dedupe prevents finding floods.** Each ledger key is derived from the topic, time window, category, and message evidence. Re-running the same audit updates the same canonical issue instead of creating a new one.

**The audit is signal-only.** It never prevents a message from being sent, never edits the transcript, and never changes mentor judgment. Its job is to make observations durable so a human or later process can inspect them.

**The classifier avoids expected ACKs.** The first implementation was too eager and treated normal "got it, looking into this" acknowledgements as content-free updates. The final version narrows that category to status chatter such as "actively working" and "still working" patterns, then groups repeated identical notices.

**Evidence stays as a pointer.** Ledger observations use opaque topic/message/window references. The human-readable report may show short excerpts, but the durable ledger evidence does not inline full logs or secrets.

## What ships when

This PR ships the command, tests, and the small ledger fix together. The live fixture from topics 2278 and 2271 for 11:15-11:21 PDT was run once in dry-run mode, then once in filing mode. The command found three findings and filed them through the ledger.

## What you actually need to decide

Approve whether this narrow transcript-auditor slice is the right structural answer for fix B, leaving any future dashboard or mentor-loop automation to a later PR.
