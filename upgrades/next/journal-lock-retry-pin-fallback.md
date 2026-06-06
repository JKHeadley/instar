# Journal writer self-recovery + quiet-topic fetch fix

## What Changed

The first LIVE run of the P2 working-set proof caught two real bugs; both
are fixed with regression tests.

1. On release days the server restarts in quick succession — the
   coherence journal's writer lock could be left held by a dead process,
   and the new writer sat silently read-only until the NEXT restart (75
   live minutes of missing placement/run history). The writer now retries
   on a bounded timer and recovers in place; live holders heartbeat the
   lock so even a recycled process id can't impersonate one.
2. A conversation deliberately moved to a machine — but quiet since the
   move — had no recorded owner, so the "go fetch this topic's workspace"
   reflex refused to run in exactly the situation it was built for. The
   deliberate placement (the pin) now counts as ownership until real
   traffic takes over.

## What to Tell Your User

Nothing to do. Your machines' shared history can no longer silently stop
recording after updates, and fetching a moved conversation's files works
even before you've sent it a new message.

## Summary of New Capabilities

- CoherenceJournal: lock retry timer + mtime heartbeat + pid-reuse-proof
  stale reclaim (issue #925).
- Working-set ownerOf seam: placement-pin fallback for unowned topics
  (issue #926; WORKING-SET-HANDOFF-SPEC §3.3 delta).
- Autonomous scanner: runs are not marked seen while the writer is
  locked out (dropped emits re-emit after recovery).

## Evidence

3 new lock tests (38 total in CoherenceJournal.test.ts); live remediation
on the echo pair confirmed the analysis end-to-end.
