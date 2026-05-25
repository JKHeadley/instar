# Arming the Response-Review Safety Net — the plain-English version

## The short version

We have a safety net that's supposed to catch the agent before it does something
bad — like quitting a job halfway through with a flimsy excuse, or sending a
reply full of claims it can't back up. The problem: the net is hung up in a way
where you can check any one corner and it looks fine, but the net as a whole
isn't actually catching anything. This spec is about hanging the net properly and
proving — corner by corner *and* all together — that it actually catches.

## Think of it like a smoke detector

A smoke detector only protects you if **four** things are all true at once:

1. **It's screwed into the ceiling** (the host actually runs the hook).
2. **It has a battery in it** (the config flag is turned on).
3. **The wiring behind it is connected** (the server-side reviewer is actually
   built and answering).
4. **Nobody pressed the "hush" button and walked away** (the hook wasn't quietly
   switched off).

Right now you can walk into the room, see the detector on the ceiling, and say
"yep, we have a smoke detector" — while the battery's out, or the hush button is
stuck on. Each check passes on its own; the house still burns. Our safety net has
exactly this shape, and it's dark in two different ways depending on the engine:

- On **Claude**, the detector was never screwed into the ceiling — the file is
  sitting in the closet, never hung up (it's on disk but not in the list of
  things the host runs).
- On **Codex**, it's on the ceiling and powered, but someone hit "hush" once and
  it stayed hushed forever — and the update process politely refuses to un-hush
  it because it assumes a person meant to do that.

## The sneaky part

On Codex there's a real mystery we're still nailing down: does the "hush" turn
itself on automatically every time we tweak the detector (because changing it
makes the system distrust it), or did it get hushed once by a misclick? That
difference matters a lot:

- If it auto-hushes on every tweak, then **every time we improve this safety hook,
  we accidentally switch it off for everyone** — that's a big deal and means we
  must "re-bless" the detector in the same motion as every edit.
- If it was a one-time misclick, the fix is narrower.

Our partner agent (codey) is running the clean experiment to tell these apart. We
don't need to wait for that to do the main fix — but the answer tells us how
loudly to insist on the "re-bless on every edit" rule.

## What we're going to do

1. **Hang the detector properly** on both engines, for old setups and new ones —
   not just freshly-installed ones.
2. **Stop trusting one-corner checks.** A "we're safe" verdict now requires all
   four things to be true together, and it tells you *which* corner is broken if
   one is.
3. **Make the most important detector un-hushable.** This particular safety hook
   (the one that stops the agent from bailing on work with a bad excuse) gets
   pinned by policy — if it's found hushed at startup, the system un-hushes it
   and writes a note saying it did. Less-critical hooks can stay hushed but get
   flagged.
4. **Test it for real.** Not "is the file there" — actually push a bad reply
   through the whole chain and confirm it gets blocked.

## What we are NOT doing

- We're not rewriting how the reviewer decides what's bad — just making sure it's
  actually plugged in and running.
- We're not touching codey's broken setup — it's being kept as evidence for the
  experiment.
- We're not shipping any of this until Justin says yes. This is a plan, not a
  change.
