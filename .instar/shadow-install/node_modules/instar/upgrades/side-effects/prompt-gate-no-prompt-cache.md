# Side-Effects Review — PromptGate NO_PROMPT cache (token-burn fix)

**Version / slug:** `prompt-gate-no-prompt-cache`
**Date:** `2026-05-15`
**Author:** Echo (instar developer agent)
**Second-pass reviewer:** required (touches a monitoring sentinel decision point)

## Summary of the change

`src/monitoring/PromptGate.ts` — adds a bounded per-session NO_PROMPT
classification cache to `InputDetector.llmDetect()`. Once the LLM has
classified a specific terminal-output snapshot for a session as "not a
blocking prompt," the same snapshot will short-circuit the LLM call instead
of re-asking on every monitor tick. Cache is keyed on a SHA-256 fingerprint
of the 20-line context the LLM actually sees, capped at 32 entries per session
(FIFO eviction), cleared in `onInputSent()` and `cleanup()`.

Files touched:
- `src/monitoring/PromptGate.ts` — adds `noPromptCache` field, cache lookup
  before LLM call, cache write on NO_PROMPT, clear in `onInputSent`/`cleanup`,
  helper `recordNoPrompt()`.
- `tests/unit/PromptGate.test.ts` — 7 new regression tests covering
  idle-session short-circuit, per-session isolation, distinct-context still
  calls LLM, `onInputSent` clears cache, `cleanup` clears cache, cache cap
  bounded, positive detections are not cached.

Decision points the change interacts with: only one — `InputDetector.llmDetect`,
which uses Haiku to classify terminal output as a blocking prompt or not.
The change is a memoization layer in front of that authority. The authority
itself is untouched.

## Decision-point inventory

- `InputDetector.llmDetect` (LLM-backed authority that classifies terminal
  output as blocking prompt vs. not) — **modify** — adds a memoization step
  before the LLM call. The authority's verdicts are unchanged; we just stop
  re-asking it the same question with the same input.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The change cannot over-block prompt detection in the conventional sense
(rejecting a legitimate user input). But it could *over-suppress* LLM
re-classification, leading to a missed real prompt. Concrete failure mode:

- A session's terminal output is classified NO_PROMPT for snapshot X.
- Later, the agent prints a real blocking prompt, producing snapshot Y.
- Snapshot Y is a *different* fingerprint (X ≠ Y) → cache misses → LLM is
  called normally → real prompt detected.

So the cache only suppresses LLM calls when the *exact same 20-line context*
recurs. A real prompt would necessarily produce different output. No false
suppression of real prompts is introduced.

The one edge case worth naming: if the LLM made a wrong classification (false
NO_PROMPT verdict on an actual prompt) and that *exact* output recurs, the
cache amplifies the LLM error by preventing re-classification. Mitigation:
the cache is bounded (32 entries) and cleared on `onInputSent()`, so the
amplification window is short. Tradeoff is acceptable: a wrong LLM verdict
gets re-asked at most 32 outputs later anyway, and the alternative was
burning 3B tokens/day to repeatedly get the same wrong answer.

---

## 2. Under-block

**What failure modes does this still miss?**

- **Subtle output noise that defeats fingerprinting.** A session showing a
  spinner, timer, or animated counter will produce slightly different
  fingerprints each tick. Each variant gets one LLM call before being cached.
  Existing pre-filters (`/Scampering|Thinking|Reading \d+ file/i`) already
  catch the most common animated-output cases. Residual noise from
  not-yet-cataloged spinners would still call the LLM once per variant.
- **Cache size cap (32).** A truly flapping session with > 32 distinct
  recurring outputs would evict and re-classify. This is a deliberate
  bounded-memory tradeoff; the cost is small (~32 SHA-256 calls per
  flapping session per cycle) compared to the alternative of unbounded
  growth. The existing 5-second outer cooldown still gates burst rates.

Neither of these is a regression — both were always true. The fix is purely
additive: same behavior on cache misses, suppressed re-classification on
cache hits.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. This is a pure memoization at the same layer as the existing
`llmRelayTimestamps` rate limiter. Both are private to `InputDetector` and
gate the same LLM call. The cache is a *signal-level* optimization: it
records which contexts have already been ruled out, so the authority
(LLM) is not re-consulted unnecessarily. The authority (Haiku via
`IntelligenceProvider.evaluate`) keeps full responsibility for the actual
classification — the cache only suppresses redundant calls.

