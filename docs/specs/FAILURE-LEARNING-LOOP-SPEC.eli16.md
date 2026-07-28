# Failure-Learning Loop — the plain-English version

## The one-sentence idea

When something we built breaks later, automatically write down *what broke*, trace it back to *exactly what produced it* — the spec, the project, and the tools we used to build and review it — and slowly learn from the pile of those records so we keep making the same mistake less often.

## Why this matters

Right now, building software here works like a kitchen with no incident book. A dish goes out, a few weeks later a customer sends it back, the cook fixes it, and… that's it. The lesson lives in one cook's head and disappears. Next week a different cook makes a similar mistake, because nobody wrote down that the recipe step was unclear, or that nobody tasted it before it left.

This builds the incident book — but a smart one. Every time something we shipped breaks, it doesn't just record "this broke." It records "this broke, it came from *this* recipe (spec), it was made on *this* station (project), and it was cooked with *this* set of tools and checked by *these* inspectors." Once you have a stack of those, you stop asking "what went wrong this one time?" and start asking the much more useful question: "what about *how we work* keeps letting this kind of thing slip through?" Maybe one recipe template is always vague. Maybe one inspector never catches a certain kind of mistake. Maybe one cooking tool skips a step. You can only see that pattern if you wrote down the cause every time.

## The hard part, said honestly

The tricky bit is connecting "the thing that broke today" back to "the thing we built three weeks ago." Sometimes that trail is clean and we can follow it automatically — if a fix undoes a specific change, we can walk that change back to the feature it belonged to. But plenty of breakages show up sideways, and for those we'll need a quick one-tap "this traces back to feature X" at the moment someone figures it out — not a long form to fill in. We're being upfront: it's automatic where the trail is clean, one tap where it isn't, and a guess is always *labeled* as a guess instead of pretended to be certain.

## The clever reuse

We don't build a whole new system from scratch. Two things we already have do most of the work. The initiative board already remembers which spec and which code-change each feature came from — so a failure just attaches to the right card. And every time we change Instar's own code, the rules already force us to leave a little receipt of what we did. We just make that receipt also note *which build tool and which review steps* were used. That one small addition is what makes it possible to later say "features built with tool A break more than features built with tool B" — which is exactly what we need, because we're about to have different build tools for different kinds of work.

## How it reaches you (three ways, loudest last)

You shouldn't have to go digging, so there are three channels, deliberately ordered from quietest to most attention-grabbing:

1. **The dashboard, a new "Process Health" tab** — the full picture you can browse whenever you want, from your phone or laptop: every failure, what caused it, which tools built it, the trends, and the standing recommendations with a clear "did this fix actually work?" marker next to each. This is the calm, look-when-you-like view.
2. **A quiet heads-up in your existing system topic** — when a real insight is discovered, I post *once*, into the channel you already have, the same calm way the watchdog alerts work — not a new buzzing topic (we learned that lesson the hard way), and never a ping per bug. Just "here's a pattern worth knowing, with the evidence," once, and it stays off by default until you switch it on. Using the topic you already have (rather than a brand-new one) is a deliberate decision, not something we're putting off — it's how we avoid re-introducing notification spam. This is the "tell me when you learn something" channel you asked for.
3. **The attention list** — only when an insight has become an actual decision waiting on you ("want me to tighten this part of the process?"), so it doesn't get lost in chat scroll.

Everything noisy stays on the pull surface; only the genuinely worth-knowing gets pushed. Same anti-spam discipline we've been holding everywhere.

## The full loop — and why it's a loop, not a suggestion box

This is the part that makes it real. A suggestion box just collects complaints. This closes the circle:

- **Track** the failure (automatic).
- **Discover** the pattern (automatic, only with enough evidence).
- **Implement** — when a pattern is solid, the system automatically opens a tracked to-do for the fix so it can't be forgotten — but it *never* changes the process on its own; you approve turning it into a real change.
- **Deploy** the approved fix through the exact same build-and-rollout path everything else uses (including the rollout board we just built, so it matures safely).
- **Verify** — and this is the kicker — afterward the system checks whether that kind of failure *actually went down*. If it did, great, the lesson is confirmed. If it didn't, it reopens the issue and says so out loud instead of quietly assuming it worked. And if the fix itself ever breaks, that gets tracked too — the loop even watches its own repairs.

So it's an honest, unbroken line: failure → insight → approved change → deployment → proof it helped. Over time the whole point is simple: we build with fewer failures because we finally remember the ones we had — and we only trust a fix once the numbers agree.

## How careful we're being

It's mandatory but invisible — the recording happens where the work already happens, so nobody has to remember to do it. It only speaks up when there's genuinely enough evidence to mean something (two unlucky coincidences never get dressed up as a "pattern"). And it ships dark first and matures on the rollout board we just built — fittingly, this feature is its own first test case.
