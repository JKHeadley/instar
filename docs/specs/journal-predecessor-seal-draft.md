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

### Receiver stall and backup restore

A barrier in the prepared hook reproduces the remaining expiry gap. The receiver validates while the synthetic clock is below expiry, pauses, and then commits the same tip after the clock reaches expiry. Moving the check into the prepared hook narrows the gap but does not close it. The Git ref alone therefore cannot serve as the wall-clock write authority under this contract.

The restore fixture holds an fsynced generation and exact tip in a separate witness directory, then opens an older bare clone. Recovery closes ingress for the stale backup, a missing witness, a pending manifest, and an active manifest that does not match the witness. It admits only the current matching pair. This proves the recovery predicate on disposable files. It does not wire the predicate into production append or fold admission, prove that a real witness survives independent storage loss, or exercise machine failure during the witness write.

### Receiver authentication fixture

The receiver now verifies an SSH signature against a receiver-owned principal allowlist. The canonical signed request binds receiver audience, principal, protected ref, expected predecessor and exact candidate. Unsigned requests, a different signer's key, a different receiver audience and a changed candidate are refused. After authentication, the receiver still applies transition and role checks. Test keys and trust configuration are generated only inside the disposable fixture. Deployment still needs protected receiver configuration, credential provisioning and revocation, and transport that cannot bypass the receiver hook.

An epoch revocation committed by the same authority can fence a paused writer after the revocation wins the compare-and-swap. It does not by itself meet a wall-clock expiry guarantee. A receiver stalled with the ref locked can publish the old transition before the expiry transaction acquires that lock. Keep that distinction explicit when evaluating an expiry-driven generation advance.

### Witness-gated acceptance

A successful Git push stages candidate bytes. It gives the writer no decision receipt and supplies no input to an active fold. The independent witness is the acceptance authority. In one serialized operation it evaluates its live clock, active generation and expected predecessor and durably records the exact candidate, decision digest and intent digest. A qualifying receipt already committed before expiry can be recovered after a lost acknowledgement. A signature or hook check made before expiry confers no acceptance. A first sighting after expiry or after a generation change is refused.

Decision receipts, consumer publication and folds require current witness evidence binding the exact object and record. While witness and activation disagree or either is unavailable, both generations remain pending. Older accepted evidence can contribute through the verified predecessor seal only. A staged late tip can block progress until the authority resolves Git staging, but cannot authorize a decision.

The fixture uses a separate SQLite witness and a synthetic clock. It keeps the known late Git commit visible and shows that the acceptance predicate refuses it, then tests exact receipt recovery after expiry, altered intent, a restored earlier tip, a pending witness and unavailable witness storage. It does not wire an actual fold or reply, implement a production witness, or prove timing at the witness's own durable commit under a real clock. That implementation must define and test the acceptance linearization point and behavior during stalls.

The witness fixture independently reads the protected tip, verifies its sole predecessor and checks the exact decision and intent blobs against the object. Receipt lookup and live publication eligibility are distinct. An exact timely receipt can still be read after expiry, while a new fold requires current live authority. The fixture's eligibility predicate is a read. Production publication must make the fresh check and the publication conditional in the same authority. A deterministic post-check barrier demonstrates the SQLite model's own gap. At expiry an independent reader still sees no receipt, then the writer commits a receipt with the earlier time. A production witness must close that gap before wall-clock acceptance can be claimed.
