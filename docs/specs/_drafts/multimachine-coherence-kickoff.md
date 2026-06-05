# Multi-Machine Coherence Initiative — kickoff capture (2026-06-05)

> Source: Justin, topic 13481 (instar-exo), 2026-06-05 ~12:21 PDT. Option A
> (census-first) approved same day ~13:18 PDT: "I agree with everything you
> said I approve please proceed."

## The problem in one sentence

Everything multi-machine shipped so far makes machines TAKE TURNS correctly
(fenced lease, placement/pin/transfer, post-move closeout, exactly-once
ingress, quota-aware placement); none of it makes them KNOW THE SAME THINGS —
the agent's mind (working files, commitments, threadline conversations,
cross-topic awareness, learnings) is machine-local.

## Specimen failure (Justin's example)

EXO topic-19437 gap analysis ran overnight on the Mini; the gap matrix lives
in the Mini's machine-local autonomous session state. No consolidated artifact
in the repo; the Laptop cannot see it. "Fittingly, that's the very
project-sync incoherence this topic flagged via instar.sh, biting our own
workstream."

## Justin's requirements (captured near-verbatim)

- VERY ROBUST sync mechanisms: leverage both Git AND robust
  inner-communication channels for immediate data/information transfer.
- Evidence-driven gap-filling: if one machine notices state is missing with
  evidence (user behavior or otherwise), it needs an extremely efficient way
  to check in with other machines to fill the gap.
- Critical metadata kept up to date by ALL machines: recent activity history,
  e.g. a history of what machine a topic has been linked to and when. Goal:
  an efficient audit dataset enabling machines to coordinate, investigate,
  diagnose — maintaining syncing/coherence as a shared goal.
- Threadline communication awareness: which machines hold threadline
  conversations? Linked to topics? What happens when those topics swap
  machines? Can a threadline conversation swap machines? Global awareness of
  conversations across machines.
- Cross-topic awareness: current infra exists single-machine — is it robust
  across machines?
- General: systems built for "whole agent awareness/coherence" within a
  single machine must now evolve to multi-machine coherence.
- Approach: HUGE undertaking — take it on carefully, leverage projects
  infra, start small, identify core infrastructure, iterate, plan as much as
  possible while expecting to learn as we go.

## Approved approach — four primitives, in dependency order

1. **STATE CENSUS** → a living State-Coherence Registry: every durable state
   category classified by scope (machine-local-by-design / must-be-coherent /
   derived-cache), freshness need (real-time / eventual / session-boundary),
   conflict shape (single-writer / append-only-mergeable / LWW), transport
   (git vs peer-HTTP). Machine-readable so the sync layer enforces it.
2. **COHERENCE JOURNAL** — per-machine append-only streams of coherence
   events (topic placed/moved + why, session opened/closed, threadline convo
   started/bound, autonomous run started/ended + artifact paths, commitment
   mutations). Peers replicate each other's streams over machine-auth HTTP;
   per-machine single-writer streams = zero merge conflicts.
3. **GAP-CHECK (anti-entropy)** — cheap digests per stream (seq numbers /
   hashes); evidence-driven and background-cadence delta fetch.
4. **TRANSPORT SPLIT** — git for durable/bulky/versioned artifacts; peer-HTTP
   channel for hot metadata. Threadline stays agent-to-agent; machine-to-
   machine inside one agent rides machine-auth.

## Phasing

- **P0** Census + master spec (this round's deliverable)
- **P1** Coherence journal + topic↔machine placement history + read API
- **P2** Working-set handoff: topic moves → new machine pulls its working files
- **P3** Threadline global registry + machine-swap semantics
- **P4** Cross-topic awareness extended pool-wide

## "Coherent under degradation" evidence (same-day incident, 2026-06-05)

The very delivery of the strategy became a specimen: laptop CPU-starved
(load 30-40, five agent servers + 598 claude procs), echo's server event loop
alive but HTTP starved; supervisor force-restart ceiling bounced the server 6×
in 75 min; outbound (1/2) got HTTP 200 then was lost when the server restarted
before posting to Telegram; recovery-queue delivery won the boot-window race
for (2/2) but lost it 4× for (1/2) (delivered by manual Bot-API fallback);
inbound re-delivered the same user message 3× across restart boundaries.
Structural fixes filed for the initiative: ack-after-durable-commit on
outbound, load-aware supervisor restart backoff, lifeline-direct outbound
fallback path.

## Prior art to generalize from

Cross-machine secret sync (the ONE truly-replicating state category today),
capacity/presence heartbeats, standby lease-holder sync, exactly-once ingress
ledger, machineauth shared sequence, dashboard pool-wide sessions.
