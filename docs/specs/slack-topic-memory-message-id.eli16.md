# Slack messages were overwriting each other in topic memory — plain-English overview

## The one-sentence version

Instar's conversational memory kept only the **first** Slack message in each
channel and silently threw away every message after it. This change gives each
Slack message its own id, so the whole conversation is kept.

## What already exists

`TopicMemory` is the SQLite store behind an agent's conversational memory. It is
the highest-priority context an agent gets: topic search, rolling summaries and
the history injected when a session starts all read from it. Every row has a
`message_id` and a `topic_id`, and the table says
`UNIQUE(message_id, topic_id)` — one row per message per conversation. Inserts
use `INSERT OR IGNORE`, which is deliberate: if the same message arrives twice
(a restart, a re-import), the second copy is quietly skipped instead of
erroring.

Telegram fits this perfectly, because Telegram gives every message a number.

## What was broken

Slack does not use numbers. Slack identifies a message by its `ts` — a *string*
like `"1730000000.123456"`. The code that copied Slack messages into
`TopicMemory` read:

```ts
messageId: typeof entry.messageId === 'number' ? entry.messageId : 0,
```

A Slack `ts` is a string, so it never matched `'number'`, so **every Slack
message was given the id `0`**.

Now put that together with `UNIQUE(message_id, topic_id)` and
`INSERT OR IGNORE`. The first Slack message in a channel inserts as
`(0, channel)`. The second Slack message is also `(0, channel)` — a duplicate —
so `INSERT OR IGNORE` does exactly what it was designed to do and ignores it.
And the third. And every one after that, forever.

The mechanism that exists to make retries safe was the mechanism that ate the
data, which is why nothing ever errored and nobody noticed.

## What this measured, not guessed

Two live `topic-memory.db` files were checked before the fix. Every inbound
Slack row (`from_user = 1`) had `message_id = 0`, and each Slack channel held
exactly **one** such row — 7 inbound messages kept across 8 channels. The rows
that *did* survive with real ids were mostly system notices like
"Session respawned.", arriving by a different path. So an agent asking "what did
we talk about in this channel?" was reading one human sentence and a pile of
restart notices.

## What's new

A small module, `src/messaging/slack/slackMessageId.ts`, turns a Slack `ts` into
a number: `"1730000000.123456"` becomes `1730000000123456` — the timestamp in
microseconds.

Microseconds, specifically, because the id has to do three jobs at once and only
a time-based id does all three:

1. **Be unique.** Slack guarantees `ts` is unique within a channel, so the
   derived id is too. This is what stops the overwriting.
2. **Sort in send order.** Incremental summarising asks the database for
   "messages with an id greater than the last one I summarised"
   (`WHERE message_id > ?`). A random-looking hash would also be unique, and
   would have quietly broken *that* read instead — messages would go missing
   from summaries rather than from the store. Easy to miss, so it is worth
   naming: uniqueness alone is not enough here.
3. **Stay an exact whole number.** Microsecond ids remain exactly representable
   until the year 2255, so two different messages can never round onto one id.

The two halves of the timestamp are parsed as integers and added, rather than
multiplying the decimal by a million — `parseFloat("1730000000.123456") * 1e6`
rounds, because that decimal has no exact binary form.

Because the id is derived purely from the message itself, the same message
always produces the same id. Restart-safety is unchanged: a genuine duplicate is
still ignored.

## The safeguards, in plain terms

- 18 tests run against the **real** `TopicMemory`, not a stand-in: two messages
  in one channel both survive, two messages inside the same second both survive,
  a 25-message channel keeps all 25, re-inserting is still a no-op, and the
  send-order read returns the right message.
- One test is a **positive control**: it runs the *old* derivation over the same
  two messages and asserts only one survives. Without it, the test suite could
  have passed against the very bug it exists to catch — which is the failure
  mode that let this bug live in the first place.
- A 7-mutation sweep broke the new module seven different ways (always return
  zero, drop the sub-second digits, swap in a hash, loosen the exactness bound,
  and so on). All 7 were caught by a failing test.
- All 51 lint steps and the full TypeScript check pass.

## What this does NOT fix

**Slack history already on disk is still not replayed.** `slack-messages.jsonl`
holds the inbound Slack history (90-day retention) and it is intact — but the
importer that rebuilds `TopicMemory` from a log requires a `topicId` field, and
Slack entries carry `channelId` instead, so it skips them entirely. On one
machine **568 inbound Slack messages** are sitting in those logs and missing
from topic memory. They are recoverable by a backfill; this change does not
write one. Anything dropped *before* the 90-day window has no source left and is
genuinely gone.

**The presence proxy still truncates.** A few lines below the fixed line, the
same Slack message is handed to `PresenceProxy` using `parseInt()`, which keeps
only the whole seconds and discards the sub-second part. That is a different
consumer with different needs, so it was deliberately left alone to keep this
change to one behaviour — but it means presence sees a coarser id than the store
does.

## What a reader actually needs to decide

Whether the microsecond-integer id is the right shape for `message_id`, given
that the column is also used for ordering and not only for identity. If yes,
nothing else about this change is controversial: it replaces one expression,
adds one pure module, and adds tests.
