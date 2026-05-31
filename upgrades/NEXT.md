---
review-convergence: complete
approved: true
approved-by: echo (standing 12h deploy mandate, topic 13481; multi-machine live-transfer cascade)
---

# Instar Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed — a moved conversation now finishes its handoff instead of getting stuck

Another step toward the multi-machine "move this conversation to my other machine"
feature. The handoff tracks ownership in two steps: the router assigns the conversation
to the target machine (status "placing"), then the new owner is confirmed (status
"active"). The confirm step was never being issued, so a moved conversation stayed in
"placing" limbo forever — and the router's rule of "hold messages while a handoff is in
progress" then held every later message, so the move silently failed.

This release has the router issue the confirm right after it hands the conversation to
the target machine, advancing ownership to "active". From then on the router correctly
forwards your messages to the new owner. The state machine only allows confirming the
exact machine the conversation was just assigned to, so this stays safe.

## Summary of New Capabilities

- `SessionRouter` gains an optional `confirmClaim(sessionKey, machineId)` dep, invoked
  after a successful remote `spawnOnMachine`, advancing the ownership record
  `placing → active`. Self-placement (router keeps it) does not confirm.
- Wired in the server to the ownership-registry `claim` CAS.

## What to Tell Your User

If you run your agent on more than one machine and move a conversation between them, the
move now actually sticks — the receiving machine is confirmed as the new owner and your
following messages route to it, instead of the move quietly failing. This only applies
when the multi-machine session pool is on; single-machine agents are unaffected. Nothing
to configure. (Two related pieces are still in progress: ownership surviving a restart,
and the moved conversation being able to reply — tracked separately.)

## Evidence

- Found live on 2026-05-31: after a move, every later message logged
  "route … action=queued owner=?" and was handled back on the origin — the ownership
  state machine requires place→claim→active and the claim was never issued, so the
  record stayed "placing".
- Unit, `tests/unit/SessionRouter.test.ts`: a remote placement now confirms the owner
  (placing→active); a self-placement does not.
- Unit, `tests/unit/SessionOwnership.test.ts`: the place→claim→active transition.
- 47 SessionRouter + ownership + wiring tests pass; tsc --noEmit clean.
- Spec, `docs/specs/router-confirm-claim-on-place.md` plus the .eli16.md sibling.
- Side-effects, `upgrades/side-effects/router-confirm-claim-on-place.md`.
