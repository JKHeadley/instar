# Census tracker refs — the plain-English version

## The one-sentence version

A progress tracker that's supposed to tell us "are these 49 pending items still
being tracked by something real?" can only ever answer "I have no idea" — because
the thing it points at is a note that exists on exactly one computer, written
into code that ships to all of them.

## What's actually going on

We have a list of about 60 places where I make judgment calls. Seven of them
currently record what they decided so we can grade them later. The other 49 are
a backlog — not yet wired up.

To stop that backlog quietly rotting, there's a counter that asks a simple
question of each pending item: *is the thing tracking this still alive?* If a
tracker vanishes, the item has been abandoned and nobody would notice.

Reasonable check. Except every one of those 49 items points at a to-do note whose
ID only means something on the machine where I created it. That list of 49 lives
in the shipped source code — identical on every machine. So on any machine but
the one that minted the note, the ID refers to nothing at all.

## Why this isn't just an untidy reference

Someone already noticed half of this in July and fixed it properly. The check
used to report those items as **dead** — as if the trackers had been deleted.
They hadn't; the machine had simply never seen them. So the fix taught the check
to say **"can't verify"** instead of **"deleted."**

That was right, and it stopped a false alarm firing on every machine added to the
fleet. But it left the counter permanently stuck on "can't verify," and a check
that can only ever say *I don't know* isn't doing anything. It's honest noise.

## What I'm changing

The problem isn't that the ID is broken. It's that it's the **wrong kind of ID**
for the job — a personal sticky note used where a permanent address was needed.

So trackers get a kind. A to-do ID keeps working exactly as it does today, for
the cases where it's genuinely a note-to-self on one machine. And a second kind
points at an entry in a small **registry that lives in the code itself**.

That second part is the whole trick, and I got it wrong the first time — worth
saying plainly, because the wrong version was convincing.

My first design pointed the 49 items at the **design document** that owns the
backlog. Documents ship with the code, I reasoned, so every machine can check
the file is there. An outside reviewer asked the one question I hadn't: *does
that document actually ship?*

It doesn't. Documentation is explicitly excluded from what gets published. So on
every machine except this one, the check would look for a missing file and
conclude the tracker had been **deleted** — 49 deletions that never happened.
Today's "can't verify" is at least honest; my fix would have replaced it with a
confident lie, and re-broken the very thing someone fixed in July.

Code, unlike documentation, does ship. So the anchor is a short list written in
code — a registry the check looks names up in. It's identical on every machine
because it *is* the same shipped file, with no folder to be missing and no
heading to be renamed out from under it.

There's now a test that reads the packaging rules directly and fails if anyone
tries the document approach again, so the reasoning can't quietly evaporate.

Nicely, the general idea isn't new. The same file already has a category of
entry that carries "a resolvable reference" and gets validated. The pending
entries just never adopted the convention sitting next to them.

## The thing I want to be explicit about

The task I was given says: fix the reference *so the unverifiable count shrinks*.

I could make that number zero in about a minute by swapping in a to-do ID that
happens to be live on this machine. The counter would read clean. It would still
be broken everywhere else, and now nobody would ever look again — because the
warning light would be off.

That's the trap, and I want it on the record that I'm not taking it. The point
isn't a smaller number; it's a check that can actually answer. The number drops
as a *consequence* of that, which is the only version worth having.

## What you'd notice

Honestly, nothing directly. This is instrumentation — a counter on an internal
health page going from "49 unknown" to "0 unknown, 49 pending."

What it buys is that the pending backlog becomes genuinely watchable. If one of
those 49 ever loses its tracker for real, the check will say so, on every
machine, instead of shrugging. Right now it would shrug, and we'd never know the
difference between "fine" and "abandoned."

One honest caveat about the new failure mode: because the registry ships with
the code, a name that isn't in it reads as **deleted** rather than "unknown."
That's deliberate — a shipped list's silence is a fact everywhere, not a local
gap — but it does mean a typo would be loud rather than quiet. Two things stop
that reaching you: the build refuses to publish a name that isn't in the
registry, and undoing the change restores today's quieter behaviour.

The second half of the task — actually wiring up the highest-traffic ones so they
start recording — is where the backlog really shrinks. This comes first because
wiring things up against a tracker nobody can verify is building on sand.
