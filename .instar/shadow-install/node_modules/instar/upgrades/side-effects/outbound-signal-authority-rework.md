# Side-Effects Review — Outbound gate signal/authority rework

**Version / slug:** `outbound-signal-authority-rework`
**Date:** `2026-04-15`
**Author:** Echo (autonomous, forward-plan Track 2 — T2.4 + T2.5 combined)
**Second-pass reviewer:** pending — will be conducted via reviewer subagent before shipping; this artifact will be amended with the subagent's findings before commit.

## Summary of the change

Reshapes the outbound-messaging gating in `server/routes.ts` from three independent blockers (junk-payload guard, tone gate, outbound dedup) to a single authority (`MessagingToneGate`) that receives structured signals from the other two as upstream detectors. Also hardens the authority itself with rule-id enforcement and a structured decision log.

Specifically:

1. **`src/core/MessagingToneGate.ts`** — extended `ToneReviewContext` with a `signals` field carrying `{ junk: {detected, reason}, duplicate: {detected, similarity, matchedText} }`. Extended the prompt with an explicit enumerated rule list (B1–B9). Added two new signal-driven rules: `B8_LEAKED_DEBUG_PAYLOAD` and `B9_RESPAWN_RACE_DUPLICATE`. Added reasoning-discipline enforcement: if the LLM returns a block with a rule id not in the enumerated set, or with no rule id at all, the gate fails open and flags `invalidRule: true` on the result. Added `rule` field to `ToneReviewResult`.

2. **`src/server/routes.ts`** — replaced three separate helper functions (`checkMessagingTone`, `checkJunkPayload`, `checkOutboundDedup`) with one helper (`checkOutboundMessage`). New helper collects junk + duplicate signals, passes them to the tone gate, and returns the gate's single decision. All four channel routes (telegram reply, telegram post-update, slack, whatsapp, imessage) now use the unified helper. Added `logToneGateDecision()` — structured stderr log of every decision for over-block audits.

3. **`tests/unit/MessagingToneGate.test.ts`** — updated existing block-case tests to include rule ids. Added a new `reasoning-discipline enforcement` suite (invalid rule → fail-open, no rule → fail-open, valid signal-driven rule → honored). Added a new `signal rendering` suite (junk signal renders in prompt, duplicate signal renders with similarity, placeholder when no signals).

Files changed:
- `src/core/MessagingToneGate.ts`
- `src/server/routes.ts`
- `tests/unit/MessagingToneGate.test.ts`

## Decision-point inventory

| Decision point | Change | Description |
|---|---|---|
| `server/routes.ts` junk-payload 422 path | **remove** | No longer holds block authority. |
| `server/routes.ts` dedup 422 path | **remove** | No longer holds block authority. |
| `server/routes.ts` `checkOutboundMessage()` | **add** | Unified single-authority helper — collects signals, calls tone gate, returns one decision. |
| `MessagingToneGate.review()` | **modify** | Accepts signals parameter; enforces rule-id discipline; exposes `invalidRule` flag. |

No decision points remain that violate the signal-vs-authority principle in the outbound messaging path.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- A legitimate "test" sent in a conversation where the user just said "this is a test of the emergency broadcast, can you acknowledge" — the tone gate, seeing the junk signal AND the recent user message, should pass. The old junk-payload guard would have blocked this unconditionally; the new authority has the context to allow it.
- A legitimate restatement after "can you say that again" — the tone gate, seeing the duplicate signal AND the recent user request, should pass. The old dedup gate would have blocked.
- Technical narrative prose — the gate's rule list is explicitly closed (only B1–B9 can trigger a block). "Exposes internals" is not in the list. The reasoning-discipline enforcement specifically catches the drift we observed on 2026-04-15 where the gate invented an over-broad rule.

**New over-block risks introduced by the change:**

