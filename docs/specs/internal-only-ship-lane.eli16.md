# ELI16 — A lighter release-note lane for changes users never see

## What this is, in plain English

When a developer changes instar, they write a little "release note" describing the
change. The note has four parts, two of which are aimed at the END USER of the agent:
"What to Tell Your User" and "Summary of New Capabilities."

That makes total sense for a real feature. But lots of changes have nothing to tell
the user about at all — fixing a flaky test, tidying a build script, updating docs.
For those, the developer was forced to write two sections that both just say "None —
internal." Busywork, and worse: writing "None" over and over trains people to ignore
sections that are supposed to catch real user impact.

## What's new

A change with no user-facing surface can now add a tiny marker —
`<!-- internal-only -->` — to its release note and simply LEAVE OUT those two
user-facing sections. The tool that assembles the final release notes fills them in
automatically with "None — internal change (no user-facing surface)," but ONLY when
*every* note in that release is internal-only. If even one note is a real user-facing
feature, nothing is auto-filled — that feature still has to tell the user about itself.

## Why it's safe

The important part: you can't cheat with the marker. Before a push, the gate checks
the marker against what actually changed. If you slapped `<!-- internal-only -->` on a
change that touches the real product code (`src/`), the push is REJECTED — a
user-facing change can't use this lane to skip telling the user. You set the marker;
the diff proves it.

And nothing else gets lighter: the safety review and the audit trail are exactly the
same. This only removes boilerplate from changes that provably have no user-facing
surface (tests, docs, build scripts).

The auto-fill lives in the one shared tool both the pre-push check AND the publish
check use, so they can never disagree about a release note. Proven with 45 tests
covering the auto-fill, the "don't auto-fill when a real feature is present" case, and
the marker-can't-be-misused gate.
