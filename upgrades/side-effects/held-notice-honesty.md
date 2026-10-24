# Side-Effects Review — a held-reply notice must not promise a retry it will not perform

## Summary of the change

The attention item raised when an outbound reply is held says it "is held durably
and retried on the recovery schedule." Two different kinds of hold share that
text, and for one of them the retry never happens.

A **forwarded** hold (the reply is handed to the lease holder and the handover
fails) is genuinely retried. A **direct-path** hold — taken when this machine
sealed the record before discovering it does not hold the serving lease — cannot
be forwarded at all: the sealed record is bound to the machine that produced it.
It can only be sent if the lease returns, and otherwise expires.

The direct-path call site now passes `awaitsLeaseReturn: true`, and that branch
states the truth: cannot be forwarded, not retried, expires unless the lease
returns here.

**Measured, on one agent:** 152 direct-path operations — 0 ever retried, 0 ever
sent, 133 expired undelivered, the oldest eleven days old. Each produced a notice
saying it was being retried.

## Decision-point inventory

One: *which of two sentences does this notice carry?* Determined by the call site,
which already knows which kind of hold it took. No inference, no new state.

## 1. Over-block

Nothing is blocked. This changes words in an attention item. The only "over" risk
is wording a forwarded hold as unretried — impossible, because the flag is passed
at exactly one call site, the one inside `onLeaseHoldObserved`, which is by
construction the direct-path handler.

## 2. Under-block

The **aggregate** summary (several topics collapsed into one item) still uses the
original "held durably and retried" phrasing. A mixed aggregate could therefore
still over-promise. Left deliberately: the aggregate spans both kinds and the
per-topic items carry the accurate text. Narrowing it correctly needs the
collapser to track kind per topic, which is a larger change than this one earns.
Stated here rather than silently accepted.

## 3. Level-of-abstraction fit

The notice text belongs where the kind is known. `raiseHeldItem` is called by both
paths and could not previously tell them apart; passing the fact from the site
that has it, rather than re-deriving it, is the smaller and more honest shape.

## 4. Signal vs authority compliance

No authority. This is a message-content change that blocks nothing, gates nothing,
and alters no delivery behaviour. The same replies are held, retried or expired as
before. Only the sentence differs.

## 5. Interactions

- `heldCollapser` — unchanged; the aggregate path is untouched (see §2).
- `onHeldForwardExpired` — unchanged; the expiry item is separate and already
  honest about what happened.
- The audit (`logs/telegram-origin-held.jsonl`) — unchanged; phases are untouched,
  so the lifecycle analysis that produced the measurements above still holds.

## 6. External surfaces

An attention item's text changes for one class of event. No id, category, priority
or routing change, so dedupe and collapse behaviour are unaffected.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design and by subject: the notice describes *this* machine's
inability to send, raised by the machine that could not send. Nothing replicates.
The condition it reports is itself a multi-machine condition, which is why the new
wording names the lease rather than an internal reason code.

## 8. Rollback cost

One optional field and one ternary, in one file. Reverting restores the previous
sentence. No migration, no persisted state, no config.

## Verification performed

- `tsc --noEmit` clean.
- `tests/unit/held-notice-honesty.test.ts` — asserts the direct-path wording says
  it is not retried and names the lease, asserts the forwarded wording is
  unchanged, and asserts the two are not the same string.
- The claim that direct-path holds are never retried is not assumed: it is
  measured from the held-origin audit by grouping every operation by its recorded
  lifecycle (152 direct-path, 0 with any recovery phase, 133 expired).
