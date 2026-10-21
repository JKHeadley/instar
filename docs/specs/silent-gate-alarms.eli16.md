# Three silent gates get an alarm (ELI16)

## The pattern

Three incidents this week had the same shape: a mechanism did the right thing by its own rules, and nobody was told. This change closes three such gaps. Each fix only tells someone; none of them retries, restarts or repairs anything.

## 1. A held Telegram reply on a topic that was held once before

When a reply can't be delivered (for example, the machine that owns the conversation is unreachable), it is held and kept, and one attention item says "Reply to topic N is held". That item's name was just the topic number. The attention store ignores a new item whose name already exists, even if the old one is a week old. So the first hold on a topic was announced, and every later hold on that topic was silent. On 2026-10-19 a reply to topic 48154 was held for hours while the item from 2026-10-11 still sat open, and nobody heard anything. The same applied to the "replies held on 3 topics" summary item and to the "held reply expired" item.

Now each name includes when that run of holds started (and the expiry item names the exact message). A hold after an hour of quiet on that topic is a new item. A run of holds on one topic still makes only one item.

## 2. The session watchdog killing a session's own waits

Instar's watchdog interrupts commands that look stuck. A poll loop that waits with `sleep 300` between checks looks quiet, so the watchdog interrupted the sleep, which ends the loop. The session that started it was never told, so it kept reporting its watch as running. That happened twice to the coordinating session on 2026-10-19.

Two changes. A `sleep N` is not interrupted while it has run no longer than N plus a minute: it says how long it will wait, and it is doing exactly that. (Past two hours the normal stuck check applies again, as for other waits.) And whenever the watchdog does interrupt a command, the session that owns it now gets one message saying which command was stopped and that it is no longer running, so it can start it again instead of claiming it is still on.

## 3. Feedback triage paused on quota for a long time

Triage checks the sorting model's usage before every call and pauses at 75% of a usage window, or when the usage can't be read at all. An unreadable reading could pause triage forever, and nothing said so. Now, if a pause lasts six hours while feedback items are waiting, one attention item says so, says why, and says nothing needs approval. Each new pause gets its own item.

## What a reader needs to decide

Nothing. These are notices only.

One detail from review: the "replies held on several topics" summary item starts a new episode whenever the number of held topics drops below three and then climbs back, not only when every hold has cleared. Otherwise one topic that kept getting held would pin the old summary and a later burst would be silent.
