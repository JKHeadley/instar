# Codex model retirement, September 2026 — Plain-English Overview

> The one-line version: OpenAI switched off the AI models Instar was asking for, including the
> spare it falls back to, so every background check in the agent stopped working — this points
> them all at models that still exist and teaches the recovery code to recognise the second way
> a model can disappear.

## The problem in one breath

Instar does a lot of small thinking in the background — checking whether a message is safe to
send, noticing when a session is stuck, working out what a conversation is about. Those checks
run through OpenAI's Codex tool, and Instar tells Codex which model to use by name. OpenAI
retired those model names. Every one of those background checks started failing instantly, on
every machine, and had been for a while before anyone noticed — because a failed check costs
nothing and makes no noise.

## What already exists

- **Two lists of model names** — one used when Instar makes a quick background call, another
  used when it launches a full working session. They are supposed to say the same thing, and a
  comment in the code asks whoever edits one to remember to edit the other.
- **A recovery mechanism** — Instar already knows models get retired. When Codex says "that
  model isn't supported", the code catches it and immediately tries again using a designated
  spare model. This was built after the last time this happened, in June.
- **An error reader** — a small piece of code that looks at whatever Codex complains about and
  labels it: an authentication problem, a rate limit, a network glitch, a retired model. The
  recovery mechanism only wakes up when it sees the "retired model" label.

## What this adds

The main change is unglamorous: the model names are corrected to two that were actually tested
and confirmed working, rather than assumed. Everywhere Instar picks a model for Codex now points
at a live one.

But the more important fix is why the safety net didn't catch this. Two things had gone wrong
with it:

- **The spare was dead too.** The designated fallback model was retired in the same sweep as
  the main ones. So when a call failed and the recovery kicked in, it retried using another
  model that was equally gone. The net was there; it had a hole the same size as the thing
  falling through it.
- **The error reader only knew one of the two ways a model can vanish.** When OpenAI removes a
  model from a particular subscription, Codex says "not supported" — the reader knew that one.
  When OpenAI deletes a model outright, Codex says something completely different: "does not
  exist or you do not have access to it". The reader had never been taught that phrasing, so it
  filed those under "unknown problem" and the recovery mechanism never even woke up.

Fixing only the names would have looked like a fix and left both holes in place.

## The new pieces

Nothing genuinely new is introduced — this repairs machinery that already existed. The one
addition is a second pattern in the error reader, and it is deliberately fussy: it only matches
when Codex names a specific model in the complaint. A plain "404 not found" from a mistyped web
address does **not** count, and there is a test that fails if someone ever loosens it, because
treating an unrelated error as a retired model would make Instar quietly retry things it should
be reporting instead.

## The safeguards

**Stops the same mistake being made again by hand.** The tests no longer contain the model names
typed out. They check that whatever the code resolves to is on the approved list, and that the
spare is not one of the names known to be dead. Previously a test had the old spare's name typed
into it, which is why it broke the moment the spare changed — it was checking the name, not the
behaviour.

**Stops a false alarm becoming a retry loop.** The recovery only ever tries once, and it refuses
to run at all if it is already using the spare. So even in the worst case, a misread error costs
exactly one extra attempt, not an endless cycle.

**Does not pretend to be future-proof.** If OpenAI invents a third way of saying "that model is
gone", this will not catch it. And nothing yet checks that the spare is still alive on a regular
basis — if the new spare gets retired one day, the same thing happens again. Both gaps are
written down and tracked rather than quietly hoped away.

## What you should know as the person paying for it

These checks were failing for free. Broken calls cost nothing, so the bill looked healthy while
the agent was effectively running blind. Turning them back on means real spending appears where
there was none — roughly 650 calls an hour across three machines, and about three-quarters of
each call's cost is fixed overhead that Codex charges just for starting up, regardless of how
small the question is. That is the honest trade: working background checks cost money, and
broken ones only looked free. If the total is more than the checks are worth, the lever is
running fewer of them, not making them smaller.

## What ships when

This change ships on its own. Two related repairs are deliberately kept separate so that if one
misbehaves it is obvious which one: the session-watcher that hammers a broken service instead of
backing off, and a stale list of model names that still accepts retired ones. Both are tracked.
