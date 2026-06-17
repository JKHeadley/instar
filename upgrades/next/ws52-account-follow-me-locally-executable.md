## What Changed

WS5.2 Account Follow-Me, §6.2 — the `locallyExecutable` account-selection gate. A new shared predicate `isLocallyExecutable(account)` (an account is executable on THIS machine iff it holds a real local `configHome` AND a valid login — active/warming) now gates account selection at its chokepoint: both `QuotaAwareScheduler.selectAccount()` (placement + swap-target selection) and `poolHeadroom()` (the quota throttle) filter on it, preserving the documented never-loop invariant `placeable ⟺ selectAccount(...) !== null`. A credential-less meta-only account replicated in from a peer (empty `configHome`) is now structurally unselectable — closing the force-mode "use an account I have metadata for but no credential" hole at SELECTION time. Adds `SubscriptionPool.locallyExecutable()` as the canonical machine-executable account set.

This is a pure tightening: every real pool account already carries a non-empty `configHome` (required by `add()`), so among genuinely-held accounts the predicate is a no-op — it only ever excludes a credential-less peer projection. The structural guard that lets the later enrollment-execution PRs add accounts without any path ever selecting a peer's credential-less account.

## Evidence

- 9 unit tests (`tests/unit/account-follow-me-locally-executable.test.ts`): both boundary sides (executable active/warming + real configHome; non-executable empty/whitespace configHome, needs-reauth/disabled/rate-limited), selectAccount exclusion of a meta-only account, real-over-meta preference, no-regression for held accounts, and explicit never-loop-invariant agreement (`poolHeadroom.placeable ⟺ selectAccount !== null`) for meta-only and real cases. `tsc --noEmit` clean.
- Side-effects review + mandatory independent second-pass security review (concurred): verified the never-loop invariant is preserved by the shared predicate, the change is a true no-op for current accounts, zero dangling references, no missed selection path, fail-closed (no fail-open). Artifact: `upgrades/side-effects/ws52-account-follow-me-locally-executable.md`.
- Spec: `docs/specs/ws52-account-follow-me-security.md` §6.2 + §6.3a (converged, approved).

## What to Tell Your User

Nothing to do — this is an internal selection-safety guard, shipped off by default as part of the multi-machine account-sharing groundwork. It guarantees this machine can only ever pick an account it actually holds a login for, never a peer's account it merely knows about. No user-facing surface in this release.

## Summary of New Capabilities

Internal: a `locallyExecutable` account-selection gate so a credential-less peer account projection can never be selected for execution, placement, or swap on this machine. Defense-in-depth groundwork for the WS5.2 enrollment-execution path. No user-facing surface.
