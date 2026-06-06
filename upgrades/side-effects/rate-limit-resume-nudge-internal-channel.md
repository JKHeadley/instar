# Side-Effects Review — Rate-limit resume nudge routed through internal channel (not the user-message path)

**Version / slug:** `rate-limit-resume-nudge-internal-channel`
**Date:** `2026-06-05`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `independent reviewer subagent`

## Summary of the change

The RateLimitSentinel's post-backoff resume nudge ("the throttle should have cleared — please continue where you left off") was injected into the throttled session via `injectTopicNudge`, which prefixes the text with `[telegram:${topicId}]` — the exact wire format of a real inbound user message. The agent therefore could not distinguish the infrastructure's own poke from a message from the user: it answered the nudge conversationally ("no throttle on my end, still rolling") and, because the `[telegram:N]` prefix triggers the mandatory "relay your reply to the user" rule, posted that denial into the topic between the sentinel's own throttle notices — appearing to contradict itself. The change routes the resume nudge through the internal recovery channel (`injectInternalNudge` → `injectInternalMessage`) for ALL sessions, topic-bound or not. The internal path converges on the same low-level `rawInject` (identical un-stick behavior) but carries no user-message prefix, so the agent never mistakes it for the user. The now-dead `injectTopicNudge` method is removed from `RateLimitRecoverySurface` and its `server.ts` wiring. Files: `src/monitoring/sentinelWiring.ts`, `src/commands/server.ts`, plus the two rate-limit recovery test files.

## Decision-point inventory

- `buildRateLimitRecoveryDeps.resumeFn` (sentinelWiring.ts) — **modify** — was: topic-bound → `[telegram:N]`-prefixed inject; non-topic-bound → internal inject. Now: ALL sessions → internal inject; topic recorded in audit detail only.
- `RateLimitRecoverySurface.injectTopicNudge` (interface + server.ts wiring) — **remove** — the prefixed-inject path is deleted so the resume nudge cannot use it again.
- The user-facing notice path (`notifyFn` → `deliverNotice` → Telegram) — **pass-through** — unchanged; the "throttled / back online" heads-ups still post exactly as before.

---

## 1. Over-block

No block/allow surface — over-block not applicable. This change selects an injection channel; it neither rejects nor admits inputs.

---

## 2. Under-block

No block/allow surface — under-block not applicable. The recovery still fires on every detected throttle; nothing is newly suppressed. The user-facing throttle notices are unchanged.

---

## 3. Level-of-abstraction fit

Correct layer. The resume nudge is infrastructure→session communication; the right primitive for that is `injectInternalMessage` (`source: 'sentinel-recovery'`), which exists precisely for "trusted internal nudge that bypasses the topic-prefix requirement" and logs the trusted bypass to the security log. The previous design borrowed the user-message primitive (`injectMessage` with a topic prefix) for InputGuard-provenance convenience, which was the wrong layer — it made an infra signal indistinguishable from user speech. The fix moves the resume to the primitive built for it. No higher-level gate is bypassed; the InputGuard provenance check the old path ran is intentionally not needed for a known-internal nudge (and `injectInternalMessage` records the bypass).

---

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

- [x] No — this change has no block/allow surface.

