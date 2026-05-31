# Side-Effects Review — RateLimitSentinel codex parity

**Slug:** `ratelimit-sentinel-codex-parity`
**Date:** `2026-05-31`
**Author:** `echo`
**Second-pass reviewer:** independent review — **CONCUR (ship dark)**, see below.

## Summary
Makes the RateLimitSentinel codex-aware: recovery-verification reads the newest codex
rollout (account-wide throttle → newest-rollout growth signal) for codex sessions, vendor
wording follows the framework, and a dark `server.ts` poll reports throttled codex
sessions. Claude path byte-for-byte unchanged.

## Decision-point inventory
1. `getSessionFramework === 'codex-cli'` gate in readJsonlBaseline + vendor().
2. `codexUsageDetection === true` gate for the detection poll (default off).
3. `findNewestRolloutSync` (which rollout is "newest").

## 1. Over-block
No blocking surface. The sentinel never blocks a stop; it nudges + notifies. Worst over-action
= a spurious "backing off" notice to a healthy codex session when the poll is ON (cosmetic;
finalizes fast). Dark by default.

## 2. Under-block
Recovery can MISS a codex session's recovery for one cycle if codex rotates to a fresh smaller
rollout on resume (self-heals next cycle via baseline-refresh). And the concurrent-session hole
(see §5) can FALSE-recover a still-stuck sibling. Both gated behind the dark flag.

## 3. Level-of-abstraction fit
Lives where the claude equivalent lives (RateLimitSentinel + its server.ts wiring). The new
sync rollout finder sits beside the existing codex sessionPaths helpers. No new subsystem.

## 4. Signal vs authority compliance
**Ref:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md). The sentinel is an
existing recovery (authority) surface; this does not newly elevate authority — it extends the
SAME nudge/notify lifecycle to codex. No monitoring-into-blocker conversion. Detection is a
read-only signal gated dark.

## 5. Interactions
- **Existing claude triggers** (watchdog 'rate-limited', SessionManager idle-error): untouched;
  fire only for claude. The codex poll fires only for codex sessions. No double-report (dedup
  covers any overlap anyway).
- **CONCURRENT codex sessions (the review's real finding):** account-wide newest-rollout signal
  recovers ALL reported sessions off one session's growth → a still-stuck sibling can get a
  false recovery. Gated behind the dark flag; documented must-fix-before-enable in the spec.
- **CompactionSentinel:** unchanged (the bidirectional deferral predicate is not touched).

## 6. External surfaces
None new. The poll reads local codex rollout files (`readLatestCodexUsage`); no HTTP route, no
external API. User-facing Telegram notices reuse the existing notifyFn path.

## 7. Rollback cost
Lowest tier. Set `monitoring.rateLimitSentinel.codexUsageDetection: false` → the poll never
installs (instant, no redeploy). The recovery branch is inert unless a codex session is
report()'d (only the poll does that). Full PR revert is clean (additive).

## Conclusion
Safe to ship DARK. The concurrent-session correctness hole is gated entirely behind the
default-off flag + single-codex-session reality, and is a documented hard must-fix before the
flag is enabled.

## Second-pass review
Independent reviewer **CONCUR on shipping with detection DARK** (2026-05-31). Verified: v1
per-session-UUID bug gone; Claude path byte-identical; `findNewestRolloutSync` correct +
perf-safe (single statSync, no stat-storm); poll correctly gated/unref'd/error-isolated. Must-
fix-before-enable: the concurrent-session false-recovery (§5). Should-fix (follow-up): a
Tier-2/3 test for the detection poll wiring (the poll ships dark → lower risk).

## Evidence pointers
- Unit: `tests/unit/findNewestRolloutSync.test.ts`, `tests/unit/RateLimitSentinel-codex-recovery.test.ts`.
- Claude-unchanged: existing `tests/unit/RateLimitSentinel.test.ts` (message assertions pass).
- Spec: `docs/specs/ratelimit-sentinel-codex-parity.md` (+ `.eli16.md`).
