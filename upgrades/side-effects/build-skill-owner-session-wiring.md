# Side-Effects Review — Build SKILL --owner-session wiring (ACT-155)

**Slug:** `build-skill-owner-session-wiring`
**Date:** `2026-05-26`
**Author:** Echo
**Spec:** `docs/specs/BUILD-STOP-HOOK-SESSION-SCOPING-SPEC.md` (approved; this is the tracked fast-follow ACT-155 named in the spec's Migration Parity §3 / Open Question #2)
**Second-pass reviewer:** not-required (single surgical line-patch + idempotent migration; precision add-on on top of already-shipped + reviewed v1.3.0 tmux scoping)

## Summary of the change

The session-scoping fix (v1.3.0) added `--owner-session` to `build-state.py` and
the stop-hook compares it, but nothing passed it yet — so only tmux-name scoping
was active (the load-bearing path). This wires the `/build` skill to pass
`--owner-session "$CLAUDE_CODE_SESSION_ID"` at init, adding precise Claude-session
ownership on top of tmux scoping.

## Files changed

- `.claude/skills/build/SKILL.md` — Step 1 init invocation now passes
  `--owner-session "$CLAUDE_CODE_SESSION_ID"` (+ a short note on why / that empty
  is fine). This is the bundled source new installs copy.
- `src/commands/init.ts` — the CLAUDE.md `/build` help snippet mirrors the flag.
- `src/core/PostUpdateMigrator.ts` — new `migrateBuildSkillOwnerSession()`
  (registered in the migrate sequence): surgical, idempotent line-patch that
  appends the flag to the `build-state.py init` line on deployed agents.
- `tests/unit/PostUpdateMigrator-buildSkillOwnerSession.test.ts` — 5 tests.

## Decision-point inventory

- No new runtime decision points. The hook's ownership decision (shipped v1.3.0)
  is unchanged; this only ensures `owner.session` is populated so the
  session-UUID arm of that decision is exercisable.

## Over/under-block, abstraction, signal-vs-authority

- **No gating behavior added.** This is wiring, not a gate. `owner.session` is an
  additional positive owner identifier; the hook already treated it as optional
  (empty → tmux-only scoping, which is the proven load-bearing path).
- **Graceful when the var is empty/unset:** `--owner-session ""` → empty
  `owner.session` → tmux scoping still fully works. No regression for harnesses
  that don't expose `$CLAUDE_CODE_SESSION_ID`.
- **Abstraction fit:** the SKILL is the right place to pass the agent's own
  session id (the only layer that has it at init time, per the documented
  child-process non-inheritance of `$CLAUDE_CODE_SESSION_ID`).

## Migration parity

- New installs: bundled SKILL.md already carries the flag (test asserts it).
- Deployed agents: `migrateBuildSkillOwnerSession()` patches the installed
  SKILL.md (install-if-missing means a dedicated migration is required, per
  Migration Parity §5). Idempotent (skips if `--owner-session` already present),
  surgical (only the init line), and safe on customized skills (no init line →
  no-op).

## Interactions

- Pairs with the v1.3.0 hook + `build-state.py --owner-session` already on main.
  End-to-end verified: running the SKILL's exact init command stamped
  `owner.session` with the real live session UUID.
- No interaction with `migrateBuildSkillMethodology` (different marker, different
  line); both can run in any order, both idempotent.

## Rollback cost

Trivial. Revert the three source files; the migration simply stops patching. The
flag in deployed SKILL.md is inert if `build-state.py` lacked the arg (it doesn't
— shipped v1.3.0), and harmless if present.

## Verification

- 5 migration unit tests (append, idempotent, absent-file no-op, no-init-line
  untouched, bundled-already-has-flag).
- End-to-end: SKILL init command with the flag stamped `owner.session` = real
  session UUID (proves `$CLAUDE_CODE_SESSION_ID` is live in the Bash shell and the
  command captures it).
- Full suite run before push.
