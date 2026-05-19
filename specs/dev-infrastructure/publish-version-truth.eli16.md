---
title: "Publish version-truth — ELI16"
slug: "publish-version-truth-eli16"
parent: "publish-version-truth.md"
---

# Publish version-truth — explained simply

## The problem in one paragraph

Instar's release robot publishes a new version to npm every time we merge a
substantive change. To decide the new version number, it looked at what was
already on npm and added one to the patch number. It never looked at the
version we'd written in our own project file (package.json). So when we set
that file to "1.0.0" to ship the big v1.0.0 milestone, the robot ignored it,
saw "0.28.124" on npm, and shipped "0.28.125" instead. The v1.0.0 we kept
talking about could never actually come out, because the robot had no way to
hear us ask for it.

## The fix in one paragraph

Now the robot compares two things: the version we wrote in package.json (what
we *want*) and the version on npm (what already *shipped*). If our version is
higher, it ships our version — that's how a deliberate jump to 1.0.0 happens.
If our version equals what's on npm (the normal case, because most PRs don't
touch the version file), it does the old patch+1 behavior. If our version is
somehow lower than npm (a stale leftover from a queued run), it ignores ours
and patch-bumps npm, so it never accidentally goes backwards.

## Why this is small and safe

This is one decision, moved out of buried workflow scripting into a tiny
testable file with nine tests — including one that replays the exact numbers
from the 2026-05-19 incident and proves the robot now produces 1.0.0 instead
of 0.28.125. Normal patch releases behave exactly as before. The only new
capability is: we can now deliberately ship a major version when we mean to.

## What this is not

This is not the full lockdown project (the release-tier switch, the
two-signature requirement, the major-work branch isolation). Those are being
designed separately. This is just the one prerequisite without which a real
v1.0.0 release is impossible.
