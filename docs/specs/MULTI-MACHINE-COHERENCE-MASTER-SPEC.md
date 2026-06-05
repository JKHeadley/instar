---
title: "Multi-Machine Coherence — Master Plan (single coherent agent)"
slug: "multi-machine-coherence-master"
author: "echo"
eli16-overview: "MULTI-MACHINE-COHERENCE-MASTER-SPEC.eli16.md"
status: "draft"
layer: "core-instar-primitive"
parent-principle: "Structure > Willpower — coherence is enforced by a declared registry and structural sync machinery, never by per-feature discipline"
principal-signoff: "pending — P0 deliverable for Justin's review (Option A census-first approved 2026-06-05, topic 13481)"
project: "multimachine-coherence"
---

# Multi-Machine Coherence — Master Plan

> **One sentence:** everything multi-machine shipped so far makes my machines
> *take turns correctly*; this initiative makes them *know the same things* —
> by declaring every category of durable state in one registry and giving the
> mesh a journal, a gap-check reflex, and a deliberate transport split.

## 1. Motivation

A multi-machine agent is ONE agent. The user experiences a single "me" across
a laptop and a mini — and the infrastructure for *turn-taking* now holds up:
the fenced lease decides who serves, the session pool places and transfers
topics, post-transfer closeout kills duplicate sessions, the exactly-once
ingress ledger stops double-replies, quota-aware placement avoids rate-limited
machines.

What does NOT hold up is *shared knowledge*. The specimen (Justin, 2026-06-05,
topic 13481): an overnight workstream produced a gap analysis on the Mini —
and the result was stranded in the Mini's machine-local autonomous session
files. The Laptop, serving the same topic the next morning, could not see it.
Nothing failed; every machine behaved as designed; the *agent* still lost its
own work product. The agent's mind — working files, commitments, threadline
conversations, cross-topic awareness, learnings — is machine-local today.

Full requirements capture from Justin's directive:
`docs/specs/_drafts/multimachine-coherence-kickoff.md`. The directive's core:

- VERY ROBUST sync, leveraging both git AND inner-communication channels.
- Evidence-driven gap-filling: a machine that *notices* state should exist
  (from user behavior or otherwise) must have an extremely efficient way to
  check with peers and fill the gap.
- Critical metadata maintained by ALL machines — e.g. the history of which
  machine a topic was linked to and when — as an efficient audit substrate
  for coordination, investigation, and diagnosis.
- Threadline awareness across machines; cross-topic awareness across machines.
- Start small, identify core infrastructure, iterate; plan while expecting to
  learn.

## 2. Scope

**This spec is the umbrella architecture** for phases P0–P4 of the
`multimachine-coherence` project. It defines the four primitives, their
dependency order, and the requirements every phase inherits. Each phase still
gets its own focused spec before building (per-round pipeline).

**Non-goals.** No redesign of the fenced lease, the session pool, or the
seamlessness channel guarantees — those are prior art this builds ON (§4). No
attempt to make *all* state coherent: the registry exists precisely so that
machine-local-by-design state (resource samples, per-boot ids, nonce
watermarks) is *declared* local instead of accidentally local.

## 3. Definitions — the classification axes

Every durable state category is classified on four axes. These axes ARE the
schema of the State-Coherence Registry (P0):

| Axis | Values | Question it answers |
|------|--------|---------------------|
| **Coherence class** | `must-be-coherent` \| `machine-local-by-design` \| `derived-cache` | Should every machine see the same thing? |
| **Freshness need** | `realtime` (seconds) \| `eventual` (minutes) \| `session-boundary` \| `archival` | How stale may a peer's copy be before it lies? |
| **Conflict shape** | `single-writer` (lease/ownership-fenced) \| `append-only-mergeable` (per-machine streams) \| `last-writer-wins` \| `crdt-ish` (set-union) | What happens when two machines write? |
| **Transport class** | `git-coarse` \| `peer-hot` (machine-auth HTTP/MeshRpc) \| `encrypted-secret` (X25519-sealed) \| `none` (declared local) | Which channel carries it? |

