<!-- bump: patch -->
## What Changed

Adds the relay-path row carrier for the Context Budget work (`src/memory/topicRowCarrier.ts`, `src/memory/topicRowWatermark.ts`). On an agent with several machines, a message's conversation-memory row is written on the machine that received it, but the conversation may run on another machine. The forward that already delivers each message to the conversation's owner now also carries that row, and the owner stores it before it acknowledges the message (so a crash in between loses nothing: the redelivery stores it). Each forwarding machine numbers the rows it carries per conversation, and the owner keeps a watermark that only advances when every earlier row has arrived. A missing row is fetched from the machine that carried it over a new signed `topic-row-pull` request; a conversation that moves to a new machine fetches the previous owner's recent rows first. A row that an older machine forwarded without carrying it is fetched from that machine, and a repair pass every minute retries anything still missing (including rows lost if the conversation memory is rebuilt). Fetches are bounded (500 rows); anything older is recorded as a visible cut, and a row no machine can supply after five tries is marked unrecoverable and reported, so a conversation never stays stuck without saying why. The fold precondition "the owner holds the conversation's rows up to its last message" now reads this watermark instead of always answering no. Older machines ignore the extra field; a message an older machine forwarded without its row keeps the conversation from folding until the row arrives. Behind `contextBudget.enabled` (live on development agents, off on the fleet).

## What to Tell Your User

Nothing changes for you yet. This is groundwork so that, when conversation summaries arrive, a conversation running on another of my machines has its full message history there first.

## Summary of New Capabilities

- Conversation-memory rows follow the conversation to the machine that runs it, with a watermark that shows any gap.
- A signed request lets a machine fetch the rows it is missing from the machine that has them.

## Evidence

- Unit `tests/unit/topic-row-carrier.test.ts`; integration `tests/integration/topic-row-carrier-two-node.test.ts`; e2e `tests/e2e/topic-row-carrier-lifecycle.test.ts`.
