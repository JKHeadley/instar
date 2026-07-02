# Pin Persistence — Plain-English Overview

> The one-line version: when you deliberately say "run this conversation on the
> Mac Mini," that choice must survive restarts, captain handoffs, and network
> hiccups — and it turns out the machinery to remember it already exists but ships
> switched off and has seven real defects; this work turns it on properly and fixes
> every one of them, instead of building a duplicate.

## The problem in one breath

You pin a conversation to a machine, and later find it drifted somewhere else with
no explanation — or your *un*-pin quietly comes back from the dead. That's the mesh
forgetting a choice you explicitly made, the exact opposite of "you never have to
think about which machine answers."

## What three rounds of review did to the design (the honest story)

**Round 1 — the system already exists.** The first draft proposed building a
durable, replicated pin system. Grounding against the real code showed all of it
ALREADY EXISTS — a durable pin file, a replicated copy, and a background reconciler
that moves topics to match pins. It just ships dark (off), which is precisely the
"a dark feature guards nothing" failure named in the constitution after the July 1st
incident. The spec became "graduate and harden what's there," and the seven-defect
list below is what grounding actually found.

**Round 2 — three catches that changed the design.** (1) *Clock-skew poisoning:*
records are ordered by a skew-tolerant logical clock, and a record stamped with a
future-dated time would beat every honest "unpin" forever — and once the channel
keeps all records (the storage fix), that poisoned record would be retained
immortally. The defense already existed in the clock code, unwired; the spec now
wires it. (2) *The 500-entry read window:* the journal reader hard-caps every read
at the newest 500 entries, so fixing storage alone would just move the "old pin
falls out of view" bug months into the future — the read was redesigned as a
boot-time fold over EVERY retained record (own machine's and every peer's), kept
current afterwards by cheap byte-offset tail reads. (3) *The silent churn loop:*
a pin naming an offline machine made the reconciler start a transfer, time out,
and retry — every ~2.5 minutes, forever, with no signal. Now an offline target
simply yields an honest "pending" state and, if it ages out, one question to you.
Round 2 also caught that the standard update process would silently undo an
operator's rollback of this feature (fixed in the graduation plan), and added a
required live proof through your real Telegram before anyone calls it done.

**Round 3 — three more, on the round-2 fixes themselves.** (1) Rejecting a
misclocked record at the door where records arrive would have wedged that peer's
ENTIRE pin stream (the arrival pipeline halts a stream on any per-record refusal) —
so skewed records are accepted onto disk but excluded where pins are computed.
(2) The skew exclusion had to become a *durable quarantine*: the clock check is
relative to wall time, so a future-dated record would silently un-quarantine once
real time caught up and then resurrect itself over your unpin. The offending record
is now remembered on disk and stays excluded regardless of clock progress, until
you acknowledge it or a newer honest record supersedes it. (3) The round-2 claim
that the fold stays small via "compaction" was false — no such mechanism exists;
the honest bound is total retained bytes (small, because pins are rare human
actions), backstopped by a byte-guard that truncates LOUDLY, never silently.

## What this adds, concretely

- The pin layer graduates through a staged rollout, registered as load-bearing so
  a stalled half-on state raises an alarm instead of sitting quiet.
- Un-pinning finally sticks: every unpin writes a dated "this pin is gone" record
  that stale copies can never override.
- A corrupted pin file is quarantined with one notice — never silently wiped and
  re-saved as empty.
- The placement view now reports verified reality, not intent: pinned-and-actually
  -there, pending, or diverged (which raises one deduped question if it persists).
- Pinning to an offline machine waits honestly as "pending," moves only after the
  machine has been back and stable for a couple of minutes, and an old stuck pin
  asks you once rather than sitting forever or moving things by surprise.
- Who set a pin is recorded only on the machine where it happened — never copied
  to other disks.

## The safeguards

Moves are paced (a captain flap can never trigger a transfer storm); a stale
captain's actions are fenced out; every alarm is one deduped item per episode, not
a stream; a pin still beats a rate-limit signal (your explicit choice outranks a
transient quota reading — today's behavior, deliberately kept); and a topic with
live autonomous work is never yanked to satisfy a pin.

## What you actually need to decide

Nothing — you pre-approved this project's decisions (topic 29836), and the spec
ends with zero open questions. Approval of the converged spec is the only step.

*(Build note, 2026-07-02: the two named follow-ups — per-key rewrite-compaction
at rotation if pin volume ever nears the fold byte-guard, and the Tier-4
live-user-channel matrix that gates the dryRun-exit/fleet graduation — are
tracked as commitment CMT-1875, so they re-surface on cadence instead of
relying on memory.)*
