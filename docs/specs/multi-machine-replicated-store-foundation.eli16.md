# Replicated-Store Foundation — the plain-English version

## What this is

My machines already keep shared **diaries** (the coherence journal) — append-only
logs they swap with each other over a secure line. That works great for *history*
("which machine ran the overnight job"). But my **memory** — your preferences, our
relationships, what I've learned, my knowledge base — isn't history. It's a set of
*current facts* that I edit, and that can be edited on more than one machine. To
let my memory follow you across machines, I need rules for *merging edits* that
never quietly throw away the right answer. This document is those rules — the
plumbing every memory store will sit on top of. No memory store ships until this
plumbing exists; that's why this is the "foundation."

## What already exists (so I'm not reinventing it)

The transport is done and battle-tested. Machines write only their OWN diary
lines, never each other's, so there are no edit-collisions on the wire; they swap
copies, validate every incoming line, reject forged lines (a line must really come
from the machine that sent it), and only count a line as "saved" after it's safely
on disk. I'm building the *meaning* layer on top of that proven pipe — not a new
pipe.

## What's new

1. **A smarter clock (HLC).** Plain wall-clock time is a terrible referee — if one
   machine's clock runs fast, it would "win" every disagreement. The Hybrid
   Logical Clock combines the wall clock with a little counter so edits get a fair,
   consistent order *across all machines*, and a clock that's wildly ahead can't
   bully its way to the front. A record that claims to be from five minutes in the
   future gets set aside, not believed.
2. **Catch-up without re-reading everything (snapshot-then-tail).** When a machine
   has been off for a while and rejoins, it does NOT re-read the entire history
   from the beginning. It grabs a quick *snapshot* of the current state, then reads
   only what happened *after* the snapshot. The clever part: each machine only ever
   hands out a snapshot of **its own** writes — never another machine's. So a
   returning machine pieces together the full picture by collecting one snapshot
   per machine, from each machine itself. That means no machine can ever forge a
   record and pretend it came from a different machine (a security guarantee that
   falls out of the design, not a bolt-on check). Catch-up uses the diary's
   existing line-counter to know exactly where it left off — no gap, nothing read
   twice — and the snapshot is built off to the side so it never freezes anything.
3. **A holding pen for bad data (quarantine).** Anything malformed, too big, from a
   future-dated clock, or not really from who it claims to be is put in a small,
   bounded holding pen — not silently dropped, not blindly applied. If one machine
   floods me with junk, the junk *collapses into one counter* ("machine X: 1,000,000
   bad records") instead of filling the pen, and a machine that keeps misbehaving
   gets cut off.
4. **Reading the union, never clobbering (the big one).** When I read a memory, I
   read *everyone's* copy merged together — but a copy from another machine NEVER
   silently overwrites a *different* answer I have locally. If two machines edited
   the same thing at the same time during a disconnect, I **keep both** and **flag
   it** for you to settle, rather than picking a winner behind your back. To tell a
   real simultaneous-edit apart from a normal "you edited, then I edited after
   seeing yours," each edit carries a little note saying *what it had already seen*
   for that item. If the note proves one edit saw the other, it's just a normal
   update; if it can't prove that, I treat them as simultaneous and ask you — and
   the math is rigged to always lean toward asking rather than risking a silent
   wrong overwrite.
5. **Clean undo (rollback-unmerge).** If a machine turns out to have sent bad data,
   I can drop that machine's whole contribution cleanly — and any value that came
   from it falls back to the next-best real answer, with no broken leftovers.
6. **Fair budgets.** One chatty memory store can't hog the pipe and starve the
   others, and the budget grows sensibly when you add more machines (not hard-wired
   for exactly two).

## The safeguards, in plain terms

- **Reach is not authority.** Another machine can *send* me a memory, but it can't
  *force* it over a different local truth. Conflicts are surfaced to you, never
  silently resolved.
- **I never pick the winner of a real conflict — you do.** When I genuinely can't
  tell which of two edits is right, I show you both and let you choose (or merge);
  there's a dashboard for it.
- **Off by default, dry-run first.** Every store ships dark. The first time one is
  switched on it runs in "log what I *would* merge" mode before it touches
  anything. A single-machine setup does literally nothing — no new behavior at all.
- **Bad data is caged, not trusted and not lost.** The quarantine pen is
  inspectable, so I can always tell you *why* a record was set aside.
- **A deletion stays deleted.** If you delete something, it can't quietly come back
  to life later just because an old machine that never heard about the delete shows
  up months afterward with its stale copy. I remember "this was deleted" even after
  the deletion note itself ages out, and a very-stale machine is made to grab a
  fresh full snapshot instead of replaying ancient history.

## What you actually need to decide before approving

1. **Am I OK keeping BOTH versions and asking you, when two machines edit the same
   memory during a disconnect?** (The alternative — silently picking one — is the
   thing this design refuses to do for important stores like preferences and
   relationships.)
2. **The conflict detector errs on the side of asking too often rather than too
   rarely.** Is that the right bias for you (a few extra "which one?" prompts) versus
   risking a silent wrong overwrite? My recommendation is yes — and I'll measure how
   often it actually fires so we can tighten it later if it's noisy.
3. **A machine whose clock is badly out of sync:** should it be barred from
   authoring shared memories until its clock settles? I'm leaning yes (its
   timestamps can't be trusted), and I've flagged it as an open question.
4. **PII note (heads-up, not in this PR):** the relationships/user-registry store
   (WS2.3) means more machines hold personal data; that store ships behind its own
   focused security round, on top of this foundation — you already pre-approved the
   boundary, this just builds the floor it stands on.

Nothing here changes a single-machine setup. It only wakes up when you run me on
more than one machine and switch a memory store on.
