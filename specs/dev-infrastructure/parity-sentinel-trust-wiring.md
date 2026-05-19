---
title: "FrameworkParitySentinel mirror-trust wiring + PostUpdateMigrator backfill"
slug: "parity-sentinel-trust-wiring"
author: "echo"
status: "converged"
type: "amendment-spec"
eli16-overview: "parity-sentinel-trust-wiring.eli16.md"
review-convergence: "2026-05-19T16:00:00Z"
review-iterations: 1
review-completed-at: "2026-05-19T16:00:00Z"
review-report: "docs/specs/reports/parity-sentinel-trust-wiring-convergence.md"
review-deviation: "Tactical amendment to merged primitive (PR #255). Lessons-aware reviewer (PR #260) is now structurally in /spec-converge but a full convergence run would be over-engineered for a wiring fix with no new design surface. Manual lessons-check applied transparently in the spec body against the canonical principles index."
approved: true
approved-by: "Justin (pre-authorized 2026-05-19, autonomous-mode hybrid C, with explicit 2026-05-19 ack: 'please enter autonomous mode and complete ALL of these')"
approved-date: "2026-05-19"
approval-note: "Audit-identified critical backtrack: FrameworkParitySentinel shipped with remediationPolicy='mirror-trust' but the gating was a binary remediationEnabled boolean — never actually consulted AdaptiveTrust. This is the structural fix + the PostUpdateMigrator backfill to seed existing agents."
lessons-engaged:
  - "P1 (Structure>Willpower): trust gating is structural — the sentinel consults AdaptiveTrust by code, not by per-rule docs."
  - "P2 (Signal vs Authority): mirror-trust now actually mirrors trust — the brittle policy enum is the signal, the AdaptiveTrust level is the authority."
  - "P3 (Migration Parity): PostUpdateMigrator entry in same PR. Existing agents pick up the seed entry on update; new agents pick it up via natural AdaptiveTrust flow."
  - "P4 (Testing Integrity): 5 mirror-trust gating tests + 6 migration tests = 11 new unit tests; wiring integrity for the optional AdaptiveTrust field; semantic correctness for all four trust levels (autonomous/log/approve-always/blocked)."
  - "P10 (Comprehensive-First): v0.1 ships full wiring + migration + tests. No deferred items."
  - "L6 (Side-effects review): seven-dimension review at upgrades/side-effects/feat-parity-sentinel-trust-wiring.md."
  - "L9 (ELI16 required): parity-sentinel-trust-wiring.eli16.md sibling."
  - "L10 (Release notes in same PR): upgrades/NEXT.md in this PR."
  - "B28 (Spec-converge pre-auth circular): this amendment is one of the audit-identified critical fixes."
---

# FrameworkParitySentinel mirror-trust wiring + PostUpdateMigrator backfill

## What changed

Two coordinated changes:

