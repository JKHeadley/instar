---
title: "hookParityRule alwaysOverwrite — amendment per Migration Parity §4"
slug: "hook-always-overwrite"
author: "echo"
status: "converged"
type: "amendment-spec"
eli16-overview: "hook-always-overwrite.eli16.md"
review-convergence: "2026-05-19T05:30:00Z"
review-iterations: 1
review-completed-at: "2026-05-19T05:30:00Z"
review-report: "docs/specs/reports/hook-always-overwrite-convergence.md"
review-deviation: "Tactical amendment to merged primitive (PR #253). Lessons-aware reviewer (PR #258) just merged and is not yet rolled out to deployed agents — manual lessons-check applied transparently in spec body against the canonical principles index."
approved: true
approved-by: "Justin (pre-authorized 2026-05-18, autonomous-mode hybrid C, with explicit 2026-05-19 acknowledgment + audit-driven amendment scope)"
approved-date: "2026-05-19"
approval-note: "Audit-identified critical backtrack: hookParityRule shipped refuse-on-user-edit-conflict for canonical (built-in) hooks, contradicting Migration Parity §4 (built-in hooks always overwritten on every migration run — never install-if-missing). This is the structural fix."
lessons-engaged:
  - "P1 (Structure>Willpower): contract change at the ParityRule interface enforces alwaysOverwrite structurally; not a per-rule docs request."
  - "P2 (Signal vs Authority): user-edit-conflict remains a signal (verify() emits it; sentinel emits parity:user-edit-overwritten for audit); refuse-to-write authority is removed for canonical hooks."
  - "P3 (Migration Parity §4): direct fix — built-in hooks always overwritten per the documented policy."
  - "P4 (Testing Integrity): tier-1 unit tests updated; remediate-always-overwrites test added; sentinel test added for new event; existing test inverted."
  - "P10 (Comprehensive-First): full fix in v0.1 (interface change + rule change + sentinel change + tests). No deferred recurrence-risk."
  - "L1 (AGENT.md bloat): N/A — no AGENT.md changes."
  - "L6 (Side-effects review): seven-dimension review at upgrades/side-effects/fix-hook-stamp-migration-parity.md."
  - "L9 (ELI16 required): hook-always-overwrite.eli16.md sibling."
  - "L10 (Release notes in same PR): upgrades/NEXT.md in this PR."
  - "B28 (Spec-converge pre-auth circular): this amendment is the second case caught by the audit — first was the Conversational-action AGENT.md inlining."
---

# hookParityRule alwaysOverwrite — amendment per Migration Parity §4

## What changed

`src/providers/parity/rules/hookParityRule.ts` `remediate()` previously threw `CanonicalHookError` when the rendered hook had a `user-edit-conflict` (stamp matches canonical hash, but body differs — user edited the rendering). That refuse-on-conflict for built-in hooks contradicts Migration Parity §4:

> **Built-in hooks (`instar/` directory) are always overwritten on every migration run — never install-if-missing.** This ensures agents can't get stuck on broken templates (lesson from `hook-event-reporter.js`: it was install-if-missing, so agents with ESM hosts got stuck on a broken CJS `require('http')` — fixed by switching to always-overwrite). Custom hooks (`custom/` directory) are never touched.

The fix:

1. **`src/providers/parity/types.ts`** — added optional `alwaysOverwrite?: boolean` field to the `ParityRule` interface. Updated `remediate()` contract docstring: "Throws if the current rendering has a `user-edit-conflict` AND the rule is not marked `alwaysOverwrite: true`."
2. **`src/providers/parity/rules/hookParityRule.ts`** — set `alwaysOverwrite: true` on `hookParityRule`; removed the refuse-on-conflict throw in `remediate()`. The `verify()` behavior is unchanged — it still flags `user-edit-conflict` as a mismatch (the signal).
3. **`src/monitoring/FrameworkParitySentinel.ts`** — when verifying a rule with `alwaysOverwrite: true`, a `user-edit-conflict` mismatch is treated as drift (remediation proceeds), and the sentinel emits a new `parity:user-edit-overwritten` event for audit. Operators can recover any clobbered user edit via git.
4. **Tests** — `tests/unit/providers/parity/hookParityRule.test.ts`: inverted the prior "remediate refuses on user-edit-conflict" test into "remediate ALWAYS OVERWRITES user-edits per Migration Parity §4" + added "advertises `alwaysOverwrite=true`". `tests/unit/monitoring/FrameworkParitySentinel.test.ts`: added "alwaysOverwrite=true rule REMEDIATES through user-edit-conflict and emits parity:user-edit-overwritten".

## Why this ships now

