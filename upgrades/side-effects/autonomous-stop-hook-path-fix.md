# Side-Effects Review — Autonomous loop re-engagement fix (stop-hook registration path)

**Version / slug:** `autonomous-stop-hook-path-fix`
**Date:** `2026-06-03`
**Author:** `Echo`
**Second-pass reviewer:** `Echo (self, single-pass — Tier-1 fix)`

## Summary of the change

The autonomous-mode stop hook is what re-injects the task list on every `Stop`
event so an autonomous session keeps working between turns. It was registered in
`settings.json` at `.instar/hooks/instar/autonomous-stop-hook.sh`, but the hook
is only ever deployed to the skill dir (`.claude/skills/autonomous/hooks/`). The
registered path therefore pointed at a non-existent file: every `Stop` failed
silently and the loop never re-engaged. Files touched:
`.claude/skills/autonomous/SKILL.md` (Step 2a registration snippet),
`src/core/PostUpdateMigrator.ts` (`ensureAutonomousStopHook` repair pass +
`migrateAutonomousStopHookTopicKeyed` SKILL.md re-deploy), and a new unit suite.
The decision surface is purely *which file path is written into the Stop-hook
registration* — there is no message block/allow logic.

## Decision-point inventory

- `SKILL.md Step 2a registration` — modify — registers the deployed skill path
  (was the never-deployed `.instar/hooks/instar/` path) and self-heals stale entries.
- `PostUpdateMigrator.ensureAutonomousStopHook` — modify — adds a repair pass that
  rewrites wrong-path entries before the existing presence check.
- `PostUpdateMigrator.migrateAutonomousStopHookTopicKeyed` — modify — adds SKILL.md
  to the marker-gated re-deploy list so existing agents receive the fixed prompt.
- No message-gating / block-allow decision point is touched.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The change only corrects a
filesystem path string in a hook registration; it never rejects any input.

---

## 2. Under-block

No block/allow surface — under-block not applicable. One adjacent correctness
note: the repair targets specifically the `.instar/hooks/instar/autonomous-stop-hook.sh`
wrong path. If a future custom registration used some *third* wrong path, the
repair would not catch it — but that path was never shipped by instar, so there
is nothing in the install base to miss. The registration helper still adds a
correct entry if none exists at all.

---

## 3. Level-of-abstraction fit

Correct layer. This is a deterministic settings/file-path migration — exactly the
class `PostUpdateMigrator` owns (Migration Parity Standard). The SKILL.md snippet
is the install/activation-time registrar; the migrator is the in-place repair for
already-deployed agents. No reasoning/LLM layer is involved or appropriate: the
correct path is a fixed, known string, so a structural fix is the right tool (and
matches the sibling `build-stop-hook.sh` path-repair precedent).

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

It rewrites a hook-registration path in `settings.json`; it holds no message or
operation authority. The autonomous stop hook itself (unchanged here) remains the
authority for whether a session continues, and it is session-id-gated.

---

## 5. Interactions

- **Shadowing:** The repair pass runs *before* the existing `hasAutonomousHook`
  presence check inside `ensureAutonomousStopHook`. This is intentional and is the
  core of the fix: previously the presence check matched the wrong-path entry and
  short-circuited the correct registration, so the wrong path was permanent. After
  repair, the entry already holds the correct path, so the presence check finds it
  and adds no duplicate (verified by the "no duplicate" test).
- **Double-fire:** Two registrars exist — the SKILL.md Step 2a (activation-time,
  dynamic add/remove) and `ensureAutonomousStopHook` (update-time, permanent). Both
  now converge on the *same* command string, so they can no longer disagree or
  produce two divergent entries. The SKILL.md snippet strips-then-appends, and the
  migrator's presence check prevents duplicates; combined they always yield exactly
  one correct entry (verified).
- **Races:** No shared concurrent state. `settings.json` is edited by the same
  single-writer migration path as every other hook registration.
- **Feedback loops:** None. A one-time path correction; the corrected entry is a
  fixed string, so subsequent passes are no-ops (idempotency verified).

---

## 6. External surfaces

- **Other agents on the machine:** none — per-project `settings.json` only.
- **Install base:** existing agents are healed on next update (the intended
  surface). The `migrateAutonomousStopHookTopicKeyed` re-deploy is marker-gated and
  fingerprint-guarded, so a customized `SKILL.md` (missing the stock
  `ALL_TASKS_COMPLETE` fingerprint) is left untouched — verified by test.
- **External systems (Telegram/Slack/GitHub/Cloudflare):** none.
- **Persistent state:** `.claude/settings.json` and the deployed `SKILL.md`. The
  edit is convergent (always lands on the one correct entry), so re-running is safe.
- **Timing/runtime:** none — the migration is synchronous on the existing update path.

---

## 7. Rollback cost

Pure code + template change. Back-out is `git revert` + ship the next patch. There
is one consideration: this migration *writes a corrected entry* into existing
agents' `settings.json`. A revert would stop applying the correction but would NOT
re-break already-corrected agents (the correct path resolves to a real file, so a
reverted build leaves them working). No data migration, no agent reset, no
user-visible regression during the rollback window. Worst case of the fix itself
being wrong: an agent ends up with a Stop-hook entry pointing at the skill path —
which is exactly where the file lives — so the failure mode of the fix is "it
works".

---

## Conclusion

The review produced no design changes. The fix is a narrow, deterministic path
correction with a self-healing registrar and an in-place repair migration that
satisfies the Migration Parity Standard for both the `settings.json` entry and the
deployed skill prompt. The only decision surface is a fixed path string, the
repair is idempotent and convergent, and the customized-prompt guard is preserved.
Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** Echo (self) — Tier-1 fix, single-pass per the tiered process.
**Independent read of the artifact: concur**

The change has no message-gating surface, the repair-before-presence-check
ordering is the load-bearing correctness point and is tested, and the Migration
Parity obligations (settings repair + marker-gated SKILL.md re-deploy + customized
guard) are all covered. No concerns.

---

## Evidence pointers

- `tests/unit/PostUpdateMigrator-autonomousHookPath.test.ts` — 9 tests (repair,
  no-duplicate, sibling-preservation, no-op-when-correct, register-when-missing,
  idempotency, SKILL.md content marker, topic-keyed re-deploy + customized-skip).
- Empirical SKILL.md snippet run against a wrong-path settings fixture: wrong entry
  rewritten to the skill path, siblings preserved, second run idempotent.
- Regression: `autonomous-skill-deployment`, `PostUpdateMigrator-buildStopHook`,
  `autonomous-stop-hook-notify`, `installCodexHooks`, `emit-session-clock` — 50
  tests green. `tsc --noEmit` clean.
