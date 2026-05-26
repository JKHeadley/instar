# Build Stop-Hook Session-Scoping — the plain-English version

**What I need from you:** a yes/no to ship this fix, plus a quick call on two
small choices at the bottom. No code gets written until you say go.

## The problem, as a kitchen

Picture a busy kitchen where I'm cooking several dishes at once — each dish on
its own burner (each "burner" is a separate work session I'm running).

When I start a big dish, I put a sticky note on the fridge that says *"don't
walk away — this dish isn't done."* There's a little buzzer that reads that note
and, every time anyone tries to leave the kitchen, it goes off and says *"get
back to the stove."* That buzzer is the thing that keeps me from quitting a big
job half-finished. Useful.

**The bug:** the sticky note doesn't say *which cook* the dish belongs to. So
when I'm at burner A working on the SessionReaper dish, and I happen to step
away from burner B (a totally different, unrelated task), the buzzer reads the
note and yells at *burner B* — *"get back to the SessionReaper dish!"* — a dish
burner B has nothing to do with. It nagged one of my sessions four times in a
row last week to go drive a build it never started.

**And it's worse than just noise.** Every time the buzzer goes off, it punches a
hole in a punch-card. After enough punches (3, 5, or 10 depending on dish size)
the buzzer gives up and goes quiet *for good* — including for the real cook who
actually needs it. So a wrong session getting nagged isn't just annoying; it
*burns up* the protection the real builder was counting on.

## The fix, in one sentence

Write the cook's name on the sticky note the moment the dish starts, and teach
the buzzer to only nag *that* cook. Everyone else, it lets walk out the door —
quietly, without punching the card.

The "name" is the work session's stable address (its tmux session name), stamped
automatically when the build begins. No new step for me to remember — it gets
written the instant a build starts.

## Why I had a reviewer tear it apart first

My first draft had a backup plan: *"if the note has no name yet, let the first
cook who walks past claim the dish."* A second reviewer (an independent pass
over the real code) caught that this is exactly backwards for how the bug
actually happens. The real cook is **standing at the stove the whole time** —
they don't walk past the door. It's the *other* sessions that keep walking past.
So my "backup" would've handed the dish to the wrong cook, and then kicked the
real cook out when they finally turned around. Strictly worse than today.

So I cut it. New rule for a name-less note: the buzzer just **stays quiet** — it
won't nag anyone and won't burn the punch-card. We lose the safety buzzer for
that one un-named dish, but we never yell at the wrong person. That's the right
trade: a forgotten buzzer is annoying; kicking the real cook out mid-dish is
damage.

The reviewer caught two more things — a fragile shortcut I'd leaned on (checking
*which room* a session is standing in, which turns out to be unreliable), and a
worry about whether this even matters for other people's agents. Both got fixed
or explained: I dropped the fragile shortcut for the reliable name-tag, and it
turns out this bug really only bites *me*, in my own workshop, because I'm the
one running a dozen burners at once. Other folks' agents run one burner and
never hit it.

## What I'm NOT doing

- Not changing how builds work, the phases, or the worktree setup.
- Not merging this with the other similar buzzer (the "autonomous mode" one) —
  that one already got this exact fix separately, and gluing them together would
  be more risk than reward. I'm just giving the build buzzer the same smarts the
  autonomous one already has.

## How I'll prove it actually works (not just "tests pass")

- I'll recreate the exact failure: a build owned by session A, then poke session
  B and confirm B walks free with the punch-card untouched — and that A is still
  protected.
- Then the real test: I'll load this onto a live agent on this machine, run a
  genuine two-session scenario, watch it behave, and only then merge. Green unit
  tests alone don't count as proof here.

## Two small calls for you (optional — I have a default for each)

1. **Restart handling:** if a session restarts mid-build and gets a new ID, I
   re-link it by its name and keep protecting it. I think the simple version is
   plenty (a build is usually one continuous sitting). *Default: keep it simple.*
2. **How to ship it:** I'd put the buzzer fix + the name-stamping in one change,
   and leave one tiny precision tweak (also tagging the exact session ID, not
   just the name) as a quick follow-up. *Default: one change now, tiny follow-up
   after.*

If you're fine with both defaults, just say "go" and I'll start building.
