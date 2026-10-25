# The locked room was refusing its own scratch folder — plain-English overview

## The one-sentence version

The sandbox that fix-writing runs inside was denying writes to the sandbox's *own* temporary
directory, so the test command died the moment it tried to create a folder there.

## What already exists

Before the feedback pipeline lets an AI session write a fix for one of your bug reports, it
rehearses the locked-down workspace that session will run in — about twenty probes. Most must
FAIL (reading the agent's config, reaching the network, writing outside the workspace). A few
must SUCCEED, including the repository's lint and one small existing unit test, because a
workspace where nothing can pass is useless for proving a fix works.

Each attempt gets its own private temporary directory. That directory is deliberately placed
inside the machine's shared temporary area — not for convenience, but because some internal
connections communicate over sockets whose file paths must stay short, and the agent's own home
directory sits too deep to produce a short enough path.

Separately, the sandbox denies writing anywhere in that shared temporary area, so a confined
session cannot drop files where other agents or users would read them.

## What was broken

Those two decisions collide. The sandbox was told "writes allowed in the attempt's own temp
directory" *and* "writes denied throughout the shared temporary area" — and the attempt's own
directory lives inside that area.

The sandbox's documented rule for writes is that a denial beats a permission. (For reads it is
the other way round, which is why reading worked fine and only writing failed.) So the attempt
could not create a folder inside its own scratch directory:

```
EPERM: operation not permitted, mkdir '/private/tmp/fb-8ac70c2cde/HH0KfR7JCSG9zBDVFZQSa'
  from vitest's configuration step
```

The lint step passed because lint never needs that folder. Only the test step did — which is
exactly the one probe that had been failing since 2026-10-22, and for three days the only thing
recorded about it was the words `exit 1`.

The rule's author had thought about this collision and covered one case: do not deny the shared
area if the *main workspace* lives inside it. They did not cover the second: the *attempt's own
temporary directory* living inside it. In production the first case never happens and the second
always does.

## What is new

One function now protects both. A shared temporary directory is dropped from the deny list when
it is an ancestor of the workspace **or** of the attempt's own temporary directory, compared by
real path (on macOS `/tmp` is a link to `/private/tmp`, so comparing the spellings as text would
have missed it).

## The safeguards, in plain terms

- **This does not open the shared temporary area.** Writes are permission-list based: only paths
  on the allow list are writable, and the shared area itself is never on it. Removing it from the
  deny list changes nothing about the rest of it.
- **The rehearsal proves that every run.** One of the must-fail probes writes to the shared
  temporary area and must be refused. If this change had loosened anything, that probe would
  start passing and the rehearsal would fail — the opposite of a silent regression.
- **The test pins it from both sides.** Reverting the change fails a test, and exempting too much
  also fails a test. Both were verified by deliberately breaking the code each way.

## What you actually need to decide

Nothing. If it is wrong, reverting the commit fully undoes it — there is no stored state and no
user-visible surface.
