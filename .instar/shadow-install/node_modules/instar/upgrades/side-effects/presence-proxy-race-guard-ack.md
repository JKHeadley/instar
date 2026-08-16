# Side-Effects Review — PresenceProxy race-guard + Tier 1 ack-only-delta

**Version / slug:** `presence-proxy-race-guard-ack`
**Date:** `2026-05-13`
**Author:** `echo`
**Second-pass reviewer:** `pending — high-risk (touches watchdog/timer cancel path)`

## Summary of the change

Closes two gaps left open by PR #128 (presence-proxy ack + baseline).

1. **Race guard now ack-aware.** `checkLogForAgentResponse` in `src/commands/server.ts` (the function wired into `PresenceProxy.config.hasAgentRespondedSince`, which fires inside `fireTier` as a safety net before Tier 2/3) re-reads the messages log to decide "did the agent already respond?" PR #128 taught the event-driven path (`PresenceProxy.onMessageLogged` → `recordAgentMessage`) to treat brief acks as non-cancelling, but the log-reader did not share that classifier. Result: an ack written to the messages log was read back at Tier 2 time and treated as a real response — silently cancelling progressive updates. Fix: import the same `isBriefAck` from PresenceProxy.ts and skip ack-classified entries alongside the existing system/proxy filter.

2. **Tier 1 ack-only-delta guard.** At the 20-second Tier 1 firing point, the post-message terminal delta typically contains only the agent's own ack text. The LLM was then prompted to "describe what the agent is doing in response," and produced a generic paraphrase of the ack ("Echo acknowledged and is investigating"). Fix: track the most recent brief ack on `PresenceState` (`lastAckText` + `lastAckAt`), expose `isPostMessageDeltaAckOnly()` that detects "anchored delta is short AND we have an ack on record," and short-circuit `fireTier1` to a fixed placeholder ("on this — I'll check back at the 2-minute mark with a progress update.") when both hold. The LLM call is skipped entirely, saving a token call and producing a clearer message.

Files touched:
- `src/monitoring/PresenceProxy.ts` — `PresenceState` adds `lastAckText` + `lastAckAt`; new role `'ack'` on `conversationHistory` (replacing the `// not strictly proxy` hack); new exported `isPostMessageDeltaAckOnly()`; `fireTier1` short-circuit; `buildConversationPrompt` history-rendering updated to label `Agent (ack)` rows; restart recovery defaults the new fields to null.
- `src/commands/server.ts` — `checkLogForAgentResponse` imports and applies `isBriefAck` alongside `isSystemOrProxyMessage`.
- `tests/unit/presence-proxy-race-guard-ack.test.ts` — 12 new tests across `isPostMessageDeltaAckOnly`, the log-reader filter, and the Tier 1 short-circuit.

## Decision-point inventory

- `PresenceProxy.fireTier`'s race-guard call to `hasAgentRespondedSince` — **modify** — now filters brief acks from "has the agent responded" via shared classifier.
- `PresenceProxy.fireTier1`'s LLM-vs-placeholder branching — **add** — new short-circuit when post-message delta consists solely of an ack.
- `conversationHistory` role schema — **modify** — adds `'ack'` as a distinct role from `'user' | 'proxy'`. No external surface — internal-only structure.
- The agent-ack handling in `PresenceProxy.onMessageLogged` — **modify** — now also stamps `state.lastAckText` / `state.lastAckAt`.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- A genuine substantive reply that begins with an ack opener (e.g., "Got it. I traced the bug to PresenceProxy.fireTier and patched checkLogForAgentResponse. PR coming.") that's **also** under 200 characters would be classified as an ack. The existing `isBriefAck` 200-char cap and 60-char opening-window already handle this — substantive replies are reliably longer than 200 chars. Verified by the existing `isBriefAck` tests in `presence-proxy-ack-and-baseline.test.ts`. The bias matches the documented "false-positive (treat real reply as ack) costs at most one extra standby message; false-negative is the bug we're fixing."
- A small post-message delta (≤ 350 trimmed chars) that happens to contain genuine work would skip the LLM summary in Tier 1 and emit the placeholder instead. This is an acceptable trade: 20 seconds is too early for substantive work, so misclassifying it as "still early" is the right error direction. Tier 2 (2 min) will still run with a fresh snapshot and capture the work.

