# Every deployed agent was reporting zero builtin capabilities

## What was broken

Instar ships a file listing every builtin thing an agent has — hooks, jobs, skills, capabilities —
called the builtin manifest. `CapabilityMapper` reads it to answer "where did this capability come
from: instar, the agent itself, or the user?"

It was looking in the wrong place, in a way that was invisible during development.

The code resolved the manifest relative to its own file, as `../data/builtin-manifest.json`. In a
source checkout the reading file lives in `src/core/`, so `../data/` is `src/data/` — which is exactly
where the manifest is generated. Everything worked.

In an installed package the compiled file lives in `dist/core/`, so `../data/` becomes `dist/data/` —
a directory that does not exist. TypeScript does not copy JSON files when it compiles, and nothing
else creates it. Meanwhile the real manifest ships at `src/data/`, because that path is in the
published file list.

This was verified on a real install rather than reasoned about: `dist/data/builtin-manifest.json` was
absent, and `src/data/builtin-manifest.json` was present at 62,717 bytes.

## Why nobody noticed

Because the failure was silent, twice over.

If the file was missing, the code fell through and returned an empty result. If the file was present
but corrupted, the error was caught and it also returned an empty result. An empty result is
indistinguishable from "this agent genuinely has no builtin capabilities" — so a deployed agent
reported zero builtins, and nothing anywhere said the data had failed to load.

And the tests could not catch it, because tests run from a source checkout, which is the one layout
where the wrong path happened to be right. The bug existed only in the environment the tests never
ran in.

## What changed

Two things, because fixing only the first would leave the second waiting for the next cause.

**The path now covers both layouts.** Instead of one location, the loader tries the source layout and
then the installed layout. Both are checked rather than picking one, because a build step that copies
the file into place is a step that can be skipped, and this read should not depend on it.

**A failed load is now distinguishable from an empty one.** The loader reports which of three things
happened: it loaded, the file was not found, or the file was found but unreadable. That state is
carried into the capability map summary, so anyone reading a low builtin count can tell whether it
means "this agent has few builtins" or "the data that answers that question could not be read."

This stays a signal, not an alarm. A missing manifest still produces an empty set and the map still
builds. Nothing here fails or throws in production.

## A note on the tests

The first version of the tests reimplemented the path resolution inside the test file and checked
that copy. That is the same blindness the bug is made of: a test that reproduces the logic it is
checking cannot fail when the real logic changes. The resolution is now exported and the tests call
it directly, and each one was verified by breaking the production code on purpose and confirming the
test failed before restoring it.
