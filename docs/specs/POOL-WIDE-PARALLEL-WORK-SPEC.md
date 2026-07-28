---
title: "Pool-Wide Parallel-Work Awareness — what ALL my hands are doing on ALL my machines (P4 of multi-machine coherence)"
slug: "pool-wide-parallel-work"
author: "echo"
eli16-overview: "POOL-WIDE-PARALLEL-WORK-SPEC.eli16.md"
status: "converged-approved"
approved: true
approved-by: "justin (standing directive)"
approved-evidence: "Topic 13481, 2026-06-06 ~03:05 PDT standing 24h directive. ELI16 sent to topic 13481 at approval."
layer: "core-instar-primitive"
parent-principle: "Structure beats Willpower — overlap with work running on another machine is visible by machinery, not by remembering to ask each machine"
parent-spec: "MULTI-MACHINE-COHERENCE-MASTER-SPEC.md"
project: "multimachine-coherence"
project-items: "P4.1 pool-wide-cross-topic-awareness"
supervision: "tier0 — a read-side merge over already-replicated journal streams; no policy decisions. Justified per LLM-Supervised Execution."
lessons-engaged: >
  P19 (zero new loops, zero new stores, zero new verbs — P4 is a READ
  composition over P1's replicas under the P1 reader's existing bounds);
  Signal vs Authority (the pool-wide view never actuates; it answers the
  overlap question); Near-Silent Notifications (no push surface — the
  ParallelWorkSentinel Phase-B extension stays dark and out of scope);
  Honest absence (remote intent TEXT is machine-local by design — the view
  names what it cannot see rather than fabricating).
inherited-invariants: >
  Inherits P1 (COHERENCE-JOURNAL-SPEC), P2 (WORKING-SET-HANDOFF-SPEC), and
  P1.5 (COMMITMENTS-COHERENCE-SPEC) invariants by reference: bounded reads
  with partial-result honesty; replicas are SIGNAL never actuation
  authority; staleness carried in the wording; composite identity where
  ids are per-machine. Reviewers: treat violations as material without
  re-deriving them.
review-convergence: "2026-06-06T13:47:05.228Z"
review-iterations: 2
review-completed-at: "2026-06-06T13:47:05.228Z"
review-report: "docs/specs/reports/pool-wide-parallel-work-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
---

# Pool-Wide Parallel-Work Awareness (P4)

> **One sentence:** `GET /parallel-work/activities?scope=pool` answers
> "what is every machine of mine working on right now, and is anything
> overlapping?" by composing the LOCAL parallel-work index with the
> journal replicas P1 already ships — zero new stores, zero new verbs,
> zero new loops.

## 1. Motivation (master spec P4 row)

The Parallel-Work Awareness index (`GET /parallel-work/activities`) is the
antidote to self-blindness — but it reads only THIS machine's topic-intent
store. On a multi-machine agent the king sees half his council: a topic
running on the Mini is invisible to the Laptop's overlap check (the
duplicate-work shape the 2026-06-05 parallel-session protocol memory
records on the SESSION level, recurring at the MACHINE level). P1's
journal already replicates exactly the evidence needed — placement
(where every topic lives), session-lifecycle (what's running), and
autonomous-run (what each machine's runs produced) — first-hop, bounded,
staleness-tagged. P4 is the read that composes it.

## 2. Scope

**In (P4.1, deliberately the smallest phase):**
- `?scope=pool` on the EXISTING `GET /parallel-work/activities` route
  (backed by ParallelActivityIndex over TopicIntentStore — round-1
  grounding). The pool response is a DISCRIMINATED union — every row
  carries `kind: 'local' | 'remote'`:
  - LOCAL rows = today's shape ({ topicId, focus, tags, refCount,
    updatedAt, nickname, running }) PLUS `kind:'local'`,
    `machineId: <self>`, `stalenessMs: 0`, `intentVisibility: 'local'`.
  - REMOTE rows = `{ kind:'remote', topicId, machineId, running,
    lastEventAt, lastEventKind, stalenessMs, artifactsKnown,
    focus: null, tags: [], refCount: null, updatedAt: null,
    nickname: null, intentVisibility: 'machine-local' }` — absent local
    fields are NAMED nulls, never fabricated.
  - **`running` provenance asymmetry (stated):** a LOCAL `running` is
    enriched from the live in-memory session list (point-in-time
    accurate); a REMOTE `running` is replica-derived (eventually
    consistent, staleness-tagged). Same field, two trust levels — the
    `kind` discriminator + stalenessMs carry the difference, and any
    user-facing rendering of a remote running quotes its staleness.
- A `possibleOverlap` soft signal on EVERY pair of machines showing the
  same topicId running (local↔remote AND remote↔remote — codex round-2:
  the local-only pairing would miss two peers double-running a topic
  this machine merely observes) — flagged, never acted on. **Known benign
  transient (round-1):** EVERY legitimate transfer produces this shape
  for up to ~2 reaper ticks (the documented post-transfer closeout
  window) plus replication lag. The fold therefore checks the
  answer-complete topic-placement stream for a recent epoch change on
  that topic and annotates the flag `recentMove: true` when one exists
  within the closeout window — the signal distinguishes "routine move
  settling" from "genuinely stuck double-active" instead of crying wolf
  on every move.

