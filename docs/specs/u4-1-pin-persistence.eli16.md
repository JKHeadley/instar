# Pin Persistence — Plain-English Overview

> The one-line version: when you deliberately say "run this conversation on the Mac Mini," that choice must survive restarts, handoffs, and network hiccups — and it turns out the machinery to remember it already exists but was shipped switched-off and had four real bugs; this work switches it on properly and fixes the bugs, instead of building a duplicate.

## The problem in one breath

You pin a conversation to a machine, and later find it drifted somewhere else with no explanation. That's the mesh forgetting a choice you explicitly made — the exact opposite of "you never have to think about which machine answers."

## The surprise the review found

The first draft of this spec proposed building a durable, replicated pin system. Nine reviewers (including two outside AI models) ground it against the real code and found that system ALREADY EXISTS — a durable pin file, a replicated copy, and a background reconciler that moves topics to match pins. It just ships dark (turned off), which is precisely the "a dark feature guards nothing" failure written into the constitution after the July 1st incident. So the spec was rewritten from "build it" to "turn it on safely and fix what's actually broken in it."

## What's actually broken, in plain terms

1. **It's off.** The whole pin-replication and pin-enforcement layer is dark or dry-run on every machine.
2. **Un-pinning doesn't stick.** The "remove pin" tombstone was never wired up, so if you unpin a topic, a stale replicated copy of the old pin can quietly re-pin it later. That's a live bug today.
3. **A corrupted pin file silently erases every pin** and then saves the empty state — your choices vanish with no notice.
4. **The replication channel can drop pins** because old records rotate away and readers only look at a recent window.
5. **Nobody verifies the result.** The system records where a topic SHOULD be but never checks where it actually IS — so "pinned" can be a comforting label on a wrong reality.

## What this work does

Turns the existing machinery on through a staged rollout (with the new load-bearing-guard alarm from this week watching so it can't quietly stall half-on), wires the unpin tombstone, makes a corrupt pin file quarantine loudly instead of wiping, makes the replication channel keep every pin record, adds a real "did the topic actually land there?" check to the placement view, and adds honest handling for pinning to a machine that's currently offline (the topic waits as "pending," moves only after the machine has been back and stable for a while, and an old stuck pin asks you once what to do rather than sitting forever or moving things by surprise).

Two deliberate non-changes: a pin still beats a rate-limit (your explicit choice outranks a transient quota signal — that's today's behavior, kept), and who-set-the-pin is recorded only on the machine where it happened, never copied around (keeping people-data off other disks).

## Open questions

None — the operator pre-approved this project's decisions (topic 29836). Every contested point is resolved in the spec: no parallel pin system gets built (the existing one is graduated and hardened), conflicts between machines are settled by the skew-proof ordering the code already uses (never wall-clock), un-pinning wins over stale copies, pins to offline machines wait honestly with a bounded escalation instead of forever, and timing windows are configuration defaults borrowed from the reconciler that already exists.
