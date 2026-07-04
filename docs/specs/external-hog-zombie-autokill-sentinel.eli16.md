# External-Hog Zombie Auto-Kill Sentinel — plain-English overview

_Why this matters (the principle it serves): an agent that gets silently starved of
its machine can't be the one to fix its own resource problems — it's locked out
exactly when it's needed. This keeps the agent able to reclaim its own resources._

## What problem this solves

Sometimes a program that has nothing to do with the agent goes haywire and eats
the computer's processing power. The real case that started this: someone closed
their code editor, but one of the editor's background helpers didn't shut down
with it — it kept running, invisibly, burning more than two CPU cores for almost
a full day. That starves the agent's own server and makes everything sluggish,
and nobody notices until a human feels the slowness.

Today the agent only watches ITS OWN programs for this kind of runaway. An
outside program hogging the machine is a blind spot. This feature closes that
blind spot.

## What it does — two halves, be honest about each

There are two separate jobs here, and it's worth being precise about how far each
one reaches:

1. **Noticing (broad).** It periodically looks at everything running on the
   machine and, whenever an OUTSIDE program is genuinely burning a lot of CPU for a
   sustained stretch, it surfaces that to you. This half is general — it catches any
   runaway outside hog, whatever it is.

2. **Auto-cleanup (deliberately narrow).** It only ever *automatically* ends ONE
   specific kind of leftover to start: an orphaned code-editor extension helper
   (the exact thing that bit us). Everything else is noticed and reported, never
   auto-ended. We widen what it's allowed to clean up later, slowly, with evidence —
   never in one leap.

So honestly, v1 is "auto-clean orphaned editor helpers + notice every other outside
hog," not a general program-killer. That narrowness is the safety.

## Who decides, and what keeps it safe

The DECISION of whether a leftover is harmless dead-weight worth cleaning up is made
by intelligence (an AI model), because that's a judgment call, not a checkbox. But
ending a program can't be undone, so a mechanical "safety floor" sits underneath the
decision. The floor can only ever STOP a cleanup — it can never start one. In one
line: the AI may only ever DECLINE to clean something up; it can never widen what's
eligible. A cleanup happens only when the rigid safety rules AND the model both say
so. The floor refuses, no matter what the model concludes, to touch anything that is
part of the operating system, owned by another user, still attached to a running
app, or whose exact identity can't be re-confirmed at the split second of action. So
the model drives within a fenced yard the rules have already proven safe — and a
program that gives itself a misleading name to trick the model still can't escape the
fence.

## How it ships — and how you turn it on

Carefully, in stages. It starts on this machine only (dark on your other agents),
and it starts in "watch and log" mode: for a while it just writes down what it WOULD
have cleaned up, touching nothing, so we can prove the safety floor holds even if the
model ever misjudges. Turning on real cleanup is a deliberate, separate step that
needs YOUR PIN from the dashboard — not a config file toggle, and not something the
agent (or a stray edit, or a restart) can flip on by itself. Once you've disarmed it,
it stays disarmed until you re-arm with the PIN again.

It never floods you with messages, it stops itself (and tells you) if something keeps
respawning rather than fighting it forever, it never blocks the machine while it
works, and there's a one-tap switch to disarm it instantly.

## The one honest judgment call for you

During review, both outside (non-Anthropic) AI models kept making the same point:
because the safety rules are already a complete decision on their own, the AI's only
real job is to occasionally SPARE something the rules would have cleaned up — and
they'd rather ship the simpler rules-only version without the AI at all. That's a
fair point, and it's in tension with the earlier call to let intelligence make the
decision. Rather than just assert the AI earns its keep, the watch-and-log period now
MEASURES exactly how often the AI spares something the rules would have ended. If that
number is essentially zero, the honest outcome is to drop the AI and ship the simpler
rules-only version. So the design proves its own worth instead of assuming it — and
the architecture choice stays yours.

## What changes for you

Mostly, you stop losing hours of machine performance to invisible runaway programs.
When the watcher does clean something up (once you've armed it), you get one plain
note saying what and why. Anything it's unsure about, it reports instead of guessing —
and it can never quietly hide a real hog from you.
