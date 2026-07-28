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
   guards and recording an "accepted risk." **That machinery isn't built yet** — it's a
   still-planned item. So the spec builds its owner/deadline/proof-of-life piece on the
   parts that *do* exist today, and lines it up to connect with the planned machinery when
   that lands, instead of leaning on something that isn't there.

## What's yours to decide

Nothing in here turns anything on for your whole fleet, changes the safety filter, or
invents a new rule. Everything ships dark and dry-run first. The one genuine decision I'm
handing you is finding 3: the dark mesh switch on a critical path — do you want it turned
on, or do you want to formally record "I'm okay leaving it off"? Either way it stops being
an invisible gap.

*One term worth knowing: **dark / ship-dark** — a feature that's built but shipped turned
off, so it can be proven safe before it affects anyone.*
