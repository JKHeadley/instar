# The approving machine trusts only approvals it recorded itself

<!-- bump: patch -->

## What Changed

SEC-088 part 2. The trust journey's records (approval requests, one-time approvals, acceptances, device approvals, trust-level changes, legacy grants) replicate to every machine of an agent. Until now the machine in charge of approvals counted every record, including ones another machine wrote, so one compromised paired machine could write "the owner approved this" and the agent would act on it.

With `trustJourney.peerGrants` resolved to `ignore`, a record that grants something now counts only on the machine that wrote it, and only during that machine's current run of the lease: it holds the lease now and has held it without a break since the grant was written (tracked locally in `state/trust-held-epochs.json`). A record another machine wrote can still close, use or withdraw something by its id, because believing it can only make the agent more careful. The writer of a record is taken from the transport (the authenticated sender, or the replica file's machine), never from a field inside the record. `journal-sync` responses are now signed by the serving machine and checked by the asking one; a trust record arriving in a response with a bad signature is refused and counted, an unsigned response from an older build is accepted. A trust record whose origin does not match its sender is refused as forged, and a replica claiming this machine's own id is refused.

After another machine has been in charge, earlier approvals, acceptances, raised trust levels, the autonomy profile and legacy grants no longer count on the new holder; the owner is asked again the next time each is needed. A same-machine lapse and re-acquire keeps them. On an agent with more than one machine this also happens once at the upgrade. Single-machine agents see no change.

Rollout: `ignore` on development and throwaway agents; the fleet keeps today's behaviour (`fold`) until the fleet review, and a multi-machine agent under `fold` says at every boot how many grants from other machines are live. Set `trustJourney.peerGrants` explicitly to override.

## What to Tell Your User

- **Approvals stay on the computer that got them**: "When a different one of my computers takes over approvals, I will ask you again for things you approved before, the next time they come up. I only act on approvals I recorded myself while in charge, so a stolen or compromised computer of mine cannot fake one."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Peer-written trust grants are evidence only | Automatic where `trustJourney.peerGrants` resolves to `ignore` |
| Trust journey counts on the trust summary | The `trustJourney` block of the trust summary (ignored peer grants, grants outside the current run, held epochs) |

## Evidence

- `tests/unit/sec088-trust-holder-authored.test.ts`: forged peer action-approval, change (any epoch, id or time), request reusing an own id, legacy grant and device acceptance never grant; peer dispatch and consumption narrow by id; A to B to A leaves every earlier grant absent; a same-machine re-acquire keeps them; a standby's grant never counts; unknown epoch writes no grant; single machine unchanged; `fold` honours peer grants; the held-epoch tracker's run, restart, lost-file and contested cases.
- `tests/unit/sec088-journal-sync-trust-transport.test.ts`: signed responses (valid, unsigned, invalid), origin mismatch forged, self-sender refused, writer from the replica entry, first record wins.
- `tests/unit/trust-journey-review-c.test.ts`: a joining machine imports nothing from another machine's legacy grants.
- `tests/integration/trust-account-path-routes.test.ts`, `tests/e2e/trust-account-path-alive.test.ts`: a forged peer approval never yields proceed-once over HTTP and on the journal-backed boot path; the summary block is present with and without adaptive trust; `fold` restores today with the boot warning.
