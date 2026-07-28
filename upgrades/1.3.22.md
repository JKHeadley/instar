# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Tenth increment of the **Feedback Factory Migration** (Dawn → Echo; spec `docs/specs/feedback-factory-migration.md`, approved). Ports the remaining half of "scar (d)" — the operator-report **lifecycle partitioning with re-report prevention** — from the reference Python (`the-portal/.claude/scripts/feedback-processor.py`, `:2747`) into a pure function at `src/feedback-factory/processor/reportPartition.ts`.

Given the current bug-clusters and what was surfaced in the last operator report, it decides what is actionable now: which issues are newly-open versus already-known, the same for in-progress work, and which bugs were fixed since the last report — announcing each fix exactly once (the re-report guard that stops the digest from repeating itself). It also decides when there's nothing new and the report should be skipped entirely. Pure function; **not wired into any route or job yet** — no behavioral change.

This completes scar (d): the cluster-level cycling was ported earlier (in the state-machine increment); this is the digest-level partitioning + re-report prevention Dawn specifically flagged.

## What to Tell Your User

- The last piece of the feedback "brain" Dawn flagged is now ported — the logic that decides what goes into a status report and, crucially, doesn't re-announce the same fix over and over.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Report partition + re-report guard (TS port) | Internal module `src/feedback-factory/processor/reportPartition.ts` — not yet wired |

## Evidence

- The decision is embedded in a Telegram-rendering function in the reference, so equivalence is by faithful transcription plus both-sides-of-boundary tests (6 unit tests): new vs continuing open/investigating; severity ordering; the re-report guard (a fix updated after the last report and not previously announced is included; one before the last report or already announced is excluded); the first-run 4-hour window; and skip-only-when-nothing-new.
