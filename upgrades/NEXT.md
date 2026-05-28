# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

`ReleaseReadinessSentinel.failLoud()` evaluator-self-failures (fetch / analyzer / top-level tick stages) are HOUSEKEEPING by default — they write to `logs/sentinel-events.jsonl` + `server.log` but no longer post a per-stage Attention item / Telegram topic. The user-actionable "Release blocked — unreleased work piling up" signal is unaffected (it always posts).

Origin: dogfood feedback on Echo (2026-05-27) — the pre-fix sentinel created a new Telegram topic each time its own fetch or analyzer broke ("Release-readiness check could not evaluate"). That violated the sentinel-trio standard codified after the 2026-05-22 topic-spam flood — internal-plumbing failures belong in logs, not on the user's Telegram surface, especially when the body ("analyze-release returned no report") gives the user nothing actionable.

The new behaviour matches `monitoring.sentinelTelegramEscalation`: housekeeping default, opt-in via `monitoring.releaseReadiness.escalateEvalFailures` for callers who do want catastrophic-failure escalation surfaced in chat.

A PostUpdateMigrator step (`migrateRetireStaleReleaseReadinessEvalFailureAttention`) strips stale `release-readiness-eval-failure-*` items from existing agents' `attention-items.json` on update so closed-but-tracked topics don't keep haunting the topic list.

## What to Tell Your User

- The "Release-readiness check could not evaluate" topics that kept popping up on every fetch or analyzer hiccup are gone. Those signals were internal plumbing failures masquerading as user-actionable items; they now route to my audit log + server log instead, matching how my session-silence sentinels already work. You'll only see a real Attention item when the watchdog detects something you can act on — finished work piling up unreleased — not when the watchdog itself stumbles.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Quiet release-readiness watchdog by default | Nothing — existing config carries over. The watchdog still audits every tick to `logs/sentinel-events.jsonl`; the user-facing "release blocked" Attention path is unchanged. |
| Opt-in eval-failure escalation | Set `monitoring.releaseReadiness.escalateEvalFailures: true` in `.instar/config.json` if you want catastrophic watchdog failures (fetch / analyzer / tick stages) to surface as a low-priority Attention item again. |
| Stale eval-failure attention auto-retire | Migration runs on update — no manual cleanup needed. Stale `release-readiness-eval-failure-*` entries are dropped from `.instar/state/attention-items.json` idempotently. |

## Evidence

- 6 unit tests cover the new fail-loud behaviour (housekeeping default vs `escalateEvalFailures: true`, audit-always invariant, and the regression guard that the legitimate "release blocked" signal still posts under default config).
- 7 unit tests cover `migrateRetireStaleReleaseReadinessEvalFailureAttention` (absent file, empty array, no-match no-op, selective drop, idempotency, malformed-entry tolerance, unparseable JSON).
- Side-effects: `upgrades/side-effects/release-readiness-housekeeping-default.md`.
