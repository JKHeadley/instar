# Plain-English — the class of blind spot behind the false alarm

## The one-sentence root

Both halves of the false-alarm bug came from the same mistake:
**I trusted a *sign* that something was true instead of actually checking if it was true.**

- The alarm fired because the words "API Error" were *on the screen* — but they were there
  because I was *investigating* API errors, not because anything had failed. (Sign present →
  I assumed it was real.)
- Then it kept nagging for 11 minutes because the "did it recover?" check went looking for a
  file in one folder, didn't find it (the session was actually running out of a *different*
  folder), and decided "no file = never recovered." (Sign missing → I assumed the worst.)

Presence of a sign isn't proof. Absence of a sign isn't proof either. Neither one *checked
the actual thing*. That's the whole class.

## The three shapes it takes (so we can guard each one)

1. **A word on the screen is not an event.** Before sounding an alarm, I need a *second*
   signal that only the real situation could produce — one a healthy session can't fake. (A
   genuinely-stuck screen freezes; a working one keeps animating. The freeze is the real
   tell; the word alone is not.)

2. **Don't let my own work set off my own alarm.** A detector should never read a channel
   that my normal work writes into by accident. If I'm *talking about* errors, an
   error-detector watching my chat screen will fire on me. (We already learned this once —
   that's why we keep test attack-strings in files, not pasted into chat.) The detector
   should look at the real exit state of the turn, not the free text on the screen.

3. **"I couldn't check" is not "it's broken."** If I can't find the evidence, the honest
   answer is *unknown* — and unknown should fail toward the **least harmful** action. For a
   safety lock, that means "stay locked." For a notification, the harmful thing is the
   annoying ping itself, so unknown should mean **stay quiet**. And I should look for the
   evidence in the *right* place (the actual folder the session runs from), instead of
   assuming there's only one folder.

## What I'm proposing

A new constitutional rule — **"Verify the State, Not Its Symbol"** — that bakes all three
into how we build *anything* in the future, not just this one sentinel:

- Every detector must **corroborate** before it fires (a second, unfakeable signal).
- Every detector must **read a channel its own work can't accidentally write into.**
- Every detector must **say which direction is least-harmful** and fail that way when it
  can't be sure — and look up its evidence in the real place, not an assumed single one.

And it's not just words: the spec-review step will automatically flag any future design that
breaks one of the three, and where it's checkable in code, a test will block it. So this
becomes a *guardrail*, not a note we have to remember.

## What I need from you

Just a thumbs-up (or edits) on the rule above. The concrete bug fix is already approved and
I'm building it now — this is the bigger "make sure we never build this blind spot again"
piece you asked for.
