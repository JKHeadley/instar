# Side-Effects Review — Truthful Telegram Injection Failure

**Version / slug:** `telegram-injection-failure-truth`
**Date:** 2026-11-23
**Author:** Echo
**Review status:** Independent implementation review concurred; exact targeted results are recorded below. Startup-only verification passed as recorded below; final-head verification remains pending.

## Summary of the change

A refused Telegram injection no longer populates the successful-delivery dedup map. Possible-effect failures retain a separate same-source uncertainty receipt and return false on repeats, preserving suppression without claiming delivery. An invocation-local observation identifies only the ordinary missing-Codex-baseline branch before prepare and physical effects. The existing routing callback creates durable, attempt-qualified attention and an agent-owned existing commitment, inspects persistence and notice receipts, and returns refused to the forwarding route. The forwarding route awaits its actual handler verdict before acknowledging, so lifeline can withhold Delivered. Native identity, hook installation, binding, lease, replay, bootstrap and physical-effect authorization are untouched. Chief71d7b22c authorized this narrowed increment after the larger design stopped; full-convergence remains false.

## Decision-point inventory

- SessionManager success-only dedup insertion — modify transport mechanics; a false attempt is never a successful prior delivery.
- Exact pre-prepare baseline branch — observe, no new admission authority; nested synchronous context restored in finally.
- Failure attention and commitment — pass through existing stores with actual disk verification and existing synchronous externalKey dedup.
- Response outcome and forwarded acknowledgement — preserve uncertainty; await handler and propagate explicit refusal rather than acknowledge early.
- Native binding/identity/incarnation and historical custody — untouched and parked.

## 1. Over-block

An absent baseline still refuses exactly where the existing guard refuses. No new input meaning rule, sender permission or retry policy is added. Source-key mechanics use authenticated adapter namespace and first-party message identity. The forwarding HTTP request now waits for callback completion as mobile ingress already does; media resolution or a slow existing routing branch can therefore lengthen the request. An HTTP timeout is not a no-effect or resend authority. No deadline increase or new retry is introduced.

## 2. Under-block

This does not fix native identity capture or guarantee eventual delivery. A current refused attempt cannot classify an earlier uncertain physical effect. The notice always uses conservative attempt-qualified wording. Only the exact baseline branch is tagged for durable before-effect failure handling. Generic false outcomes withhold acknowledgement and use uncertainty wording without resend advice. They do not acquire a no-effect tag. Missing stores can still prevent durable recording; combined degradation is explicit instead of a fabricated saved or informed claim. A stored replica can be missing or stale.

## 3. Level-of-abstraction fit

Dedup insertion belongs at the existing Telegram injection chokepoint. The synchronous wrapper observes the real branch rather than parsing logs or repeating an authority check. Failure handling uses existing Attention and CommitmentTracker composition; it creates no inbox or replay loop. The adapter verifies its existing best-effort persistence by actual disk readback before claiming durability.

## 4. Signal vs authority compliance

Reference: docs/signal-vs-authority.md. No brittle message-meaning gate is added. The exact typed branch observes an existing safety invariant; source-ID dedup is transport idempotency, and shape validation is mechanical. Existing dispatch and transport remain authoritative. No notification or commitment authorizes resend, injection or completion.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Success-only cache insertion is enumerable boolean mechanics. The existing tracking cadence and caps are reused. An old uncertain outcome stays unknown; no timing heuristic classifies it.

## 5. Interactions

- Shadowing: observation is emitted only at the first ordinary pre-prepare baseline guard. The later bind failure and matching bootstrap exception are not tagged.
- Double-fire: attention conditionKey and tracker synchronous active externalKey return one record per namespaced source. Concurrent-handler tests read back one active commitment. No cross-process uniqueness is claimed.
- Races: nested observation contexts restore in finally; no process-global reason lookup or second asynchronous baseline check. Forwarding now awaits the actual callback result. Unknown delivery remains under the existing physical-effect authority. The first independent code review found that success-only caching without uncertainty suppression would allow upstream duplicate partial effects. The correction retains suppression in a separate uncertainty receipt using the existing window, with actual partial-effect duplicate coverage; the finding is retained, not called a passing review.
- Feedback loops: no new retry, respawn, automatic resolution or message injection. Notice acknowledgement and later identity binding never discharge the obligation.

## 6. External surfaces

The topic receives plain attempt-qualified failure wording, and forwarding can return additive refused:true for the actual handler refusal. Existing lifeline understands refused and withholds Delivered. Attention/commitment rows contain fixed prose and hashed source identifiers, not raw message text or credentials. No new API endpoint or permission is added. The owner can read/acknowledge via existing phone surfaces; follow-through belongs to the agent and has no resend button.

## 6b. Operator-surface quality

No dashboard markup or new grant/approval form. Existing topic wording leads with what happened and discloses missing persistence or follow-through. It does not present internal hashes as primary content. No destructive operator action is added. Real user-channel verification remains separately required before claiming live benefit.

