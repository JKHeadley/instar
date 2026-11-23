# Side-Effects Review — Combined Phase 2 batch: registries, and practice-fold content pinned to its provider family

**Version / slug:** `cb-p2-verify-fixes`
**Date:** `2026-11-20`
**Author:** `Echo (Opus 5.5)`
**Second-pass reviewer:** independent subagent (see the end of this file)
**Spec:** `docs/specs/context-budget-layered-summaries.md` §16, maturation plan
**Part of:** #3543

## Summary of the change

Local verification and a full local unit run found three project ratchets the batch had not satisfied; review of those fixes found that fold content could reach another vendor, which is now closed.

1. **Feature ladder** (`src/data/feature-ladders.json`): adds `contextBudget.fold.shadow`, measured from the fold log: at least 40 graded folds with zero `step-threw` rows on the dev rung. `contextBudget.layers` dev rung moves from 7 to 3 soak days and metric windows, matching the spec change.
2. **Component registry and family pin.** `FoldAudit` and `FoldProbe` are registered as reflectors. Registration alone would route them by category, possibly to another vendor, against spec §9. So the runner's model calls now use `foldPinnedIntelligence`: a new `pinnedFramework` call option makes `IntelligenceRouter` use only the Claude provider, with no category or nature routing and no failure swap. The router verifies provider identity even in its default slot, because a boot fallback can place another vendor there. To make that possible, `ClaudeCliIntelligenceProvider` and `AnthropicSubscriptionRouter` now declare `frameworkId: 'claude-code'`. If Claude is unavailable the call throws; a provider that cannot prove it is Claude yields `no-judge`.
3. **Hook wiring** (`hookEventConsumers.wireShadowFoldStop`): the runner's `Stop` listener moves out of `server.ts` into the reviewed wiring module, with the consumer fixture updated. A throw in it is contained, so it cannot skip the hook's other consumers.
4. **Fold log rotation:** the rotated file is now `folds.jsonl.1`, the name the ladder reader recognizes, so a rotation no longer hides graded folds or recorded failures.

## Decision-point inventory
No new decision point. The ladder records a bar; advancing it stays an owner action.

## 1. Over-block
None.

## 2. Under-block
The ladder's harm metric counts only `step-threw`. It misses a would-be protected loss (nested in the row), a throw whose close was refused (`terminal-refused`), and a throw before the record began (reported through `onDegraded`, no row). `GET /context-budget/fold-shadow` reports the first two and the Phase 2 exit reads them there.

## 3. Level-of-abstraction fit
Each entry is in the registry that owns it.

## 4. Signal vs authority compliance
`FoldAudit` can decline a practice fold or trigger a send-back. The send-back reaches the live session as a first-party turn, so it now carries only fixed text and the verifier's own codes (`sendBackQuestions`). The audit's free-text questions and deficiency details are never forwarded, because they derive from a handoff that can quote tool output. The request's message index is fenced as data, and a row is labelled `operator` only when `classifyRow` says it is the verified operator's own typed message, so a forwarded, relayed or third party's row cannot pass as the operator's words. Those rows keep their own label (`other-person` in the index, an `other` still-needed origin and tail kind) and render as data from someone else, never as the session's own words.

## 5. Interactions
The pin bypasses component routing and failure swap for these two components only. The cost is availability: with Claude down, a practice fold stops as `no-judge` or a failed step instead of using another vendor, which is the spec's intent.

Declaring that id also affects `OrgActionCheck.providerIsOwn`: on an agent whose sessions run on another framework, a Claude provider no longer counts as that agent's own. That is stricter and more accurate.

## 6. External surfaces
The Maturation Board gains one row.

## 7. Multi-machine posture
The ladder reads each machine's own log, matching the per-machine runner.

## 8. Rollback cost
A revert.

---

## Second-pass review

(appended below by the reviewer)

Concern raised:

