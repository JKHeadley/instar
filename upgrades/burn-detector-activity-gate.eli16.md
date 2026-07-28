# ELI16: Burn-detector activity gate (stop the repeating token-burn noise)

Instar watches how many tokens each part of an agent is using. If one part suddenly hogs more than a
quarter of a whole day's spend, it raises a heads-up: "a component is using more than a quarter of
the token budget." That's the **token-burn detector**, and it's meant to catch a runaway loop or an
unexpected cost spike early.

## The bug

The detector only asked one question: "Over the last 24 hours, did one part use more than 25% of the
total?" It never asked the obvious follow-up: "Is that still happening right now?"

So here's what went wrong. One big working session ran for a while, used a lot of tokens, and then
finished. For the next 24 hours that finished session still counted as a big slice of the trailing-day
total — so the alarm kept going off, over and over, every time the cooldown expired. And because the
session had stopped, the alarm even said "Projected 0 tokens in next 24h" — it was literally
announcing "this thing is burning a lot" and "this thing is spending nothing right now" in the same
breath. That's the noise the user saw: a full day of contradictory, useless heads-ups for something
that was already over.

## The fix

Add one missing check: only raise the alarm if the component is **actually spending right now** —
meaning it used tokens in the last hour. A big 24-hour share with a zero current rate is a finished
burst, not a live burn, so it stays quiet. The detector's other trigger (a sudden spike versus a
component's own 7-day normal) already had this kind of "is it active now" check; this just brings the
25%-share trigger up to the same standard.

## What already existed vs. what's new

- **Already there:** the burn detector, the 25% trigger, the 1-hour spend lookup, and the throttle
  runbook that decides whether to just alert or actually slow a component down.
- **New:** (1) the activity gate on the 25% trigger; (2) an operator off-switch and tuning knobs under
  a burn-detection config block, so anyone can silence or retune the alerts without a code change; (3)
  a cleaner alert message (the old internal "Phase 3/Phase 4" wording is gone); (4) a one-paragraph
  note added to every agent's instructions on update so any agent can explain the alert and offer the
  off-switch.

## Safeguards (plain terms)

- The change only ever makes the alarm **quieter** — it adds a condition that must also be true before
  alerting. It can never cause a new false alarm.
- The detector is still just a *reporter*. It doesn't slow anything down or block anything by itself;
  a separate piece decides whether to act. That separation is unchanged.
- All the new config is optional. If you set nothing, you get the fixed-but-sensible defaults.
- Rolling it back is a one-line revert with no data cleanup. Worst case, the old noise comes back —
  there's no risk to correctness or to stored data.

## What's NOT fixed (on purpose)

It still labels un-attributed spend as `unknown::<some-id>`. That just means "we couldn't pin this
spend to a named component" — it's not a problem by itself, and giving those a real name is a bigger,
separate piece of work.
