# Inbound-Queue Boot-Order Fix — Plain-English Overview

> The one-line version: a startup-ordering bug meant the durable inbound-message queue could never actually turn on, so this fixes the one line that always answered "stay off" when the queue should have started.

## The problem in one breath

The agent has a "durable inbound message queue" — a small crash-proof on-disk holding area for
messages that can't be delivered the instant they arrive (because the conversation is mid-move
between two of your machines, or the machine that owns it is briefly wobbly). It is supposed to
catch those messages so none get dropped. The problem: it never actually started. Even with the
right settings turned on, the part of startup that builds the queue's engine asked a question —
"is the machine pool active?" — through a switch that hadn't been wired up yet at that exact moment,
so the answer was always "no, it's off (dark)." The engine therefore never got built, and the page
that reports on the queue (`/pool/queue`) returned "not available" forever.

## What already exists

- **The durable inbound queue** — the full engine, the crash-proof storage, the drain loop, the
  loss-notices, and the `/pool/queue` status page were all built and shipped already. The feature
  ships OFF by default (and in "dry-run" even when on), so nobody on the fleet ever hit this — it
  only bites the first person who tries to turn it on for real.
- **The session pool "stage" switch** — a small function (`_sessionPoolStage()`) that reports the
  multi-machine pool's rollout stage: "dark" (off) or a named live stage. Lots of code consults it
  to decide whether to do multi-machine things.

## What this fixes

During startup, the code that builds the queue engine runs *before* that stage switch gets wired
to its real implementation. Until it's wired, the switch is a placeholder that always says "dark."
So the build step read "dark," concluded the pool was off, and skipped building the queue — every
single boot, no matter what the settings said. The fix: at the build step, don't ask the
not-yet-wired switch. Instead read the same setting directly from config right there, inline, the
exact same way the real switch reads it later. Now the build step gets the true answer and the
engine constructs when it should.

## The new piece

- **`resolveSessionPoolStage(cfg)`** — a tiny shared helper that takes the pool's config block and
  returns its stage ("dark" unless the pool is both enabled and carries a stage). Both the
  early build-step (now) and the real switch (later) call this one helper, so they can never again
  drift apart and disagree — which is the root cause class of this whole bug. It's pure logic with
  no side effects, so it's directly and exhaustively unit-tested.

## The safeguards

**Fails toward OFF, never toward a half-on queue.** If reading the config ever throws, the inline
resolution returns "dark" — the queue simply doesn't build this boot, which is byte-for-byte the
shipped default. The safe direction is "no queue," and that's the direction every error path takes.

**No new authority, no new config, no new route.** This only changes *when* an existing decision is
read. It does not add a setting, change a default, add an endpoint, or grant any new capability.
The queue still only runs where it was always meant to: enabled + a non-dark pool stage + not
dry-run + the existing config invariants all satisfied.

**The whole rest of the startup flow is untouched.** The placeholder switch is deliberately left in
place — other code (the live message-routing handlers) legitimately closes over it and sees the
real wired version when those handlers run later, after boot. Only the one synchronous build-time
read was wrong, and only that read is changed.

## Who is affected

- **The fleet: no-op.** The inbound queue ships disabled by default, so nothing changes for any
  agent that hasn't deliberately turned it on.
- **An agent that enabled it (e.g. Echo, under the "no dark features on the dev agent" directive):**
  the queue engine will now actually construct, and `/pool/queue` will answer 200 instead of 503.
  This is the intended activation — the bug was hiding the feature from the very agent meant to
  exercise it first.

## How we proved it

The bug was precisely "the engine is null when it should be live." So the proof is a test that
checks the build-step no longer consults the not-yet-wired switch and instead resolves the stage
inline — it fails against the old code and passes against the fix. A second focused test checks the
new shared helper returns the right answer on both sides of the decision (enabled + stage → the
stage; disabled or missing stage → dark). The existing route and lifecycle tests already prove that
a constructed engine serves a real 200 on `/pool/queue`.

## Open questions

- **None blocking.** This is a behavior-correctness fix restoring intended behavior; there is no
  design choice left open for the operator to make. The only judgment call was inline-read vs.
  hoisting the wiring block — resolved in favor of the lower-risk inline read plus a shared helper
  so the two readers can't drift again. If a future change wants the queue genuinely live (not
  dry-run) on a real multi-machine setup, that is a separate, deliberate config flip, not part of
  this fix.
