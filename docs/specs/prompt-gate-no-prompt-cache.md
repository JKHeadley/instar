---
slug: prompt-gate-no-prompt-cache
review-convergence: converged
approved: true
approved-by: justin
iterations: 1
---

# PromptGate NO_PROMPT Cache — Stop Idle-Session Token-Burn

## Problem

`InputDetector.llmDetect` in `src/monitoring/PromptGate.ts` is the LLM-backed authority that classifies terminal output as a blocking prompt versus background activity. On 2026-05-15 it accounted for ~108,782 LLM calls / ~3.03 billion tokens in 24 hours across all instar agents on this machine — by itself, 73% of the machine's entire 24h token spend.

Root cause: the class has a 5-minute per-session rate limit (`llmRelayTimestamps` + `LLM_RELAY_COOLDOWN_MS = 300_000`) intended to cap re-classification. But the timestamp is **only set when the LLM detects a real prompt and emits it**, not when it returns NO_PROMPT. For idle sessions sitting at the same `❯` terminal output across many ticks, the LLM kept getting re-asked every ~5 seconds, returned NO_PROMPT every time, and the rate limit never engaged. The outer 5-second cooldown (`COOLDOWN_MS` on `lastEmissionTime`) has the same bug — it gates on emit, not attempt.

Observed call rate over the most recent 8 hours: 3,400–5,000 LLM calls/hour, ~125M tokens/hour. Direct cause of Justin's "we're burning tokens very fast again" report on topic 8615.

## Root Cause

`src/monitoring/PromptGate.ts`, lines 269–278 (origin/main): `llmDetect` is fired whenever stableCount ≥ 2 and the 5-second outer cooldown allows. Inside `llmDetect`, line 333 gates on `llmRelayTimestamps`, which is only set inside `if (emitted)` at the very end of the function. NO_PROMPT classifications never touch the gate, so for sessions in the steady "no real prompt" state, the LLM is re-consulted on every tick.

The historical evolution explains the bug: the rate limiter was originally named for its actual semantic — *throttle relays to the user* — and was correctly set only on emit. Later, the gate at the start of `llmDetect` was repurposed to also gate LLM calls (not just relays), but the set-site wasn't updated. The naming/semantics drift went unnoticed because the symptom (excessive cost) was diffuse and only became visible once the token ledger was running.

## Fix

Add a bounded per-session NO_PROMPT classification cache (`noPromptCache: Map<string, { set: Set<string>; order: string[] }>`) keyed on a SHA-256 fingerprint of the same 20-line context the LLM sees. Before calling the LLM, `llmDetect` checks the cache; on hit, it returns without consulting the LLM. On NO_PROMPT verdict, it adds the fingerprint to the cache. FIFO eviction at 32 entries per session.

Hardening (added in response to second-pass review):

- **Generation counter** (`cacheGeneration: Map<string, number>`) bumped on every `onInputSent()` and `cleanup()`. `llmDetect` captures the generation at call start and `recordNoPrompt` drops the write if it has advanced. Prevents a mid-flight stale verdict from repopulating the cache after the session has received input or been cleaned up.
- **Strict NO_PROMPT cache write** — only the exact `trimmed === 'NO_PROMPT'` signal is cached. The permissive `startsWith('NO')` branch still returns from `llmDetect` (preserving existing behavior) but is not memoized, so transient confused LLM responses don't lock in.

The cache is purely in-memory, lost on process restart, and adds no persistent state, no migration, no external API surface.

## Acceptance Criteria

1. Idle session showing the same terminal output across many monitor ticks produces at most 1 LLM call regardless of how many ticks occur.
2. Different terminal output produces a fresh LLM call (cache is keyed on context, not session).
3. After `onInputSent(sessionName)`, the same prior output triggers a fresh LLM call (cache cleared on input).
4. Positive prompt detections are not cached — a real prompt is detected the first time it appears, on every session.
5. Cache size is bounded per session (cap 32 with FIFO eviction).
6. Mid-flight `llmDetect` that resolves after `onInputSent` or `cleanup` does not repopulate the cache.
7. Permissive `startsWith('NO')` responses (e.g. "NOT SURE") do not enter the cache.
8. Existing regex-pattern detection and per-session cooldown behavior is unchanged.

All eight criteria are pinned by regression tests in `tests/unit/PromptGate.test.ts` (42 total, 9 new for this fix).

## Decision Points (signal vs authority)

The InputDetector's LLM classification is the authority for "is this session blocked on input." The cache is a memoization layer in front of that authority — it records prior LLM verdicts to avoid re-asking. On hit, the cache returns the LLM's *prior* verdict; on miss, the LLM runs unchanged. No new blocking surface, no brittle detector gaining authority. Compliant with `docs/signal-vs-authority.md`.

## Rollback

Revert two source files (`src/monitoring/PromptGate.ts`, `tests/unit/PromptGate.test.ts`) and ship a patch release. No persistent state, no migration, no external API change. Estimated 10 minutes from detection to revert.

## Side-Effects Review

`upgrades/side-effects/prompt-gate-no-prompt-cache.md` — full 7-question review with second-pass reviewer concurrence appended. Two hardening items raised in second-pass review were addressed in the same commit (see "Author response" section).

## Convergence Notes

Single-iteration convergence. The conversational alignment with Justin (Telegram topic 8615, 2026-05-15) covered: (1) measurement of the burn pattern — agreed; (2) root cause located in `PromptGate.ts` — confirmed by source read; (3) approval of the cache-based fix with focus on stopping the bleeding — explicit ("yes, please proceed with a focus on immediate steps to stop the bleeding"); (4) second-pass reviewer subagent verdict — concur with two hardening notes, both addressed in commit. No design alternatives required exploration — the bug location and fix shape were unambiguous from the source read.