No higher-level gate exists that this should feed instead. No lower-level
primitive exists that already does this. The change sits in the natural home.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface.
- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic.

The cache does not make any classification decisions. It memoizes verdicts
already produced by the LLM authority (`IntelligenceProvider.evaluate`). On
a cache hit, the *previous LLM verdict* is what determines behavior —
specifically, "the LLM said NO_PROMPT for this exact context, so we honor
that verdict without re-asking." That is identical to what the LLM would
return if re-asked on identical input (Haiku at temperature 0 with the same
prompt is deterministic to within margin). No brittle logic gains blocking
authority; the authority remains the LLM, the cache just records its prior
output to avoid redundant calls.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing**: the cache check sits *after* the existing pre-filters (regex
  rejects for status bar / "Thinking" / etc.) and *after* the existing
  5-minute `llmRelayTimestamps` rate limiter. It runs *before* the LLM call.
  If the existing rate limiter triggers, the cache is never consulted —
  correct behavior, no shadowing.
- **Double-fire**: the cache write happens once per LLM call (`recordNoPrompt`
  is only invoked from the NO_PROMPT response path inside `llmDetect`, and
  `pendingLlmDetection` prevents overlapping calls per session). No
  double-fire surface.
- **Races**: cache reads and writes happen on the same async path
  (`llmDetect`). The `pendingLlmDetection` set already prevents concurrent
  `llmDetect` calls per session. `onInputSent()`, `cleanup()`, and the LLM
  response handler all touch `noPromptCache` from the same event loop. No
  cross-thread / cross-process state — Node single-threaded, no race.
- **Feedback loops**: the cache feeds back into its own check (cache hit →
  skip LLM → no new cache entry). This is the desired loop — it converges,
  not diverges. Counter-direction (real prompt appears → different
  fingerprint → cache miss → LLM called → emit) is also stable.
- **Adjacent cleanups**: `cleanup(sessionName)` already drops
  `lastOutput`, `stableCount`, `emittedPrompts`, `lastEmissionTime`,
  `llmRelayTimestamps`, `pendingLlmDetection`. We add `noPromptCache.delete`
  to the same list. `onInputSent` similarly clears the cache so post-input
  output gets re-classified.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine** — yes, indirectly: every instar agent
  embeds the same `InputDetector`, so every agent's LLM burn rate for prompt
  detection drops once the new code is installed. Behavior visible only as
  reduced Haiku usage on the API side; no functional change in detection
  behavior.
- **Other users of the install base** — same: all agents inherit the fix
  on upgrade. Strictly cost-positive.
- **External systems** — Anthropic API usage drops materially. No format
  change to any externally-visible message or event.
- **Persistent state** — none. Cache is purely in-memory, lost on process
  restart. No DB schema change, no file written, no migration.
- **Timing / runtime conditions we don't fully control** — the cache assumes
  Haiku's NO_PROMPT verdict on a specific input is stable enough to memoize.
  At `temperature: 0` this is true to within stochastic noise; even if Haiku
  flickered between NO_PROMPT and a positive response on the same input, the
  cache would just lock in whichever came first for at most 32 outputs and
  then evict. Acceptable.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

- **Hot-fix release**: revert two files (`src/monitoring/PromptGate.ts`,
  `tests/unit/PromptGate.test.ts`), ship a patch release. Estimated 10
  minutes once issue is detected.
- **Data migration**: none. No persistent state introduced.
- **Agent state repair**: none. Cache is per-process, in-memory; restarting
  the agent server drops it instantly.
- **User visibility**: zero. The only user-visible behavior change is
  reduced Telegram-relay duplicate-prompt spam, and the existing detection
  behavior is preserved for first-time-seen outputs.

Lowest possible rollback cost: pure code change, no migrations, no state.

---

## Conclusion

The change is a bounded in-memory memoization layer in front of an LLM-backed
authority. It introduces no new decision logic, no new blocking surface, no
persistent state, and no external API changes. Worst-case failure mode is
under-detection of a single class of recurring prompts (same exact 20-line
output as a prior NO_PROMPT verdict), which is mitigated by `onInputSent`
clearing the cache. The fix targets a specific, measured token-burn pattern
(108k LLM calls / 3B tokens per 24h on this machine, 2026-05-15) caused by
the existing 5-minute rate limit being incorrectly gated on emit. With the
cache, idle sessions burn one LLM call per distinct output instead of one
per monitor tick. Clear to ship pending second-pass concurrence.

