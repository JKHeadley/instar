# Side-effects review — Framework-neutral relay path (Gap 4)

Per L6. Seven dimensions.

## 1. Over-block / under-block

Before: UNDER — Codex/Gemini agents instructed to run a nonexistent script.
After: no over-block. The `.claude/scripts/` copy is retained, so Claude Code
behavior is byte-identical. The neutral copy is additive.

## 2. Level-of-abstraction fit

Script installation stays in `migrateScripts` (where all reply-script
installation lives). The identity instruction stays in IdentityRenderer. No
logic leaked elsewhere.

## 3. Signal vs Authority compliance

The generated script content is the single source; both locations receive the
same bytes. The SHA-migrate guard remains the authority on whether a
user-customized copy is overwritten — unchanged, now applied to both copies.

## 4. Interactions with adjacent systems

- **SessionStart hook (3309-3314)** — already preferred the neutral path; now
  it resolves because the file exists. No hook change needed.
- **Claude SessionStart hook template (1822)** — intentionally unchanged
  (Claude-only path; Codex has no SessionStart hook — that's why the appendix
  exists).
- **buildTelegramRelayBlock (bootstrap helper)** — separate function, not
  touched; its tests still pass.
- **TemplatesDriftVerifier / verify-deployed-templates** — checks
  `.claude/scripts/telegram-reply.sh`; that file still exists with the same
  content, so drift verification is unaffected (regression-tested).

## 5. Rollback cost

Low. Two source edits + one new test + one updated assertion. `git revert`
restores prior behavior. The neutral copy left on disk after a revert is an
inert extra file (the appendix would point back at `.claude/scripts/`),
harmless.

## 6. Backwards compatibility / drift surface

Fully backward-compatible. Claude Code: unchanged. Existing agents: get the
neutral mirror on next update via Migration Parity, idempotent. Drift surface:
the two copies are generated from the same content in the same pass — they
cannot diverge within a run; the SHA-migrate guard handles user customization
identically for both.

## 7. Authorization / Trust posture

No new authority. Same write surface the migrator already owns
(`.claude/scripts/` and `.instar/scripts/` are both under projectDir/stateDir
the migrator already writes to). Best-effort: a neutral-copy write failure is
captured as a migration error, never throws out of the migration run.

## Outcome

Ship. Surgical, additive, Migration-Parity-compliant, regression-swept,
trivial rollback. Second of the v1.0.9–v1.0.14 hardening series.
