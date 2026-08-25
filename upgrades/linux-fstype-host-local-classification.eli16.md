# Two safety limits misjudge ordinary Linux disks — Plain-English Overview

> The one-line version: on Linux, four perfectly normal local filesystems look like network drives to instar's safety limits, so one limit quietly stops guarding and the other slowly clogs — this teaches them to ask the operating system what the filesystem actually is instead of guessing from its name.

## The problem in one breath

Instar has two limits that stop a machine tearing itself apart: one caps how many test suites run at once, and one caps how many model processes can be spawned at once. Both coordinate through a shared file, and before trusting that file each one asks "is this disk actually mine, or could another machine be writing to it too?" On Linux it asks that question in a way that gets the wrong answer for several completely ordinary disks — and when it does, the two limits break in opposite directions without saying a word.

## What already exists

- **The test-runner limit** — stops several test suites running at once and starving the machine. Born from a day when 29 test runs collided and healthy servers got killed.
- **The spawn limit** — caps how many model processes can run at once across everything instar is doing on the machine. Born from a fork-bomb that ate roughly 100GB of memory.
- **The shared "who's holding a slot" file** — how both limits coordinate between separate processes on the same machine.
- **The "is this disk mine?" check** — the piece being fixed. It exists because if the coordination file were on a drive shared with another computer, two machines could each think they held the same slot.

## What this adds

The check currently decides by looking at the disk's *name*: if the name looks like a traditional hard disk it is trusted, and otherwise it isn't. That worked on Macs, where disks always look like that. On Linux, several everyday local filesystems don't have a name of that shape at all — RAM-backed temporary space (which is the standard setup on Ubuntu), the layered filesystem every Docker container runs on, the kernel's own device area, and ZFS, which names a storage pool rather than a disk. All four are unmistakably local. All four were being treated as "might be a network drive."

This change gives the check a second, better question on Linux: instead of guessing from the name, ask the operating system what type of filesystem it actually is, and compare that against an explicit list of types known to be local *and* known to support the kind of file locking these limits depend on.

- It only runs on Linux. Macs never reach the new code and behave exactly as before.
- It can only ever change a "not mine" answer into "mine" — never the reverse.
- Anything not on the list keeps today's cautious answer, unchanged.

## The new pieces

- **A filesystem-type lookup** — reads the list of mounted filesystems the Linux kernel already publishes, and works out which one a given file sits on. It picks the most specific match, because otherwise everything would match the root filesystem.
- **An explicit list of trusted filesystem types** — a closed, named list, not a pattern or a guess. Adding to it is a deliberate act.

## The safeguards

**It cannot make anything less safe.** The new code only runs after the existing check has already declined to say "local", and the only outcome it can produce is "local". There is no input anywhere for which this change produces a stricter answer than today's code. Reverting it restores exactly the behaviour every Linux agent is running right now.

**It refuses the tempting shortcut.** The obvious fix is to widen the name-matching to accept these filesystems. That cannot be made safe: a ZFS pool name and a cloud-storage bucket name are indistinguishable by shape, and one of those is genuinely remote. Only the filesystem type tells them apart — which is the argument for fixing it at this level rather than with a cleverer pattern.

**It keeps the right things rejected, on purpose.** WSL's view of the Windows C: drive is on the same physical machine, but the file-locking behaviour these limits rely on isn't dependable across it, so it stays untrusted — now deliberately, with the reason written down, rather than by accident. Shared-with-other-guests filesystems stay untrusted too. Genuine network drives were already rejected correctly and still are.

**It doesn't hide a broken probe.** If the underlying disk query fails outright, the answer stays "I couldn't tell" rather than becoming a confident verdict — the distinction that a previous incident turned on.

## What ships when

One change, one PR: the filesystem-type lookup, the trusted-types list, and nine tests covering both the newly-correct answers and the rejections that must remain rejections. Nothing is staged or behind a flag, because there is no rollout risk to stage — the change cannot produce a stricter answer than the code it replaces.

## What you actually need to decide

Whether to accept a change that makes two existing safety limits work correctly on Linux and containers, given that it can only ever loosen a verdict in the direction of "this disk is mine" and only for an explicit list of filesystem types — yes or no.
