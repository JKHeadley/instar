# Side-Effects Review — File-path feedback advisory by default

**Version / slug:** `file-path-advisory-default`
**Date:** `2026-09-04`
**Author:** `echo`
**Second-pass reviewer:** `Codex /root/rule2_side_effects_review`

## Summary of the change

`MessagingToneGate` changes `B2_FILE_PATH` from blocking to advisory for every install, independent of the broader fleet-dark advisory-migration flag. `PostUpdateMigrator` replaces the prior CLAUDE.md advisory section idempotently and mirrors it into Codex/Gemini shadows. The Telegram route describes evidence recording honestly when the recorder is unavailable. Focused tests cover runtime disposition and override, fresh-install awareness, migration replacement, idempotency, shadow parity, and positioning.

## Decision-point inventory

- `MessagingToneGate.RULE_DISPOSITIONS.B2_FILE_PATH` — modified — a contextual file-path judgment no longer has terminal blocking authority.
- `PostUpdateMigrator.migrateClaudeMd` — modified — existing installed awareness text is replaced or added idempotently.
- `PostUpdateMigrator.migrateFrameworkShadowCapabilities` — modified — the replacement section is copied into Codex/Gemini shadows after CLAUDE.md migration.
- `POST /telegram/reply` advisory instructions — modified — recording claims depend on a live decision reference and recorder.

## 1. Over-block

The change removes the known over-block: a legitimate path needed to open, edit, or locate an artifact can no longer be an absolute wall. The first advisory response still withholds the send until the agent revises or supplies a reasoned override; that bounded nudge is intentional and preserves the opportunity to improve confusing prose.

## 2. Under-block

An agent can override a genuinely confusing raw path with a poor reason. That is accepted because file-path clarity is a contextual writing judgment, not a safety invariant. Credential exposure remains independently non-overridable, and paths do not bypass that guard.

## 3. Level-of-abstraction fit

This is at the existing authority layer: the LLM tone gate may still detect and cite `B2_FILE_PATH`, while the disposition map controls whether that contextual judgment is a wall or a nudge. No parallel detector or new decision path is introduced.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change removes brittle terminal authority from an existing smart-gate verdict.

The change does not create a detector. It changes the disposition of the existing contextual verdict so a path-shaped observation cannot itself become terminal authority. The author retains final authority through the existing reasoned advisory override seam. Hard credential invariants remain separate.

## 4b. Judgment-point check

No new static heuristic is added at a competing-signals decision point. The static disposition is a floor preventing a contextual prose judgment from becoming an absolute blocker; the existing LLM authority still decides whether to issue the nudge.

## 5. Interactions

- **Shadowing:** Credential checks still execute independently and remain non-overridable; the B2 disposition cannot shadow them. The framework-shadow copier runs after CLAUDE.md migration and now searches for the replacement marker, preventing the migrated section from disappearing on Codex/Gemini.
- **Double-fire:** The existing advisory protocol is reused, so no second sender or parallel retry path exists.
- **Races:** The runtime map is immutable and process-local; migration is content-sniffed and idempotent.
- **Feedback loops:** Where decision recording is available, compliance and dissent continue feeding the existing quality meter. Where unavailable, B2 still remains overridable, avoiding a false hard wall.

## 6. External surfaces

Agents on fresh and upgraded installs see revised guidance in CLAUDE.md and framework shadows. Telegram and other tone-gated outbound callers receive the existing advisory protocol; the explanation now says when decision-quality evidence cannot be recorded. No new operator action, database, URL, or external-service dependency is introduced.

## 6b. Operator-surface quality

No dashboard or operator form surface — not applicable.

## 7. Multi-machine posture

**Replicated:** the behavior ships in source and the awareness text is applied by the normal update migration to CLAUDE.md plus existing Codex/Gemini shadows on each machine. It emits no independent notice, holds no durable per-machine state, and generates no URLs. Topic transfer cannot strand an override because the decision is per-send and the base disposition is identical on every updated machine.

## 8. Rollback cost

A hot-fix can revert the disposition and awareness migration in a later patch. No data migration or agent-state cleanup is required; an update would rewrite the owned awareness section again. During rollback propagation, machines could temporarily differ in whether B2 is a wall, which is visible and bounded to message composition.

## Conclusion

The change is narrower than the broad advisory-migration program and directly implements the operator's September 3 decision. It removes inappropriate blocking authority without weakening credential safety. Focused tests pass; full-suite verification must be repeated after rebasing onto current main.

## Second-pass review

**Reviewer:** `Codex /root/rule2_side_effects_review`
**Independent read of the artifact:** `concur`. The first pass identified framework-shadow marker drift, an unproven no-recorder override path, misleading recording claims, and incomplete authority/inventory wording. The corrected diff resolves all concerns; the reviewer independently verified the relevant code and the combined 193-test focused evidence.

## Evidence pointers

- Focused suite: 5 files, 193 tests passed on 2026-09-04 after the independent-review corrections.
- Prior stale-base full suite: 50,956 passed, two failures; both require current-main reconciliation before release.

## Class-Closure Declaration

`defectClass: brittle-keyword-authority`, `closure: guard`, `guardEvidence: {enforcementType: ratchet, citation: tests/unit/tone-gate-advisory-migration.test.ts, howCaught: the test asserts B2_FILE_PATH is advisory even when the broader migration and decision-quality recording are unavailable, so a future return to a hard wall fails the suite}`.
