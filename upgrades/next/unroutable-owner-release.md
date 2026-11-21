# A conversation owned by a machine that left the pool moves to a live machine on its own

## What Changed

- New shared rule `src/core/unroutableOwner.ts`: a topic owner is *unroutable* when the machine registry marks it revoked, or when it is absent from the registry and the pool view and its replicated journal has been silent at least 9 minutes (with a fresh journal sync, outside the first 9 minutes after boot). An unreadable registry, no journal evidence, or recent activity all read as routable.
- Session router: an inbound message for a topic whose owner is unroutable is taken over by the lease holder (version-conditioned `force-claim`, journaled as a placement) and answered there, after the usual local placement checks. Before, the owner-dead path used `place`, which the ownership FSM refuses on a live record, so the message waited in custody forever.
- Stale-owner engine: unroutable owners are treated as expired without adverts or probes, and their claims land even while the engine is in dryRun (opt-out `multiMachine.sessionPool.staleOwnerRelease.unroutableOwnerLive: false`). Lease-holder-only, per-tick cap and per-topic budget are unchanged.
- `POST /pool/transfer`: a topic owned by an unroutable machine now really moves (force-claim to the target, `seatMoved: true`), and the transfer no longer asks for an unsatisfiable confirmation because the dead owner's run state "could not be verified".
- Fixes the U4.2 evidence-5 mirror lookup: it read `streams[machineId]`, but journal streams are keyed `<machineId>.<kind>`, so every owner looked quiet. The check now sees real recent activity.

## Evidence

Incident 2026-11-20 (fb-b3d47791-3fb): after the Mac Studio rebuild, 47 active topics on the Studio and ~200 on the Laptop/Mini/Mama PC were still owned by the old Studio id, including the Chief of Staff topic; the server log showed `route topic 141385 → action=queued … (ownership-contention)` for every owner message. Unit, integration and e2e tests reproduce each dead end and its fix; the e2e test moves a revoked owner's topic through the real AgentServer stack.

## What to Tell Your User

If one of your computers is wiped or replaced, the conversations it was handling now move to a working computer by themselves, so your messages keep getting answered instead of only "your message didn't reach the session" notices. Moving a conversation by hand also works in that situation now.

## Summary of New Capabilities

- Conversations owned by a removed or replaced machine are taken over automatically by the machine in charge.
- Manual moves of such conversations succeed and report truthfully.
