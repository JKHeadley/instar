# A re-delivered message now says it is re-delivered — plain English

## The one-sentence version

When instar hands you the same message a second time because it thinks you never
answered the first one, the message now carries a visible label saying so —
instead of arriving looking exactly like a brand-new instruction.

## What actually goes wrong today

instar has a safety net called **no-loss recovery**. If a message arrives, gets
claimed by a session, and no reply is recorded within a time window, instar
assumes the reply was lost and *re-delivers the message*. That is a good feature.
It is why a message doesn't silently vanish when a session dies mid-turn.

The problem is what the session is handed. Internally the second copy is clearly
labelled: it gets a different id (`replay-…`) and a flag on it that literally says
`replay: true`. But that flag was never carried through to the words the session
reads. The two payloads that reached the agent were **byte-for-byte identical**.

So from inside the conversation there is no way to tell "this is a fresh
instruction from the operator" apart from "this is a stale instruction being
handed back to you." On 2026-08-20 that is exactly what went wrong: an
instruction that was 21 hours old, and had already been superseded, was
re-injected and read as current.

## What already exists (nothing here is new state)

- The re-delivery already happens (`reinjectStuck`).
- The flag already exists (`metadata.replay: true`).
- The label the session reads is already built in one place (`buildInjectionTag`),
  which produces the familiar `[telegram:29723 "Window 21" from Justin (uid:…)]`
  prefix on every message.

## What is new

One thing: the flag is now passed the last few inches, from where it is set to
where the label is built. When it is set, the label gains a phrase:

```
[telegram:29723 "Window 21" from Justin (uid:12345) — RE-DELIVERED — no reply was recorded for this message] Start the migration now.
```

That's the whole change. The message body is untouched.

## The safeguards, in plain terms

**It can only ever add words.** It runs *after* the decision to deliver has
already been made. It has no ability to refuse a message, delay one, reorder
them, or drop one. If every part of it failed, messages would still arrive —
just without the label, which is exactly today's behaviour.

**Nobody can fake it.** The label is minted from an internal flag that is set by
instar's own recovery code, in memory, in the same process. It is never derived
from the text of the message. So somebody who writes "RE-DELIVERED — no reply
was recorded for this message" into a Telegram message cannot make their message
look like a system re-delivery. There is nothing to string-match, so there is
nothing to forge. This is the same discipline instar already uses for its
"first-party" bootstrap flag.

**Nothing downstream breaks.** Everything that reads these labels looks for the
topic number at the very front (`[telegram:29723…`). The new phrase is added at
the *end* of the label, after the topic number, so every one of those readers
still finds what it is looking for. This was checked before any code was written,
and it is now covered by tests.

**A first delivery is unchanged, down to the byte.** If the flag isn't set, the
label that comes out is character-for-character what it was before.

## The one honest limit

There is a second, rarer delivery route — the durable queue drain — where the
replay flag is not carried in memory (only an id string survives). A message
re-delivered through *that* route will not be marked. That is a known, stated
gap, not an oversight; closing it means adding a column to a durable store,
which is deliberately outside this change. The common route — the one that
produced the 2026-08-20 incident — is covered.

Separately: this makes *instar's own* re-delivery visible. It says nothing about
an actual external replay attack; that is a different problem with a different
fix.

## What you actually need to decide

Whether "add a label to a message we are already sending" is worth landing on
its own. The argument for yes: the failure it prevents is an agent acting on a
stale instruction believing it is current, which is a whole class of wrong
action, and the cost is a handful of lines that cannot refuse a message.
