# Side-Effects Review — Circuit-breaker "reset after Ns" parsing

**Version / slug:** `circuit-breaker-reset-after`
**Date:** `2026-06-03`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Two regexes in `LlmCircuitBreaker.parseRetryAfterMs` change `\s+in\s+` → `\s+(?:in|after)\s+`,
so a provider's "reset **after** N seconds/minutes" hint parses to `retryAfterMs` the same way
"reset **in** N" already did. Adds three unit tests. No other code paths change.

## Decision-point inventory

None added. The change widens one existing best-effort parse; it introduces no new branch that
decides anything. The parsed value flows into the same `onRateLimited` clamp that already existed.

## 1. Over-block (false positive — a wrong/too-short window extracted)

`parseRetryAfterMs` only runs inside `classifyRateLimit`, i.e. on a message ALREADY classified as a
rate limit. The new alternation still requires the literal stem `reset`/`resets`/`try again`,
immediately followed by `after`, a number, and a time unit — so it cannot fire on unrelated prose.
Even if a genuine rate-limit message contained a misleading "reset after N" phrase, the extracted
value is bounded twice: `classifyRateLimit` clamps to `[1s, 15min]`, and `onRateLimited` floors to
`min(30s, openMs)`. The breaker therefore can never open for **less than 30s** or **more than 15min**
regardless of what parses. The blast radius of a mis-parse is at most "recovers 30s vs the old 15min"
— strictly safer than the bug being fixed.

## 2. Under-block (false negative — a window still missed)

Unchanged phrasings ("reset in Ns", "retry-after: N", "try again in N minutes") match exactly as
before — the change is purely additive (an extra alternation), so no previously-parsed message
stops parsing. Messages with no recognizable duration still return `undefined` and fall back to the
flat default, identical to today.

## 3. Interaction with #708 (gemini capacity policy)

#708 handles the structured provider path (it retries within a single `evaluate` with the
gemini-reported window). This fix is a layer up: it governs how long the GLOBAL breaker stays open
when a gemini failure propagates as a classified rate-limit. The two compose — #708 keeps a single
call resilient; this keeps a breaker trip proportionate. Neither overrides the other.

## 4. Reversibility

Pure code change, no migration, no persisted state, no config. Revert = revert the two regex edits.

## Verdict

Bounded, additive, no new decision surface. The only behavioral change is that gemini-style short
resets now produce a proportionate (≥30s) breaker window instead of a flat 15-minute pause.
