# Side-Effects Review — Selected History Upload Staging

**Slug:** local-history-upload-staging
**Date:** 2026-11-23
**Author:** echo
**Risk:** Tier 2, private storage and authority-sensitive lifecycle.
**Second-pass reviewer:** channel_side_effects (independent subagent); concur after correction.

## Summary and build location

This adds dormant internal disk allocation and raw upload ownership, with no production construction, endpoint or app action. Work is isolated in `.worktrees/local-history-preview-143810` after channel checkpoint c5a193cdf, package 1.3.1984. Both repository remotes point to JKHeadley/instar. This continues the existing approved dependency stack rather than changing the agent-home source. The published channel branch remains frozen. Driving approved/converged spec: `docs/specs/local-history-native-contract.md` and its existing ELI16 companion. Parent integration remains actively tracked by topic 143810.

## Decision-point inventory

Current owner, enrolled device key and selected issuer bindings; single-use challenge; stable request fingerprint; bounded rows/disk reservations; exact chunk retry; raw verification lane; absolute expiry; process-held recovery custody; owned cleanup and filesystem identity checks. These are explicit transport, identity, byte integrity and resource invariants. They do not interpret message meaning, grant consent or authorize copying.

## 1. Over-block

The component owns one shared parent custody generation, so another staging instance or surviving child holder prevents replacement. Row saturation refuses further admission because request barriers are retained. Earlier unversioned ledgers are refused intact; no deployed schema migration is claimed. At low disk recovery may dispose files, but new metadata or payload admission still requires its floor. These limits must be surfaced accurately when actual routes are connected. No additional legitimate-input rejection was identified in focused review.

## 2. Under-block

An injected principal callback is not proof of authenticated HTTP. Real native signature checks, pre-body exchange admission, destination pinning, parser isolation, normalized-preview identity, explicit consent, durable owner claims and copy transactions remain mandatory layers under topic 143810. Verified raw bytes supply none of these. SQLite metadata reservations are a conservative bounded work allowance, not a hard filesystem quota against unrelated processes. Synchronous local kernel operations have no hard preemption guarantee. No plaintext fallback or user-content log is introduced.

## 3. Level-of-abstraction fit

Raw operation storage belongs between authenticated channel dispatch and isolated semantic parsing. It reuses actual private-path checks, shared child custody, SafeFsExecutor and SQLite handle registration. It does not add an alternative authenticator, source registry or copy permission system. Parser integration must compose with this held parent custody, not independently acquire competing parent ownership.

## 4. Signal vs authority and judgment

Reference: `docs/signal-vs-authority.md`. Exact scope binding, digests, sequence, lifetime, file ownership and capacity are hard-invariant/protocol exceptions. No brittle semantic detector gains blocking authority. A matching source name or valid hash never implies a permitted copy. Fixed degradation reports describe unresolved cleanup only; they do not actuate an agent or grant authority.

## 5. Interactions

SQLite transactions protect durable reservation accounting. Buffers are bounded and cleared; positive short reads cannot skip bytes. Files become sealed before hashing. Verification yields and rechecks live owner authority between chunks. Expiry/cancel mark memory terminal before disposal, so failed cleanup cannot revive writes. Failed admission cleans by its known generated tag even when file creation failed before returning an identifier. Timer failures are contained; shutdown has unconditional nested finalizers. Cleanup retries are bounded and retain failed charges. Recovery requires exclusive acquisition against real surviving holders and leaves unknown residue untouched. New schema creation and its version marker commit atomically.

## 6. External surfaces and operator quality

No new endpoint, user action or agent capability. Private file-route protection now also recognizes the new disk ledger and operation database, including their SQLite sidecars and generated block hard-link aliases; all staging files remain within the already-private local-history-upload namespace. The state registry declares machine-local ownership, retained failed cleanup and bounded bookkeeping. No hook, installed skill or scaffold changes require migration. The component's fixed internal degradation report includes no selected text, path, owner identifier or operation identifier. No operator surface is introduced; import UI remains disabled.

## 7. Multi-machine posture

Machine-local by design. Raw selections, private plan, custody, boot challenges and operation state belong to the destination signing machine. They are not replicated or served through the file viewer. Switching destination or boot requires fresh admission. No URLs or cross-machine status claims are generated. Internal-only cleanup reports use existing DegradationReporter behavior and create no new user notification loop.

## 8. Rollback cost

Before production integration, revert the two runtime modules and their path/registry/test/documentation changes. Stop the owning component and wait for its real custody holders before inspecting owned temporary files. Preserve unresolved files and bookkeeping; never remove the entire namespace as a rollback shortcut. Existing older ledgers are left intact by refusal. No real user content migration or copied conversation mutation occurs in this checkpoint.

## Evidence and limits

Actual TypeScript build and noEmit passed. Focused evidence totals 98 checks across six suites (30 staging, 17 disk, 10 exchange, 6 custody, 10 SQLite wiring, 25 file protection). All 55 lint steps passed before the final metadata protection tests; normal pre-commit repeats required checks. Synthetic tests cover wrong profile/key/issuer, malformed foreign rows, lost acknowledgements, incomplete retries, conflicting chunks, digest mismatch, short reads, partial allocation, retained cleanup charge and retries, stopped-clock challenge/upload expiry, cancel/revoke between chunks, low-disk recovery and real parent death with a surviving holder. The static SQLite wiring regression initially caught the omitted new handle allowlist entry; it was corrected. Final review also caught missing hard-link alias protection for the new operations database; the fixed inode list now includes it and sidecars, with actual read/download route regressions. The new parameterized test initially reused an alias filename; each case now uses its own path. Full suites and production HTTP/native acceptance are not claimed and remain coordinated through throughput.

## Second-pass review

**Independent read of the artifact: concur after correction.** The initial review found that the new `local-history-upload/jobs.sqlite` operation/challenge database was absent from the fixed inode protection list, leaving innocent hard-link aliases outside the namespace unaccounted for. The source now includes that database and automatically expands all SQLite sidecars, and the protection suite adds real HTTP read/download alias cases for the disk ledger, operation database and journal. I re-read that correction and the artifact; the concrete concern is resolved in source and test coverage. The remaining checks implement enumerated identity, transport, byte-integrity and resource invariants rather than judging message meaning. The artifact accurately keeps real authentication, parser/copy authority, production wiring and native acceptance separate, declares machine-local custody and preserves unresolved cleanup state during rollback. Source review only; I ran no tests or builds and do not independently attest the final rerun result. No source changes made by this reviewer.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable. This component owns raw request resources and bounded cleanup; it does not spawn, restart or dispatch agents. The custody fixture starts synthetic children only in tests. The separately denied bookkeeping-retirement source edit and review patch remain unapplied; this checkpoint does not route around that gate.
