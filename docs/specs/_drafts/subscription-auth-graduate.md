---
kind: spec
id: subscription-auth-graduate
title: Graduate the Subscription Pool to a surfaced capability
status: approved
parent: subscription-auth-standard
date: 2026-06-07
author: echo
parent-principle: "Structure beats Willpower"
parent-principle-fit: "Agent awareness is enforced structurally, not by hoping the agent remembers the feature: the capability is surfaced in CAPABILITY_INDEX (so /capabilities lists it by construction) and the awareness blurb is added to BOTH generateClaudeMd (new agents) AND migrateClaudeMd (existing agents) — the Migration Parity gate's structural requirement. The maturity-honesty bar that kept it INTERNAL was itself a structural guard (a code comment + the lint), and graduating only once the bar is objectively met (P1.3 + P2.1 + P2.2 merged) keeps the honesty structural rather than discretionary."
review-convergence: internal-grounded-2026-06-07
review-convergence-detail: "Internal convergence (single-agent, noted honestly). Grounded against the real INTERNAL_PREFIXES note, which pre-declared the exact graduation criteria ('graduates once P1.3 + P2.1 make it user-usable'); all phases (P1.1 #956, P1.2 #959, P1.3 #963, P2.1 #966, P2.2 #967) are merged/landing. The change is classification + awareness only: CapabilityIndex.test.ts confirms /subscription-pool is claimed by exactly one CAPABILITY_INDEX entry and absent from INTERNAL_PREFIXES; scaffold-templates.test.ts stays green; tsc clean. The only risk-floor signal is that it touches PostUpdateMigrator (fleet-migration surface) — but the migration is the standard idempotent content-sniffed CLAUDE.md append (the same pattern ~30 prior sections use), adds no behavior, and never touches custom sections."
approved: true
approved-by: Justin
approved-via: "Telegram topic 20905 (2026-06-07): 'Approved for all. Please enter a 12 hour autonomous session to finish this out.' — the autonomous task breakdown names the graduate step explicitly ('Graduate the capability … move /subscription-pool … CAPABILITY_INDEX … generateClaudeMd … migrateClaudeMd'). Recorded per the autonomous-directive precedent."
eli16-overview: subscription-auth-graduate.eli16.md
---

# Graduate the Subscription Pool capability

> Tier-2 by risk floor (it touches `PostUpdateMigrator`, the fleet-migration
> surface) — but the actual change adds no behavior: it surfaces an already-shipped,
> already-tested capability and appends a documentation section.

## Goal

Now that every phase of the Subscription & Auth Standard is merged, make the
`/subscription-pool` capability **discoverable + known** instead of dark/internal —
without changing any runtime behavior.

## Why now (the honesty bar)

The `INTERNAL_PREFIXES` entry for `subscription-pool` pre-declared its own
graduation criteria: surface it "once the quota-aware scheduler (P1.3) and mobile
enrollment wizard (P2.1) make it user-usable" — surfacing the bare registry earlier
"would overclaim an unfinished capability (maturity honesty)." P1.3 + P2.1 (+ the
P2.2 dashboard) are merged, so the bar is met.

## What this adds

1. **CapabilityIndex** (`src/server/CapabilityIndex.ts`) — remove `subscription-pool`
   from `INTERNAL_PREFIXES`; add a `subscriptionPool` entry to `CAPABILITY_INDEX`
   whose pure `build()` reports `configured` + account count + poller/scheduler/
   wizard wiring + the full endpoint list.
2. **New-agent awareness** (`generateClaudeMd`) — a "Subscription Pool" blurb
   (multi-account quota + continuity-guaranteed auto-swap + mobile enrollment;
   "never ask the user to paste a token").
3. **Existing-agent awareness** (`migrateClaudeMd`) — the same blurb, appended via
   the standard content-sniffed, idempotent migration (Migration Parity).

## Non-goals / invariants

- **No route, no class, no behavior** — the routes, scheduler, continuity guarantee,
  and enrollment wizard already shipped (P1.1–P2.2).
- **No new authority** — auto-swap of live sessions stays OFF by default.
- **Idempotent migration** — re-running appends nothing; never touches custom
  sections.

## Tests

- `CapabilityIndex.test.ts` — `/subscription-pool` claimed by exactly one entry,
  absent from INTERNAL_PREFIXES (the discoverability invariant).
- `scaffold-templates.test.ts` — generateClaudeMd output stays valid.
- tsc clean. (No new runtime path → no new integration/e2e tier; the underlying
  routes already carry their P1/P2 three-tier coverage.)

## Rollout

Immediate on merge. New agents get the blurb via init; existing agents via the
migration on next update. `/capabilities` gains one block.
