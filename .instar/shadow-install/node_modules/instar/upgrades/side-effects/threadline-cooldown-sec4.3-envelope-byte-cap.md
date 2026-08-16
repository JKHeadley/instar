# Side-Effects Review — Threadline §4.3 commit 1: payload byte-size cap

**Version / slug:** `threadline-cooldown-sec4.3-envelope-byte-cap`
**Date:** 2026-04-19
**Author:** echo
**Second-pass reviewer:** not required (pure admission gate; oversized payloads are refused at the entry point with no side effects)

## Summary of the change

First commit of §4.3. Adds a payload byte-size cap so peers can't drink drain-tick budget with bulk content. Spawn requests whose `context` exceeds `maxEnvelopeBytes` (default 256 KiB) are refused at admission with a distinct `envelope-too-large` reason BEFORE any cooldown / queue side-effects.

This is the first of several §4.3 commits. Subsequent commits will add: hashing of envelope content (for tamper detection), gate freeze/downgrade policy, three-tier admission caps, truncation marker.

Files touched:
- `src/messaging/SpawnRequestManager.ts` — `DEFAULT_MAX_ENVELOPE_BYTES` constant; `maxEnvelopeBytes` config field; admission check at top of `evaluate`.
- `tests/unit/spawn-request-manager.test.ts` — 5 new tests: refusal above cap, exact-cap acceptance, default 256 KiB enforcement, UTF-8 byte counting (not code units), no queue side-effect on refusal.

## Decision-point inventory

1. **Check at the very top of `evaluate` (before cooldown).** Bulk-content rejection is cheaper to do first — no cooldown side-effect, no queue write, no penalty interaction. Spec says "refused at enqueue", which `evaluate` is the entry to.
2. **`Buffer.byteLength(context, 'utf8')` for sizing.** Spec specifies bytes, not code units. A peer sending 65k 4-byte emojis would only be 65k characters but 256k bytes — the byte count is what affects drain budget.
3. **Default 256 KiB.** Spec literal. Configurable via `maxEnvelopeBytes`.
4. **Refusal reason is a distinct string `envelope-too-large`.** Easy to grep / pattern-match in logs and DegradationReporter (added in §4.5).
5. **Boundary inclusive at exactly cap (i.e., `bytes > maxBytes`, not `>=`).** A 256 KiB envelope is allowed; 256 KiB + 1 byte is not. Matches usual cap semantics.

## Blast radius

- **Existing callers below 256 KiB:** zero behavior change.
- **Existing callers above 256 KiB (if any):** would now be refused. Quick grep confirms no production caller sends bulk content via `SpawnRequest.context`; the field is small text strings (typically a one-paragraph reason). Risk: zero in practice.
- **Cap configurability:** consumers that need a larger cap can pass `maxEnvelopeBytes` in config.

## Over-block risk

A legitimate caller passing a large but valid context would be refused. Mitigation: the cap is configurable; default is generous (256 KiB ≈ a small novel). If a real workflow needs more, it can either chunk or raise the cap.

## Under-block risk

The cap only protects the `context` string. Other queue side effects (e.g., spawn prompt construction in `#buildSpawnPrompt`) could in theory grow large from queued message accumulation, but `MAX_QUEUED_PER_AGENT × maxEnvelopeBytes` is the bounded worst case (256 KiB × 10 = 2.5 MiB for one peer's queue), which is acceptable.

## Level-of-abstraction fit

Check lives in `evaluate` because that's the entry point where `SpawnRequest` arrives. No separate validator class needed for one constant comparison.

## Signal-vs-authority compliance

The check is a hard authority gate (refusal) at the right boundary (admission). Not a signal — refusal is final and the caller must respect it. Compliant.

## Interactions

- **§4.2 cooldown / penalty / soft limiter:** unaffected. Refusal happens first, so no queue / cooldown / penalty state is touched.
- **§4.3 future commits:** envelope hashing and admission caps will compose with this check. The cap is the cheapest gate to evaluate, so it stays first.
- **§4.4 config plumbing:** `maxEnvelopeBytes` will be exposed via runtime PATCH endpoint (next commit). Already wired through the constructor.

## Rollback cost

Revert. Default behavior reverts to "no cap" at this layer (the broader system has no other byte-cap protection here). No persisted state.

## Tests

- 5 new tests under `describe('§4.2 drain loop', ...)` (sharing the existing setup): refusal above cap, exact-cap accepted, default 256 KiB enforcement, UTF-8 byte counting via emoji, no queue side-effect on refusal.
- All 49 prior tests pass unmodified.
- `npx tsc --noEmit`: clean.

## Rollout

Ships on `feat/threadline-cooldown-queue-drain`. Next §4.3 commits: envelope hashing (SHA-256 with versioned prefix), three-tier admission, gate freeze/downgrade, truncation marker.
