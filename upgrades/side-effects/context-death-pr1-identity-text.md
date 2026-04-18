# Side-Effects Review — Context-Death PR1 (identity text + marker migration + pin support)

**Version / slug:** `context-death-pr1-identity-text`
**Date:** `2026-04-18`
**Author:** `Echo (instar-developing agent)`
**Spec:** `docs/specs/context-death-pitfall-prevention.md` § (a)
**Phase / PR sequence position:** PR1 of 8
**Second-pass reviewer:** `not-required` (identity text is a weak prior per the spec — it is not counted in defense-depth accounting; no decision-point logic introduced — see Phase 5 criteria below)

## Summary of the change

Lands the "context-death self-stop" anti-pattern text into the generated CLAUDE.md and AGENT.md templates, plus an idempotent marker-block migration that retrofits existing agents. Per spec § (a): this is a **weak prior**. Identity guidance alone cannot be counted on to prevent drift — that's why PR3's gate exists. But cheap priors sometimes catch easy cases, and the marker makes the intent explicit so future context-death rationalizations land on a piece of the agent's own identity that says "don't do that."

Files touched:

- **`src/scaffold/templates.ts`** (MOD) — two inline insertions:
  - `generateClaudeMd()`: adds the `<!-- INSTAR:ANTI-PATTERN-CONTEXT-DEATH --> ... <!-- /… -->` marker block inside the "## Critical Anti-Patterns" section, right after the existing "Apology-Only Response" entry.
  - `generateAgentMd()`: adds the same marker block as a new numbered principle (#12) inside "## My Principles".
- **`src/core/PostUpdateMigrator.ts`** (MOD) — adds:
  - New private method `migrateContextDeathAntiPattern(result)` that injects the marker block into both files when absent, idempotent by marker detection, honors `.instar/identity-pins.json`, soft-fails on malformed pin file.
  - Helper `readIdentityPins()` that reads the pin file and returns `{}` on any read/parse failure (so a corrupted pin file can never block migration).
  - Called from `migrate()` after `migrateAgentMdSections`.
- **`tests/unit/PostUpdateMigrator-context-death.test.ts`** (NEW) — 8 tests:
  - Marker injection into CLAUDE.md under "Critical Anti-Patterns".
  - Marker injection into AGENT.md under "My Principles".
  - Idempotency — re-running does not double-inject; exact count assertions.
  - Pin file honored — entry for the marker id causes full skip on both files.
  - Malformed pin file soft-fails to empty pins; marker still injected.
  - Missing CLAUDE.md / AGENT.md are skipped cleanly (no errors in result).
  - "Critical Anti-Patterns" section is appended if missing.
  - "My Principles" section is appended if missing.

## Decision-point inventory

Zero. The migration is a deterministic string-insertion operation gated by presence-checks. No blocking, no routing, no judgment calls. The pin file is a user-override mechanism, not a decision — if the pin exists, skip; that's content-addressable, not content-evaluated.

The anti-pattern TEXT itself is a behavioral nudge, not a gate. Per spec § (a): "Identity guidance is a **weak prior**, not a structural layer." PR3's LLM authority is the decision surface.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

None. The migration writes content; it does not reject anything. The pin file is a user-opt-out, so power-users who want a different phrasing can set a pin and the migration respects it.

## 2. Under-block

**What failure modes does this still miss?**

- **Model ignores its own identity text.** Per spec § (a): "The spec's premise is that Claude 4.7 ignores identity guidance in exactly this domain." This PR ships the weak prior anyway because (i) it's cheap; (ii) it makes the intent explicit for any agent/user reading CLAUDE.md later; (iii) an occasional easy case may land. The structural defense is PR3.
- **User has already customized Critical Anti-Patterns.** The migration only checks for the marker id, not surrounding text, so a user who hand-wrote a similar paragraph will get the marker block inserted alongside theirs. Acceptable: this is what pins are for — if the user objects, they add a pin and the migration skips.
- **Migration runs on every `instar upgrade`.** Idempotency guarantees no double-insertion, but a rapid sequence of updates re-runs this method many times. Performance is negligible (two file reads + two string searches); no concern.

## 3. Level-of-abstraction fit

**Is this at the right layer? Should a higher or lower layer own it?**

Yes. `PostUpdateMigrator` is specifically designed to patch CLAUDE.md / AGENT.md sections post-update (see existing `migrateClaudeMd`, `migrateAgentMdSections`); this PR adds one more section-patch in the same style. Template edits go in `src/scaffold/templates.ts`, which is where `generateClaudeMd` / `generateAgentMd` live.

The pin-file format is kept local-only (`.instar/identity-pins.json`), not synced across machines. The spec explicitly chose this over cross-agent pinning (I201 fix) — simpler and honest about the drift-correction threat model.

## 4. Signal vs authority compliance

`docs/signal-vs-authority.md`: detectors emit signals; only authorities can block.

The migration is neither. It is a writer of identity text. The text it writes is a prior, which influences the model's behavior but does not gate any runtime decision. Per spec, this text is explicitly NOT counted in defense-depth accounting — it is understood to be insufficient by itself. PR3 is the authority; this PR is the loudspeaker.

The pin file is user-override state, not a signal consumed by any agent runtime path. Its presence changes what the migrator does, nothing more.

## 5. Interactions

- **Existing `migrateClaudeMd` / `migrateAgentMdSections`** — both run BEFORE this new method. The new method's detection works on post-run state of each file, so concurrent section additions don't collide. Marker detection is exact-string (`MARKER`), no regex-engine surprises.
- **`.instar/identity-pins.json`** — agent-local file. No cross-agent sync. No server endpoint reads it in this PR (the pin is a migrator-only concern).
- **Section anchor logic** — inserts before the NEXT top-level heading after the target section header. If Critical Anti-Patterns or My Principles is the last section in the file, insert position is end-of-file. Either case is handled.
- **Backup system** — CLAUDE.md / AGENT.md are included in default backups per `builtin-manifest.json`. Both pre- and post-migration copies are snap-shotted by the regular backup cycle; rollback via `instar backup restore` works unchanged.

## 6. External surfaces

- New marker id `INSTAR:ANTI-PATTERN-CONTEXT-DEATH` becomes part of the CLAUDE.md / AGENT.md public surface for any reader (human or agent) of those files.
- New pin file path `.instar/identity-pins.json` is created lazily only when a user wants to pin — absence is the default. No `.gitignore` entry needed (agents may or may not check `.instar/` into version control; if they do, pins propagate across machines for that agent — which is user intent).
- No changes to HTTP routes, dispatch, session lifecycle, or coherence.
- The anti-pattern text itself is visible to the agent on every session-start re-read of CLAUDE.md and on every compaction-recovery of AGENT.md. That visibility IS the point.

## 7. Rollback cost

Trivial. Revert:
- Removes template-text inserts in `templates.ts`.
- Removes `migrateContextDeathAntiPattern` method + helper.
- Removes the test file.
- **Already-migrated agents keep the marker block in their files.** Future `instar upgrade` runs won't re-touch it (no migration code to look for it). If a user wants the block removed retroactively, they delete it manually from their CLAUDE.md / AGENT.md — the marker id makes it findable with a one-line grep. No data migration, no agent-state repair.

Total rollback time: one `git revert` + restart (~30s).

---

## Tests

- `tests/unit/PostUpdateMigrator-context-death.test.ts` — 8 tests, all passing.
- `npm run lint` clean.

## Phase 5 second-pass review criterion check

- Block/allow decisions on outbound messaging, inbound messaging, or dispatch — **no** (this is text + a migrator).
- Session lifecycle: spawn, restart, kill, recovery — **no** (the identity-text loudspeaker is read-only at runtime).
- Context exhaustion, compaction, respawn — **the text is *about* these topics**, but does not gate any runtime path. PR3 is where runtime gating lands.
- Coherence gates, idempotency checks, trust levels — **the migrator has idempotency by marker-detection**, but this is deterministic string search, not a decision layer.
- Anything with "sentinel," "guard," "gate," or "watchdog" — **no**.

PR3 will require Phase 5 second-pass review.
