# ELI16 — Solo Codex agents stop spawning into a quota wall

## What Changed

Instar’s global quota brake already protected Claude and Gemini work, and the subscription pool already understood Codex quota. But a Codex agent with only one account had no producer feeding those real Codex windows into the global brake. When that account was exhausted—or when its quota reading disappeared—the agent could keep starting work that could not succeed.

## What to Tell Your User

Solo Codex agents now read the same authoritative five-hour and weekly rollout windows already used by the subscription pool. Healthy headroom allows work normally. A full window stops new jobs and sessions. If the Codex reading is missing, stale, unreadable, or incomplete, the Codex brake fails safe and pauses new work instead of repeatedly spending attempts against an unknown wall.

## Summary of New Capabilities

- Start the existing quota collector for Codex agents instead of skipping every non-Claude framework.
- Convert the existing rollout reader’s primary and secondary windows into the shared quota-state shape with `codex-rollout` provenance.
- Treat Codex rollout data as authoritative at the same load-shed decision layer as provider-native capacity signals.
- Persist explicit uncertainty when a previously healthy reading disappears, preventing stale headroom from silently keeping the gate open.
- Preserve Claude semantics: OAuth remains authoritative, JSONL remains bounded-degraded, and missing Claude data retains its existing behavior.

## Evidence

Focused unit tests cover healthy, exhausted, missing, unreadable, and first-boot Codex states plus explicit Claude regression boundaries. Integration coverage drives collector through QuotaManager into the persisted quota file and proves both wall shedding and healthy-to-unknown fail-safe replacement.
