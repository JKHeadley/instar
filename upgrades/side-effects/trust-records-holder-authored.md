# Side-Effects Review — the approving machine trusts only grants it recorded itself (SEC-088 part 2, cut form)

**Version / slug:** `trust-records-holder-authored`
**Date:** `2026-11-18`
**Author:** `echo (security session, Mac M5 Pro)`
**Second-pass reviewer:** `independent read-only subagent (see below)`

## Summary of the change

Tier 2 (security, multi-machine authority). Spec: `docs/specs/trust-records-holder-authored.md` (cut form after round 7, converged at a scoped round 8). About 20 files, roughly 1,300 lines including tests. Proportion: the spec took 7 review rounds and was then cut by rule (the Chief of Staff's cut rule), which is out of line for its size; the reason is that every round-2-to-7 finding sat on a special hand-over path, and the cut removed that path instead of patching it.

- `TrustJourneyStore`: `fold(writer, key, record)`; records keyed by (writer, key); an own index (grants) and an id-keyed narrowing set from every writer; every grant query filtered to the current run; grant keys carry the lease epoch on a multi-machine agent (added inside `write()`); peer grants counted, never used; `legacyUnchanged` by own write order; `legacyImportedAnywhere` evidence query; `summary()`.
- `TrustRunTracker` (new): the held-epoch set and the foreign-epoch list in `state/trust-held-epochs.json`; `inRun(e)` is true only when this machine holds the lease uncontested at N, held every epoch from e to N, and none of them is foreign (seen held by another machine, contested, split-brain detected, or shown held in a peer's own lease, live or expired). Fed by a five-second unref'd lease read, each admission, each trust write and the coordinator's `splitBrainDetected` event (round 8).
- Withdrawals (round 8): `withdrawAcceptance` and `withdrawDeviceAcceptance` name every acceptance id any machine recorded for the subject (devices also by key fingerprint), via evidence-only store queries, so a withdrawal made where approvals are not handled reaches the holder.
- `TrustJourneyRuntime`: `resolvePeerGrants`; store options; `onPeerRecords(writer, …)` and `onOwnCommitted`; the autonomy profile narrowed (source `revoked`, owner line) when a new run starts; admission recheck after the dispatch write; legacy import's joining check uses evidence only.
- `AccountPathService`: the "made earlier" line for an earlier run's request; the honest denial line when another machine closed or used a request; claims use any-run lookups so a non-holder still answers part 1's "send it again".
- Transport: `journalSyncResponseSignature` (new, sign/verify/screen); `JournalSyncApplier` origin-must-equal-sender for `trust-grant-record` (forged), self-sender refusal, `badSignature` counter; `ReplicatedPeerStreamReader.loadAllRecordsWithWriter`; `MeshRpc` `requesterNonce`; server signs and verifies `journal-sync`.
- `server.ts`: writer on own-commit, peer-commit and boot paths; registry-based multi-machine check and one-read lease view; the trust store's own id is the journal's machine id when the journal sink is used; applier gets its own id.
- `/trust/summary`: `trustJourney` block, also without adaptive trust.
- `AutonomyProfileManager.configuredDefaultProfile()` (public wrapper).
- Awareness entry `trust-holder-authored-grants.md`; upgrade note.

## Decision-point inventory

- Does a replicated record grant here? Now: only an own record in the current run. Authority removed from peer records, not added anywhere.
- Is a record used/closed/withdrawn? Unchanged rule (id-keyed), now explicitly from every writer.
- Admission: unchanged logic; its inputs (approvals, proven level, legacy) are narrower. One new ask: the post-dispatch recheck.
- `journal-sync` response signature: a new refusal for trust records only, on an INVALID signature.
- Origin mismatch on a trust record: a new `forged` refusal (same handling as `failure-callout-chunk`).

## 1. Over-block

- After any hand-over, every earlier approval, acceptance, raised level, autonomy profile and legacy grant is absent on the holder; the owner re-approves when each is next needed. This is the accepted cost (operator item a). It is larger than the six-round design's cost: raised levels and legacy kinds are now re-asked too.
- A lapse too short to be observed (the held set misses an epoch) also ends the run: denial only.
- Multi-machine agents: one re-ask of everything at the upgrade (records without an epoch).
- Under `ignore`, a joining machine never imports legacy grants (it was importing still-unchanged kinds from peers). Under `fold` it imports them as today.
- Under `ignore` on a multi-machine agent, the first observation after the upgrade starts a run: a raised autonomy profile with no own current-run change is narrowed to the default once, with the owner line.
- An unknown epoch on a multi-machine agent writes no grant: the action asks.
- Epoch churn: the dev agent's epoch moved about 100 times in an hour on 2026-11-17; same-machine re-acquires keep the run, so only real hand-overs cost re-asks; the dev rung measures runs ended per week before the fleet rung.

## 2. Under-block

- A compromised machine that actually takes the lease grants during its own run (identity piece 2).
- Split brain the coordinator does not see as `contested`: both machines count their own grants (lease-medium residual).
- An on-path attacker can strip the response signature; then trust records are narrowing-only anyway.
- Older-build holders in a mixed pool still fold peer grants.
- Removing every other machine from the registry returns to the single-machine rule, so this machine's own earlier-run grants count again (own records only; the owner's act). Listed as a residual in the spec.
- A lease medium whose epoch were reset could let an old held range cover a new epoch (the medium only writes epoch + 1 today). Residual.
- Plain `proceed` (level path) shares one fresh lease read per admission; a hand-over in that instant is covered for proceed-once by the post-dispatch recheck only.
- Other AdaptiveTrust consumers that read the stored level directly (outside `admit()`) are not run-filtered; this spec governs the trust-journey admission path, as before.

## 3. Level-of-abstraction fit

The rule lives in the store (one fold, one index), the run in one small tracker fed by the existing coordinator (holds, epoch, contest), and the writer at the transport boundary. No caller decides authority itself. The signature sits at the existing MeshRpc response boundary, following the agent-identity signed-response pattern.

## 4. Signal vs authority compliance

A peer's record is treated as a signal (evidence, counts) and never as authority; the authority is this machine's own first-hand records within its lease run. The only new refusals are structural (invalid signature, forged origin, self-sender), not judgments, and each only removes the ability to grant. Compliant.

## 4b. Judgment-point check

No competing-signals heuristic is added. The fleet default and the dark window are judgment-candidates with floors and arbiters (maturation review, operator), unchanged from the spec.

## 5. Interactions

- Part 1 (PR 3403): its non-holder "send it again" path now uses any-run request lookups, since a non-holder has no current run; behaviour unchanged.
- The legacy fallback file (`trust-legacy-kinds.json`) is rebuilt from own current-run grants only, so after a hand-over the hook's offline fallback passes fewer kinds (stricter).
- `checkAtLoad` and `checkTrustProfileAgainstLog` read the run-filtered change log; a level with no current-run change is left as stored (as before for history-less levels) but `provenLevel` returns null, so admission asks.
- The autonomy profile narrowing writes source `revoked` (an automatic source), so it never ends anything elsewhere.
- Self-sender refusal applies to every journal kind (a self-claiming replica was never legitimate for any kind).

## 6. External surfaces

- Owner-visible: re-asks after a hand-over and once at upgrade (multi-machine); the "made earlier" and "another of my machines closed that request" lines; the autonomy-profile restore notice.
- API: `/trust/summary` gains `trustJourney` (additive) and returns 200 without adaptive trust when the runtime exists.
- Wire: `journal-sync` request `requesterNonce` and response `sig`, both additive; older peers ignore them.
- Config: `trustJourney.peerGrants` (no default written).

## 6b. Operator-surface quality

No dashboard, approval page or form file changed. Not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Replicated store (`trust-grant-record` journal, unchanged path), per-run grants by design: what differs per machine is which records count as grants, which is the rule itself. The held-epoch file is machine-local by design (it records this machine's own lease holding; replicating it would let a peer claim a run). Status surface: `/trust/summary` → `trustJourney` reports this machine; only the holder acts, so no pooled read.

## 8. Rollback cost

Set `trustJourney.peerGrants` to `fold` and restart (peer grants live again, boot warning says how many), or revert the release. No record type or field changes; epoch-keyed records read as ordinary records on older builds; the held-epoch file is ignored by older builds. The signature fields are additive.

## Conclusion

Ships the cut form as specified. It removes authority from peer records and adds none. The owner-visible cost is real and is the operator's decision (items a, b, c), with the epoch-churn measurement before the fleet rung.

## Second-pass review (if required)

Required (trust levels, admission gate).

Round 1: independent read-only subagent (fresh context, given the code and the spec, artifact read last): CONCERN. No path lets a peer record grant under `ignore`; writer derivation, applier, signatures and key forms verified. Blocker: on a single-machine agent (and a multi-machine agent with no coordinator) the post-dispatch recheck saw no lease view and used up every one-time approval, in both modes. Should-fix: under `fold` a joining machine stopped importing unchanged legacy kinds; the run tracker, recheck and profile narrowing also ran under `fold`; no lease-tick observation, so same-machine epoch moves between trust activity ended runs; the first observation never narrowed an earlier profile. Notes: grants written while not holding could count after a lapse; unreadable peer request lacked the peer mark; the peer-closed line could be false with an own consumption; the fallback file was not refreshed on a new run; parity with `resolveDevAgentGate`.

Fixes: tracker only under `ignore`; recheck only when multi-machine; `fold` keeps today's any-machine `unchangedLegacyKeys`; a five-second unref'd lease tick plus a fresh read at each admission; the first observation starts a run; grants written while not holding are keyed `s<N>` and never count; the notes fixed; regression tests for each (single-machine approval in both modes, no tracker under `fold`, N -> N+1 -> N+2, standby write, `fold` joining import).

**Reviewer:** the same independent subagent, re-asked (not replaced), 2026-11-18 03:27 PST: **Concur.** All five items resolved; the notes resolved or recorded as residuals (registry back to one machine, lease epoch reset, the per-admission read); no new issues; the `onNewRun` -> fallback refresh path cannot recurse.

## Evidence pointers

- Unit (run here, 5 files max per run): final run after round 8, 10 files, 154/154 (70 + 84); `tests/unit/sec088-trust-holder-authored.test.ts` (now with the runtime-wiring cases); `tests/unit/sec088-journal-sync-trust-transport.test.ts` 18/18; `trust-journey-store`, `-account-path-service`, `-proof-check`, `-corrupt-state`, `-device-approval`, `-review-c`, `-governed-effects`, `mobile-trust-approval-routes` all pass; transport neighbours (`JournalSyncApplier`, `ReplicatedPeerStreamReader`, `MeshRpc`, `PeerPresencePuller-journal`) 103/103 with the new file.
- Integration and e2e (`tests/integration/trust-account-path-routes.test.ts`, `tests/e2e/trust-account-path-alive.test.ts`): written and type-checked; run by Local Verify (not run by hand on this machine, per the Chief of Staff's rule).
