# Side-Effects Review — Jev shadow: disagreement excerpts

**Version / slug:** `jev-shadow-disagreement-excerpts`
**Date:** `2026-09-24`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier 1; observe-only research instrument, no decision surface, off by default)`

## Summary of the change

The shadow trial recorded only `sha256` per message, so its 49 disagreements
could be counted but never adjudicated — uninterpretable in both directions.
Adds opt-in retention of a scrubbed, detector-span-anchored excerpt on
DISAGREEING rows only, with a per-UTC-day volume cap.

## Decision-point inventory

- *(none)* — the shadow decides nothing and gates nothing. This adds a field to
  a research log.

---

## 1. Over-block

Nothing is blocked. The only "refusal" is declining to retain: an agreeing row,
a disabled flag, a missing detector span, an exhausted daily cap, or a scrub
error each yield no excerpt, and the last three say which in
`excerptUnavailable` rather than going silent.

## 2. Under-block

Deliberate: where the MODEL fired and the detector did not, there is no span to
anchor to and nothing is kept (`no-detector-span`). Those disagreements stay
unadjudicable. Widening the window to the message would cover them at the cost
of retaining full text of messages neither side located an artifact in — the
exposure this design exists to avoid. 12 of 52 observed disagreements are this
shape; the other 40 are covered.

## 3. Level-of-abstraction fit

Built at the existing dispatch chokepoint, which already holds the message, the
detector signals and the verdict. No new layer, no second pass over the text.
The detector's `spans` (already produced and already capped at 8/signal) are
reused rather than re-deriving positions.

## 4. Signal vs authority compliance

Signal-producer with no authority. Per `docs/signal-vs-authority.md` a brittle
mechanism may inform and must not block; this one only appends a field to a
JSONL research row. Every failure path returns "no excerpt", never an exception
into the message path (`observe` remains try/caught and fire-and-forget).

## 5. Interactions

- Runs strictly after `disagree` is computed; cannot change it.
- Does not touch the request to the provider — the body is unchanged.
- The daily counter is per-instance and resets on restart. It bounds VOLUME,
  not secrecy: per-excerpt secrecy is carried by span-anchoring and the scrub,
  which hold regardless of the count. Stated rather than implied, because a
  reset-on-restart counter must not be read as a retention guarantee.

## 6. External surfaces

None. Excerpts are written to the existing machine-local trial log and are not
served over HTTP, replicated, or sent to the provider. The full message already
reaches the provider for comparison — unchanged by this work.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN. The trial log is a per-machine research artifact; each
machine compares its own traffic and keeps its own rows. Nothing is replicated
or merged, so there is no cross-machine read to keep coherent and no
topic-transfer stranding (the log is not conversation state).

## 8. Rollback cost

Remove `retainDisagreementExcerpts` from the config block — retention stops
immediately (live config read, no restart). Existing rows remain valid JSONL
with an extra field readers may ignore. Deleting already-retained excerpts is a
file edit on one machine-local log.
