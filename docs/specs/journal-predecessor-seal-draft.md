# Draft predecessor seal contract

The authenticated seal binds the agent, store namespace, stream identity and incarnation, predecessor writer identity and lease epoch, terminal sequence, digest format, and digest of the authoritative prefix through the terminal sequence. It also binds the exact unresolved operation, attempted sequence, and attempted record digest when an append outcome is uncertain.

Resolve the predecessor writer and epoch against authoritative lease history for that agent and store. Publish a seal only after proving that the predecessor has lost write access and the sealed prefix cannot change. A newer lease alone supplies no such proof.

The consumer verifies that the seal matches the expected predecessor and that the full required prefix is present and matches the terminal sequence and digest. A peer reader reporting that its local files are readable cannot establish that every required entry has arrived. Delayed, missing, conflicting, or unverifiable evidence leaves the decision pending.

Carry any uncertain intent across handover. It continues to block an opposing decision until exact authenticated reconciliation establishes the outcome. Absence in peer files does not clear it.

The delayed-rebind baseline must show refusal while a required entry is delayed and reevaluation only after the complete authenticated prefix arrives. Integration and activation remain gated on proving the seal and excluding already-installed legacy writers.

## Authority review, November 25 at 6:42 p.m. PST

The current LeaseStore contract reads the current record and epoch. It exposes no predecessor-history lookup. GitLeaseStore records accepted changes through the registry commit and fast-forward push, so a verified registry transition is a candidate identity witness for git-backed deployments. It supplies no proof of journal writer revocation. LocalLeaseStore keeps the current record in a replace-in-place file and explicitly has no shared medium. For that deployment, a handover proof needs a new durable authenticated transition record or must keep the consumer pending.

The seal issuer needs independent evidence of old-writer exclusion. Design's installed launcher draft checks the protocol floor on the updated entrypoints, but already-installed direct binaries can ignore those checks. An authoritative lease transition and a complete prefix cannot fill that gap. Require a test that starts an actual legacy binary through its old direct entrypoint after fencing and proves the journal cannot be opened for write, then verify the same cutover preserves a pending intent and admits the successor only once the sealed prefix is available.

## Disposable reproduction

On macOS, set `INSTAR_JOURNAL_FIXTURE_LEGACY_PACKAGE` to the absolute path of an installed prior Instar package and run `tests/unit/CoherenceJournal-chief-decision.test.ts` with one worker. The fixture uses the package's original CLI entrypoint in a disposable project, with network access denied. The process-specific OS policy denies journal writes. The successor reopens the same local journal using the kernel-backed lock and requires exact reconciliation of an uncertain append. The standalone Python fixture also runs an unfenced control and checks that the old process actually acquires a journal lock.

This experiment applies OS policy to the launched process. It does not install or demonstrate a mandatory policy for every legacy process, issue an authenticated seal, or establish authority across machines. The production seal and activation remain pending those proofs.

## Dark Git authority prototype

Run `python3 tests/fixtures/journal-writer/git-authority-fixture.py`. It uses an isolated bare receiver and a prepared reference-transaction hook. Every accepted update directly follows the receiver's current tip and binds the generation, writer, append bytes and expected intent in one commit. The hook checks the receiver clock and fixture principal. The pending phase blocks append and fold commands, and activation requires the fixture witness to name the exact pending tip. Ignoring the push outcome and reading the receiver's exact tip and blobs demonstrates the recovery rule.

The fixture uses a local transport-supplied principal, a synthetic receiver clock and a fixture witness. It does not establish production principal authentication, live expiration across a receiver stall after the prepared hook, witness durability or rollback resistance, or isolation of stored payloads on a managed remote. Managed Git hosting must support equivalent receiver-side enforcement before it can serve as authority. The existing GitLeaseStore production path remains unchanged.
