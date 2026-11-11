# Side effects: a long removal proves it still holds the lease at commit

## What changed

A removal's signed plan carries a lease snapshot with a fixed expiry, while this machine keeps renewing the same epoch. A removal that outlasted the snapshot failed the clock check, leaving writes on hold.

- The signed plan stays unchanged. A fresh same-epoch proof, `activationHolding`, is minted synchronously at the last moment and checked at commit. It sits on the activation certificate, inside the witness signature and outside the request hash.
- `GraphMemberLossActivation`: separates the clockless plan check from the holding check. The holding check requires a valid bridge, the same epoch, writer and `acquiredAt`, a nonce not lower, and an activation time inside the proof.
- `GraphWitnessService`: six pre-commit checks are now clockless. `recoverPending`, `finishRecoveryUpload`, `finishBootstrapTransfer` and `bootstrap` take the proof for member loss and refuse without it. Replay of a logged commit needs none.
- `beginRecoveryUpload` defers its clock check only for a verified member-loss plan.
- `validatedAt` is taken at the lease snapshot rather than per row.

Other recoveries and planned transitions keep today's rules. A certificate with the field but no member loss is refused.

## Decision point

Yes: when a removal may commit. Authority stays at the witness.

## Review

1. **Over-block:** a synchronous finish that outlasts the proof refuses cleanly and can retry.
2. **Under-block:** see Known limits.
3. **Level of abstraction:** the commit point is the only place that needs a live proof.
4. **Signal vs authority:** no change in who decides.
5. **Interactions:** older verifiers refuse the new certificate, so a future join needs version gating. A member-loss request over HTTP refuses except on replay; production uses the local witness.
6. **External surfaces:** a new optional certificate field.
7. **Multi-machine posture:** replicated through the existing signed activation.
8. **Rollback cost:** a certificate already written with the field would be refused by reverted code. Revert before any removal has happened, or keep the field's verifier.

## Class-Closure Declaration

- `unbounded-self-action`: closure n/a. One owner-driven action per attempt, with no new loop or trigger.

## Known limits

- **Stale writer during a network cut, medium.** The witness only knows epochs it has seen, so this rests on the local `holdsLease()`. During a network cut, a machine superseded at a newer epoch could keep minting and commit a removal. Before, the snapshot capped this at one lease length; now there is no such cap. It still needs the owner to confirm the other machine is gone for good while that machine is alive and has taken the lease.
- **Long finish, medium.** The proof is minted once with no minimum remaining life, and a synchronous finish blocks renewal. Past its expiry the error is a misleading `membership-activation-invalid`. It rolls back cleanly, but retries can keep failing.
- **Low.** A proof is not bound to its request and has no nonce high-water mark; replay needs in-process access. A stale owner-signed plan can occupy staging, and it still cannot commit.

## Evidence

Real run, Studio and M5, real network: M5 stopped, 40 rows of history, Studio hard-killed during the removal, restarted, finished in 302 s. All 40 efforts intact, and a new change committed. On the same machines this failed before the change.

`surface-route-slow` failed first with `member-loss-role-initial-proof-invalid`. 123 tests across 12 files pass, including refusal cases at the verifier and through the witness, and old certificates still verify.

This commit used the gate's one-off end-to-end bypass. The change sits in the commit path of a removal, which an end-to-end boot cannot reach without a real second machine; the real run above and the integration modes cover it, and the route has its own end-to-end test.

## Not established

The full suites on this code. Removal at hundreds or thousands of rows: it is still slow, at about 5 minutes for 40 rows on a loaded machine, with event-loop stalls of about 19 s, and the capacity limits are unmeasured.

## Second-pass review

One fresh Claude reviewer, adversarial, read-only, nothing run. No way to commit without a holding proof, and no half-commit. Findings are under Known limits and not fixed here. Could not establish whether `ConversationGraphReplication.ts:832-833` receives a live lease, though the real run above passed through it.
