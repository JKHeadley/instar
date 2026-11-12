<!-- bump: patch -->
## What Changed

A reply forwarded from another machine and delivered by the lease holder is now recorded in the holder's own topic history (`OriginMesh` submit → `runtime.options.onForwardedDelivered` → `TelegramAdapter.recordRecoveredOutbound`). Before, only the sending machine recorded it, and only when the forward answered cleanly. When the sender got "acceptance unknown", no machine recorded the reply at all.

That gap caused a real stall in topic 141868 on 2026-11-11. A progress note ("round 6 running, report to follow") was held on the M5 at 19:35 UTC while the Studio was unreachable. At 19:41:37 the session's next message, a decision question, was delivered (Telegram 141952), but the M5 got "acceptance unknown" back, so neither machine wrote it to history. The held note's overtaken check (`reviewQueuedReplyHistory`) reads local and pooled history only. It found nothing newer and released the stale note six seconds later (141953), right below the question. The operator waited for the promised report while the session waited for his answer, for 2 h 43 min.

With the holder's row in place, the pooled read the overtaken check already does finds the newer question and retires the stale note. The Studio's own topic history also stops missing replies sent from peer machines, so overseers and anything else reading one machine's history no longer see a silent topic. The pooled history read already dedupes by direction + Telegram message id, so a reply recorded on both machines shows once.

## What to Tell Your User

When a conversation is served from one of your other machines, its replies now show up in the main machine's message history too. This also stops an old "I'll report soon" note from popping up under a newer question after a brief network hiccup.

## Summary of New Capabilities

- The lease holder records every peer reply it delivers in its own topic history (history only, never a send).

## Evidence

- Unit: `tests/unit/telegram-origin/forwarded-delivery-history.test.ts`, including a replay of the topic 141868 sequence. With no holder row the held note is delivered (the bug); with it, the note is retired.
- Integration: `tests/integration/telegram-origin-mesh.test.ts`, covering a signed mesh submit through the real holder handler. The holder records the original pre-format text, the thread and the receipt. A throwing recorder leaves the delivery unchanged, and a refused reply records nothing.
