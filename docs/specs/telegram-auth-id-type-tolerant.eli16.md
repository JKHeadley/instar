# ELI16 — Telegram authorized-user check, type-tolerant

## What this is, in plain English

Instar agents talk to people over Telegram. To make sure only the right people
can give the agent instructions, each agent keeps a short list of allowed Telegram
user IDs (a Telegram ID is just a big number, like `7812716706`). When a message
comes in, the agent checks: "is this sender's ID on my allowed list?" If yes, it
answers. If no, it treats them as a stranger and shows a "you're not registered"
gate instead.

## The bug

That allowed list lives in a config file, which is plain text (JSON). The code that
reads it *expects* the IDs to be numbers, but nothing stops someone (a human editing
the file, or an agent setting another agent up) from writing an ID as **text** —
`"7812716706"` with quotes — instead of a number — `7812716706` without quotes.

The check used JavaScript's `includes`, which compares *strictly*: the text
`"7812716706"` is NOT considered equal to the number `7812716706`. So if your ID was
written as text, the check said "not on the list" — and the real, authorized owner
got treated as a stranger and locked out behind the registration gate. Silently.
Nothing in the logs screamed "wrong type"; it just quietly failed.

## How we found it

While one agent (Codey) was setting up another agent (Gemini) on Telegram, it wrote
the owner's ID as text. The newly-set-up agent then refused to recognize the owner —
the exact symptom above. That made the underlying brittleness obvious.

## What's new

The check now compares IDs as text on both sides — it turns whatever is in the list
into text and compares it to the sender's ID turned into text. So `7812716706` and
`"7812716706"` are treated as the same person. Numbers, text, or a mix of both in
the list all work now. Nobody who used to be recognized stops being recognized — the
change only *widens* recognition to include the people it was always supposed to.

A second spot (the auto-add step that remembers a newly-onboarded user) got the same
treatment, so it won't add a duplicate when the list already holds the ID as text.

## Why it's safe

It can only make MORE of the intended IDs match — never fewer. The "empty list means
accept everyone" behavior is untouched, and the other chat platforms (Slack, etc.)
are separate code and unaffected.
