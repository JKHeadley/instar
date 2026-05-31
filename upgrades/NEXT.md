---
review-convergence: complete
approved: true
approved-by: echo (standing 12h deploy mandate, topic 13435; independent 2nd-pass review CONCUR ship-dark)
---

# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed — the rate-limit auto-recovery now works for codex sessions too (ships DARK)

The RateLimitSentinel keeps a throttled session alive: it notices, tells you "backing off,
you're not dropped," retries with escalating backoff, confirms recovery by watching the
session's transcript grow, and escalates if it never clears. This whole lifecycle was
Claude-only — a codex session throttled by OpenAI was invisible to it and could hang with
no recovery.

Now it's codex-aware. Recovery-verification reads the newest codex rollout (the OpenAI
limit is account-wide, so the newest rollout's growth is the "is codex producing output
again?" signal — no fragile per-session id needed, which was the earlier attempt's bug).
The user-facing notices use OpenAI wording for codex. A dark server-side poll reads
codex's own rate-limit flag and reports throttled codex sessions into the sentinel.

Claude behavior is byte-for-byte unchanged. The detection poll ships OFF by default.

## What to Tell Your User

Nothing changes yet — the codex side ships switched off. It is the groundwork so that a
codex agent that hits a temporary rate limit gets the same calm, automatic "backing off,
hang tight, here we go again" recovery a Claude agent already gets, once it is turned on.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Codex-aware rate-limit recovery | Automatic for codex sessions once detection is enabled. Recovery reads the newest codex rollout's growth. |
| Codex throttle detection poll | Set `monitoring.rateLimitSentinel.codexUsageDetection: true` (default false / dark). Off → instant rollback. |
| Per-vendor throttle wording | Codex notices say OpenAI / status.openai.com; Claude unchanged. |

## Evidence

- Unit: `tests/unit/findNewestRolloutSync.test.ts` (newest-by-filename, month/year crossing,
  empty-partition skip, null-safe, single-stat perf). `tests/unit/RateLimitSentinel-codex-recovery.test.ts`
  (grow→recover, no-grow→escalate, codex vendor wording = OpenAI not Anthropic).
- Claude-unchanged: existing `tests/unit/RateLimitSentinel.test.ts` message-asserting tests pass.
- `tsc --noEmit` clean; `npm run lint` clean.
- Independent second-pass review: CONCUR on shipping DARK. Known must-fix-before-enable:
  concurrent-codex-session false recovery (account-wide signal vs per-session state) — gated
  behind the default-off flag. See the spec + side-effects.
- Spec: `docs/specs/ratelimit-sentinel-codex-parity.md` (+ `.eli16.md`).
- Side-effects: `upgrades/side-effects/ratelimit-sentinel-codex-parity.md`.
