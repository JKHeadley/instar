# Auto-expiry holds and archive, in plain English

## What this is

Instar has two cleanup jobs. One closes old promises the agent made
(commitments). The other clears old items from its self-improvement to-do list
(actions). Both run in practice mode: they write down what they would close, and
close nothing.

We were close to turning them on, so two different AI models read the full lists
of what they would close. Both said no. The lists contained real, live work.
One entry was a security token that has to be rotated in 2027. Others were
standing rules like "never push to main", which look idle because a rule does
nothing until it is needed. Worse, the to-do cleanup would have deleted items for
good, across every machine, keeping only their id numbers.

## What already exists

Both cleanup jobs, and a log of what each one would close. A "pinned" tag already
protects to-do items, but nothing could be set over the API, and promises had no
protection at all.

## What is new

**Rules that cannot go idle are left alone.** Standing rules no longer count as
stale, and a promise marked as broken is treated as a defect, not as old news.

**A hold.** Anyone working with the agent can mark one promise or to-do item
"do not expire this", with a reason. It stays until someone removes it, because a
hold that quietly ran out would send the item straight back to the cleanup.

**An archive instead of a shredder.** When the to-do cleanup does go live, it
first copies the whole item to an archive file, then takes it off the list. No
delete signal goes to other machines. They just see it as closed, which can be
undone. If the archive cannot be written, or looks damaged, the cleanup removes
nothing at all.

**Undo.** One call restores an archived item. It comes back with a hold, because
it is still old and would otherwise be cleaned up again straight away.

## Safeguards

Both jobs stay in practice mode. This change cannot close anything by itself. It
only makes a later decision to turn them on safe to take.

## What the reader needs to decide

Nothing now. Turning either job on stays a separate decision, made after someone
re-reads the lists. The specific items the review named get their holds once this
ships.