A category's transport is *derived from* its other three axes — that derivation
rule, applied uniformly, is what replaces today's per-feature ad-hoc choices.

## 4. Prior art — what exists, and what each piece teaches

| Existing piece | What it solved | What it teaches this initiative |
|----------------|----------------|--------------------------------|
| **Fenced lease + machineAuth + MeshRpc** (Ed25519 envelopes, recipient-bound, nonce/sequence replay-proof, registered-peer RBAC) | Authenticated machine-to-machine commands | The journal replication verb rides THIS — no new transport, no new auth |
| **CROSS-MACHINE-SEAMLESSNESS spec** (message ledger, live-tail, dual-medium markers, handoff sentinel) | Coherence for ONE domain: the conversation channel | The ephemeral/durable transport split and "hard vs best-effort" guarantee discipline generalize to every category |
| **Cross-machine secret sync** (push-on-provision, X25519→AES-GCM per-recipient, receive-only default) | The FIRST truly-replicating state category | The prototype: enumerate → seal → push → idempotent overwrite; and the anti-clobber lesson (a stale machine must not push) |
| **Session pool + placement/transfer + closeout** | WHERE a topic runs | Placement *events* are the first journal consumers (topic↔machine history) |
| **Standby pool-session writes** (sessionScoped guard exception) | Read-only standby vs pool ownership collision | Coherence writes need the same surgical guard-scoping — never blanket-weaken the standby guard |
| **GitSyncManager + RegistrySyncDebouncer** | Coarse git path for some categories (config, users, soul, project map) | Git is the durable/bulky path — but **SourceTreeGuard refuses GitSyncManager on agent homes that are instar checkouts** (the dev agents!), so git can NEVER be the only medium for a must-be-coherent category |
| **Exactly-once ingress ledger** (SQLite, dedupeKey lifecycle) | No double-acting on inbound | Local-immediate durability + bounded cross-machine propagation is the right durability split |

## 5. The four primitives

### P0 — State-Coherence Registry (the census)

A **living, machine-readable registry** of every durable state category:
`docs/specs/STATE-COHERENCE-REGISTRY.md` (human form, the census deliverable)
plus `src/data/state-coherence-registry.json` (machine form, added when the
first consumer lands in P1 — the doc is authoritative until then).

Each entry: name, owning module, on-disk location pattern, write pattern,
readers, the four §3 classifications, current sync mechanism (mostly `none`),
target sync mechanism, and migration notes. The 2026-06-05 census found
**~100 categories**; roughly a dozen are `must-be-coherent` with NO sync today
(commitments, attention items, topic-project bindings, relationships, message
threads, autonomous working artifacts, threadline conversation state among
them) — the registry's classified inventory is the initiative's work-list,
priority-ordered.

**Structural enforcement (Structure > Willpower):** once the machine-readable
form exists, a CI lint walks the source for durable-write patterns
(`writeFileSync`/JSONL appends/SQLite opens under state dirs) and FAILS when a
store is not declared in the registry. New state cannot be silently
machine-local again — a feature author must *declare* the coherence class at
birth. (Pattern proven by the no-unfunneled-topic-creation lint.)

### P1 — Coherence Journal (the audit metadata layer)

Per-machine, **append-only** streams of coherence *events* — the durable
answer to "what happened where, and when":

