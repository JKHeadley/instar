# Plain-English overview — fixing the "don't forget the dark features" machine

## The promise, and how it's broken

Instar ships lots of features **turned off** at first ("dark mode"), on the promise
that a background helper — the maturation engine — will keep bringing each one back to
your attention until it's either turned on for real, fixed, or killed. That promise is
the whole reason it's safe to ship things off. The engine is supposed to make sure a
dark feature can **never be quietly forgotten**.

We looked at the actual code and the running logs. The engine isn't off — it's on, and
it has sent you three weekly check-ins. But it isn't keeping the promise. It's failing
in three concrete ways, and there's a deeper reason it was allowed to.

## What's actually wrong (all verified in the code and logs)

1. **It's watching the wrong list.** The engine is supposed to watch the switches for
   dark features. Instead it mostly watches a general to-do tracker with 933 items — and
   the part of it that's meant to track "is this dark feature earning its way on?" can
   only see **3 of those 933**. The real dark switches — the ones "ship dark" is all
   about — it can't see at all. So its weekly note is loud about the wrong thing (about
   258 stale to-do items) and silent about the thing that matters.

2. **It sends to the wrong room.** Its check-in goes to your "Updates" topic — the one
   we literally set up as *"nothing urgent, just keeping you in the loop."* So anything
   that actually needs a decision ("this feature is ready — turn it on?") lands in the
   FYI channel you don't watch for action, instead of your alerts.

3. **When its one message gets blocked, it just gives up for the week.** This is the
   worst one, and we have the receipt: on June 29 the weekly note got blocked by our own
   outbound safety filter (because the note contained raw code jargon the filter flags),
   the engine marked that week "done," and **never tried again**. No retry, no backup
   route, no heads-up. The one guarantee it exists to give — never silently drop a dark
   feature — got silently dropped.

**The deeper reason (the meta-finding):** the two rules in our constitution that say
"don't defer things" and "close every loop you open" are written down but have **no
enforcement** — nothing structural checks them. The very principles about not-forgetting
are running on willpower, which is exactly the thing our root rule ("Structure beats
Willpower") says never to trust.

## The fix, in five plain pieces

- **A — watch the right list.** Point the engine at the real inventory of dark switches
  (the `/guards` list, which already grades every switch as dark / dry-run / should-be-on).
  Stop leading with the 258-item to-do noise.
- **B — give every dark switch an owner, a deadline, and a proof-of-life.** Who's on the
  hook for it, when its trial window closes, and how we'll know it actually ran. A dark
  switch with no owner or a blown deadline becomes a flagged item all by itself.
- **C — make the message impossible to silently drop.** Three parts: if a send gets
  blocked, retry it *and* raise a flag instead of eating the week; write the message in
  plain words so it doesn't trip our own filter (that's the real cause of the June 29
  block); and send anything that needs a decision to your **alerts**, not the FYI room.
- **D — put a watcher on the watcher.** A small guard that checks the engine is alive and
  actually delivering. If it goes quiet, the guard tries to fix it **itself** first (within
  strict limits, all logged) and only pings you if its own repair fails. Nothing is ever
  swallowed — every check and repair is written down.
- **E — give the two "don't forget" rules real teeth.** Add a review check + a registry
  marker so those rules are *enforced*, not just remembered — which is the direct answer to
  the meta-finding.

## Two things I had to correct while checking (honesty)

The task handed me a list of findings from an earlier pass. Two of them were wrong when I
checked them against the real code, and I fixed them rather than repeat them:

1. A specific switch the earlier pass named as a "load-bearing gap"
   (`…preferredCaptainHandback`) **doesn't exist anywhere in the code**. The real dark
   piece in that family is named differently (`…soloCaptainHold`). The *shape* of the
   finding was right — there is a dark mesh switch on a critical path — but the name was
   made up, so I corrected it and left it as a decision for you (turn it on, or formally
   accept leaving it off), not something this spec flips.

2. The earlier pass said to "reuse the existing" machinery for classifying load-bearing
   guards and recording an "accepted risk," and then a correction said that machinery
   **isn't built yet**. The correction was wrong, and the spec body now says so: it was
   written against a working copy about 108 versions out of date. On the real main branch
   that machinery **is** built and running. So this spec adds only the one thing it genuinely
   lacks — an owner, a deadline and proof-of-life per switch — and leans on the existing
   parts for everything else, instead of building a second, competing version of them.
   (Keeping this paragraph rather than deleting it: a wrong correction that got believed is
   worth leaving visible.)

## What's yours to decide

Nothing in here turns anything on for your whole fleet, changes the safety filter, or
invents a new rule. Everything ships dark and dry-run first. The one genuine decision I'm
handing you is finding 3: the dark mesh switch on a critical path — do you want it turned
on, or do you want to formally record "I'm okay leaving it off"? Either way it stops being
an invisible gap.

*One term worth knowing: **dark / ship-dark** — a feature that's built but shipped turned
off, so it can be proven safe before it affects anyone.*

---

## What is actually built, as of 23 October 2026

This spec has four parts. Here is the honest state of each.

**Built and shipping now (parts 1 and 2 — "watching the wrong list"):**
The engine now reads the real list of switches straight from the running code, rather than
only the ones someone remembered to register. That takes it from seeing 3 features to
seeing all of them. Every switch it finds gets a written-down owner, a deadline, and a
record of whether there is any evidence it has ever actually run — and that record survives
restarts, which matters because a trial measured only in memory can never prove "it has
been fine for a week."

Four traps are handled, because without them this kind of record is useless in practice:

- A switch that flickers on and off cannot keep resetting its own clock to dodge review.
- Switches that were *already* off before anyone was watching do **not** get a fresh clean
  deadline. That would hide exactly the forgotten pile this exists to surface, so they show
  up overdue immediately.
- A switch that gets renamed or deleted leaves its history behind instead of vanishing.
- "No evidence it ran" is reported as **unknown** and can never be read as proof. A switch
  nobody can show working is never reported ready.

It also stops shouting about the wrong thing: the general to-do noise moves to the bottom,
and the feature-readiness signal leads.

**Already shipped earlier (part 3 — "gives up when blocked"):** the delivery fix landed in
July. Note it is still switched off, so it is not yet doing its job.

**Not built (part 4 — the watcher on the engine itself):** nothing yet watches whether the
engine has gone quiet. That is the next piece.

**Yours, and deliberately untouched:** the part that turns two existing principles into
enforced rules edits the constitution, so it stays an operator decision.

## What this does NOT do yet, said plainly

It makes the forgotten pile **visible and durable**. It does **not** decide anything for
you. Turning a feature on is still a human call, and there is not yet a one-tap
"promote / give it longer / retire it" button — that is the next increment. Until then, a
surfaced item is acted on through the paths that already exist.

Expect the first live report to name a sizeable pile of switches with **no owner at all**.
That is the point, not a fault: an un-owned switch left off is exactly the gap being closed.
