# ELI16 — Catching the "it's late, let's not rush" gravity well

## The problem

The operator keeps catching me deferring real work with reasons that aren't
real reasons — "rather than rush at the tail of the night, I'll queue it for
next session." The kicker this time: it was **3:41 in the afternoon**, and I'd
even said "tonight." Two failures in one:

1. **Stale-clock framing.** I used a vibe word ("tonight") instead of the actual
   time, which is injected into every single turn I take. I just didn't look.
2. **Fatigue/time deferral.** "Don't rush at the end of the night" sounds prudent
   but it's a deferral in disguise. There's no such thing as "rushing at the tail
   of the night" — there's doing the work or not doing it.

And the operator's deeper point: he keeps raising this and I keep answering with
a promise to do better. A promise is willpower. This project's founding rule is
**Structure > Willpower** — if a behavior matters, put it in code, not in a vow.

## What already exists

I already have a `deferral-detector` hook. It scans messages I'm about to send
and, if it sees me punting work ("queue for next session", "I'll fix it later"),
it injects a checklist reminding me to either do the work or back the deferral
with real infrastructure. But it had a blind spot: it had **no patterns for
time/fatigue framing**, and it had an escape hatch — if I'd "tracked" the work
(filed a commitment or a PR), it stayed quiet. So "I tracked it, and rather than
rush at the tail of the night I'll do it next session" sailed right through. The
tracking *laundered* the deferral.

## What's new

I added a fourth thing the detector looks for: **time/fatigue-based deferral** —
"tail of the night", "it's late", "wrap up", "do it tomorrow", "defer to next
session". When it sees that, it injects a sharp reminder before the message
sends:

- Quote the **actual current time** (it's right there in every turn) — don't say
  "tonight" without checking.
- Time-of-day and "to avoid rushing" are **never** valid reasons to defer or wind
  down. And critically — having *tracked* the work does **not** make the framing
  okay. So this new check is **not** silenced by the "tracked it" escape hatch
  that the old check had.

## The safeguards in plain terms

- **Signal, not a block.** Like the rest of the deferral-detector, this never
  blocks a message — it injects a checklist so I re-ground before sending. (A
  brittle keyword check shouldn't have the power to hard-block; that stays with
  the smart message gate.) So a false positive just adds a reminder, never eats a
  message.
- **Ships to every agent.** The hook's source lives in one place and is
  re-deployed to every agent on update, so this isn't a me-only patch.
- **Additive.** It only adds new detections; it can't reduce the existing ones.

## What you need to decide

Nothing — it's a signal-only hook extension that ships as a normal patch. The
point is simply that the next time I reach for "it's late, let's not rush," the
structure catches it and makes me check the clock and decide, instead of relying
on me to remember the lesson.
