# Checking whether the agent misses your corrections, without changing anything — plain English

## The background

Instar has a "correction and preference learning" feature. When you correct
the agent ("no, that's wrong") or tell it how you want things done from now on
("always give me a direct link"), it is supposed to notice, write the lesson
down, and remember it in future sessions.

The catch is the first step. Before the feature looks at a message properly, a
cheap keyword check decides whether the message is a correction at all. Only
messages that pass that check are ever studied. On 5 October we found that the
keyword check had passed nothing since 29 September, even though you had
clearly corrected the agent on 1, 2 and 4 October. The lessons were never
learned because the gatekeeper never let them in.

## What we measured first

We took the last two weeks of your messages (347 of them) and asked Jev, the
small fast model from TypeSafe we have been testing, one question about each:
is this a correction, a standing preference, neither, or can't tell? We showed
it the agent's previous message too, so it could see what you were replying
to. Jev picked out 90 messages. The keyword check picked out 12. They agreed on
11. Reading Jev's 90 by hand, most are real corrections or standing rules; the
weak ones are things like a bare "yes" that agreed to a rule the agent had
proposed.

## What this change does

It turns that test into a quiet, ongoing measurement on the development agent
only. Each time you send a message, the server removes anything that looks
like a secret, asks Jev the same question, and writes down only the answer:
how likely a correction, how likely a preference, what the keyword check said,
and whether the two agree. It records the message's number so someone can
look it up later, but never the words.

It changes nothing about what the learning feature records. It sends nothing
to anyone. A summary page shows the totals: how often Jev flags something,
how often the keyword check does, and how often they disagree.

## The safeguards

- It only runs on the development agent. Everywhere else it is off.
- One setting turns it off immediately, without a restart.
- It needs the Jev key, which only the development agent has.
- It costs about a hundredth of a cent per message, with a daily ceiling.
- If anything goes wrong (Jev slow, down, or confused), it writes down why and
  moves on. It can never delay or block a message.

## What you need to decide

Nothing now. After it has run for a while, the numbers will show whether Jev
should be allowed to hand messages to the learning feature alongside the
keyword check. That would be a separate change, decided on its own.
