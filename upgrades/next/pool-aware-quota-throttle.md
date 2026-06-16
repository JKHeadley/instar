# Pool-Aware Quota Throttle (end the whole-agent stall when one account maxes out)

## What Changed

The global quota brake (`QuotaTracker.shouldSpawnSession`) was account-blind: it stopped the WHOLE agent
on a single account's usage, so when one Claude account hit its weekly limit the agent froze even though
other pooled accounts sat at 0% (the 2026-06-15 "two accounts untouched while work stalls" incident; a
degraded JSONL estimate reading 186% jammed it harder). It now reasons over the whole pool by asking the
placement layer's OWN `selectAccount` predicate (via a provider wired in `server.ts`): the brake never
halts the agent while a placeable account has headroom, and never allows work placement can't land — the
90–95% "allowed-but-unplaceable" respawn-loop band is closed by construction (`allowed ⟹ placeable`).
Missing/implausible/degraded readings trigger a BOUNDED mode (shed low priority, allow medium+, honor an
authoritative 5-hour wall) instead of a stall or unbounded fail-open.

## What to Tell Your User

If you run several Claude accounts pooled together, the agent no longer freezes when one account hits its
weekly limit — it keeps working on the accounts that still have room, and it won't get stuck in the
"session respawned" restart loop. Single-account agents are completely unaffected (byte-identical
behavior). Nothing to configure; it's on by default because it removes a bug.

## Summary of New Capabilities

- `QuotaTracker.setPoolQuotaProvider()` — the brake shares placement's exact eligibility predicate, so a
  maxed account can never stop the whole agent while a placeable account exists.
- Bounded degraded-data handling (shared by the pool and single-account paths): non-authoritative /
  out-of-range / missing readings shed low priority and allow medium+, instead of stalling or running blind.
- The "use-it-or-lose-it" optimizations (drain near-reset accounts first, burn-rate balancing) are the
  tracked SECOND PR — this one is the robust+safe foundation.

## Evidence

Converged over 3 `/spec-converge` rounds (6 internal reviewers + codex GPT-5.5); the first two designs were
rejected by review (one dead in production, one with a staleness/loop gap) and redesigned. 253 quota tests
pass with no regressions, including a test proving `allowed ⟹ placeable` across a 0→100 usage sweep and the
90–95% band → stop. Spec: `docs/specs/POOL-AWARE-QUOTA-THROTTLE-SPEC.md`. Acceptance: the two previously-idle
accounts demonstrably carry load after the fix (live proof).