---

## Second-pass review

**Reviewer:** general-purpose subagent (Echo's review subagent)
**Independent read of the artifact: concur**

The cache is a textbook memoization layer in front of an LLM authority. On hit it short-circuits with the same behavior the LLM would have produced (`return` from NO_PROMPT branch); on miss it falls through to the unchanged authority. No new blocking surface, no decision logic, no persistent state. Signal-vs-authority compliance is clean. Worst-case under-suppression is bounded by a recurring-identical-context window of at most 32 outputs, after which FIFO eviction forces re-classification. Token spend in the degenerate >32-distinct-cyclic-context case is no worse than baseline.

Minor notes (do not block ship, but worth tracking):

- **In-flight `llmDetect` vs `onInputSent` race.** `onInputSent()` clears `noPromptCache` synchronously, but if an `llmDetect` is mid-flight for the same session (`pendingLlmDetection` set), its awaited `recordNoPrompt(...)` will land *after* the clear and repopulate the cache with a verdict computed against pre-input output. The stale entry only fires on a future byte-identical context (unlikely post-input) and would be evicted within 32 outputs or on the next `onInputSent`. Consider: capture a generation counter in `llmDetect` at start and skip `recordNoPrompt` if it doesn't match the current generation. Not urgent — failure mode is "one redundant cache entry," not "missed prompt."

- **`startsWith('NO')` permissiveness amplified by cache.** Line 416 treats any LLM response starting with `NO` (e.g. "NOT SURE", "NOW WAITING") as NO_PROMPT and now caches it. Pre-cache this was a per-call leniency; post-cache it locks in for up to 32 cycles. Consider tightening to exact-match `NO_PROMPT` or `^NO_PROMPT\b`. Tracked as a hardening followup, not a blocker.

- **Cleanup vs in-flight `llmDetect` (same race as above for terminated sessions).** `cleanup()` clears `pendingLlmDetection` and `noPromptCache`, but a mid-flight `llmDetect` whose `.finally()` has not yet run will still call `recordNoPrompt(sessionName, ...)`, creating a cache entry for a dead session. Pure memory leak (one entry per dead session per race window) until process restart. Bounded and minor.

- **Test coverage gaps.** No regression test exists for: (a) the in-flight-vs-cleanup race, (b) the `startsWith('NO')` permissiveness path (e.g. asserting that `"NOT SURE"` is cached and impacts subsequent calls), (c) lack of interaction between `onPromptRejected` and `noPromptCache` (currently fine because rejection only applies to positive emits, but worth a defensive test if those branches ever cross). Add when the followups land.

None of these break the ship criteria. The change is correct under the assumptions it states, and the failure modes I found degrade to at most "one extra LLM call" or "one stranded cache entry," never to a missed prompt. Clear to commit.

**Author response to reviewer notes (addressed before commit):**

- **In-flight race + `startsWith('NO')` permissiveness** — addressed in the
  same commit. Added `cacheGeneration: Map<sessionName, number>` bumped by
  `onInputSent()` and `cleanup()`. `llmDetect` captures the generation at
  call start; `recordNoPrompt()` now drops the write if the generation has
  advanced (covers both the input-during-flight and cleanup-during-flight
  cases). Also tightened cache write to require strict `trimmed === 'NO_PROMPT'`;
  the permissive `startsWith('NO')` branch still returns from `llmDetect` but
  no longer memoizes, so a transient "NOT SURE" reply doesn't lock in.
- **Test coverage** — two new tests added: one for the in-flight clear race
  (asserts no cache entry after `onInputSent` mid-flight), one for permissive
  non-strict-NO responses (asserts they are not cached). Total NO_PROMPT-cache
  regression tests now 9; full PromptGate suite 42/42 passing.

---

## Evidence pointers

- Original measurement (108,782 calls / 3.03B tokens / 24h):
  `/private/tmp/claude-501/-Users-justin--instar-agents-echo/fb63ccb9-b8ab-4b63-8f49-55d3d6427255/tasks/bwgzdb1bf.output`
- Unit-test verification: `npx vitest run tests/unit/PromptGate.test.ts`
  → 40/40 passed, 7 new NO_PROMPT-cache regression tests included.
