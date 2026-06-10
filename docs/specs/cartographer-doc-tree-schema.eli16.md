# Cartographer Doc-Tree Schema — Plain-English Overview

## The one-sentence version

We're building a living "map" of the codebase where every folder and important
file has a short plain-language note saying what it does — and each note knows
whether it's still accurate or has gone out of date because the code underneath
it changed.

## Why we need it

Today Instar has a *directory listing* — it can tell you which folders exist and
roughly how big they are. What it can't tell you is what each part of the code is
*for*, and it has no idea when a description has rotted because someone changed the
code. Imagine a building directory that lists the rooms but never says what's in
them, and never updates when a room is renovated. That's what we have.

This map is the foundation for three later pieces: a background job that keeps the
notes fresh, an audit that checks the code against our own rules, and a way for
helper agents to "zoom in" on just the part of the codebase they need. None of
those can exist until the map exists. This spec builds *only* the map's structure
— not the things that use it.

## What a "node" is

Think of the map as an outline that mirrors the folder tree. Each entry — a
"node" — covers one folder or one important file and holds:

- a **plain-language summary** of what the code there does (the valuable part);
- a **timestamp** of when that summary was last written;
- a **fingerprint** of the code as it looked when the summary was written.

## The clever part: knowing when a note is stale — for free

Here's the trick that makes the whole thing affordable. Git (our version control)
can produce a tiny fingerprint of any folder's contents instantly. We store that
fingerprint next to each note. Later, we ask git for the *current* fingerprint and
compare: if they match, the note is still accurate; if they differ, the code
changed and the note is stale. This costs no AI calls at all — it's just comparing
two short strings. And because a folder's fingerprint covers everything inside it,
we can check the whole codebase top-down: if the root fingerprint hasn't changed,
*nothing* is stale and we stop instantly; if it has, we only dig into the branches
that actually changed.

## How it's stored

As plain files (no database — that's an Instar rule). There's one small **index**
file listing every node and its fingerprint (so we can scan the whole tree for
staleness fast), plus **one file per node** holding its full summary (so a helper
agent can read just the one node it cares about, and the background job can refresh
one node without rewriting the whole map).

## How you'd use it

There are a few read-only web endpoints — "show me the whole tree," "show me this
one node," "show me everything that's gone stale," and a health check. Writing to
the map happens inside the program (via the background job built in the next spec),
never through an open web endpoint.

## What's still being decided

A few honest tuning questions for the review round: should the map be one big file
or many small ones (we lean many small, for speed); should "what counts as
changed" use git's fingerprint or file timestamps (we lean git — timestamps lie
across machines); and how deep should the map go / which files deserve their own
node. None of these change *what* the map is — only how it's tuned.

## What changes for a user if this ships

Nothing visible yet — this is foundation. On its own it's an empty, structure-only
map. It becomes useful when the next specs fill in the notes and start using them.
It ships turned off until then.