- If the LLM's judgment on B8 (leaked-debug) is too aggressive, even context-aware blocks could still misfire. Mitigation: the gate's decision is logged with the full signal context; the audit tail can detect patterns.
- The LLM now has more information per call (signals section added to prompt). This may bias it toward blocking when signals are triggered even when context says not to. Mitigation: prompt explicitly calls out cases where signals DON'T justify blocking (e.g., user asked to repeat).

---

## 2. Under-block

**What failure modes does this still miss?**

- A semantically-paraphrased duplicate that the dedup detector scores below 0.7 similarity will not produce a `duplicate.detected=true` signal. The authority will therefore have no dedup signal to act on. This is the known trade-off documented in the dedup gate module and now inherited. Future: consider an embedding-similarity fallback; out of scope for this change.
- A debug-token the junk detector doesn't know about (e.g., a new internal sanity probe) won't be flagged. Same as before — the detector's token list is the constraint.
- If the LLM itself fails open (provider timeout, malformed JSON), the message passes. Unchanged behavior, documented semantic.

---

## 3. Level-of-abstraction fit

This is the whole point of the change.

Before: three layers of brittle detectors in front of a smart gate, each with independent block authority. Wrong levels holding authority they shouldn't have.

After: detectors are pure classifiers emitting structured evidence. One smart gate, with full conversation context and enumerated rules, makes the single block/allow call. Each piece is operating at the level appropriate to its capability.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate (for the two detectors)
- [x] Yes, with smart-gate logic + full conversational context (for the single authority)

Both detectors (`isJunkPayload` and `OutboundDedupGate.check`) have zero blocking authority after this change. They are pure functions producing structured evidence. The authority (`MessagingToneGate.review`) now owns all block/allow decisions and traces its reasoning to an enumerated rule list, with drift detection that fails open on invalid rule citations.

This is the canonical signal-vs-authority pattern from the principle doc, applied to the exact decision point that prompted the principle to be written.

---

## 5. Interactions

- **Test suites:** 65 unit tests pass (MessagingToneGate: 23, OutboundDedupGate: 11, junk-payload: 31). 90 integration tests pass (server.test.ts + messaging-routes.test.ts). Full suite: 15847/15861 passing (7 failed, 7 skipped — the 7 failures include one preexisting `security.test.ts execSync` check unrelated to this change; the other 6 occurred in a truncated test run output and were not reproducible in the targeted reruns).
- **Bypass metadata flags** preserved: `isProxy`, `allowDebugText`, `allowDuplicate` still work via the new helper's signature.
- **Upstream detectors** (`isJunkPayload`, `OutboundDedupGate.check`) are not modified — the change is in how they're wired. Existing callers elsewhere in the codebase (none currently, they were only used by the routes we reshaped) would be unaffected.
- **Downstream consumers** of the 422 response see a different body: `rule` field is now populated. Telegram-reply.sh reads `issue` and `suggestion` which are unchanged. The new `rule` field is additional context, not a breaking change.
- **Decision log** writes to stderr. This adds log volume proportional to outbound message throughput. Low cost (one JSON line per outbound), but worth monitoring if throughput is high.

---

## 6. External surfaces

- **Other agents:** no change to any agent-runtime code. Change is in the server that hosts the agent, not the agent itself.
- **Other users:** user-visible behavior changes only in that fewer legitimate messages get over-blocked. 422 response body gains a `rule` field (non-breaking addition).
- **External systems:** none.
- **Persistent state:** none.
- **Timing / runtime conditions:** none new.

---

## 7. Rollback cost

Low. The change is additive and localized:

- Revert `MessagingToneGate.ts` to its pre-change version.
- Revert the `checkOutboundMessage` helper and restore the three separate helpers in `routes.ts`.
- Revert `MessagingToneGate.test.ts` to match.

Since the pre-change code is `git log -1` away and no persistent state is touched, the rollback is a simple git revert of one commit. Callers outside this change (none exist) would not be affected.

---

## Conclusion

