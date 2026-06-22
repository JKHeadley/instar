<!-- bump: minor -->
<!-- change_type: feature -->

## What Changed

The other half of the rate-limit principle: **never let the agent silently stay stuck on a
fallback.** When an internal call exhausts its options and the caller drops to a simple rule-of-thumb
instead of real AI, the agent now tracks that. The moment a real AI call for that component succeeds
again, it clears itself automatically. And if it stays stuck for too long (default 15 minutes) AND
has genuinely retried, the agent raises one calm heads-up that the AI path hasn't recovered — so a
degraded state can't quietly rot. A component that just ran once and finished (not stuck) quietly
closes itself with no false alarm.

This is **off by default** (on for the dev agent first), and it's built carefully to NOT repeat an
event-loop freeze the same subsystem caused earlier: it's bounded, it never re-enters the alert
machinery, and it only alerts when something is genuinely stuck.

## What to Tell Your User

Nothing changes unless you turn it on. Once on, if your agent ever falls back from real AI to a
basic rule on some internal check and stays that way, you'll get one quiet heads-up instead of it
silently persisting — and it clears itself the moment the AI path recovers.

## Summary of New Capabilities

- `DegradationReporter` open-degradation lifecycle: `openDegradation` / `resolveDegradation` /
  `sweepOpenDegradations` / `configureNeverSilent` + `openDegradationCount`, keyed on
  `(component, framework)`, bounded by a hard cap, O(1) per open/resolve.
- `IntelligenceRouter` `onHeuristicFallthrough` (fires when a non-gating call exhausts the ladder)
  + `onResolved` (fires on a successful real-LLM answer) hooks, wired to the reporter.
- A dev-gated 60-second sweep that escalates a genuinely-stuck degradation (≥1 retry, open past
  `escalateMs`, deduped) and auto-closes an idle/run-once one at the TTL.
- Dark/dev-gated (`resolveDevAgentGate` + a `DEV_GATED_FEATURES` entry); no-op when off.

## Evidence

**Before:** `DegradationReporter` reported a degradation once (`report()` + a one-shot self-healer)
but had NO continuous "is this still degraded?" tracking — a fallback could persist indefinitely with
nobody knowing. **After:** a non-gating heuristic fallthrough opens a tracked degradation; a real
answer auto-resolves it; a genuinely-stuck one escalates once (deduped); a run-once one auto-closes.
Reproduced by `tests/unit/degradation-never-silent.test.ts` (6 cases) + 3 router-hook cases in
`degradation-ladder.test.ts`. Critically, the escalation path surfaces via `telegramSender` directly
and NEVER calls `report()` — the reentrancy that caused the 2026-06-21 event-loop wedge cannot recur.
Full lint + tsc green; the existing reporter/router tests are unaffected.