1. **BLOCKING: the new categories send fold content to other vendors, against the spec.** Spec §9 (the paragraph before "## 10") requires `FoldAudit` and `FoldProbe` to run under an `enforced` routing plan pinned to the conversation's own provider family, so handoffs and folded spans never reach a vendor the conversation never used. No such plan exists: neither component is in `natureRoutingMap.ts`, and their calls pass only `attribution.component`. With no operator `componentFrameworks` and active frameworks `[codex-cli, gemini-cli, claude-code]`, `resolveInternalFrameworkDefault` plus the registry now gives `FoldAudit` -> gemini-cli and `FoldProbe` -> codex-cli. Unregistered, both resolved to the agent default. So the artifact's "None changes what a practice fold does" is false, and §5 presents a spec violation as normal gate routing. Fix: implement the pinned plan (or pin to the session's family) before this ships. `gate` is also a poor fit on its merits: that category picks the fastest framework for synchronous, user-blocking checks, and this audit is a background call with a 90s timeout.

2. **BLOCKING: the ladder cannot see rotated fold rows, and the harm metric can read clean because of it.** The path, `stateDir`, `at` (epoch ms) and the `outcome`/`reason`/`t` matches are all correct. But `foldShadowLog` rotates to `folds.1.jsonl`, while `LadderEvidenceReader.segmentsOf` only recognizes `folds.jsonl.<n>`. Reproduced with the real modules: 40 graded rows plus 1 `step-threw` read as count 40, ratio 0.024; after one rotation they read as count 0, ratio 0, with no `evidence-cut`, while `readShadowFolds` still reports 40 graded. A recorded failure therefore disappears and the at-most-0 harm metric can pass. Fix: align the rotated name or teach the reader this segment, and test it. The 40 bar itself is reachable (about 3 graded folds a day, and retention is by size, 2 MB, not age), but each rotation resets the visible count.

3. **Harm metric undercounts (lesser).** A step throw whose close is refused is logged as `terminal-refused: ...`, and a throw before the fold record begins writes no row (only `onDegraded`). Neither counts as `step-threw`. §2 of the artifact names only the protected-loss gap.

4. **`wireShadowFoldStop` (minor).** Payload fields and unsubscribe are correct, and it is the only `Stop` listener today. But `emit` in `HookEventReceiver.receive` is unguarded and the listener calls `enabled()` and `sessions()` without a try, so its "does not throw" comment is not enforced; a throw would skip `dispatchHookEvent`'s side effects. I did not show that either call throws in practice. The new function was also inserted between `wirePreCompactionFlush` and its doc comment, so that comment now sits on the wrong function.

Verified: the three permitted test files pass (39 tests). They do not cover items 1 or 2.

Re-review:

Concern raised:

1. **BLOCKING: the pin can still run fold content on another vendor when Claude failed to build at boot.** If the configured framework is `claude-code` but its provider build returns null, `server.ts` (the `enabledForFallback` loop) makes another enabled framework the shared provider, while the router keeps `defaultFramework: 'claude-code'`. `resolveProvider('claude-code')` then returns that other vendor, and the pin's identity check is skipped because `framework === defaultFramework`. Reproduced with the real `IntelligenceRouter` and `foldPinnedIntelligence`: a default provider with `frameworkId: 'codex-cli'` under `defaultFramework: 'claude-code'` served a pinned `FoldAudit` call. The same gap exists without a router: `foldPinnedIntelligence` accepts `frameworkId === undefined`, and the Gemini and Pi providers declare no `frameworkId`, so a Gemini fallback passes as Claude. The artifact's "If Claude is unavailable the call throws" is therefore not true in this path.

2. **The pin always fails on a Codex-default agent running Claude sessions (fails closed, but the feature cannot work there).** `ClaudeCliIntelligenceProvider` and `AnthropicSubscriptionRouter` declare no `frameworkId` (a factory-built Claude provider reports `undefined`), so the non-default branch's `provider.frameworkId !== framework` always throws "identity unverified". The new test covers only a missing Claude provider, so it does not show this. One fix closes both items: give the Claude providers `frameworkId: 'claude-code'` (the wrappers already forward it), require strict equality in the router and in `foldPinnedIntelligence`, and add tests for a mislabeled default and a real Claude build under a Codex default.

Confirmed fixed: the audit, probe and grade calls all use the pinned provider, and the answerer spawns on Claude. The early return keeps decision minting and settlement in `evaluate()` and the breaker and spawn-cap wrappers; the subscription router's fallback stays within Anthropic. Rotation to `folds.jsonl.1` is read by the ladder, `wireShadowFoldStop` contains a throw and its placement is fixed, and artifact §2 is accurate. The three requested test files pass (39 tests).

Final re-review:

Concur with the review.
(a) Real factory-built Claude providers (plain, with breaker, and with the subscription router) all report `claude-code` through their wrappers and pass the pin, and `server.ts` puts that build directly in the router's default slot, so the pin does not fail closed on a normal Claude agent. The two requested test files pass (28 tests).
(b) `frameworkId` has two other readers. `OrgActionCheck` changes only when it is handed a raw Claude provider on a non-Claude agent; `IntelligenceRouter` declares no id, so a routed provider still counts as own. In block mode that case now reads `unknown` and holds the action, as the artifact's "stricter" note covers. The one effect the artifact does not mention is harmless: in `CircuitBreakingIntelligenceProvider`, a Claude call that ends before `onModel` fires now records its usage row as `claude-code` instead of null.

Registry re-review:

Concern raised:

1. **BLOCKING: `FoldAudit` can put model-written text into a live session, so its registry and artifact descriptions are false.** The provenance entry says it "can only decline a practice fold, and nothing in a live conversation changes", and artifact §4 says the same. In `foldShadowRunner.ts`, a send-back copies `audit.verdict.questions` into `buildHandoffRequest`, which lists them unfenced, and `session.inject` delivers that as a new turn. `server.ts` injects with `firstParty: { source: 'fold-handoff' }`, and `SessionManager.injectMessage` sends first-party text straight to `rawInject`, skipping the InputGuard layers. The audit reads a handoff that can quote tool output (this entry is itself marked `EXPOSED_ALL`), so injected text that steers the audit could reach a live, full-permission session as an unguarded turn. I traced this path in code and did not run an exploit. It is in the batch's committed runner rather than this diff, but the fold flag is live on the dev agent once enabled. Fix: do not forward free-text audit questions (use fixed question codes or deterministic deficiency text), or fence them as data and send them through the guarded path; then correct the provenance reason and §4.

2. **The `FoldProbe` contract entry covers only part of its parsing.** `FoldProbe` has two model replies: question generation (`foldProbe.ts`, closed `PROBE_TYPES`) and grading. The entry names only `fold-grade.test.ts`, which does not exercise generation; that coverage is in `fold-probe.test.ts`. Within the grade vocabulary, `retained` and `retrievable` pass through the parser in tests, but an accepted `lost` reply never does (`verdict('lost')` bypasses `parseGrade`, and the one parsed `lost` case is a rejection). Fix: add an accepted `lost` case and name both test files in the entry's comment or contract.

Confirmed: `FoldAudit`'s `completionClaim` is accurate (its prompt asks whether anything called finished is contradicted by the signals) and has no runtime effect, because only the ratchet test reads `LLM_JUDGES_CLAIMS`. The exposure and untrusted flags are consulted by the nature resolver, which the pin returns before, and otherwise feed the display map, so they do not change these calls. `parseAudit`'s closed vocabulary is exercised on both verdicts and on rejection. Per instruction, no tests were run for this pass.

Send-back re-review:

Concern raised:

1. **BLOCKING: the message index still carries agent- and sender-written text, unfenced, in the first-party turn.** `buildHandoffRequest` adds up to 200 rows from `topicMemory.getRecentMessages`, each an 80-character excerpt of the row's raw text, with no `fenceData` or other data marking. The turn is injected with `firstParty`, so it skips InputGuard. Agent rows can quote tool output or web pages. Collapsing whitespace stops an excerpt from forging a new line, but not from carrying an instruction or a fake `#id operator:` label within its own line. `TelegramAdapter` logs an inbound message before its routing callbacks, so a message the guard later refuses at injection can still appear here. The 80-character limit reduces this risk but does not remove it. I traced this in code and did not run an exploit.

2. **The index labels non-operator text as `operator`, and the verifier then trusts it.** The label is just `fromUser`. Telegram sets `fromUser: true` on forwarded messages (with `forwarded: true`), on every authorized sender in a multi-user topic, and on any sender when no allowlist is configured. The `messages` mapper in `server.ts` drops `forwarded` and the sender fields. `verifyHandoff` builds `opByText` from the same `fromUser` rows, so a forwarded third party's words can pass as `origin: 'user'` or as a bound decision, and `foldPacket` frames them as `operator · kept by the handoff`. Today that packet reaches only the throwaway answerer, so the effect is limited to grading; it must be fixed before any fold replaces live context.

Fix for both: pass `forwarded` and sender identity through the mapper, label a row `operator` and admit it to `opByText` only when it is a non-forwarded message from the verified operator, and render the index as fenced data with the fence tag neutralized.

Confirmed: `sendBackQuestions` forwards only fixed text, well-formed verifier codes and a count, and `buildHandoffRequest` at `foldShadowRunner.ts:229` is the runner's only `session.inject`. `fold-shadow-runner.test.ts` and `fold-grade.test.ts` pass (33 tests).

Index re-review:

Concern raised:

1. **A non-operator's words are presented in the fold packet as the session's own.** `foldMessageRow` now reduces every non-operator row to `fromUser: false`, so the packet can no longer tell a real agent message from a forwarded, relayed, third-party or unattributed one. There are two paths. In the tail, `foldShadowRunner.ts:273` maps every `fromUser: false` row to `{ kind: 'agent' }`, and `foldPacket` renders it as `(agent message #id; author: session)`. In still-needed items, a quote marked `user` that is not an operator row is relabelled `agent` and rendered as `(your own words, relabelled from "user"...; author: session)`; the handoff prompt also offers no origin for another person's words. So a forwarded "approve the deploy" would read as something the session itself said. It also catches the operator's own messages when a row has no sender identity (`classifyRow` returns `third-party`, confirmed with the real helper). `neutralizeDerived` stops forged frames but does not correct the author. Today the packet reaches only the throwaway answerer, so the effect is limited to grading and this does not endanger a live session. It should be fixed now, and must be fixed before any fold replaces live context. Fix: carry the `classifyRow` label through `foldMessageRow`, add a tail kind and a still-needed origin for non-operator people rendered as labelled data ("from another person / forwarded: not the operator, not you"), and test both paths.

Confirmed: (a) the mapper's binding is identical to `server.ts:19657`, and `_memoryPrivacyWired` is a const set at line 7910 and read at call time. (b) Coverage is unaffected, and the U floor still comes from stored operator rows, so a disagreement there refuses the packet rather than passing it. (c) The index fence holds against closing-tag variants (run against the real builder), and the rest of the turn is fixed text, the generated fold id, and verifier codes, so no other model- or tool-derived text remains. The four requested test files pass (59 tests).

Labels re-review:

Concur with the review.
(a) A sender-less row gets `fromUser: false` and `fromOther: true`, so it reads as `other` and cannot read as operator; operator labels, `opByText` and bound decisions all require the verified binding. (b) `other` items and tail rows are neutralized, render only in the handoff and tail sections with no protected span, count toward coverage and still-needed, and a forged frame in them is refused. The two requested test files pass (32 tests).
(c) Nothing blocks the shadow phase. One gap must close before any fold replaces live context: only an exact whole-row match becomes `other`, so a partial third-party quote marked `user`, or a whole one the session marks `agent`, still renders as `author: session`; today that reaches only the throwaway answerer.
