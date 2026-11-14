# Side-Effects Review — boot-queued replies keep their origin label

**Version / slug:** `boot-queued-reply-origin-label`
**Date:** `2026-11-02`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

A reply a session sent while the server was booting got HTTP 503 `{status:warming,phase:booting}` from the boot beacon. `telegram-reply.sh` queued it in the local pending-relay SQLite queue, and the origin runtime later imported the row through `prepareImportedLegacy`, which labels every legacy row "unknown machine · unknown harness · unknown model". Live case: session "Instar App", topic 134088, 2026-11-03T01:47Z, delivered with the footer `echo · unknown · unknown · unknown`.

The fix:
- `telegram-reply.sh` (both queue writers) stores `origin_session_digest`, the SHA-256 of the session's `INSTAR_ORIGIN_TOKEN`. The credential itself is never stored. `PendingRelayStore` gains the same column through its idempotent column-add list, plus an optional `EnqueueInput` field.
- `OriginSessionRegistry` keeps up to four earlier credential digests per session (`priorVerifiers`). It needs them because server boot re-enrolls surviving sessions with a new credential, so the digest a session queued during boot belongs to its previous credential. The new `attributeVerifier(digest)` returns the binding of the live session that held that credential. `verify()` (send authority) is unchanged and still accepts only the current credential.
- `TelegramOriginService.attributeLegacy(snapshot)` resolves what the importing machine can truthfully claim. The machine is always known, because the queue is in this agent's local state and only local writers fill it. Harness and model are filled from the live session binding and the runtime observer, exactly as a direct session send would fill them. `prepareImportedLegacy` takes that attribution. The record stays `producerKind: 'imported-legacy'` with `originMachineId: 'legacy-unattributed'`, so send-policy review, legacy recovery review, metrics scoping and the held-notice gate behave exactly as before.
- The "legacy records claim nothing" invariant in `OriginAttestation` and the `OriginStoreBackend.importLegacy` fence becomes one shared rule, `legacyAttributionValid`. The machine may be observed. Harness and model may be claimed only together with a session id; without a session they must stay unknown.
- The previous `telegram-reply.sh` SHA is registered in `TELEGRAM_REPLY_PRIOR_SHIPPED_SHAS`, so deployed agents receive the new script on update.

Tier 1: about 170 runtime LOC across 8 source files, plus tests. Effort: one design pass, no spec review rounds.

## Decision-point inventory

- `OriginAttestation.verifyOriginAttestation` legacy-attribution check — modify. It used to reject any evidence on an imported-legacy record; it now rejects only evidence that `legacyAttributionValid` disallows.
- `OriginStoreBackend.importLegacy` origin fence — modify (same shared rule).
- `OriginSessionRegistry.verify` — pass-through (unchanged; prior digests never authorize).

---

## 1. Over-block

No new block surface. The two existing fences got looser in a narrow way only: an observed machine is allowed, and harness/model are allowed when a session id is present. Nothing that passed before is rejected now.

## 2. Under-block

- A reply queued by a session that has since ended, or that has been re-issued more than four times, recovers with the machine only. That is honest: there is no live evidence left.
- The model comes from the session's observation at recovery time, not at queue time. If the session switched models between the two moments (seconds to minutes), the label shows the newer model. That is the same staleness window as a direct send's observation.
- When the match comes from an earlier credential, the record carries the session's current (post-restart) `sessionIncarnation`, not the one that queued the reply. The session id, harness and footer are correct. The incarnation identifies the same running process after re-enrollment.
- A local process with the agent user's file access could write a matching digest into the queue. It could already read the registry file and the tmux environment, so this opens no new trust boundary.

## 3. Level-of-abstraction fit

The attribution sits where the label is decided, in the origin service import. It reuses the registry's existing verifier digests and the runtime observer instead of adding a parallel identity store. The script only records evidence; it decides nothing.

## 4. Signal vs authority compliance

