# Live-proof fixes: quiet-topic fetch ownership + commitment replication wiring

## What Changed

Two more wiring truths surfaced by the live two-machine proof:

1. The "this conversation was deliberately moved here" pin is kept by the
   machine that DID the moving (the lease holder) — the machine it moved
   TO couldn't see it, so the workspace fetch still refused on the
   receiving side. The receiver now also accepts the mover's replicated
   placement diary entry (emitted at the router's CAS chokepoint) as
   proof it's the home; the per-write ownership recheck still aborts on
   any real claim.
2. Machines announced their promise-list versions on every heartbeat, but
   the listener's response parsing discarded the field — so commitment
   replication NEVER actually fired in either direction. One pass-through
   line fixes it, plus a source-shape regression test on the seam the
   integration suite had bypassed.

## What to Tell Your User

Nothing to do — these complete the "files follow the conversation" and
"promises visible everywhere" features so they work from the machine that
actually needs them, not just in tests.

## Summary of New Capabilities

- wsOwnerOf second fallback: newest topic-placement journal entry
  (own+replica) ⇒ self-ownership for the pull (issue #930).
- fetchPeerCapacity passes commitmentsAdvert through to
  driveCommitmentsSync (the P1.5a replication enabler).

## Evidence

tests/unit/working-set-ownerof-wiring.test.ts (both fallback steps + the
advert pass-through); typecheck + wiring suites green. The staged live
proofs complete on the echo pair once this ships.
