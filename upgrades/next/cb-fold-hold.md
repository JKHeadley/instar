<!-- bump: patch -->
## What Changed

Adds the egress fold hold for the Context Budget work (`src/monitoring/FoldHoldStore.ts`): while a fold is reorganizing a conversation's working memory, every session-authored send for that conversation is refused `409 fold-hold` at the shared outbound chokepoints (`evaluateOutbound` on every channel, and `authorizeTelegramSessionSend` before the relay fork). Conversations are keyed channel-neutrally (`foldKeyForConversation`), so the hold covers Telegram, Slack, the app, WhatsApp and iMessage. The hold is a carrier of the fold record: written by the coordinator, released only by the fold's terminal transition or the boot sweep, with a scoped fail direction when its store is unreadable, and every refusal audited. A redriven reply refused by a hold is retried after the fold, never reported as lost. Nothing writes a hold yet, so every send is unchanged.

## What to Tell Your User

Nothing changes for you yet. This is what will keep my private bookkeeping turns from ever reaching you while I tidy a long conversation's memory.

## Summary of New Capabilities

- Fold hold on the outbound funnel for every channel; not used yet.

## Evidence

- Unit `tests/unit/FoldHoldStore.test.ts`, `tests/unit/recovery-policy.test.ts` (fold-hold retry); integration `tests/integration/fold-hold-outbound-routes.test.ts` (real routes over HTTP, Telegram and Slack); e2e `tests/e2e/fold-hold-crash-lifecycle.test.ts` (a real process dies mid-fold; a server-style boot releases or keeps the hold, observed over HTTP).