The change chooses a delivery channel for a recovery nudge. It holds no blocking authority and adds no brittle gate. It removes an accidental coupling (infra wearing the user's identity), which strictly reduces surface.

---

## 5. Interactions

- **Shadowing:** None. The resume nudge and the user-facing notice are separate paths (`resumeFn` vs `notifyFn`); this change touches only `resumeFn`. The notice path is untouched.
- **Double-fire:** Reduced. Previously the agent burned a full conversational-reply turn answering each nudge (and relayed it). That spurious turn is eliminated — fewer LLM turns hitting the already-throttled account during a fleet-wide throttle.
- **Races:** No new shared state. `rawInject` resets the same idle-prompt timer it always did; the verify()/JSONL-growth recovery detection is unchanged. The internal path was already the live path for non-topic-bound sessions, so its reliability is proven in production.
- **Feedback loops:** This CLOSES one. The old behavior was a feedback loop — sentinel poke → agent reply → relayed to topic → contradicts sentinel notice. Removing the user-message framing breaks the loop at its source.

---

## 6. External surfaces

- **Other agents / users (install base):** behavior change ships to every instar agent on update. It strictly improves coherence (removes self-contradiction during throttle recovery); no capability is added or removed.
- **Telegram:** fewer messages posted to topics during a throttle (the spurious "no throttle on my end" replies stop). The intended "throttled / back online" notices are unchanged.
- **Persistent state:** the audit line in `logs/sentinel-events.jsonl` / recovery records now reads "resume nudge injected via internal recovery channel (topic N)" instead of "via topic". Read-only observability; no consumer parses the prior exact string for control flow.
- **Timing/runtime:** none introduced. Same inject mechanism, same timers.

---

## 7. Rollback cost

Pure code change — revert the two source edits and ship as the next patch. No persistent state, no schema, no migration, no agent-state repair. The only user-visible effect during a rollback window would be the return of the original incoherence, not a hard failure. Recovery itself never depended on the prefix (both channels converge on `rawInject`), so reverting cannot break un-sticking.

---

## Conclusion

The review found no block/allow surface and no new authority — the change removes an accidental identity coupling (infrastructure injecting a nudge that looked like a user message) and replaces it with the purpose-built internal channel. It reduces external surface (fewer spurious Telegram messages, fewer wasted LLM turns under throttle) and closes a self-reinforcing feedback loop. The one related site found in the sibling sweep — the compaction-resume re-inject in `server.ts`, which also uses a `[telegram:N]` prefix — is left unchanged because it only fires when there is a genuinely unanswered user message, where a relayed reply is wanted; it is tracked for audit under the new Truthful Provenance standard at JKHeadley/instar#894 rather than altered here. Clear to ship. Regression coverage pins the contract (the resume nudge can never again carry a `[telegram:` prefix).

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent
**Independent read of the artifact: CONCUR**

The reviewer independently read the diff and the SessionManager injection internals and concurred the fix is correct, minimal, and the artifact is honest:

- **Resume parity is real (the load-bearing claim).** `injectInternalNudge` → `injectInternalMessage` (SessionManager.ts:3060) and the old `injectTopicNudge` → `injectMessage` both converge on the identical `rawInject` (3080): same bracketed-paste, same framework-aware Enter (codex double-Enter), same `verifyInjection`/`recordStrandedDraftMarker`. The fix does not weaken un-sticking. The redundant `isSessionAlive` guard inside `injectInternalMessage` is harmless (resumeFn already guards it).
- **The relay-trigger cannot fire on the new path.** The mandatory "relay your reply" behavior keys strictly on the anchored `^\[telegram:(\d+)` prefix (InputGuard.ts:114; UserPromptSubmit hook regex). The bare nudge text carries no such prefix; the new test asserts `not.toContain('[telegram:')`, pinning the contract.
- **Audit/recordRecovery preserved.** Collapses to one `recordRecovery(..., ['internal-injection'])`; topic retained in the detail string, verified by the updated unit test.
- **No dead/broken code.** `injectTopicNudge` fully removed from interface, server.ts wiring, and both test harnesses (grep returns zero hits); typecheck clean.
- **The "compaction-resume is defensible to leave" judgment is correct, with a concrete reason.** That sibling inject (server.ts:6053-6055) is gated on `lastReal?.fromUser` — it fires only when the most recent real message is a genuinely unanswered user message, where a relayed reply is wanted. The RateLimitSentinel resume has no such gate, which is exactly why a user prefix there manufactured a phantom user turn. Structurally different cases.
- **No edge-case regression** for InputGuard provenance (the internal path auditably bypasses it via the logged `internal-recovery-injection` event), multi-line handling (nudge is single-line), or codex-vs-claude submit (shared `rawInject`).

**Reviewer nits, both resolved:**
1. Stale comments that still described the nudge as "topic-tagged so InputGuard accepts it" (RateLimitSentinel.ts:85 + sentinelWiring.ts:329) — **fixed** in this change so no future reader re-introduces the prefix.
2. The compaction-resume "leave unchanged" decision must be tracked durably, not left as prose — **filed as JKHeadley/instar#894** (audit it under the new Truthful Provenance standard).

---

## Evidence pointers

- Root cause confirmed live in `logs/sentinel-events.jsonl` (2026-06-06 ~04:31Z): a fleet-wide throttle drove ~7 sessions through this recovery, each logging "resume nudge injected via topic".
- Smoking-gun line: `src/commands/server.ts` `injectTopicNudge: (name, topicId, text) => sessionManager.injectMessage(name, \`[telegram:${topicId}] ${text}\`)` (pre-fix).
- Tests: `tests/unit/rate-limit-recovery-reachability.test.ts` (incl. new anti-impersonation regression) + `tests/integration/rate-limit-recovery-sentinel-lifecycle.test.ts`; 59 tests green across the rate-limit/sentinel suites.