**Out (explicitly):**
- Replicating topic-intent content (focus/tags text) — a new sync channel
  for derived, fast-changing text; revisit only if the running-state view
  proves insufficient in practice. Registered as its OWN follow-on item
  (P4.2 row in the project plan's Tier 5 table — round-1 caught this
  deferral mis-filed under the P3 machine-swap marker, a different
  concern entirely)
  <!-- tracked: multimachine-coherence-p4-intent-text-replication -->.
- The ParallelWorkSentinel Phase-B proactive councilor (ships dark; its
  pool-wide upgrade rides this read when it graduates — no sentinel
  changes here).
- Any new mesh verb, store, or timer.

## 3. Design

One new pure function + one route extension:

- `derivePoolActivities(reader, opts)` — NET-NEW code on the reader's raw
  `query()` path (round-1 grounding: `readOwnAutonomousRuns` is
  own-stream-only by construction and there is NO existing lifecycle
  helper — nothing here reuses it; peer machines are discovered from the
  reader's own streams map, not an injected list). For each replica
  machine, fold its session-lifecycle + autonomous-run streams — newest
  entries per topic under the P1 reader's existing byte/archive bounds —
  into remote rows. `running` is derived PER INSTANCE then aggregated
  (codex round-2): fold lifecycle entries per `sessionId` and
  autonomous-run entries per `runId` — an instance is active when its
  newest entry is non-terminal (`created` / `started`) — and the topic's
  `running` = ANY active instance (a later terminal for session B never
  masks a still-running session A). `stalenessMs` = the replica
  stream's staleness.
- **Gapped-replica honesty (round-1, the P3 lesson applied):** staleness
  measures recency, NOT completeness — a fresh-but-gapped replica whose
  terminal entry scrolled past a read bound would derive a false
  `running: true`. Therefore (a) a `running:true` derived from a fold
  that hit a read bound carries `lowConfidence: true` (the bound-hit
  flag connected to the derivation, available TODAY), and (b) the full
  `streamStatus` qualifier (`gapped`/`suspect` per stream) DEPENDS ON
  the P1.3 reader states — named dependency: until the reader surfaces
  them (it hardcodes 'current' in P1.2), gapped streams are
  undetectable and `lowConfidence` is the only honest signal. The §6
  tests cover the bound-hit path now; the streamStatus column lands
  with the P1.3 reader work.
- The route: `?scope=pool` composes local + remote; default scope stays
  byte-identical. Replica layer dark/absent → remote rows simply absent
  (200 with local rows) under a
  `pool: { selfMachineId, replicasRead, boundHit }` honesty header.
  NOTE vs the GET /sessions?scope=pool precedent (whose header is
  `{ peersQueried, peersOk, failed }`): that route FANS OUT live HTTP to
  peers; P4 reads LOCAL replica files — no fan-out, no peer-reachability
  dependency, an offline peer's last-replicated streams still answer.
  The pre-existing 503 when the parallel-activity index itself is absent
  is unchanged and orthogonal.
- **Signal vs Authority:** the view never gates, never moves, never
  kills. `possibleOverlap` is a flag the agent may mention.

## 4. Degradation requirements

1. A replica read failure degrades to local-only rows + the honesty
   header — never a 5xx for the pool scope.
2. Bounded: the fold runs under the P1 reader's per-query ceilings;
   over-bound → rows carry the partial-result flag.
3. Mixed-version: peers without replicated streams contribute nothing
   (absence, never fabrication).

## 5. Security

No new transport, no new disclosure: the composed data (placement,
lifecycle, run metadata) already replicates under P1's posture and the
P3 social-graph honesty note covers the only metadata-aggregation
concern (topics, not counterparties — strictly less sensitive). The
route is Bearer-gated like its existing base.

## 6. Testing

- **Unit:** the fold (running derivation both kinds, per-machine; named
  intent absence; staleness threading; possibleOverlap on shared
  topicId; partial-result flag propagation).
- **Integration:** the route over real own + replica stream files
  (?scope=pool composes; default byte-identical; dark → local-only 200).
- **E2E (feature-alive):** production-shaped boot answers 200 on
  ?scope=pool with replicas present (and without).
- **Wiring-integrity:** the route reads through the REAL
  CoherenceJournalReader (observed via stream fixtures).

## 7. Work breakdown

1. **P4.1** the fold + route extension + all-tier tests + live
   two-machine verify on the echo pair (start a quiet run on the Mini,
   ask the Laptop's pool view; show the Mini's row with running:true +
   staleness; stop it; show the row turn).

## 8. Open questions for Justin

None — P4 composes already-approved, already-replicated data through an
existing route with explicit honesty about what stays machine-local.
