## What Changed

Slack follow-through generalization (Phase 2.3). A promise made in a Slack conversation now registers a durable commitment bound to the conversation's minted id, so it survives a restart and is delivered back into that exact thread by the already-shipped increment-2 PromiseBeacon + `deliverToConversation` funnel — the way Telegram already works. The only new surface is the **registration trigger**:

- `detectTimePromise` is hedge-tolerant ("in about 5 minutes" now registers — the exact 2026-07-03 S7 miss).
- The Action-Claim Stop hook is generalized to Slack: it keys on `INSTAR_CONVERSATION_ID` (a channel-neutral, 1:1-session-scoped id — never set on the shared lifeline, so a Slack DM can't cross-channel mis-deliver), sends the §7 bind token, dropped the ≥20-char floor, and clamps the payload to 16KB.
- `/action-claim/observe` gains: the negative-id §7 bind gate (shared `verifyConversationBind` helper — `POST /commitments` refactored onto it, behavior-identical), a dev-gated `messaging.actionClaim.slack` lane (dryRun-first, with a `logs/action-claim-observe.jsonl` would-register audit), Lane-A precedence (one row per turn), a new Lane-B time-promise predicate, and a per-topic cap that now counts both `actionclaim:` and `timepromise:` rows against one budget.

Ships **dev-gated DARK** behind `messaging.actionClaim.slack` (live-on-dev in dryRun, dark on the fleet) and gated by the master `messaging.actionClaim.enabled`. Delivery still rides the separate `conversationIdentity.followThrough` gate.

## Evidence

- Spec (converged + approved; internal multi-lens + gemini-2.5-pro + codex-cli/gpt all clean): `docs/specs/slack-followthrough-generalization.md`.
- Side-effects review + independent second-pass concurrence: `upgrades/side-effects/slack-followthrough-generalization.md`.
- Tests (3 tiers, both sides of every boundary): `tests/unit/detect-time-promise-hedge.test.ts`, `tests/unit/conversation-bind-gate.test.ts`, `tests/unit/action-claim-hook-slack.test.ts`, `tests/unit/migrate-actionclaim-slack-devgate.test.ts`, `tests/integration/action-claim-route.test.ts` (Slack lane), `tests/e2e/action-claim-lifecycle.test.ts` (minted-id feature-alive). §7 golden test (`tests/integration/conversation-registry-routes.test.ts`) green — refactor parity. tsc + lint clean.

## What to Tell Your User

⚗️ **Experimental / dev-gated — nothing changes for you yet.** This ships **dark on the fleet**: it runs live only on a development agent (in dry-run first) and is off for everyone else until an operator turns it on after a clean soak. When it is eventually enabled, the visible behavior will be: a promise you make in **Slack** ("I'll post that in about 5 minutes") gets written down durably and followed up on even across a restart — exactly like it already works on Telegram. Until an operator flips it on, there is no user-facing change.

## Summary of New Capabilities

None yet for end users — this change ships dev-gated dark. (When an operator enables it: Slack-born promises and time-boxed conversational promises register durable commitments and are followed up in-thread across restarts, generalizing the existing Telegram follow-through.)
