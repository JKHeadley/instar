# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

A new, dark research instrument: the Jev signal-layer shadow. When turned on, every
message reaching the outbound tone gate is also shown to TypeSafe's Jev model with
seven yes/no questions — one for each existing deterministic check for jargon a
user shouldn't see (raw paths, terminal commands, config keys, internal endpoints,
paste-and-run code, environment variables, cron strings and internal ids). Each
answer is compared with what the existing check found and a content-free row is
written to `logs/jev-signal-shadow.jsonl`. It decides nothing, is never waited on,
and never stores message text.

It ships OFF (`intelligence.jevSignalShadow.enabled: false`), and it stays inert
even when enabled unless a future `soakEndsAt` is set and a `typesafe_api_key` is in
the vault. `scripts/jev-shadow-report.mjs` turns the log into per-check agreement
tables. Existing agents receive the dark default block on update.

## What to Tell Your User

Nothing changes for you. This adds a measuring tool I can switch on for a limited
time to test whether a small, cheap model can take over some of the checks I run
on my own messages. It never changes, delays or blocks what I send.

## Summary of New Capabilities

- Dark, time-bounded comparison of Jev against the B1–B7 outbound jargon checks.
- Content-free comparison log plus a per-check confusion-matrix report script.
- Shadow calls metered under feature `jev-signal-shadow` in the LLM metrics.

## Evidence

- Unit `tests/unit/JevSignalShadow.test.ts` (17 passing): question set covers every detector kind; inert when disabled, with no soak window, past it, or without a key; compared and every not-compared reason reachable; no message text in any row or from a vendor error body; synchronous, never-throwing `observe()`; key cached; metering recorded.
- Integration `tests/integration/jev-signal-shadow-gate.test.ts` (6 passing): real gate verdict identical with a disabled shadow; verdict returns while the Jev call hangs; a throwing observer or a network failure cannot break the gate; report script builds deduplicated confusion matrices.
- E2E `tests/e2e/jev-signal-shadow-lifecycle.test.ts` (3 passing): the update path installs the dark default idempotently; the shipped state makes no call and writes no row; flipping the config with no restart produces a compared row.