## 7. Multi-machine posture

Attention uses existing proxied pool reads with their actual peer failure limits. Commitments use existing replication and stored-replica mesh reads; a dark layer can return local-only HTTP200 and missing replicas cannot prove no obligation. The local canonical record is authoritative; no new replication or execution path is added. Notice sends stay inside the existing response envelope and origin-aware sender. No URL is persisted or generated. No new status/health/capabilities/channel answer. The registry awareness entry is consumed by the existing fresh template and PostUpdateMigrator paths, including framework mirrors; no native-hook or config migration is needed.

## 8. Rollback cost

Revert source and release through the normal update path. No schema migration or production repair is required. Retain attention, commitments and historical unknown delivery evidence. Rolling back restores the old false-success risk; do not describe rollback as a delivery repair.

## Conclusion

The bounded source and test implementation is prepared and has actual independent implementation concurrence. Final TypeScript build and all 55 lint checks passed. The original unit batch stopped with 66 passes and 5 failures because the framework-sensitive fixture did not supply the real framework selector's tmux observation. The fixture-only correction preserved production source and assertions. Actual corrected and final targeted results are separated below. Startup-only verification passed; normal final-head complete verification remains pending. This is not a live repair or full-convergence claim.

## Verified targeted cohorts and final source-reference correction

The original allocated unit tier recorded66passes/5failures and stopped before HTTP/lifecycle. The fixture-only correction then ran the affected observation file with7passes/exit0, HTTP with8passes/exit0 and lifecycle with1pass/exit0, all actual ordinary admissions and no required skips. The four unchanged-file unit results remain a separate64-pass cohort; they are not one newly executed combined run. Raw receipts remain under .instar/n80-preparation/runs/.

After that amended batch naturally finished, a separately reviewed three-file correction populated the existing sourceConversationKey and sourceMessageId commitment fields and added unit/lifecycle readback assertions. The source hash remains the dedup key, but is not reversible, so it cannot by itself identify the exact failed message during later investigation. Independent readback concurred that these references are necessary and safe: no raw message content, sourceVerified/owner assertion, schema, replay, dispatch or binding authority is added. This correction was prepared while the prior batch was frozen but not applied until it completed. The exact allocated affected-file batch subsequently passed as recorded below. The prior results remain qualified evidence for their actual bytes.


## Second-pass review

**Reviewer:** `/root/n80_r1_security_adversarial`. **Result:** Concur with the complete bounded final implementation at manifest bcd290d5. The reviewer verified all 21 file checksums and read all nine test/helper paths listed in the normal trace scope. Native uncertainty suppression, isolated observation, awaited refusal acknowledgement, durable existing tracking and exact source references remain intact. No native identity capture, binding change or replay authority is added. This is actual implementation review, not full specification convergence, runtime proof or a new design round. The reviewer ran no tests or probes and edited no files.

The final affected-file allocation naturally passed 8 unit, 4 HTTP and 1 lifecycle cases, each exit zero with actual ordinary admission, matching collection and no required skips. Earlier 64 unchanged unit cases and 7 corrected unit cases remain separate cohorts. Earlier failures are retained. Startup-only verification passed; complete normal verification of the eventual exact pushed head is still required.


## Startup-only verification

The one supported private Node 24 test-as-self --no-roundtrip invocation exited zero at 2026-11-23T10:20:19.906277Z with report PASS. It started the final built distribution in guarded throwaway home 2026-11-23T10-20-13-524Z, port 4040, and passed crash verification. Bot acquisition and roundtrip were intentionally skipped; no live message benefit or lease roundtrip is claimed. Independent exact-target process and listener checks were empty after CLI exit. The harness left its inspection home, which was removed only with SafeFsExecutor after exact path and symlink checks. Independent final checks again found no target processes, listener or home. Full report, stdout, CLI result and teardown receipts are retained privately. This is startup evidence, not complete final-head verification.


## Class-Closure Declaration

`unbounded-self-action`: `n/a`. The added loss notice and durable source record execute once per inbound dispatch refusal, driven by the received message, not a new timer or autonomous retry/controller. Existing CommitmentTracker externalKey dedup and existing PromiseBeacon caps/cadence are reused unchanged. This increment starts no replay, retry, respawn, restart, kill or new recurring loop.

## Fallback scanner repair

The retained full run counted 497 against the ceiling of 493. Two catches explicitly report a degradation but the scanner treated the reporting helper's name as a fallback signal. The attention disk read returns an unconfirmed result that the caller reports. It also sat next to the older save catch, so the scanner attributed that return to the save catch as well. The repair documents the already reported outcomes using the scanner's documented annotation and moves the unchanged readback method above the save method.

Independent review concurred. No permission, outcome, receipt, comparison, or threshold changed. The same scanner reports 493 on the repaired tree.
