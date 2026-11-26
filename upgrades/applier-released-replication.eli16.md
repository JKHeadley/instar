# A released conversation replicates as released — Plain-English Overview

> The one-line version: when one of my machines lets go of a conversation, the other machines now learn that it was let go — instead of learning that the machine still owns it.

## The problem in one breath

Every conversation (a Telegram topic) is "owned" by exactly one of my machines, and every change of ownership is written to a shared journal so the other machines keep the same picture. When a machine finished with a conversation it wrote "released" to that journal — but the journal line didn't carry the word *released* in the field the other machines actually read. They read the line as "this machine now owns it, at a newer version number". So the moment the Mac Mini let go of the conversation with Justin, the Mac Studio's picture flipped to "the Mini owns it" and stayed there. The pin that said "serve this topic from the Studio" could never take effect, because the Studio believed a live owner existed and politely waited for it. The Mini — a standby that is not allowed to send — kept starting sessions for a topic it could not answer in, and the conversation went silent over and over.

## What already exists

- **Ownership records** — each machine keeps a small file per conversation saying who owns it and at which version (epoch). A record can be *active*, *transferring*, or *released*.
- **The coherence journal** — an append-only log each machine writes and the others copy, so ownership changes travel across the pool.
- **The ownership applier** — the part on each machine that reads the journal and updates the local ownership files. It only ever moves a record forward (a newer version wins; an older one is ignored).
- **The ownership reconciler** — the part that notices "this topic is pinned to me but somebody else owns it" and decides whether to adopt it, transfer it, or wait.

## What this adds

The journal line for a release now says it is a release (an explicit `status: released`), the applier turns such a line into a *released* local record instead of an *active* one, and the two receive-side validators accept that new value instead of throwing the whole line away. Lines from a machine that hasn't updated yet still only carry `reason: released`, and the applier treats that as a release too.

The already-wrong records get repaired as well. The applier only ever moves a record forward to a newer version, so a record it had already written as "active, version 3" could never be touched by the same "released, version 3" line again — and a released conversation produces no newer line. So the applier now has one narrow repair: when the local record is *its own* earlier write of that exact line (it signs its writes, so it can tell), and that line is really a release, it flips the status to released. It never rewrites a record one of the machines decided on itself.

Every place that writes a release to the journal now says so: the shared funnel in the server, the reconciler's writer, and the "move this conversation" route (which wrote to the journal directly and had been missed).

## The safeguards

**Only moves forward.** The release still has to carry a newer version number than the local record to land. A stale release can never undo a fresher claim another machine already made.

**Nothing is deleted.** A released record stays on disk with its version number; it just says "no live owner". The next message, or the pin target's reconciler, re-places the topic through the normal place-and-claim path.

**Older machines still cope.** A machine that hasn't updated yet keeps accepting the old-shaped line (reason only). It will still mis-read it as active, exactly as today — no worse than before, and it fixes itself when that machine updates.

**Transfers are untouched.** The in-flight "transferring" state is matched before the active default, exactly as before; the release branch is checked first and only fires on a real release.

## What ships when

One patch release. It is pure code with no config flag, because the old behavior was simply wrong — there is no situation where "a release should look like active ownership" is desired.

## What you actually need to decide

Nothing to configure. The visible result: a topic you pin to one machine actually moves there once its previous owner lets go, and a machine that cannot send no longer keeps a conversation hostage.
