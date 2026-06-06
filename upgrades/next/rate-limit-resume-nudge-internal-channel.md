<!-- bump: patch -->

## What Changed

Fixes a coherence bug in rate-limit recovery where the agent appeared to **argue with itself** during an Anthropic throttle.

When the RateLimitSentinel detected a throttle it did two things: posted a user-facing "heads up — throttled, backing off" notice (intended), and — after backing off — poked the session with a "the throttle should have cleared, please continue" resume nudge to un-stick it. The bug was in the second part: that internal nudge was injected wearing a `[telegram:N]` prefix, the **exact** wire format of a real inbound user message. The agent could not distinguish its own recovery infrastructure from a message from the user, so it answered the nudge conversationally ("no throttle on my end, still rolling") and — because every `[telegram:N]` message triggers the mandatory "relay your reply to the user" rule — posted that denial into the topic, landing between the sentinel's own "still throttled" notices. To the user it read as the agent contradicting itself, and during a fleet-wide throttle (many sessions limited at once) it happened across several topics simultaneously.

The fix routes the resume nudge through the **internal recovery channel** instead of the user-message path. It un-sticks the session identically (both paths converge on the same low-level injection) but carries no `[telegram:N]` prefix, so the agent never mistakes it for the user and never relays a contradictory reply. The dead user-message injection path for the resume nudge was removed entirely so the bug cannot reappear. The "throttled / back online" notices are unchanged.

This change also ratifies a new constitutional standard — **Truthful Provenance — Speak Only as Yourself** (`docs/STANDARDS-REGISTRY.md`): every message into an agent carries an identity, and infrastructure must never wear the user's.

## What to Tell Your User

If you ever saw your agent post "hit a throttle, backing off" and then, moments later in the same topic, "no throttle on my end, still rolling" — it wasn't confused or hijacked. Its rate-limit recovery was poking the session to continue, but that poke was formatted exactly like a message from you, so the agent answered it as if you'd said it. That's fixed: the recovery poke now travels an internal channel it can't mistake for you, so during a throttle you'll see a clean, coherent sequence of "throttled → still throttled → back online" instead of the agent seeming to disagree with itself. The recovery itself always worked; only the narration was incoherent, and now it isn't.

## Summary of New Capabilities

- None — this is a behavior fix, not a new capability. No new endpoints or config. It takes effect on the next server restart after the update.

## Evidence

Tier-1 fix; 59 tests green across the rate-limit/sentinel suites, `tsc --noEmit` clean, independent second-pass reviewer concurred (sentinel/recovery path):

- New regression in `tests/unit/rate-limit-recovery-reachability.test.ts` asserting the resume nudge is internal-only and its text never contains a `[telegram:` prefix (anti-impersonation), plus the updated topic-bound resumeFn contract.
- `tests/integration/rate-limit-recovery-sentinel-lifecycle.test.ts` re-pinned around the internal-only path.
- Root cause confirmed live in `logs/sentinel-events.jsonl` (fleet-wide throttle, ~7 sessions each logging "resume nudge injected via topic" pre-fix).
- Sibling sweep: the compaction-resume inject (honest provenance — fires only on a genuinely unanswered user message) is tracked for audit under the new standard at #894.
