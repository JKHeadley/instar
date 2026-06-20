# Side-Effects Review — Feedback webhook 429 backoff (stop the retry storm)

**Tier:** 1 (contained fix to one manager + a pure helper).
**Files:** `src/core/feedbackBackoff.ts` (new pure helper), `src/core/FeedbackManager.ts` (wiring), `tests/unit/feedbackBackoff.test.ts`, `tests/unit/FeedbackManager.test.ts`.

## What changed

`FeedbackManager.retryUnforwarded()` previously looped the ENTIRE un-forwarded
backlog every scheduled cycle, POSTing each item; on a non-2xx it simply left the
item un-forwarded — so against a 429-ing endpoint it re-POSTed the whole backlog
forever (observed live 2026-06-20, topic 13481: 661 un-forwarded items, 2,384+ 429s).

Now a pure `decideFeedbackRetry()` classifies each webhook response:
- 2xx → mark forwarded, clear backoff.
- **429/503 → HALT the batch immediately** and set a backoff window (`Retry-After`
  if present, else exponential from 60s, capped at 1h).
- other non-2xx / network error → leave un-forwarded, retry next cycle (unchanged),
  no batch halt.

`submit()` and `retryUnforwarded()` both skip the webhook entirely while inside the
backoff window. State (`webhookNextRetryAtMs`, `webhookConsecutive429s`) is in-memory.

## The 8 questions

1. **Over-block.** While backed off, `submit()` skips the live POST and the item is
   stored locally un-forwarded (picked up by the next allowed retry cycle). No
   feedback is lost — only deferred. The local store is always written, exactly as
   before. Worst case: a feedback item is forwarded minutes later instead of
   instantly, during an active rate-limit — acceptable and correct.
2. **Under-block.** A non-429/503 error (e.g. a one-off 500) does NOT halt the batch
   — by design, since it is a per-item issue, not a pool-wide rate-limit. If an
   endpoint signalled overload with a bare 500 (not 503/429) the storm guard would
   not engage; this is the documented trade (we only treat the standard rate-limit
   statuses as "stop"). The exponential cap still bounds total backoff growth.
3. **Level-of-abstraction fit.** Correct layer: the decision is a pure helper; the
   FeedbackManager owns the I/O and the (in-memory) backoff state. No new subsystem.
4. **Signal vs authority.** It governs the webhook POST cadence only. It NEVER blocks
   the local feedback record (always written) and never gates anything else. It is
   the "Responsible Resource" / L364 (No Unbounded Self-Reinforcing Loops) standard
   made real for this loop.
5. **Interactions.** No shadowing. The scheduled `feedback-retry` job still drives
   `retryUnforwarded()`; this only changes what one cycle does (halt-on-429 instead
   of POST-all). The `feedback-factory` receiver/processor are unaffected (different
   path). In-memory state means a server restart re-probes once then re-backs-off —
   self-correcting, no persistence coupling.
6. **External surfaces.** This DECREASES external load (fewer POSTs to the canonical
   feedback endpoint) — strictly better citizenship. No new external call. Honors the
   server's `Retry-After` when provided.
7. **Multi-machine posture.** Machine-local BY DESIGN: each machine forwards its own
   local feedback store and keeps its own in-memory backoff. There is no shared state
   to replicate (the backoff is about THIS machine's POST cadence to the endpoint).
   No topic-transfer or URL-survival concern (no user-facing surface).
8. **Rollback cost.** Trivial: revert the two files. No migration, no persisted state,
   no config. Back-compatible — on a healthy (2xx) endpoint behavior is identical to
   before (forward immediately, no backoff ever set).

## Second-pass

Requested (retry/recovery loop with external side-effects).

**Reviewer verdict (independent): Concur with the review.** Confirmed: (1) stop-after-
first-429 is correct (`breakBatch`→`break` before any further POST); (2) next-cycle
gating is symmetric (submit `>= nextRetryAtMs`, retry early-returns on `<`); (3) no
item loss (un-forwarded items stay persisted+retryable, success-only save is safe);
(4) no stuck-forever (a 2xx always returns `nextRetryAtMs:0`+`consecutive429s:0`).
Two non-blocking notes: (a) the load→fetch→full-overwrite race in `retryUnforwarded()`
is **pre-existing** (`appendFeedback` already read-modify-writes) and untouched here —
not a regression; (b) a non-429 error mid-recovery reset the 429 streak, softening the
curve on a flapping endpoint. **Note (b) addressed in code**: the helper now PRESERVES
`consecutive429s` on a non-429 error and clears it only on a genuine 2xx, with a
flap-protection test. Note (a) is logged as a separate pre-existing item, out of scope.
