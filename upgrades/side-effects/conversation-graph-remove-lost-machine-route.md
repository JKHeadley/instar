# Side effects: owner route for removing a lost machine

## What changed

The components for removing a permanently lost machine existed and were tested, but only a test helper composed them. An owner had no way to reach them. This adds that way.

- `src/server/ConversationGraphMemberLossSurface.ts`: `prepare`, `confirm` and `status` routes under `/conversation-graph/member-loss/` and `/mobile/conversation-graph/member-loss/`. It runs the existing components in order: hold, inventory, preflight, consent, native revocation, execution. Confirm answers 202 and the work continues in the background.
- `ConversationGraphDefaultSurface.ts`: mounts it after the owner check, only when corrections are on.
- `GraphCustodyProfileAuthority.withdrawMemberLossHold` and a `cancel` route: lifts a hold when no native progress exists.
- `dashboard/console/conversation-machines.js`: a Machines section on the Conversations overview, with a warning before removal, progress, retry, and "Finish removing" for a held removal.

Limits, stated to the owner where they apply:

- It works only when one machine would remain. The execution path refuses anything else, so this is refused before any hold.
- The owner can cancel until the irreversible step begins or a peer has been shown the hold. After either, the removal can only be finished. A step that can refuse runs before that point, so an unsupported graph ends in a cancellable state, not a frozen one.

## Decision point

Yes. This exposes an irreversible action. The route holds no authority of its own: the owner check, fresh admission, signed intent and the native revalidation all stay in the existing components. The one new refusal, the one-survivor check, is a precondition taken from the execution code, so it refuses only what could not finish.

## Review

1. **Over-block:** fleets of three or more cannot remove a machine. That is a real limit of the execution code, not of this route.
2. **Under-block:** an owner can remove a machine that is only asleep. The warning says to do this only if it is gone for good. Nothing can check that from here.
3. **Level of abstraction:** the route sequences existing components and adds no checks of its own beyond the precondition. Correct layer.
4. **Signal vs authority:** authority stays with the owner-authenticated action service. The one-survivor check is a deterministic structural precondition.
5. **Interactions:** a 403 would make the dashboard forget the owner's session, so refusals use 409. While a removal is held, positive writes wait, which is existing behaviour and is why the held state is shown first.
6. **External surfaces:** new routes and a new dashboard section, visible only with Conversations on and to the owner. The section shows only with two or more signed machines, or a held removal.
7. **Multi-machine posture:** replicated through the existing signed membership change. Job state is machine-local by design; after a restart the held intent on disk is what reports "interrupted". The route runs on the machine the owner is talking to, and that machine must be the survivor.
8. **Rollback cost:** reverting removes the route. A removal already performed stays performed, since revocation is irreversible by design.

## 6b. Operator-surface quality

1. **Primary action first:** a held removal shows its state and "Finish removing" as the section's first content. Otherwise the section is a closed Machines disclosure below the efforts, because removal is rare.
2. **No raw internals:** machine names and plain sentences. Refusal codes are not shown.
3. **Destructive action de-emphasized:** Remove is a quiet inline button behind the disclosure, then a sheet with the warning before anything is sent. It is never offered for this machine.
4. **Plain language at phone width:** the wording is plain. Width is not checked: the section has run only in JSDOM, because a real two-machine server needs joining, which does not exist yet. The sheet is the same component used by the other Conversations sheets, which were checked at 320, 390 and 1280 wide.

## Evidence

- Five real-component scenarios pass on real HTTP with a real owner session: straight removal, retry after a stop past the native step, restart after that stop, retry after a stop before the native step, and cancel then remove on a new request. After each, status is clear, the runtime is on the new membership, and a fresh surface reports nothing held. Run as unit copies on the Studio with a raised limit; each took 16 to 21 s.
- The sequence on a graph already past epoch 1: the historical test now runs `removeLostMachine` itself, epoch 2 to 3, in 164 s on the Studio under load. That is over its own 120 s limit.
- Real CLI server: status answers 403 without owner proof, and 200 with it. Run as a unit copy.
- Eight dashboard tests in JSDOM.

## Second-pass review

One fresh Claude reviewer, read-only. First read: do not ship, six blocking findings, including a missing archive step that would freeze any graph past epoch 1 and completed removals reported as held. All fixed. The reviewer missed a seventh, `installCompletedMemberLoss`, found by comparing with the historical test. Second read of the fixes and the cancel path: one critical finding, fixed. A peer shown the hold stops serving and nothing tells it the hold went away, so cancelling after that would have stopped writes for good. The disclosure is now recorded durably before the snapshot leaves, and cancel refuses after it. Three mediums and the lows also fixed. This last round has not had a further read.

## Not established

- The dashboard section rendered on a real server with two machines. That needs real joining, which does not exist yet.
- A real second machine actually gone. The fixture stops responding by design but runs in one process.
- The mobile app has no control for this yet; the routes exist.
- A fleet where this machine is not the host.
- The full suite on this code.
