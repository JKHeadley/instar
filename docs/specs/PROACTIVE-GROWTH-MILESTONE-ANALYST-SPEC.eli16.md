# ELI16 — Proactive Growth & Milestone Analyst

Imagine you build a bunch of little progress trackers. One watches your
half-finished projects. One watches new features that are "switched off" until
they prove they work. One notices when you keep rewriting the same kind of plan in
the same way. One notices when you keep correcting the assistant about the same
thing. The problem: all of those trackers were quietly writing notes that nobody
ever read out loud. So you never heard "hey, this feature has been on trial for a
week and it actually works — want to turn it on for everyone?" or "this experiment
has sat switched-off for a week and never even ran once — should we fix it, give it
more time, or drop it?"

This change adds the missing piece between the trackers and you: a single "coach"
that reads all of those trackers and decides what is actually worth telling you. It
is not a new tracker — it has no new sensors of its own. It just reads what the
existing systems already record and turns it into one short, opinionated summary
with clear rules for what crosses from "background noise" into "a real milestone
worth a heads-up."

The clever trick is a short deadline on every trial. Each switched-off feature gets
a TIGHT incubation window — three days for low-risk things, a week at most for the
rest. **The deadline running out is itself the alarm.** That is what makes "left
behind" impossible: nothing can quietly rot in a corner forever, because every
trial carries a clock that drags it back in front of you the moment it expires. When
the clock hits zero the feature is in one of two buckets: it earned a promotion (it
ran, it worked, no issues → "promote?") or it never proved itself (it just sat there
→ "fix, extend, or kill?").

There is one honesty rule that matters a lot: "it has been a week" is never enough
on its own to promote something. The feature has to have actually *run* and done
real work. And if we cannot even tell whether it ran — because nobody wired up a way
to count its activity yet — the coach says exactly that ("unknown") instead of
pretending it passed. A thing we cannot prove ran is a fix-or-kill candidate, never
a promote candidate.

For now the coach is installed but switched OFF. It only computes its report and
lets you read it at a URL; it does not message you yet. That deliberate caution is
because the whole reason this gap existed was an over-correction: after some earlier
"too noisy" incidents, everything got turned down to silent. We are turning the
volume back up carefully, one notch at a time, so we do not swing straight back to
noisy. The part where the coach actually speaks to you on a schedule — and the part
where we switch the two muted trackers back on — comes next, in its own change, with
its own review.
