# Recording what the conversation-reader decides — plain English

## The one-sentence version

The thing that reads your messages to work out what a conversation is *about*
makes that call several hundred times a week, and until now nothing recorded
what it concluded.

## What it does

As we talk, something reads each substantive turn and asks: is there a new
commitment here? Is this confirming something said earlier, or contradicting it?
That's how a topic accumulates a sense of what it's for, rather than being a flat
list of messages.

It's a judgment call, made roughly seven hundred times a week — the busiest one
left that wasn't being recorded, now that the stop-check is.

## Why recording it matters

There's a system meant to answer "are these judgments any good?" It can only
answer for decisions that were written down. This one wasn't, so the question was
unanswerable — not unanswered, unanswerable.

## The careful part

This reader sees more than most: your actual message, and a rolling summary of
the whole conversation so far. Both are yours, both could contain anything.

None of it gets stored. What's kept is the *shape* of the decision:

- a fingerprint of the message — enough to tell two apart, not enough to read one
- how long it was, whose turn it was, which turn number
- how many existing threads it had to work with
- whether a summary existed and how long it was — never a word of it

The summary is the bigger risk, and it's why this is worth being deliberate
about: leaking a message exposes one turn, leaking a summary exposes the whole
conversation. The tests put a fake password in the message *and* a fake token in
the summary, and check neither reaches storage.

It's built as a list of specific things to keep, rather than a filter over
everything — so if someone adds a new field to what this reader sees later, it
won't quietly start being stored.

## Two things I'm being explicit about

**Recorded, not graded.** Same as the last one. Knowing whether an extraction was
*right* means knowing what happened to it afterwards — was that signal later
confirmed, contradicted, or quietly ignored? Those facts exist; connecting them
to a specific decision is real work I haven't done. So it says "recorded, not
graded" in its own entry, and the health check reports it that way.

**It must never break a conversation.** This reader is designed to fail silently
— if the model is unavailable, it returns nothing and the conversation continues
undisturbed. Recording must not put a new way to fail in front of that. There are
tests for exactly that: provider throwing, provider missing, both still degrade
quietly.

## What you'd notice

Nothing. It's instrumentation on an internal judgment. What it buys is that a
question about the quality of that judgment stops being impossible to ask.
