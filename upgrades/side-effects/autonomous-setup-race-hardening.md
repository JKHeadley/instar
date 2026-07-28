# Side-Effects Review — Autonomous setup-race hardening (per-topic state write)

**Version / slug:** `autonomous-setup-race-hardening`
**Date:** 2026-06-08
**Author:** Instar Agent (echo)
**Second-pass reviewer:** not required (see Phase 5 note below)

## Summary of the change

The autonomous stop-hook already resolves a **per-topic** state file (`.instar/autonomous/<topicId>.local.md`) and migrates the legacy single file into it. The only gap was that the autonomous **skill's** setup step still instructed writing the legacy single file `.instar/autonomous-state.local.md` — so two autonomous sessions booting near-simultaneously could both write that shared file and clobber each other in the window before the hook migrates. This change makes the skill write the per-topic file **directly** at setup. Files: `.claude/skills/autonomous/SKILL.md` (the setup write step + cancel/hook-config references), `src/core/PostUpdateMigrator.ts` (bumps the existing autonomous-SKILL.md upgrade marker so existing agents re-deploy the corrected skill), `tests/unit/PostUpdateMigrator-autonomousHookPath.test.ts` (+3 tests). The stop-hook's reading/decision logic is **untouched**.

## Decision-point inventory

- `autonomous-stop-hook.sh` state resolution (per-topic read + legacy migrate) — **pass-through** — unchanged; it already prefers the per-topic file and keeps the legacy fallback for in-flight older jobs.
- `PostUpdateMigrator` autonomous-SKILL.md upgrade — **modify (marker bump only)** — re-deploys the corrected bundled SKILL.md to existing agents; same idempotent `upgrade()` mechanism, no new migration machinery.
- Skill setup state-file write — **modify** — writes the per-topic path instead of the legacy single path. This is instruction content, not runtime decision logic.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?** No block/allow surface — over-block not applicable. The change relocates where a state file is written; it gates nothing.

## 2. Under-block

**What failure modes does this still miss?** None introduced. The one residual it does NOT address: a session with no resolvable `report_topic` still falls back to the legacy single file (documented in the skill) — that path is rare and the hook's legacy migrate still handles it. This is intentional back-compat, not a missed failure.

## 3. Level-of-abstraction fit

Correct layer. The race was created by the **skill** writing the shared path; the fix is in the skill (write per-topic directly). The hook already owned per-topic resolution at the right layer and is left untouched — we feed it the file it already prefers rather than adding a parallel mechanism.

## 4. Signal vs authority compliance

Compliant. No blocking authority is added or changed. The decision-making authority (the stop-hook, which blocks/allows session exit) is untouched. This change only changes which file the skill writes and re-deploys that instruction — it adds no brittle check with blocking power. (`docs/signal-vs-authority.md`.)

## 5. Interactions

- Does NOT shadow or get shadowed by the hook (the hook reads the same per-topic file the skill now writes — they agree).
- The migration marker bump rides the existing `upgrade('.claude/skills/autonomous/SKILL.md', …)` call; it does not double-fire (one marker carries cumulative SKILL.md fixes because `upgrade()` re-deploys the whole bundled file). Idempotent: a second run finds the new marker and no-ops.
- `setup-autonomous.sh` already wrote the per-topic path when `REPORT_TOPIC` is set — unchanged, no race with the skill's in-context write.

## 6. External surfaces

No user-facing surface. Internal robustness only. Existing agents receive the corrected skill on their next update via the migration; new agents get it via `init`. No new config, route, or API. No dependence on timing beyond the boot window it closes.

## 7. Rollback cost

Low. Back-out is a revert of 3 files + a marker re-bump (or simply shipping a follow-up that restores the prior marker). No data migration, no agent-state repair: the hook's legacy fallback + migrate path means even a mixed fleet (some agents on the old skill writing legacy, some on the new writing per-topic) keeps working — the hook migrates legacy regardless. Worst case is the narrow boot-race returns until re-fixed; nothing is corrupted.

## Phase 1 — Principle check

The change involves **no new decision point**. It relocates a state-file write and re-deploys that instruction; the gate/authority that makes the session-continuation decision (the stop-hook) is unchanged. Signal-vs-authority therefore applies only as "no new authority added."

## Phase 5 — Second-pass note

The Phase-5 trigger list includes session-lifecycle changes. This change is session-lifecycle **adjacent** (it affects where the autonomous loop's state file lives) but changes **no decision logic** — the stop-hook that drives spawn/continue/exit is byte-for-byte unchanged (verified against the diff). Declared **not-required**: there is no new or modified block/allow decision for a reviewer to audit. The substantive review above stands on the verified diff.
