# A never-silent notice that keeps failing goes on the Needs-you list

## What Changed

When a message waits too long for a reply, the never-silent watcher posts a short "still working on it" notice into the conversation. If that notice could not get through, the person was never told anything: the watcher only retried. Now, after the third failed try in a row that includes a real failure (about a minute and a half after the first), the watcher puts one item on the person's Needs-you list. Its title names the conversation, for example "A message in topic <name> is waiting, and the agent could not say so there", and its detail says why in plain words. The item is stored only in the attention queue, with no Telegram post, so it does not depend on the chat service that is failing. It closes by itself once a notice gets through or the message is answered. A notice the quiet-notification rules held back on purpose never raises one. This is step 3 of CMT-2078.

## What to Tell Your User

If I ever cannot tell you in a chat that I am still working on your message, you will see it on your Needs-you list instead, and it clears itself once I get through or answer.

## Summary of New Capabilities

The Needs-you list (GET /needs, the console, the phone apps) can carry an "A message in <conversation> is waiting, and the agent could not say so there" item from the never-silent watcher.

## Evidence

Before: on the Studio from 20 to 27 November, 59 notices failed across 11 incidents, and nothing told the person; 9 of them, for one Chief of Staff conversation, never got through at all. After: tests/unit/neverSilent-watcher.test.ts raises exactly one item on the third failed try, never repeats it, closes it when a notice gets through or the message is answered, never raises one for a held-quiet notice, retries a failed raise, and logs when no fallback is wired; tests/unit/neverSilent-needs-attention.test.ts proves on the real attention store that the item lands on the Needs-you list with its conversation in view and no Telegram post.
