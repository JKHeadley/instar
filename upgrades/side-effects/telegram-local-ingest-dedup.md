# Side-effects review

- The guard lives at the canonical local append seam, so text, voice, photo, document, lifeline-forwarded, and outbound Telegram log calls share one rule.
- Identity includes direction and topic as well as platform message ID, preventing unrelated rows from colliding.
- The dedupe set seeds once from the bounded canonical log, covering process restart without a second state file.
- Persistence happens before the in-memory identity is recorded; a failed append remains retryable.
- Tail-cache versions and downstream TopicMemory and event-bus notifications advance only for the first persisted row.
- Both the legacy writer and shared MessageLogger path return an append verdict and obey the same ordering.
- One-time JSONL seeding adds a bounded read on the first append; it replaces repeated duplicate rows and does not add a per-message scan.
- The E retained-offset redelivery path is covered directly: the poll offset stays unadvanced after rejection while repeated batch ingest still leaves one log row.
