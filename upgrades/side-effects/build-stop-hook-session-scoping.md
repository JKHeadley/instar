# Side-Effects Review — Build Stop-Hook Session-Scoping

**Slug:** `build-stop-hook-session-scoping`
**Date:** `2026-05-26`
**Author:** Echo
**Spec:** `docs/specs/BUILD-STOP-HOOK-SESSION-SCOPING-SPEC.md` (converged round 1, approved by Justin via Telegram topic 13352)
**Second-pass reviewer:** independent general-purpose review agent (3 findings, all incorporated — see spec §"Review Findings Incorporated")

## Summary of the change

The `/build` Stop hook had no notion of which session owns a build. With one
shared `build-state.json` and one hook in a checkout, a build started by session
A fired its "keep working" block into every concurrent session of the same agent
— trapping unrelated sessions and, on every misfire, incrementing the shared
`reinforcementsUsed` counter, which drains the owning build's protection budget
to zero.

This change stamps the owning session at `/build` start (`build-state.py init`
writes `owner.{tmux,session,stampedAt}`) and teaches the hook to block **only**
the proven owner. Any other session approve-exits **without** incrementing the
counter. A build with no owner stamp gets a conservative no-adopt (approve,
never claim ownership) — it never traps a session and never inverts ownership.

## Files changed (in gate scope = behavior)

- `src/core/PostUpdateMigrator.ts` — the inline `getBuildStopHook()` (the
  shipping artifact; written to `.instar/hooks/instar/build-stop-hook.sh` on every
  migration via always-overwrite, and by `init.ts` via `getHookContent`). Added
  the ownership block between the terminal-phase early-exit and the counter
  mutation.
- `src/templates/hooks/build-stop-hook.sh` — the canonical reference template +
  builtin-manifest fingerprint. Kept byte-identical to the inline twin (asserted
  by a new drift test).

Out of gate scope but part of the change:
- `playbook-scripts/build-state.py` — `cmd_init` stamps `owner`; new
  `--owner-session` / `--owner-tmux` flags; `resolve_owner_tmux()` helper.
- `tests/unit/build-stop-hook-session-scoping.test.ts` (new, 12 tests),
  `tests/unit/PostUpdateMigrator-buildStopHook.test.ts` (+1 drift test).
- `docs/specs/*`, `upgrades/NEXT.md` (docs / release note).

## Decision-point inventory

- **Added**: hook ownership gate — between terminal-phase exit and counter
  mutation. Decides block (owner) vs approve-no-increment (non-owner / unknown /
  un-stamped). This is the new decision boundary.
- **Added**: `build-state.py` owner stamp at init (records identity; no runtime
  decision, pure data).
- **Unchanged**: no-state-file exit, terminal-phase exit, and the
  counter/reinforcement block logic itself (the owner path falls through to the
  exact pre-existing code).

## Over-block / under-block analysis

- **Over-block risk (trapping a non-owner):** eliminated. A non-owner returns
  `approve` before reaching the counter. The only block path requires a positive
  owner match (tmux or session). Tested: non-owner tmux, non-owner session,
  identity-unknown, and legacy/un-stamped all return approve.
- **Under-block risk (owner not protected):** bounded and acceptable. The owner
  is protected whenever `owner.tmux` matches the live tmux (the load-bearing
  path, proven live) or `owner.session` matches stdin `session_id`. The only
  under-protection case is an **un-stamped** build (legacy state, or an
  environment where stamping didn't run) — by deliberate design the hook goes
  quiet there rather than guess. Forfeiting protection for a stale build is the
  correct trade vs. trapping the wrong session (spec §"Why conservative-no-adopt").
- **Bootstrap inversion (the rejected alternative):** an earlier draft let the
  first session to Stop adopt ownership. The independent review showed this
  inverts ownership in the real incident pattern (busy owner never stops first).
  Removed entirely; replaced with conservative no-adopt. Tested: un-stamped state
  yields approve with `owner` NOT written.

## Level-of-abstraction fit

The fix lives at the same layer as the bug: the Stop hook and the state writer.
It mirrors the already-shipped autonomous stop-hook's session-scoping ladder
(tmux-name primary, session-UUID backstop, fail-open) without merging the two
(explicit non-goal — bash hooks don't share code cleanly; premature abstraction
avoided). No new module, no new service.

## Signal-vs-authority compliance

The hook is a low-context filter making a binary ownership decision from
locally-verifiable identifiers (tmux `#S`, stdin `session_id`). It does not
arrogate higher-level judgment — it only declines to block a session it cannot
prove it owns. Conservative-by-construction: every ambiguous case resolves to
`approve` (release), never to `block` (trap). It emits no user-facing messages.

## Interactions

- **Reinforcement counter:** the owner path is byte-for-byte the prior logic, so
  graduated protection (3/5/10) is unchanged for the owner. Non-owners no longer
  touch the counter at all.
- **Restart reconcile:** writes `owner.session` ONLY on a confirmed tmux-owner
  match with a rotated UUID. Gated strictly behind the tmux match — a non-owner
  can never clobber `owner.session` (tested explicitly).
- **stdin consumption:** the hook now reads stdin (`cat`). Stop hooks deliver and
  close stdin in production (the autonomous hook relies on this), so no hang.
  Even with no stdin/session, tmux-scoping alone is sufficient (proven live).
- **Worktree topology:** ownership is keyed on the cwd-independent tmux name, so
  it is correct whether the owner launched at the main root and `cd`'d into a
  worktree or launched rooted inside the worktree. The old, fragile `$PWD`-based
  stopgap is NOT carried forward.
- **Migration parity:** inline twin is always-overwritten → every agent gets the
  new hook on update. `build-state.py` rides the repo checkout (the only place
  the bug occurs — see spec §Migration Parity 2). Drift test prevents
  template/inline divergence.

## Rollback cost

Low and clean. Revert the two src files (and optionally build-state.py); the
always-overwrite migration restores the prior hook on next update. The added
`owner` block in state is additive JSON ignored by the old hook — no destructive
schema migration. No data loss path.

## Tracked deferral

The SKILL change to pass `--owner-session "$CLAUDE_CODE_SESSION_ID"` (session-UUID
precision; + its dedicated PostUpdateMigrator migration per Migration Parity §5)
is a deliberate fast-follow per the approved phasing (Justin approved one-PR-now +
tiny-follow-up). The flag is already plumbed and tested in `build-state.py`; only
the SKILL invocation + migration remain. This is tracked, not orphaned.

## Verification

- 3-tier behavior tests (12) drive the **real shipping hook** (from
  `getHookContent`) against the **real `build-state.py`** with real stdin/tmux
  seams — covering owner-block, non-owner-no-drain, repeated-non-owner,
  session-only owner, identity-unknown fail-open, legacy no-adopt, restart
  reconcile, anti-clobber, terminal-phase. Plus build-state stamp tests (3) and
  the template/inline drift test (1).
- Live test-as-self: ran the shipping hook with **real** `tmux display-message`
  resolution (no seam) in this session (`echo-build-stop-hook-session-scoping`) —
  confirmed owner→block, non-owner→approve with zero counter drain.