- `topic-placement` — topic N placed/pinned/transferred to machine M, reason
  (the literal example in Justin's directive)
- `session-lifecycle` — session opened/closed/reaped for topic N on machine M
- `autonomous-run` — run started/ended on machine M for topic N, **artifact
  paths** it wrote (the EXO-gap fix's foundation: the Laptop can *know* the
  Mini holds `19437.local.md` work product)
- `threadline-conversation` — conversation started/bound-to-topic/closed,
  which machine holds it (P3's foundation)
- `commitment-mutation` — commitment opened/delivered/violated (id + status
  only, not content)
- `state-write` — coarse "category X advanced to digest D" markers feeding P2

**Write rules:** each machine writes ONLY its own stream
(`state/coherence-journal/<machineId>.jsonl`), strictly-monotonic per-stream
sequence numbers. Single-writer-per-stream means replication is trivially
conflict-free — the per-entry-audit lesson (PR #827: shared JSONL = parallel-PR
conflicts; per-writer files = none) applied to runtime.

**Replication:** a new MeshRpc verb (`journal-sync`) — peers exchange
`{machineId → lastSeq}` watermarks and ship deltas. Authenticated by the
existing envelope; no new trust surface. Replicated copies land read-only
under `state/coherence-journal/peers/`.

**Read surface:** `GET /coherence/journal?topic=N&kind=topic-placement` —
unified view over own + replicated streams. The dashboard and the agent's own
diagnosis ("where did this topic live last Tuesday?") read THIS instead of
inferring.

### P2 — Gap-Check (anti-entropy + working-set handoff)

The "I should have state I don't have" reflex, two triggers:

- **Background cadence:** peers exchange per-stream watermarks + per-category
  digests (cheap: sequence numbers and content hashes, never full scans) and
  fetch deltas. Piggybacks on the existing capacity-heartbeat cadence.
- **Evidence-driven:** when the agent (or a sentinel) notices a reference to
  state it cannot find — the user names work product that isn't on this
  machine — it consults the journal (which machine produced artifacts for this
  topic?) and issues a targeted fetch. This is the EXO failure, mechanized.

**Working-set handoff (the headline consumer):** when a topic transfers, the
receiving machine pulls the topic's declared working set — autonomous
`<topicId>.local.md` files and journal-declared artifact paths — from the
prior owner over the peer channel (or reads them from git where the artifact
is committed). Transfer stops meaning "you get the conversation but lose the
workspace."

### P3 — Transport split (formalized, registry-driven)

The assignment rule, derived from §3 classifications:

| Category profile | Transport |
|------------------|-----------|
| Bulky, durable, versionable (specs, committed artifacts, working files at rest) | **git-coarse** (debounced, meaningful transitions only) |
| Hot metadata (journal deltas, digests, watermarks, placement state) | **peer-hot** — machine-auth HTTP/MeshRpc, the lease's low-latency medium |
| Anything secret-bearing | **encrypted-secret** — the secret-sync channel (X25519-sealed per recipient), never the journal in plaintext |
| Declared machine-local | **none** — and the registry says so out loud |

Two hard rules earned from prior art: (1) git is never the ONLY medium for a
must-be-coherent category (SourceTreeGuard makes git unavailable exactly on
dev-agent homes); (2) a stale machine must never bulk-push (secret-sync's
receive-only default generalizes: gap-check *pulls* by default; pushes are
watermark-gated).

**Boundary:** Threadline is agent-to-agent; machine-to-machine inside ONE
agent rides machineAuth. A threadline conversation's *coherence record* (which
machine holds it) is journal data; the conversation content itself stays in
its existing store, synced per its registry class (P3 phase work).

## 6. Coherent under degradation (requirements every phase inherits)

Earned the hard way on 2026-06-05, the very hour this initiative kicked off —
the laptop was CPU-starved (load 30–40, five agent servers), and the delivery
of this plan to Justin became the specimen:

1. **The 200-then-lost outbound gap.** The server acked an outbound reply
   (HTTP 200), then restarted before posting to Telegram — silent loss while
   the caller recorded success. → **Rule: ack only after durable commit.** Any
   coherence acknowledgment (journal-sync receipt, gap-fill response) is sent
   only after the local durable write lands. (Fix candidate filed for the
   relay path itself.)
2. **The starvation-restart amplifier.** Supervisor force-restart ceiling
   (~150–300s of failed health checks) bounced the server 6× in 75 min; each
   ~90s boot re-starved the box; in-flight recovery work was reset on every
   bounce. → **Rule: coherence machinery must survive serial restarts** —
   resumable from durable watermarks, no in-memory-only progress, and its
   retry backoff must be load-aware.
3. **Inbound re-delivery across restarts.** One user message arrived 3×. →
   **Rule: every coherence message/verb is idempotent** (watermarks +
   dedup keys), assumed redelivered.
4. **No out-of-band path.** While the server's HTTP was starved the agent
   could not speak at all (outbound rides the server). → **Rule: reads must
   not require the full server to be healthy** — journal files are plain
   JSONL on disk, readable by hooks/CLI/peers even when HTTP is degraded; and
   the (separately-filed) lifeline-direct outbound fallback applies.
5. **Cheap by construction.** Appends and digest exchanges only. No
   full-scan sync. A starved box must be able to afford its own coherence.

## 7. Phasing

| Phase | Deliverable | Project items | Ships |
|-------|-------------|---------------|-------|
| **P0** (this PR) | Census registry doc + this master spec, Justin-reviewed | P0.1, P0.2 | docs only |
| **P1** | Coherence journal: writer lib + topic-placement & session-lifecycle & autonomous-run events + `journal-sync` verb + `GET /coherence/journal` + registry JSON + new-store CI lint | P1.1–P1.3 | dark → dev-agent live (`developmentAgent` gate) |
| **P2** | Digest/watermark gap-check + working-set pull-on-move | P2.1–P2.2 | dev-agent live, fleet dark |
| **P3** | Threadline conversation registry events + machine-swap semantics | P3.1–P3.2 | per its own spec |
| **P4** | Parallel-work/cross-topic awareness reading pool-wide journal | P4.1 | per its own spec |

Registered: project `multimachine-coherence` (10 child items, 5 tiers,
`auto_advance: false` — each round fires on Justin's word). Commitment
CMT-1104 tracks the P0 deliverable.

**Start-small discipline:** P1's journal ships with THREE event kinds wired
(placement, session-lifecycle, autonomous-run) — not the full taxonomy. Every
later kind is an additive append to an append-only system.

## 8. Security

- Journal entries are **metadata, not content** (ids, paths, statuses,
  machines, timestamps). Anything content-bearing stays in its store and
  syncs per its registry class. Secret-pattern redaction (the live-tail
  redaction enum) applies to journal fields as defense-in-depth.
- Replication is machineAuth-only (registered peers, signed envelopes,
  replay-proof). No journal data ever rides Threadline or any agent-to-agent
  channel.
- Working-set pulls are path-jailed to the declared topic working set — a
  peer cannot request arbitrary files (the gap-fill handler resolves paths
  against the journal's own artifact declarations, never the request).

## 9. Testing strategy (Testing Integrity Standard — all three tiers)

- **Unit:** journal writer (monotonic seq, append-only, crash-mid-append
  recovery), watermark merge, digest computation, gap-fill path-jail.
- **Integration:** two in-process stores round-tripping `journal-sync`
  deltas; `GET /coherence/journal` merged view; idempotent redelivery
  (every verb double-delivered in tests).
- **E2E:** production-init path boots the journal + routes alive (the
  "feature is alive" 200-not-503 test); a simulated transfer pulls a working
  set; **degradation tier:** kill -9 mid-append → clean resume from watermark
  (requirement §6.2 as a test, not a hope).
- **Wiring-integrity:** the journal writer is reachable from the placement /
  session / autonomous code paths (the Phase-0 lesson from the seamlessness
  spec: unwired sync ships dead twice).

## 10. Open questions for Justin (none block P0)

1. **Commitments store convergence** — commitments are file-per-agent today
   and machine-local; P1 journals their mutations (visibility), but true
   convergence (one logical commitment list) likely wants the store itself to
   go append-only-mergeable. Treat as P1.5 follow-up spec?
2. **Memory stores** (semantic/episodic/topic SQLite) are classified
   `derived-cache` in the census — rebuildable, so NOT synced in P1–P4.
   Acceptable, or should topic memory be promoted to must-be-coherent?
3. **Working-set transport for large artifacts** — peer-HTTP pull vs
   committing working files to a synced git area. P2's spec will propose
   peer-pull primary (git unavailable on dev-agent homes), but if you have a
   preference, it shapes P2.
