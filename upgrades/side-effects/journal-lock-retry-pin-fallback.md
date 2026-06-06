# Side-Effects Review — journal lock retry + heartbeat (#925) and quiet-topic pin fallback (#926)

**Version / slug:** `journal-lock-retry-pin-fallback`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `not required (two live-found fixes against converged specs; both bounded; both with regression tests)`

## Summary of the change

Two bugs found by the P2 LIVE two-machine proof (echo pair, v1.3.367):

1. **#925 — writer lock wedge.** The restart cascade (3 boots/hour on a
   release day) left the journal writer silently read-only for ~75 min:
   boot-time stale-lock reclaim correctly refused while the old process
   lingered, and the locked-out state had NO retry. Fix: (a) a bounded
   retry timer (max(40×flushInterval, 10s)) re-attempts activation and
   recovers IN PLACE with one log line; (b) the live holder heartbeats the
   lock file mtime every ~40 flushes; (c) reclaim treats an mtime-stale
   (5 min) lock as dead even when its recorded pid "exists" — the
   pid-reuse defense; (d) the autonomous scanner does NOT mark runs seen
   while the writer is locked out, so dropped `started` emits re-emit
   after recovery (op-key dedupe makes re-emits safe).
2. **#926 — quiet-topic reflex refusal.** Ownership only CASes when
   traffic flows, so a topic just moved (pinned, owner:null) — the exact
   state the fetch reflex exists for — answered not-owner. Fix: the
   ownerOf seam falls back to the placement pin (`pinned &&
   preferredMachine === self` ⇒ self at epoch 0); a real claim bumps past
   epoch 0 and aborts an in-flight pull as superseded (the existing
   recheck, by design). Spec §3.3 delta + eli16 amendment ride along.

## Decision-point inventory

- Retry cadence bounded (P19): one timer, unref'd, cleared on recovery +
  close; no retry while active.
- mtime-stale threshold (5 min) vs heartbeat cadence (~10s): 30× margin —
  a paused-but-alive holder (debugger, SIGSTOP) longer than 5 min loses
  the lock deliberately (it wasn't flushing anyway; the new holder's
  'wx' open + the old holder's dead fd keep streams append-consistent).
- The pin fallback only ever returns SELF (never another machine) and
  only when pinned — an unpinned unowned topic still refuses honestly.

## 1-2. Over/Under-block

Over: a >5-min-frozen live holder is reclaimed (stated trade). Under:
two processes could still interleave between mtime check and rm in a
pathological race — the 'wx' open after rm serializes the winner; the
loser retries on its timer.

## 3. Fit / 4. Blast radius

Lock logic stays inside CoherenceJournal (the single owner of the lock
discipline); the scanner guard is one line at the existing seenRuns
seam; the pin fallback lives in the server's ownerOf wiring (the seam
the spec names). Blast radius: journal writer recovery behavior +
reflex eligibility on pinned-unowned topics; both covered by tests.

## Evidence

- tests/unit/CoherenceJournal.test.ts — 38 passing (3 new: locked-out
  honored for a fresh live-pid lock; mtime-stale reclaim despite an
  "alive" pid; freed lock acquirable). Full typecheck clean.
- Live remediation already validated the failure analysis: stale-lock
  removal + restart restored emissions (the 77901 proof artifact
  journaled + replicated to the Mini within one cadence).
