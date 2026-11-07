<!-- bump: patch -->

## What Changed

Serious agent-failure callouts now become evidence-backed investigation cases, separate from routine preferences. The shared correction ledger retains scrubbed failing replies, instructions, decisions, severity, diagnosis, class repair and verification receipts. Cases reopen on recurrence and cannot be verified without complete evidence, a repair reference and passing repeat/allowed-case checks.

The investigator reserves durable attempts before starting, backs off, and pauses after three attempts on unchanged evidence. Cases remain open during that pause. Evidence and immutable history replicate through the existing authenticated journal, with current origin-routed writes and clearly stale read-only copies when a holder is unavailable. Ordinary preference learning remains opt-in; failure capture is default-on with an explicit opt-out.

## What to Tell Your User

When you point out a serious failure, your agent records what happened and investigates whether a rule is missing or an existing rule was not followed. It keeps the case open until it has evidence that the repair prevents a repeat. If an investigation gets stuck, it tells you and stops repeating the same attempt indefinitely.

## Summary of New Capabilities

Shared failure investigations with rich scrubbed evidence, severity, constitution-versus-enforcement diagnosis, durable history, repeat-prevention receipts, cross-machine continuity and bounded automatic attempts.

## Evidence

Unit, authenticated HTTP, and production AgentServer lifecycle tests cover the three reported incident classes, default activation without preference promotion, opt-outs, early diagnosis, closure refusal, recurrence, archive retention, reservation/backoff, replica integrity, sender identity, dropped origins, offline reads and update parity. Real model replay was attempted separately and returned unavailable capacity; no semantic-gate or deployed real-world outcome is claimed by that diagnostic.