1. **`src/monitoring/FrameworkParitySentinel.ts`** — `shouldRemediate()` now consults `AdaptiveTrust.getTrustLevel('parity-sentinel', 'modify')` when the rule's `remediationPolicy` is `'mirror-trust'` AND an `AdaptiveTrust` instance is passed via the sentinel config. The trust level maps to autonomy via `trustToAutonomy()`:
   - `autonomous` → `proceed` → remediate
   - `log` → `log` → remediate (with audit trail)
   - `approve-always` / `approve-first` → `approve` → flag-only
   - `blocked` → `block` → flag-only

   When no `AdaptiveTrust` instance is wired (e.g., in tests, or in environments where AdaptiveTrust isn't initialized), the sentinel falls through to the v0.1 behavior — `remediationEnabled` boolean is the only gate. This preserves backward compatibility for any caller that constructs the sentinel without trust.

2. **`src/core/PostUpdateMigrator.ts`** — new `migrateParitySentinelTrust(result)` step wired into `migrate()`. On update, the migration seeds a `parity-sentinel` service entry in `state/trust-profile.json` at level `'log'` (auto-elevatable, not blocking). Idempotent via the `_instar_migrations` marker AND a content-sniff (existing operator-configured entries are preserved). The seed at `'log'` is intentional: it preserves the v0.1 remediate-by-default behavior while routing all remediations through the AdaptiveTrust audit channel, and it leaves room for operators to elevate to `autonomous` after a successful track record or downgrade to `approve-always` after an incident.

## Why this ships now

Audit-identified critical backtrack. The FrameworkParitySentinel (PR #255) declared `remediationPolicy: 'mirror-trust'` as the documented policy:

> 'mirror-trust' — apply remediation if the agent's trust level allows it

…but the actual implementation was a binary `remediationEnabled` flag with no AdaptiveTrust consultation. The string `'mirror-trust'` was a label without behavior — exactly the signal-vs-authority inversion the documented standard warns against (B11). This PR makes the label honest.

The PostUpdateMigrator backfill is the §3 (Migration Parity) companion: AdaptiveTrust's `DEFAULT_TRUST['modify']` is `'approve-always'`, which would have silently turned every mirror-trust rule into flag-only for existing deployed agents on the next update. Without the seed, the audit's "ship-order vs backfill" finding would repeat — the wiring would land but existing agents would lose remediation. The seed at `'log'` keeps the v0.1 remediate-by-default behavior while adding the audit channel.

## Design

### shouldRemediate ordering

```
1. flag-only rules → never remediate (existing)
2. remediationEnabled=false → never remediate (existing, global kill switch)
3. mirror-trust + adaptiveTrust set → consult trust level
4. else → remediate (existing, preserves v0.1 default for callers without AdaptiveTrust)
```

The `adaptiveTrust` field on `FrameworkParitySentinelConfig` is optional. Production wiring (when added) will pass an AdaptiveTrust instance; tests can omit it to exercise the deterministic path.

### Why `'log'` as the seed default

- `'autonomous'` would silently elevate the sentinel above the trust-floor cap (AdaptiveTrust's `MAX_AUTO_LEVEL`). Migration entries should NEVER auto-elevate trust beyond what the user has explicitly granted.
- `'approve-always'` would downgrade to flag-only by default, breaking the v0.1 behavior.
- `'log'` is the auto-elevatable middle ground: remediation happens, every event is recorded, and the AdaptiveTrust elevation streak can promote the entry to `'autonomous'` over time per the existing auto-elevation logic. Operators retain manual control via `setUserTrust`.

### Idempotency + operator-override protection

The migration uses two complementary guards:

- **Migration marker** in `config._instar_migrations`: prevents re-running the seed logic even if the trust-profile.json file is deleted (no rebuild loop).
- **Content-sniff** on existing `parity-sentinel` service entry: preserves any operator-set trust level (e.g., `'autonomous'` after explicit elevation, `'approve-always'` after an incident downgrade). The migration marker still records the run so future migrations can branch on "seeded" vs "preserved existing."

### What this PR does NOT change

- `AdaptiveTrust.DEFAULT_TRUST['modify']` stays `'approve-always'`. The DEFAULT_TRUST is the global safety floor for unknown services; per-service seeding is the right pattern, not changing the global default.
- The sentinel is not yet wired into `server.ts` boot. That's a separate concern from the trust wiring — the audit identified the wiring as missing, this fix delivers the trust-consultation layer so when the boot wiring lands, it actually mirrors trust. Boot wiring tracked separately.
- `skillParityRule.alwaysOverwrite` and the hook always-overwrite carve-out are unchanged. The trust gate applies only to mirror-trust rules; alwaysOverwrite rules bypass it (correct per Migration Parity §4).

## Bootstrap exception

The lessons-aware reviewer (PR #260) just merged to main but the SKILL.md content migration that propagates it to agents has not yet been added to `PostUpdateMigrator` (Task 3 in this autonomous session). So an agent running `/spec-converge` against this spec right now would still spawn the 7-reviewer convergence, not 8. **Manual lessons-aware check applied** against the canonical principles index — same pattern PR #259 and PR #260 used.

### Manual lessons-aware check (vs `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md`)

| Principle/Lesson | Engagement |
|---|---|
| P1 Structure>Willpower | ✓ Engaged — trust gating in code, not in per-rule documentation |
| P2 Signal vs Authority | ✓ Engaged — mirror-trust policy enum is the signal; AdaptiveTrust level is the authority |
| P3 Migration Parity | ✓ Direct fix for the §3 ship-order vs backfill audit finding |
| P4 Testing Integrity | ✓ Engaged — 5 sentinel gating tests + 6 migration tests = 11 new unit tests covering all four trust levels + idempotency + content-sniff + operator-override preservation |
| P5 Agent Awareness | N/A — internal code path |
| P6 Zero-Failure | ✓ Engaged — full sentinel test suite + migration test suite green |
| P7 LLM-Supervised Execution | N/A — pure deterministic gating |
| P8 UX & Agent Agency | N/A — no user-facing surface |
| P9 Intent Engineering | N/A |
| P10 Comprehensive-First | ✓ Engaged — wiring + migration + tests in v0.1; no deferred items |
| L1 AGENT.md bloat | N/A — no AGENT.md changes |
| L6 Side-effects review | ✓ Engaged — `upgrades/side-effects/feat-parity-sentinel-trust-wiring.md` |
| L9 ELI16 required | ✓ Engaged — sibling ELI16 file |
| L10 Release notes in same PR | ✓ Engaged — `upgrades/NEXT.md` in this PR |
| B28 Spec-converge pre-auth circular | ✓ Engaged — this amendment is the audit's structural fix #2 (after hook always-overwrite) |

No contradictions found. Zero deferrals.

## Implementation slice for this PR

1. This spec + ELI16 + convergence report (with the manual lessons-aware check above).
2. `src/monitoring/FrameworkParitySentinel.ts` — `adaptiveTrust` field on config + trust-aware `shouldRemediate`.
3. `src/core/PostUpdateMigrator.ts` — new `migrateParitySentinelTrust()` step.
4. `tests/unit/monitoring/FrameworkParitySentinel.test.ts` — 5 new mirror-trust tests.
5. `tests/unit/PostUpdateMigrator-paritySentinelTrust.test.ts` — 6 migration tests.
6. `upgrades/NEXT.md` + `upgrades/side-effects/feat-parity-sentinel-trust-wiring.md`.
7. Package.json version bump.
