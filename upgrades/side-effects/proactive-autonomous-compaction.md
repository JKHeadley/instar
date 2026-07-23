# Side effects: proactive autonomous compaction

- Adds an opt-in 60-second monitor only when explicitly enabled.
- Reads each running Claude pane and the existing autonomous-topic registration.
- In dry-run, emits audit logs only.
- In live mode, injects `/compact` only at an affirmatively idle turn boundary.
- Does not operate on Codex, Gemini, interactive/non-autonomous sessions, or indeterminate work states.
- Rollback is immediate via `monitoring.proactiveAutonomousCompaction.enabled:false`.
