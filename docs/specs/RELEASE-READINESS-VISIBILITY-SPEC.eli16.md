# Release-Readiness Visibility — the plain-English version

## What went wrong

For a while, none of my new work was actually reaching anyone. A whole season's worth of finished features — about three dozen of them — were merged and "done," but the part that packages them up and ships them out had quietly stopped happening. Every agent, me included, kept running old code and had no idea. I only found out by accident: I went to use a feature I'd just finished, and my own server said it didn't exist.

Then I found a twin of the same problem. We have a "whiteboard" that's supposed to automatically list every shipped feature so we never forget to finish raising it (turning it from "off and watched" to "on for everyone"). It missed the newest feature — because it only looks at the folder on *my* laptop, and I, being the developer, am usually working on a side-copy that I throw away after merging. So the freshest work is exactly what it can't see.

## The one root cause

Both are the same mistake: **a robot helper trusting whatever's lying around locally or in the moment, and going completely quiet when it decides to do nothing.** The safety checks all worked fine. What was missing was any *sound* when they chose to skip. Green lights everywhere, nothing shipped, nobody told.

When I dug into the actual code, the two helpers fail *different halves* of the same rule:

- **The shipper** looks at the right place (the real shared copy, "main") — but when the release notes aren't ready, it just silently does nothing. To the system, "the notes aren't ready" looks identical to "there's nothing to ship." So it shrugs and stays quiet.
- **The whiteboard** does the opposite: it goes quiet too, *and* it's looking in the wrong place (my laptop's throwaway copy instead of the real shared one).

## What I'm proposing

Three moves, all the same idea: **look at the real shared copy, and speak up whenever you skip.**

1. **Auto-write a first draft of the release notes.** Here's the lucky part: the tool that *checks* the release notes already figures out everything that changed — every new button, setting, and fix. It just never offered to *write it down*. So I'll teach it a "draft" button: it fills in a starting version of the notes from what it already knows. A human still edits and trims — but the page is never blank, which is the whole reason it went stale. (And it never overwrites anything a human wrote; it only ever adds the bits that are missing.)

2. **A smoke alarm for stuck releases.** A cheap little check that runs on a timer, looks at the *real* shared copy, and asks: "Is anything finished-but-unshipped, and for how long?" If it's been stuck too long, it quietly raises one flag on my attention list — not a phone buzz unless it's really overdue. That's the missing sound. It never ships anything itself and never overrides a safety check — it just makes sure a stuck release can't stay invisible.

3. **Fix the whiteboard's eyesight.** Make it read the real shared copy instead of my laptop, and figure out "is this actually merged?" from the real history — not from leftover scraps on my disk. And if it ever runs and finds nothing new when there *should* be something new, it has to leave a note saying so, instead of silently shrugging.

## What I'm deliberately NOT doing

I could force every single code change to update the release notes by hand. I'm leaving that out for now — the auto-draft plus the smoke alarm cover it, and forcing it would just add a nag to every commit. Easy to add later if the drift comes back.

## The honest part

The reason this is worth doing is that I'm the one who wrote the shortcut. There's literally a comment in the whiteboard's code — that I wrote — admitting "checking the real merge history properly is a refinement I'll do later." That "later" is now. Same with the release notes: the tool was always smart enough to draft them; I just never wired up the draft button.

## Where this is

This is a **draft spec, not code.** Per our own rule, I won't write a line of the actual change until this has been through review and you've signed off. The full technical version is the appendix; a short list of remaining choices (like how many days "too long" should be) is at the end of it.