---

## 2. Under-block

**What failure modes does this still miss?**

- If an ack message lands on disk but `isBriefAck` returns false (e.g., agent wrote a longer first-touch reply that happens to also be conversational filler), the race guard would still cancel Tier 2 — by design, because that reply IS a substantive agent message. We don't gold-plate the ack classifier beyond the existing patterns.
- If the agent never sends an ack at all (so `state.lastAckText` stays null), Tier 1 falls through to the LLM path. The original "summary paraphrases pre-ack work" issue is already mitigated by the baseline/delta scoping from PR #128; this change adds a second pass of mitigation only for the ack-then-silence case.
- If the agent acks AFTER Tier 1 has already fired (rare, but possible if the agent's LLM is slow), the ack-only-delta short-circuit doesn't fire because Tier 1 already produced its message. Tier 2's prompt still gets the existing baseline-anchored scope. Acceptable.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

- `isBriefAck` already exists and is exported. Reusing it in `checkLogForAgentResponse` is the right level: single source of truth, no duplicate matcher.
- `isPostMessageDeltaAckOnly` is a thin helper layered on `extractDeltaSinceBaseline` (same module) — also right layer.
- The `'ack'` conversation-history role replaces a brittle hack (`role: 'proxy' // not strictly proxy`) that previously confused `isConversation` detection. Lifting the ack into its own role is the right structural cleanup; without it, the Tier 1 short-circuit would never trigger (because `isConversation` would always be true after an ack). Verified by debugging in this build.

No higher-level gate exists for this domain. The decision being made — "should Tier 2 cancel?" / "should Tier 1 call the LLM?" — is a lifecycle question, not a user-facing block/allow.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface visible to other agents or users.

The change is internal lifecycle management of progressive standby timers. `isBriefAck` is a brittle (regex) detector producing a boolean signal; the action it influences is "should this timer keep running?" — not user-message gating. The signal-vs-authority principle is about decisions that gate information flow or constrain agent behavior; cancelling a not-yet-fired internal timer is closer to "idempotency / dedup at the transport layer" (one of the exceptions documented in the principle doc).

If the brittle detector mis-fires (treats a real reply as an ack), the consequence is at most one extra Tier 2 standby message — a UI nuisance, not a block. If it under-fires (treats an ack as a real reply), the consequence is what we're fixing here: Tier 2 silently cancels. Either way, no message is suppressed or blocked.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** The race-guard `hasAgentRespondedSince` runs early in `fireTier`. By tightening it (more entries pass through as "no real response"), we are NOT shadowing any downstream check — we are restoring the downstream checks (Tier 2 / Tier 3 firing) that were being inadvertently suppressed.
- **Double-fire:** The event-driven path (`onMessageLogged`) and the log-reading race-guard now share `isBriefAck` semantics; neither will fire timer cancellation on an ack. They are still defense-in-depth — they cancel under the same conditions, just consistently.
- **Races:** `state.lastAckText` is set inside the synchronous `onMessageLogged` handler; `fireTier1` reads it asynchronously when its timer fires. Same single-event-loop process, so no concurrency hazard. Recovery-from-restart explicitly resets `lastAckText` to null because we don't persist it — the Tier 1 short-circuit degrades to "let the LLM summarize," which is the original behavior.
- **Feedback loops:** None. The Tier 1 placeholder message goes out to the user, not back into PresenceProxy. The ack-only-delta check reads `state` and snapshots, not its own prior output.
- **`findLastRealMessage` callsites:** Two other callsites in server.ts (lines 4417 and 4741) use `findLastRealMessage` for compaction-recovery and Slack zombie-kill paths. Those make different decisions ("did the agent meaningfully respond to this conversation at all?") and are intentionally NOT extended with `isBriefAck` filtering in this PR — different semantic domain. Noted for future scope only.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Telegram / Slack messages users see:** Tier 1 in the ack-only-delta case now emits a fixed string ("`{agent} is on this — I'll check back at the 2-minute mark with a progress update.`") instead of a paraphrased LLM summary. This is the intended UX improvement.
- **Persistent state files:** `state.lastAckText` / `state.lastAckAt` are **not** persisted (added explicitly to the `recoverFromRestart` defaults as null). The persistable shape in `persistState` is unchanged.
- **`conversationHistory` role type:** Now `'user' | 'proxy' | 'ack'`. This shape is internal to PresenceProxy and not exposed via any API. The `buildConversationPrompt` history rendering treats `'ack'` as `'Agent (ack)'` in the LLM prompt — a quality-of-information improvement for conversation mode.
- **Other agents on the same machine:** None — PresenceProxy is per-agent.
- **External systems:** None — no Telegram / Slack / GitHub API contract changed.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

- Single PR, single commit (one chained change in server.ts + PresenceProxy.ts + tests). Revert is a single `git revert <sha>`.
- No data migration: no persisted schema changes, no state-file format changes.
- No agent state repair needed: `lastAckText` is in-memory only; if the rollback drops it, the next user message creates fresh state.
- The fallback if `isBriefAck` ever becomes too aggressive in production: tighten `BRIEF_ACK_PATTERNS` or reduce the 200-char cap. No emergency rollback required because the failure mode is "one extra standby message" — annoying, not destructive.
- Hot-fix path: re-release after revert. Standard semver patch.

---

## Evidence

- **Live failure signal reproduced:** `logs/server.log` on the user's machine shows `[PresenceProxy] Skipping Tier 2 for topic 8882 — agent already responded (race guard)` at `2026-05-13T15:55:05` — exactly 2 minutes after the user's `15:53:05` message and an ack at `15:53:09`. With the fix, the same scenario in `tests/unit/presence-proxy-race-guard-ack.test.ts > checkLogForAgentResponse (race-guard log filter) > returns false when the only post-baseline message is a brief ack` would return false, allowing Tier 2 to fire.
- **Test coverage:** 12 new unit tests in `tests/unit/presence-proxy-race-guard-ack.test.ts`. All 76 PresenceProxy unit tests and all 44 PresenceProxy e2e tests pass.
- **Bug-fix evidence bar:** Reproduced the failure signal in the live log + asserted on the corrected filter via test. Memory item `feedback_bug_fix_evidence_bar` requirement met.

---
## Second-pass review

**Reviewer:** echo (independent second-pass agent)
**Date:** 2026-05-13
**Verdict:** Concur with the review.

I independently re-read `isBriefAck` (line 398) against `BRIEF_ACK_PATTERNS` (line 355), the `onMessageLogged` ack branch (line 705), the `fireTier1` short-circuit guard (line 970), and `recoverFromRestart` (line 1773), and cross-checked `checkLogForAgentResponse` (server.ts:4802). The signal-vs-authority argument in §4 is honest: both code paths route an `isBriefAck` boolean into the lifecycle decision "should this internal timer cancel?" — not a user-facing block/allow. Nothing is suppressed; the worst-case mis-classification of a real reply as an ack costs one extra standby message, which the artifact correctly identifies. Persistence/recovery in §5 is also sound: `lastAckText` is intentionally unpersisted, and on restart the guard's `state.lastAckText` precondition fails, falling through to the existing PR #128 LLM-summary path. No state-recovery race exists — the race-guard log filter is the path that needs to survive restart, and that one IS persistent (reads disk).

One sub-blocker observation worth flagging for follow-up rather than holding the PR: §1's claim that "substantive replies are reliably longer than 200 chars" overstates the cap's protection. A 99-char real reply opening with "Got it." (the artifact's own example) does match `isBriefAck` — verified by reading the patterns. The artifact then correctly bounds the cost to one extra standby message, which is acceptable, but the wording should be tightened so future readers don't conclude the cap eliminates the false positive entirely. Also minor: the Tier 1 placeholder test asserts `toMatch` rather than "appears exactly once" — a stronger non-flaky assertion would count occurrences of the placeholder string and assert `=== 1`, which pins the short-circuit semantics without depending on whether Tier 2 also fires under fake timers. And `checkLogForAgentResponse`'s two sequential `continue` calls could read as a single `isNonCancelling = isSystemOrProxyMessage(t) || isBriefAck(t)` predicate. None of these block the merge; they're test-hardening and readability follow-ups.