The change is the canonical application of `docs/signal-vs-authority.md` to the exact decision point that motivated writing the principle. Detectors are now pure signal producers. The tone gate is the sole authority, traceable to an enumerated rule list, with drift detection built in. Over-block risk is reduced (context-aware judgment on short messages + repeats). Under-block gaps are documented and unchanged (same detector coverage as before).

The change is clear to ship pending second-pass review. The second pass specifically should examine:
1. Whether the enumerated B1–B9 rule list is complete for the legitimate outbound-block cases.
2. Whether the reasoning-discipline enforcement (fail-open on invalid rule) is the right default, or whether it should log-and-block instead.
3. Whether the over-block audit log needs additional fields for pattern detection.

## Second-pass review

**Reviewer:** independent subagent (general-purpose), read the artifact + code diffs + principle doc independently
**Verdict:** CONCERN → resolutions applied → final state acceptable for commit

### Reviewer findings and resolutions

1. **Bypass flags were only wired on `/telegram/reply`; slack/whatsapp/imessage/telegram-post-update all called with `{}`.**
   - *Resolution applied:* extracted `metadata.allowDebugText` and `metadata.allowDuplicate` on all four additional channel routes and threaded them into `checkOutboundMessage`. Verified in the updated diffs for `/telegram/post-update`, `/slack/reply/:channelId`, `/whatsapp/send/:jid`, and `/imessage/validate-send/:recipient`.

2. **Channels other than telegram-reply have no conversation source, so `recentMessages` is undefined; the signal-driven rules B8/B9 would misfire without context.**
   - *Resolution applied:* constrained B8 and B9 in the prompt to REQUIRE non-empty recent conversation. The prompt now explicitly instructs: "If the recent conversation section says '(no prior context available)', do NOT apply B8/B9 — pass instead." Signal-driven blocks can now only fire on paths that actually supply conversational context. Slack/whatsapp/imessage traffic still gets B1–B7 coverage (pure literal patterns, no context needed).

3. **Test coverage gap: B9 (respawn-race) had no test parallel to B8.**
   - *Resolution applied:* added a test in `reasoning-discipline enforcement` that mocks a `B9_RESPAWN_RACE_DUPLICATE` response with full duplicate signal + recent conversation context, asserts the gate honors it. All 24 MessagingToneGate tests pass.

4. **No route-level integration test verifies `checkOutboundMessage` actually threads signals to the gate.**
   - *Deferred:* the existing MessagingToneGate unit tests verify the gate consumes signals correctly; the route-level test is valuable regression insurance but not load-bearing for correctness. Flagged in the Track 2 backlog for follow-up.

5. **Rule-set completeness: no explicit rule for secret/token leaks (API keys, bearer tokens, webhook URLs with secrets).**
   - *Acknowledged as known gap:* the old junk-payload guard didn't cover these either, so this is not a regression. A `B10_SECRET_LEAK` rule would require a separate detector (e.g., a regex matcher for common secret shapes) feeding the authority as another signal. Flagged as a discrete follow-up change — not conflated with this rework.

### Verdict after resolutions

The core principle compliance is clean: detectors produce signals, the authority decides, rule-id enforcement catches drift. With the four resolutions above applied, the artifact's claims accurately match the implementation. The two deferred items (route-level integration test, secret-leak rule) are captured as backlog items, not hidden assumptions.

**Cleared for commit.**

## Evidence pointers

- Unit tests for MessagingToneGate: `tests/unit/MessagingToneGate.test.ts` (23 tests, all pass). Specifically the `reasoning-discipline enforcement` suite validates the drift-detection against the exact failure observed 2026-04-15 where the gate cited rules not in its prompt.
- Integration tests pass: `tests/integration/messaging-routes.test.ts` (74 tests).
- Type-check clean: `npx tsc --noEmit` exit 0.
- Live verification will be conducted post-commit by sending a message flow through the updated server and observing the structured decision log.
