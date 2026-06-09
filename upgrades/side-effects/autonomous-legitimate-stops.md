# Side-Effects Review — Autonomous "Legitimate Stop Conditions" allowlist

**Version / slug:** `autonomous-legitimate-stops`
**Date:** `2026-06-09`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `not required`

## Summary of the change

Adds a new top-level section to the autonomous skill's instruction file — **"## Legitimate Stop Conditions (the ONLY valid reasons to exit)"** — enumerating the only three valid reasons a pre-approved autonomous session may exit: (a) a genuine hard external blocker the agent cannot resolve, (b) duration expiry, (c) the completion condition/promise genuinely met. It pairs that with an explicit NON-stops table (reversible decisions, milestones, late-hour, "needs your steer/opinion," "good stopping point," quiet off-ramp-with-no-reply) and reinforces the existing Anti-Patterns list with two new entries ("This Needs Your Steer" and "Quiet Off-Ramp"). Files touched: `.claude/skills/autonomous/SKILL.md` (the bundled shipping source — new agents get it via `init`/`installAutonomousSkill`), `src/core/PostUpdateMigrator.ts` (bumps the existing `migrateAutonomousStopHookTopicKeyed` SKILL.md marker from `PER-TOPIC (setup-race hardening)` to `LEGITIMATE_STOP_CONDITIONS` so existing agents receive the section on update), and `tests/unit/PostUpdateMigrator-autonomousStopHook.test.ts` (four new migration tests). This is prompt/skill CONTENT plus its Migration-Parity migration — NOT a change to any decision-point code logic.

## Decision-point inventory

The change touches **no runtime decision point.** It does NOT modify the autonomous stop hook's blocking logic (`autonomous-stop-hook.sh`), the completion-condition judge, the emergency-stop check, or any gate/sentinel/watchdog. The stop hook continues to decide exit exactly as before; this change only edits the prose the agent reads and adds a content-sniffing migration that re-deploys that prose to existing installs.

- `migrateAutonomousStopHookTopicKeyed` (SKILL.md upgrade arm) — modify (marker bump only) — re-deploys the bundled SKILL.md to existing agents whose installed copy lacks the new sentinel.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface — over-block not applicable. The migration's `upgrade()` helper writes a file only when the installed copy lacks the new marker AND matches the stock fingerprint (`ALL_TASKS_COMPLETE`); a customized SKILL.md is left untouched (reported as `skipped`), so it cannot "over-write" operator customizations.

---

## 2. Under-block

**What failure modes does this still miss?**

No block/allow surface — under-block not applicable. As prose guidance, the section is advisory: the structural stop hook is what actually enforces continuation. An agent could still rationalize an early stop despite the guidance — but that is the stop-hook's job to catch (out of scope here, tracked as the separate Tier-2 stop-hook logic change). This change strengthens the guidance the agent reads each iteration; it does not claim to be the enforcement layer.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. This is skill CONTENT (prompt-level guidance), which is the correct layer for "here are the only valid reasons to exit." The structural enforcement (the stop hook) is a separate, lower layer that this content complements. The migration rides the EXISTING `migrateAutonomousStopHookTopicKeyed` path — the established, correct home for autonomous SKILL.md content updates — rather than introducing a parallel migration. The marker-bump mechanism is the same content-sniffing pattern already used for the prior SKILL.md fixes (per-topic write, registration-path fix), so it reuses rather than re-implements.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface.

This is documentation/skill-content plus an idempotent file-deployment migration. It makes no allow/block decision, holds no authority over message flow or session lifecycle, and adds no brittle detector. The migration only writes a markdown file under content-sniffing guards.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** None. The migration's SKILL.md arm shares the same `upgrade()` helper as the stop-hook and setup-script arms within `migrateAutonomousStopHookTopicKeyed`; each arm targets a distinct file path, so they cannot shadow each other. The marker bump on the SKILL.md arm does not affect the hook/setup arms (independent markers).
- **Double-fire:** None. `installAutonomousSkill()` (init path) is install-if-missing and won't overwrite; the migration is the single content-update path. They do not both write the same file in the same run (init only writes when absent).
- **Races:** None. The migration runs synchronously inside the PostUpdateMigrator sequence at update time; no shared concurrent state.
- **Feedback loops:** None.

One real interaction verified: the existing test `PostUpdateMigrator-autonomousStopHook.test.ts` already exercises this migration; the marker bump from `PER-TOPIC (setup-race hardening)` to `LEGITIMATE_STOP_CONDITIONS` required no change to the existing hook/setup test cases (those assert their own markers, not the SKILL.md marker), and the new SKILL.md tests were added alongside. Verified the bundled SKILL.md contains BOTH the new marker (so `next.includes(marker)` passes and the upgrade actually writes) AND the fingerprint.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- Other agents on the same machine: only their autonomous SKILL.md content updates on their next PostUpdateMigrator run — the intended Migration-Parity effect.
- Other users of the install base: same — they get the new guidance on update.
- External systems (Telegram, Slack, GitHub, Cloudflare): none.
- Persistent state: none beyond rewriting the one markdown file the migration targets (only when stale + stock).
- Timing/runtime conditions: none.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Pure content change — revert the SKILL.md edit and the marker bump, ship as the next patch. No persistent state to clean up, no data migration, no agent-state repair. Existing agents that already received the re-deployed SKILL.md would simply receive the reverted version on a subsequent marker bump (or keep the harmless prose section). No user-visible regression during the rollback window.

---

## Conclusion

This review confirms the change is content-only with no decision-point surface. It adds the operator-requested "Legitimate Stop Conditions" allowlist + NON-stops table to the autonomous skill, ships it to new agents via the bundled source, and reaches existing agents via the established content-sniffing SKILL.md migration arm (marker bump, idempotent, customization-preserving). No design changes were required by the review. Clear to ship pending human review.

---

## Second-pass review (if required)

**Reviewer:** not required

Tier 1, content-only, no block/allow or session-lifecycle decision logic touched — the Phase 5 second-pass triggers do not apply.

---

## Evidence pointers

- `npx tsc --noEmit` → exit 0 (clean).
- `npx vitest run tests/unit/PostUpdateMigrator-autonomousStopHook.test.ts` → 12 passed (8 prior + 4 new SKILL.md cases).
- `npx vitest run tests/unit/autonomous-skill-deployment.test.ts tests/unit/migration-parity.test.ts tests/unit/PostUpdateMigrator-autonomousHookPath.test.ts tests/unit/autonomous-stop-hook-idle-backoff.test.ts` → 52 passed.
- Bundled SKILL.md verified to contain both `LEGITIMATE_STOP_CONDITIONS` (marker) and `ALL_TASKS_COMPLETE` (fingerprint).
