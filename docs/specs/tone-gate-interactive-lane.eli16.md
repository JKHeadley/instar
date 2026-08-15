# Replies to the operator can finally use the capacity reserved for them — Plain-English Overview

> The one-line version: two slots were being held open for the agent's replies to
> its operator, nothing ever claimed them, and replies were being blocked instead.

## The problem in one breath

Everything the agent asks a model to do — background classifiers, safety checks,
and the review that every outgoing message passes through — competes for a fixed
number of concurrent slots on this machine. Eight of them.

Background work has been misbehaving: each stalled request holds a slot until it
times out, up to a minute. When enough of them pile up, there is no slot left, and
the check that clears the agent's replies **fails closed** — the message is held
rather than sent.

That is not hypothetical. While the operator was awake and waiting for a live
demonstration, the agent's messages to him were refused **twelve times over about
fifteen minutes**, purely because background work had taken every slot.

## The part that makes this worth fixing rather than tuning

Someone already anticipated this. **Two of the eight slots are reserved** for
exactly this case — a check that a human is actively waiting on — and the reply
check is on the short list of things permitted to use that reserve. The
reservation was switched on.

It claims the reserve only when told two things: that the message is going to the
operator, and that someone is waiting for **this specific message**.

It was being told the first. It was never told the second. So the condition was
never true, the reserved slots were **never once claimed**, and the replies they
exist to protect queued behind the very background work they were meant to be
protected from. Measured during the failures: the reserve showed zero occupants.

## What this changes

One line. The reply path now says whether a human is waiting.

It knows already: an ordinary reply to someone's message is exactly that case,
while scheduled updates, health alerts and background notices are not — nobody is
blocked on those, so they keep using ordinary capacity.

## The safeguards

**Only genuine replies to the operator qualify.** Two separate conditions must
both hold. A scheduled message doesn't qualify; a conversation with someone who
isn't the verified operator doesn't qualify. Tests cover both of those refusals,
because a fix that made *everything* interactive would empty the reserve of meaning.

**A short list already limits who may ask.** Only two components are permitted to
claim the reserve at all; anything else asking is quietly put back on ordinary
capacity. That guard already existed and is untouched.

**It changes routing, not judgement.** This decides which queue a check waits in.
It does not change the check, its verdict, or whether a message is allowed.

**Proved by removing it.** With the change reverted, the one test asserting the
reserve is claimed fails and the three guard tests still pass — so the tests
measure this change and not something nearby.

## What ships when

All at once, and it needs no configuration. The reservation itself was already
enabled; this simply lets the thing it was reserved for ask for it.