- [x] No — this change has no new block/allow surface. The digest is attribution evidence only; send authority (`verify`) and recovery replay-safety (`snapshotLegacyOrigin.replaySafe`) are untouched.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. `legacyAttributionValid` is an invariant: no harness or model claim without a session.

## 5. Interactions

- Shadowing: none. `replaySafe`, `reviewLegacyRecovery`, send-policy review and content dedup all run unchanged on the imported row.
- Double-fire: none. Import still happens once per row inside the existing `importLegacy` transaction, and attribution is computed before it.
- Races: `attributeLegacy` refreshes the observer the same way `runWithSessionToken` does. A session revoked between attribution and import still ends up attributed. That is a few milliseconds of benign staleness, the same as a direct send.
- `snapshotDigest` covers the whole row, including the new column. The digest is computed at both the candidate read and the import fence, so the two stay consistent.

## 6. External surfaces

- Telegram: recovered boot-time replies now show `echo · <machine> · <harness> · <model>` instead of `unknown` everywhere. Rows from older scripts and server writers now show the machine name.
- Persistent state: a nullable `origin_session_digest` column in the pending-relay queue, and an optional `priorVerifiers` array in `origin-sessions-*.json`. Older binaries ignore both: the registry loader checks only the fields it knows, and SQLite selects tolerate the extra column.
- Operator surface: none.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local by design. The pending-relay queue and the origin session registry are per-machine. A row is written and imported on the same machine, so "machine = this machine" holds by construction. Imported-legacy records keep `executionOwnerMachineId` = this machine and are never forwarded. Peers on older versions would reject an attributed legacy record only if they verified one, and the current code paths never send imported-legacy records to peers. No notices are added and no URLs are generated.

## 8. Rollback cost

Code revert, with one in-flight caveat. The extra queue column and the `priorVerifiers` registry field are inert to older code. Labelled legacy records are not: an older binary's `verifyOriginAttestation` rejects an imported-legacy record that carries any evidence. So a labelled legacy record still waiting in the origin store at the moment of a downgrade would be held (`origin-authority-revoked`) instead of sent, and the audit routes would show it as `signatureValid: false`. The window is small because these records normally go out within seconds of import. After the rollback, new boot-time replies show "unknown" again, which is the pre-change behavior.

## Conclusion

Clear to ship. The only design change made during review was the prior-verifier history in the registry. Without it, the reported case (boot re-enrolls the session with a new credential) would still have come out unattributed.

## Second-pass review

**Reviewer:** independent reviewer subagent
**Independent read of the artifact:** concur.

The reviewer found no security or correctness defect. It confirmed that earlier credentials never authorize anything (`verify`, `challengeNativeHook`, `verifyNativeHookProof`), that the registry format is safe to downgrade, that `issue()` rolls back correctly on failure, that the downstream readers keyed on `originMachineId='legacy-unattributed'` are unaffected, that the snapshot digest stays consistent, and that the script never writes the credential and has no injection path. It raised two artifact corrections, both applied: the downgrade caveat in §8 and the incarnation note in §2.

## Evidence pointers

- `tests/unit/telegram-origin/origin-service.test.ts`: "a reply queued during boot recovers with its real session label, even after the restart re-issued the credential" and "an ended session no longer attributes…".
- `tests/unit/telegram-origin/origin-session-registry.test.ts`: prior-digest attribution is bounded, needs a live session, and never authorizes.
- `tests/unit/telegram-reply-recoverable-classification.test.ts`: the script stores the digest, never the credential.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable. This is a runtime data-flow defect: an evidence field was dropped at the queue boundary.

- `defectClass: unbounded-self-action`, `closure: n/a`. Reason: no new self-triggered action. The existing recovery tick's legacy import gains a read-only label lookup (registry digest match and observer refresh, the same calls a direct session send makes). No restart, spawn, notify, retry or re-drive is added or changed.
