# Side-Effects Review — relay-socket inbound reaches canonical history; large bodies are backed

**Version / slug:** `threadline-relay-inbound-canonical-history`
**Date:** `2026-11-10` (revised 2026-11-11 after independent review blockers B1/B2; validation status updated 2026-11-11 for the reviewable checkpoint, see "Current validation status")
**Author:** `Echo (Opus coder helper, build/threadline-canonical-inbound-1111)`
**Second-pass reviewer:** independent Claude Opus 5.5 helper; review 1 raised B1/B2, review 2 concurred with stated limits (full attributed verdict below).

## Summary of the change

Bug fix to an existing capability (Robustness Phase 2 canonical per-thread history). The cross-machine relay `gate-passed` handler in `src/commands/server.ts` (`handleGatePassedRelayMessage`) wrote the legacy HMAC inbox but never called the `recordThreadMessage` funnel. So an authorized inbound arriving by relay socket was missing from `threadline/threads/<id>.log.jsonl`. Observed on Luna 1.3.1725: 8 decrypted inbound rows in the HMAC inbox, while the canonical log for the thread held 11 rows, all outbound.

Changes:

1. **`src/threadline/relayIngressHistory.ts` (new, small).** `recordRelayIngressHistory()` records one already-authorized relay inbound through the existing funnel. It excludes probes, acks the ack stage consumes (kinded acks and auto-acks), and thread ids outside `THREAD_ID_RE`. It keeps the wire message id, thread id, verified sender fingerprint and the original wire `timestamp`. Legacy fallbacks: a missing timestamp uses receive time and is marked `createdAtSource: 'receive-time'`; a missing id becomes a stable `legacy-<sha256>` id over (sender, thread, SENDER timestamp or `none`, body). It never throws. Two shared seams live here too: `classifyRelayIngress(msg)` (the handler's original text normalization + `isAutoAck` + `kindedAck`, computed once) and `recordGatePassedIngress(recorder, decision, cls, fallbackThreadId)`, the single call the handler makes. The skipped-thread-id warning JSON-quotes the peer-controlled id and is rate-limited to once per peer per 10 min (review P2).
2. **`src/commands/server.ts`.** The handler now gets `textContent` / `msgType` / `isAutoAck` from `classifyRelayIngress` (same code as before, moved) and calls `recordGatePassedIngress` right after it. That is before the waiter, the ack-stage return, the legacy inbox append and every routing branch (pipe, listener, warm, cold, router, peer-place). The ack stage's `relayAckInput.kindedAck` now reuses the same classification instead of a second `parseKindedAck` call (`parseKindedAck` is pure, so behavior is identical). The recorder is built by `createThreadMessageRecorder` (item 8). The handler's message type now includes `timestamp?` / `timestampSynthesized?`.
3. **`src/threadline/recordThreadMessage.ts`.** For bodies over the inline cap, the recorder used to write `textRef {kind:'store', messageStoreId: messageStoreId ?? messageId}` without saving anything, which left a dangling reference. Now it writes a backing record first, under a namespaced id `tlbody-<sha256(threadId)>-<sha256(direction, peer, thread, messageId, contentDigest)>` (both full 64-hex; the first part names the thread's body partition), and only then appends the row. If no store is wired, the record throws into the existing append-failure path: a log line, plus one deduped Attention item after the streak. A row that points at nothing is never written. Two more changes: a new `resolveText(entry)` returns inline text or the digest-verified backing body, and `createdAtSource` is passed through. `messageStoreId` input is deprecated and ignored, and no caller used it. Receive-time dedupe (review P1, fixed): a `receive-time` candidate whose key is already logged is digested with the EXISTING entry's `createdAt` (found by `ThreadLog.findLiveEntry`, a lookup of the bounded live segment, only on a key hit). The same body is a `duplicate`; a different body is a `collision` through the existing collision path (warn line + `recordCollision` counter). The first row and its time are kept. This is recorder correctness only, not an admission decision; the ledger and gate are unchanged.
4. **`src/messaging/MessageStore.ts`.** Adds `saveThreadBodySync` / `getThreadBodySync` writing `messages/bodies/<sha256(threadId)>/{tlbody-…}.json` (validated id, tmp+rename; a save whose id partition does not match the envelope's thread is refused), `deleteThreadBodiesSync(threadId)` (removes exactly that one partition via `SafeFsExecutor.safeRmSync`), and `get()` falls back to `bodies/` for a `tlbody-` id. That lets the existing `ThreadlineReapRecovery` resolve these bodies unchanged. Body records are **not** in `store/`, so they never enter the delivery indexes, the retry scan, or inbox/outbox queries.
5. **`src/threadline/ThreadLog.ts`.** Optional `createdAtSource?: 'receive-time'` on entries. It sits outside the hash-chain canonical bytes, so existing chains are unaffected. Adds `findLiveEntry(threadId, messageId, direction)` (live segment only) for the P1 fix.
6. **`src/server/routes.ts`.** `GET /threadline/threads/:id` and `GET /messages/thread/:threadId` now resolve store-ref bodies through `resolveText`. Before, they showed `null` / `''`. `/threadline/threads/:id` also shows `createdAtSource` when it is set.

7. **`src/threadline/ThreadlineBootstrap.ts` + `ReceivedMessage` type (B1).** The unknown-sender (plaintext) path still fills a missing envelope timestamp with its receive time before the gate (gate input unchanged), but now also sets `timestampSynthesized: true`. The history step treats a marked value as receive time: it records `createdAtSource: 'receive-time'` and leaves it out of the legacy-id hash, so an id-less, timestamp-less redelivery maps to the same `legacy-…` id and is a `duplicate`, not a second row. No other consumer reads the new optional field. The encrypted path takes `timestamp` from the signed envelope (`ThreadlineClient.ts` handleIncomingMessage) and is unchanged.
8. **`src/threadline/createThreadMessageRecorder.ts` (new, small, B2).** The one production composition of the recorder: real ThreadLog + ConversationStore, attention, `logDir`, the `threadline.canonicalHistory` knobs, `bodyStore: messageStore`, and `attachPeerContactHook`. server.ts calls it (replacing the inline `new ThreadMessageRecorder` + hook). The unit, integration and E2E tiers call the same function.

## Decision-point inventory

- Exclusion predicate in `recordRelayIngressHistory`: probe / ack-consumed / no recorder / non-canonical thread id → **skip recording**. These are the handler's existing exclusions, plus the existing route allowlist. Nothing new is decided about the message itself.
- Large-body branch: backing written → store ref; no store or write error → **append-failed** (existing observable path).
- None of these touch admission, trust, routing, waiter, ack or delivery decisions.

## 1. Over-block

Recording never blocks delivery: every path returns a status and never throws. Some legitimate legs are still not recorded, and the legacy inbox keeps a copy of each:
- a thread id outside `THREAD_ID_RE` (lowercase 36-char UUID shape, `msg-…`, `thread-…`): the handler's synthetic `auto-<uuid>` id for a wire-less thread, the unknown-sender bootstrap's own `relay-<ms>` fallback (`ThreadlineBootstrap.ts`), and any **uppercase** UUID a peer uses. The history routes refuse these shapes too, so this is a protocol limit, not a regression. It is logged with a rate-limited warning only;
- an over-cap body when no `bodyStore` is wired. The server always wires one; only test-constructed recorders lack it.

## 2. Under-block

- Plaintext from `relay-unknown-sender` with no envelope timestamp: fixed (item 7). The row is marked `receive-time` and a redelivery dedupes. The E2E sends ONE real id-less, timestamp-less envelope over the relay and gets one `receive-time` row with a stable `legacy-<sha256, first 40 hex>` id; it then replays that same gate-passed message straight into the production recorder with a later synthesized time and gets `duplicate`, still one row with the original `createdAt`. That replay is receiver-side only: it is not a second relay delivery and proves no admission. The admitted duplicate/collision boundaries are proven by the real-dependency unit tests in `tests/unit/threadline/relayIngressHistory.test.ts`.
- **Existing relay limit (pre-existing, not changed here).** The relay's replay cache (`src/threadline/relay/MessageRouter.ts:74/128`) stores an absent message id under one shared `undefined` key. After one id-less envelope is routed, every other id-less envelope on that relay, from any sender, is rejected as a replay for the cache window (5 min) before it reaches the receiver. So a legacy retry over the same relay inside that window never reaches this history step. <!-- tracked: fb-f0201004-f5e -->
- Two genuinely distinct legacy messages that share sender, thread and body, and have no id and no timestamp, collapse into one row (review P10). This now holds on the unknown-sender path too. Documented in the module.
- **Review P1, fixed.** A same-id message with no sender timestamp is compared against the logged entry using that entry's `createdAt`: same body → `duplicate`, different body → `collision` (first row and time kept, collision counted and logged). If the original entry has rotated out of the live segment, a retained seen-cache key can cause a same-body retry to be counted as a collision; after that key is evicted, the retry can append another row. This bounded history window never overwrites the first row; a duplicate is not a read receipt.
- **Review P4 (stated limit).** `createdAtSource` sits outside the hash-chain canonical bytes, for back-compat. Provenance is display/audit only and is NOT tamper-evident.
- **Review P7 (stated).** Recording happens before routing, so a message the warrants gate later declines, or one routed to a peer place, is still in owner canonical history. This matches the legacy inbox append on every branch and the HTTP receive path.
- Historical backfill of Luna's 8 rows remains part of the active repair in topic 9210, main spec §4.11 and PR-A; this observer change records new traffic. <!-- tracked: topic-9210 -->
- No fsync. History is append-only observability and makes **no crash/power-loss durability claim**. Flushed custody proof belongs to the separate, still-unapproved first-contact spec.
- A collision (same id, different body) leaves the first row and body intact. For over-cap bodies no second backing file is written, because `has()` is checked first.

## 3. Level-of-abstraction fit

The step sits in the existing handler at the one shared point before branching. It reuses the existing funnel, ThreadLog and MessageStore, and adds no new history engine. The large-body fix is inside the recorder, so all producers get it: routes.ts (3 sites), ThreadlineEndpoints and the relay socket all share the one server recorder.

## 4. Signal vs authority compliance

Compliant. Recording is a signal/observer. It has no blocking authority and does not alter what is delivered, to whom, or when. Its only failure surface is the existing bounded observability. A logged row is history and does **not** prove the message was read, submitted or delivered. Nothing here claims otherwise.

## 4b. Judgment-point check

No competing-signals decision point. The exclusions mirror existing deterministic contracts (probe, ack-never-acked).

## 5. Interactions

- **Waiter:** unchanged semantics. Recording only happens earlier in the same handler.
- **Ack stage / ack-never-acked:** acks are excluded before recording, using the same `classifyRelayIngress` result the ack stage receives. The E2E proves B's ack to A is excluded by that shared classification and step; it does not run the handler's `runRelayAckStage` itself (the full server closure is not booted).
- **Inbound-id ledger:** unchanged. Recording runs inside the same `runRelayInboundWithLedger` callback; the E2E composes it with a real in-memory ledger.
- **`canonicalHistoryRead` union:** a non-empty log is still returned directly. Relay inbound rows now land in it, so the "11 outbound suppress backfill" symptom no longer arises for new arrivals.
- **ThreadlineReapRecovery / reply validation:** can now resolve over-cap relay bodies via `MessageStore.get`, unchanged code.
- **Symmetry detection (`threadSymmetry`):** gains the inbound legs it was missing. A thread that read `diverged` purely because of the missing legs may now converge. Older history is not backfilled.
- **peerHomebaseBackfill contact hook:** wraps `record`, so it now also fires on appended relay inbound. That is the intended contact semantics.
- **Retention (review P5) — fixed, same close-only semantics.** The ONE production close seam (`installCanonicalRetentionSeam`, installed by `createThreadMessageRecorder`, so server.ts and the E2E share it; server.ts no longer sets its own seam) now deletes the thread's log AND its body partition `messages/bodies/<sha256(threadId)>/` when a non-pinned conversation transitions into resolved/failed. Each delete is independent, so a log-delete failure does not strand the bodies. This also removes a body whose log append failed after the body write (same partition). Pinned closes, cold archive, `retireInactive`/LRU and log rotation keep every body (rotation never touches `bodies/`). No scan, no index, no sweeper, no new policy: one `rmSync` of one directory named by the closing thread. `MessageStore.cleanup` is unchanged (it does not need to see `bodies/`). The id format never shipped, so there is no migration.

## 6. External surfaces

There is no new route, flag, config key or wire field. Two existing read routes now return the real body where they returned `null`/`''`, and may include `createdAtSource`. Bodies stay tagged `bodiesAreUntrustedData: true`. The only new on-disk path is `.instar/messages/bodies/`.

## 7. Multi-machine posture

**Machine-local BY DESIGN.** The canonical log is already machine-local under the single-holder model (ThreadLog header). Each machine records what its own relay socket received. The existing bounded recording-failure notice is reused; there is no new notice type or shareable URL. The durable state is append-only history that does not move on topic transfer, which matches the existing ThreadLog posture. Status surfaces: none changed.

## 8. Rollback cost

Code revert, but not a full undo (review P6). The legacy HMAC inbox was untouched and keeps every message, so a revert loses nothing. Canonical-log rows and `messages/bodies/` files written meanwhile STAY on disk after a revert. They are harmless to the old code: an old reader shows a store-ref body as `null` / `''`, exactly as before, ignores `createdAtSource`, and never scans `bodies/`. No migration, and existing agents need no notice or reset.

## Migration / awareness

This is a bug fix to an existing, already-documented capability: canonical history and `GET /threadline/threads/:id`. There is no new agent-facing command, hook, config default or skill, so `PostUpdateMigrator` and the CLAUDE.md template need no change. Existing agents get it on their normal update.

## Conclusion

The change closes the relay-socket gap in canonical history and removes the dangling large-body reference. It adds no admission or delivery authority. A revert restores the old behavior but leaves already-written rows and body files in place (harmless, §8). Body-record retention on close (P5) and receive-time duplicate-vs-collision (P1) are fixed here. Luna's existing 8-row restoration remains on the active topic-9210 repair bar (main spec §4.11 / PR-A); this change records new arrivals.

## Second-pass review (if required)

Completed by an independent Opus 5.5 helper. Review 1 raised concerns; review 2 concurred after correction. The reviewer's own attributed statement and limits follow below.

## Evidence pointers

See `.instar/state/build/threadline-canonical-inbound-1111/test-log.md`.

## Independent review 2 — Concur, with stated limits (appended by the reviewer)

**Reviewer:** an independent read-only helper, model Claude Opus 5.5 (`claude-opus-5-5`), 2026-11-11. It is not the author. This is the second review; the first review's verdict was CONCERNS (B1, B2). Full report: `.instar/state/build/d5-final-independent-review.md`.

**Concur.** I checked the source myself:

- B1: `ThreadlineBootstrap.ts:736` marks a synthesized timestamp, and the helper honors the mark.
- B2: the shared `createThreadMessageRecorder`, `classifyRelayIngress` and `recordGatePassedIngress` are used by server.ts and by every test tier.
- P1: a receive-time retry of a logged key is re-digested with the logged `createdAt`. The same body is a duplicate; a different body is a collision.
- P5: there is one retention seam. It deletes the log and that thread's `bodies/<sha256>/` partition only.

The real-relay E2E sends an envelope with no id and no timestamp twice, through the real unknown-sender bootstrap and ledger, and gets one `receive-time` row.

I found no change to the auth, gate, ledger, ack or waiter paths. No new trust grant, route or config key is added. The contact hook resolves only mutual-verified peers.

**Unresolved concerns and limits (not blocking):**

- **N1:** §2 says a rotated-out key "can only report duplicate/collision". That is too strong. If the seen cache still holds the key, a same-body receive-time retry is a false `collision` (it is counted and warned; the first row is kept). If the cache entry was trimmed, it adds a second row. This seen-window limit already applies to every path. It is untested and rare, and nothing is lost or overwritten.
- **N2:** the server.ts closure itself is still never executed by a test. Its call order is pinned only by text in `canonical-history-wiring.test.ts`. That was review 1's minimum fix, and it is stated in §5.
- Neither logs nor bodies are removed for a thread that never reaches a ConversationStore close. The "orphan sweep" named in comments has no caller. This is pre-existing parity, not a regression.
- **Reviewer limits:** I had no shell. I did not recompute the snapshot SHA-256 hashes, and I ran no tests, build or typecheck. The coder's focused-unit and typecheck results are their claim. The full suite was still running at root, and I do not claim it passed.

## Root disposition after review 2

- N1's overstrong documentation sentence was corrected. The bounded retry window is disclosed above; evaluating a bounded improvement is queued in Instar feedback as `fb-18ac162e-ab9` (Echo remains the owner). <!-- tracked: fb-18ac162e-ab9 -->
- N2 remains a stated coverage limit: behavior runs through the same exported production functions, with a static pin of their call order in the inline handler. The disposable real server boot passed as an additional initialization check; it is not claimed to drive a live peer through that inline closure.
- Checks at the time of this disposition (historical): 58 focused unit tests passed; source typecheck, full build and full lint passed. Official `test-as-self --no-roundtrip` passed deployment, server readiness and crash checks and tore down the disposable home. The complete-suite status that followed is recorded in the subsections below and in "Current validation status".

### Complete-unit verification and wiring-test correction (historical)

The first complete unit run returned 64,335 passed, 2 failed and 19 skipped. Both failures were existing `ack-stage-wiring.test.ts` assertions that required structural classification and kinded-ack parsing inline in the server handler. They now verify the handler's delegation to `classifyRelayIngress`, the actual helper calls, the stage's use of the returned fields, and the existing waiter-only prefix rule. All 20 wiring tests and 25 history tests pass after this test-only correction. Runtime source remains byte-identical to the reviewed freeze. At that point a fresh complete run was started (outcome below).

### Verification interruption and recovery (historical)

The full-suite wrapper (R2) was interrupted by the session watchdog (exit 130) after about one hour while integration was still queued. The unit phase had completed successfully: 64,337 passed, 19 skipped, zero failures (3,507 files passed, 2 skipped, exit 0). No test child survived. Integration and E2E were then run as separate direct native commands, preserving the completed unit evidence and unchanged runtime source. This does not turn the interrupted wrapper into an exit-zero result: final validation must include the actual verdict of every phase. The wrapper/queue classification issue is recorded as `fb-6796e566-24d`; Echo remains the owner. <!-- tracked: fb-6796e566-24d -->

### Root correction: legacy E2E transport assumption refuted

The reviewer's statement above ("The real-relay E2E sends an envelope with no id and no timestamp twice … and gets one `receive-time` row") is kept as written; it describes the test as it stood when reviewed. The full E2E run (R3: 4,028 passed, 1 failed, 29 skipped, 3 todo) then refuted that test's transport assumption. It finished with exactly one failure: the legacy case timed out on its second wait (`relay-ingress-canonical-history-alive.test.ts:244`). An independent read-only diagnosis traced this to the relay, not to this change: `MessageRouter` caches an absent message id as `undefined` (`MessageRouter.ts:74/128`), so the second id-less envelope was rejected before it reached B. Two relay deliveries of an id-less envelope inside the cache window never happen with this relay, so the test was asserting something impossible. That relay behaviour is an existing, separate defect, disclosed in §2 and tracked as `fb-f0201004-f5e`; Echo owns it. <!-- tracked: fb-f0201004-f5e -->

Runtime source is unchanged. Only the E2E case and this documentation were corrected. The corrected proof is:

1. one real id-less, timestamp-less arrival over the real relay, bootstrap, gate and ledger, recorded before the route hand-off as one `receive-time` row with a stable `legacy-` id;
2. a receiver-only replay of that same accepted message through the same production recorder, which returns `duplicate` and keeps one row with the original `createdAt`. This is not a second relay delivery and proves no admission;
3. the existing real-dependency unit tests (`tests/unit/threadline/relayIngressHistory.test.ts`) for the admitted duplicate and collision boundaries.

The E2E still has exactly four cases.

## Current validation status (reviewable checkpoint)

This branch is a candidate validation **checkpoint**, not a completed build. Root-observed results on the unchanged runtime source:

- Build and full lint passed. Official disposable `test-as-self --no-roundtrip` passed, and its teardown was verified.
- Complete unit phase (R2): 64,337 passed, 19 skipped, 0 failed; 3,507 files passed, 2 skipped; exit 0.
- Complete standalone HTTP integration phase (R3, `npm run test:integration`): 6,717 passed, 23 skipped, 0 failed; 805 files passed, 4 skipped; exit 0.
- Complete E2E phase, first run (R3): 4,028 passed, 1 failed, 29 skipped, 3 todo. The one failure was the refuted legacy two-delivery assumption described above, corrected in the test and this document only.
- Corrected complete E2E phase (R4): **interrupted**, exit 143 (SIGTERM), after 175 test files had passed. There is no failed-test summary and no whole-phase verdict, so R4 is **not** a pass. The actor that sent the signal is unconfirmed: no matching watchdog action was found in the examined evidence, and the root server did not restart. Root found no surviving D5 test or node processes, and all 17 candidate file hashes were unchanged during R4 (`.instar/state/build/d5-final-e2e-r4.json`).
- Inside R4, all four feature E2E cases in `tests/e2e/threadline/relay-ingress-canonical-history-alive.test.ts`, including the corrected legacy wire arrival plus receiver-only replay, passed (4 tests, 638 ms; `.instar/state/build/d5-r4-specific-test-observation.json`).
- Behavioural implementation is unchanged since independent review 2 and the green unit and integration phases. The raw bytes are **not** identical any more: after the blocked checkpoint commit (below), one role-marker comment line changed in some runtime and test files, so the older raw-source hashes no longer match those files. No logic, assertion, fixture, import or type changed.

### Canonical migration contract revision (after the blocked checkpoint commit)

The first checkpoint commit was stopped before it was created by `MCC6-revision-bump-required`, because the change edits producers of the `threadline-inbound-canonical-store` contract (`ThreadLog.ts`, `recordThreadMessage.ts`) and the revision had not been raised. The other 52 normal pre-commit lints passed in that attempt. The fix acknowledges the contract change. It does not skip or change any check:

- `docs/canonical-migration-contracts.json`: revision 3 → 4 (the base on main is 3). No producer, consumer, validator or contract was removed.
- Every role marker already declared moves from `@3` to `@4` together, as a one-line comment change: producers `ThreadLog.ts` and `recordThreadMessage.ts`; consumers `ThreadlineReplyValidation.ts` and `ThreadlineReapRecovery.ts`; the six existing validators.
- Three new validators were enrolled, each with only a `canonical-migration-validator` comment line added: `tests/unit/threadline/relayIngressHistory.test.ts` (writes through the producer to a backed over-cap body and recovers it through the `ThreadlineReapRecovery` consumer), `tests/integration/threadline/relay-ingress-canonical-history.test.ts` (canonical rows and backed bodies read over the real history routes), and `tests/e2e/threadline/relay-ingress-canonical-history-alive.test.ts` (real relay arrival into the canonical store).
- Not enrolled: `relayIngressHistory.ts` and `createThreadMessageRecorder.ts`. Both call or compose the single writer (`recordThreadMessage` / `ThreadLog`) and make no authorization or validation decision on the store, the same as the existing callers in `routes.ts` and `ThreadlineEndpoints.ts`, which are not enrolled either. `canonical-history-wiring.test.ts` still requires them to go through the funnel.
- Focused checks after these edits (coder helper, before root restaged): the 3 targeted unit files (`migration-consumer-completeness-lint`, `recordThreadMessage`, `ThreadlineReplyValidation`) passed 33 of 33. The manifest/marker integrity lint without a diff came back clean. The `--staged` run no longer reports `MCC6-revision-bump-required`; it reported only the 7 lockstep files that had been edited but not yet staged. Root restages and runs it again; that result is root's to record.

**Complete E2E (and therefore whole-suite) verification is pending.** It is delegated to the ordinary official PR verifier, run on the PR's exact head against the current base merge tree. This document deliberately does not record that changing result; the verifier's own records and the PR description carry it. **Merge and release are blocked until every required check is genuinely green.** After release, the inline server.ts closure (N2) still needs a fresh live-peer canary; no live-session result is claimed here.

Open items, all Echo-owned: N1 bounded retry window (`fb-18ac162e-ab9`), relay missing-id replay key (`fb-f0201004-f5e`), watchdog queue classification for long verification runs (`fb-6796e566-24d`). Luna's 8 historical rows remain in the full repair (topic 9210, main spec §4.11, PR-A).

### Required verification failure: `no-silent-fallbacks` on the PR 3078 merge tree

The official Local Verify run for PR 3078 (head `a3fda4a93`, base `164d3f56d`, merge tree `073d354d5`, Node v24.14.1) failed one required unit test: `tests/unit/no-silent-fallbacks.test.ts` counted 495 silent-fallback catches against a baseline of 494. Integration and E2E did not run in that attempt. Root rebuilt the same merge tree independently and reproduced the failure.

Cause, found by comparing the matched catch blocks of the base tree and the merge tree by their content (not their line numbers): exactly one block is new. It is this change's `MessageStore.getThreadBodySync` catch, which returned `null` for any read failure. The base tree passes at 494. No other block was added or dropped by line shifts. This was a real unreported degradation, not a scanner artifact. A corrupt or unreadable body record silently became "no body": history reads showed an empty body and reap recovery could not replay the message.

Fix, with no change to the guard, its baseline, or test selection: a missing record (`ENOENT`, including after close-only retention removes a thread's bodies; the getter cannot distinguish retention from unexpected deletion) still returns `null` quietly. Any other read or parse failure is now reported through `DegradationReporter` (feature `MessageStore.threadBody`), then returns `null`. Callers behave as before. Admission, trust, routing, waiter, ack and session policy are unchanged. `MessageStore.ts` holds no canonical-migration contract role, so the contract revision stays at 4. Real-file regression cases were added to `tests/unit/threadline/relayIngressHistory.test.ts` (an existing `@4` validator; its marker is unchanged): corrupt JSON and an unreadable backing path report once; retention removes the record without reporting. Independent review caught that raw parse errors can quote private message text. The revised report contains only the opaque store ID and a fixed failure category, and the corrupt-file case checks the entire event for a private sentinel. The native helper was interrupted while its filtered red-check command waited; that regression run has no completed result and is not claimed as passed. Fresh regression checks and independent review of the privacy correction are recorded below.

Earlier targeted guard results, before the privacy correction: the guard passes on the patched merge tree (494 ≤ 494), on the base tree (494), and fails on the unpatched merge tree (495). This is a targeted check only. **The whole-suite rerun is pending** on the new commit through the official verifier. Every limit stated above still applies (the R4 E2E interruption, review scope, the post-release live canary, and the unfixed `fb-f0201004-f5e`).


Privacy correction verification: independent reviewer `review_body_read_correction` raised the raw-exception disclosure concern, then **concurred** after inspecting the fixed-category correction (runtime SHA-256 `3919b4d0ba3ca8a01e60e17d9be2524e37fb3c603c2d7ca7fbd5de6c42cbe04e`, test `a05718861fdc10121cc4042492da180229d45e4d07fb1c9591db07ba7d21c4e1`). The reviewer made no edits. Root executed the final two regression cases against the original merged runtime: exactly those two failed because no report was emitted (25 other cases passed). With the correction, the guard and recorder file passed all 32 tests both on the branch (491 catches) and on the exact failed merge tree plus the minimal patch (494 catches, unchanged limit 494). These targeted checks do not establish fresh full-suite success; official verification remains required on the new commit.