Audit-identified critical backtrack. The Hook primitive (PR #253) shipped with a stamp-and-refuse-on-conflict pattern that resurrects exactly the "install-if-missing wedge" Migration Parity §4 was written to prevent.

The recurrence path: in PR #253's convergence, the author wrote both the spec and ran the convergence with internal reviewers focused on security/scalability/adversarial/integration — none of them carried the brief "does this contradict a documented Migration Parity rule." The lessons-aware reviewer (PR #258, just merged) is the structural fix going forward; this amendment is the corrective for the case already shipped.

The skillParityRule keeps refuse-on-conflict because Migration Parity §5 explicitly carves out skills: `installBuiltinSkills()` is non-destructive, and dedicated `PostUpdateMigrator` migrations are the path for skill content updates. So the `alwaysOverwrite` field is opt-in, not the new default.

## Design

### Per-rule policy

The cleanest separation is at the rule level. Each `ParityRule` declares whether it follows §4 (always overwrite) or §5 (refuse on conflict, dedicated migration overrides). The `ParityRule.alwaysOverwrite` field expresses this.

- `hookParityRule.alwaysOverwrite = true` — canonical built-in hooks, §4 applies
- `skillParityRule.alwaysOverwrite = undefined` (defaults to false) — §5 applies
- Future canonical-built-in primitives (e.g., agent/tool/memory if they enter §4 territory) can opt in per their applicable policy

### Sentinel routing

The sentinel uses `rule.alwaysOverwrite` to decide whether `user-edit-conflict` blocks remediation:

```ts
const conflictBlocksRemediation = hasConflict && !rule.alwaysOverwrite;
result = conflictBlocksRemediation ? 'conflict' : 'drift';
```

When `alwaysOverwrite=true` AND the mismatch is user-edit-conflict, the sentinel emits `parity:user-edit-overwritten` (audit signal) in addition to the standard `parity:gap-found`. This gives operators a paper trail for any clobbered user edit.

### Signal vs Authority

`user-edit-conflict` is preserved as a *signal* (the brittle stamp comparison detects user edits). The blocking *authority* (refuse to remediate) is removed for `alwaysOverwrite` rules — Migration Parity §4 is the higher-context policy that says "overwrite anyway, log it for recovery." This matches the signal-vs-authority pattern (B11) exactly: the detector emits, the higher policy decides.

### Migration

No `PostUpdateMigrator` entry needed for this change. The parity rule and sentinel are pure code paths used by Instar internally; they don't write per-agent state files that need backfilling. The contract change (`alwaysOverwrite` field) is additive and optional, so existing rules and tests don't need to be touched (only `hookParityRule` opts in).

The behavioral change for deployed agents: on the next `instar update` + parity scan, any user-edited canonical hook gets overwritten and audit-logged. This is the intended Migration Parity §4 behavior — agents stuck on broken templates get unstuck.

## Bootstrap exception

The lessons-aware reviewer (PR #258) just merged. Built-in skill content updates require a `PostUpdateMigrator` migration to propagate (Migration Parity §5 for skills), so deployed agents will only run the new reviewer after `instar update`. This amendment was drafted in the gap. **Manual lessons-aware check applied** below — same bootstrap pattern the lessons-aware reviewer itself used (PR #258).

### Manual lessons-aware check (vs `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md`)

| Principle/Lesson | Engagement |
|---|---|
| P1 Structure>Willpower | ✓ Engaged — the `alwaysOverwrite` field is structural, not a per-rule docs request |
| P2 Signal vs Authority | ✓ Engaged — user-edit-conflict remains a signal; refuse-to-write authority removed for canonical hooks |
| P3 Migration Parity §4 | ✓ Direct fix — built-in hooks always overwritten per the documented policy |
| P4 Testing Integrity | ✓ Engaged — unit tests inverted to assert always-overwrite; sentinel test added for new event |
| P5 Agent Awareness | N/A — internal code path; no agent-facing surface |
| P6 Zero-Failure | ✓ Engaged — full unit suite runs green after change |
| P7 LLM-Supervised Execution | N/A — pure deterministic code path |
| P8 UX & Agent Agency | N/A — no user-facing surface |
| P9 Intent Engineering | N/A |
| P10 Comprehensive-First | ✓ Engaged — full fix in v0.1, no deferred follow-ups |
| L1 AGENT.md bloat | N/A — no AGENT.md changes |
| L4 External cross-model review | Skipped (tactical amendment); lessons-check is the structural compensation |
| L6 Side-effects review | ✓ Engaged — `upgrades/side-effects/fix-hook-stamp-migration-parity.md` |
| L9 ELI16 required | ✓ Engaged — `hook-always-overwrite.eli16.md` sibling |
| L10 Release notes in same PR | ✓ Engaged — `upgrades/NEXT.md` in this PR |
| B28 Spec-converge pre-auth circular | ✓ Engaged — this amendment IS the audit-driven corrective |

No contradictions found. Zero deferrals.

## Implementation slice for this PR

1. This spec + ELI16 + convergence report (with the manual lessons-aware check above).
2. `src/providers/parity/types.ts` — `alwaysOverwrite?: boolean` field on ParityRule; remediate() docstring updated.
3. `src/providers/parity/rules/hookParityRule.ts` — `alwaysOverwrite: true` set; refuse-on-conflict throw removed.
4. `src/monitoring/FrameworkParitySentinel.ts` — sentinel honors `alwaysOverwrite` and emits `parity:user-edit-overwritten`.
5. `tests/unit/providers/parity/hookParityRule.test.ts` — test inverted + added.
6. `tests/unit/monitoring/FrameworkParitySentinel.test.ts` — new test for alwaysOverwrite path.
7. `upgrades/NEXT.md` + `upgrades/side-effects/fix-hook-stamp-migration-parity.md`.
8. Package.json version bump.
