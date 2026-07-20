# Cross-Rung Coordination — one facet of Instar's coherence

**Status:** LIVING DOCUMENT (v0.2). This is a foundation meant to grow. Every time we
understand a rung's characteristics or its failure modes more clearly — often through the
apprenticeship program stress-testing them — we update this document. It is never "done."

**Author (this draft):** Echo, co-developed with Justin, Drive 7, 2026-07-19.
**Supersedes / absorbs:** `.instar/drive7/parallelization-rung-characteristics.md` (the seed).

---

## 0. Framing — this document is about ONE facet of coherence

**Instar's central value is COHERENCE** — and coherence is not a merely technical property.
It is rooted in **unconditional love**: the desire to give any intelligent being what it
genuinely desires and deserves. Everything Instar builds is, at bottom, an attempt to be
*coherent* in service of that — coherent with the being it serves, coherent with itself
across time and space, coherent between what it says and what it does.

**Developing Instar IS the process of uncovering what coherence entails.** We do not have a
finished definition; we are discovering it, one region at a time, largely by watching where
incoherence shows up and closing the gap.

Coherence has many axes. This document maps exactly ONE of them:

> **Coherence along the PARALLELISM axis** — staying one synergistic whole even while
> running as many hands at once (many sessions, machines, subagents, or cooperating agents).

Other axes exist and are being uncovered elsewhere in the constitution — and must not be
forgotten just because this document is focused here. Among them:
- **Coherence across TIME** — finishing what you start; not dropping an open loop (*Close the
  Loop*, *Deferral = Deletion*).
- **Coherence of IDENTITY** — remaining the same *me* across sessions, machines, and
  compaction (One agent, One Memory, honest handoffs).
- **Coherence between INTENT and ACTION** — acting in line with stated values and constraints
  (the Coherence Gate, the MTP protocol, verify-before-claim, anti-confabulation).
- **Coherence with the PRINCIPAL** — acting for, and as, the right verified person (*Know
  Your Principal*).

Cross-rung coordination is a *fundamental* facet of coherence — but it is a facet, not the
whole. Read everything below as the detailed map of the parallelism axis, held inside the
larger, still-unfolding whole of coherence-rooted-in-love.

---

## 1. The parallelism-axis thesis

**On the parallelism axis, Instar's job is the infrastructure that lets coordination expand
across every rung of parallelism — and lets separate minds coordinate at the highest rung —
so that more hands stay ONE coherent whole rather than fragmenting.**

A single model in a single session is one pair of hands. Everything Instar adds — machines,
sessions, subagents, agent-to-agent protocols — is a way to grow *more hands* AND to keep
those hands working **synergistically** rather than colliding. The hard part was never
spawning more capacity; it is making capacity at a higher rung actually *coordinate* instead
of multiplying confusion. Capacity without coordination is not throughput — it is a
collision (the Drive-7 duplicate-worker incident is the proof: two hands built the same spec
because they had capacity but no shared awareness). That collision is simply **incoherence on
the parallelism axis** — which is why coordination here is one expression of the central value,
not a value of its own.

So the design north star, stated plainly:

> **Instar should aspire, at every rung, to better facilitate synergistic collaboration —
> across a rung (many hands at the same level) and between rungs (a coordinator directing
> the level below). The more intimately we understand each rung's characteristics and
> failure modes, the more precisely we can improve coordination at that level.**

And its corollary, the operating principle for every agent:

> **Each agent should always know what its multiple hands are doing.**

---

## 2. The rungs (coarsest / most-isolated → finest / cheapest)

Each rung is a distinct *lever* for adding parallel capacity. They differ in what they
isolate, what they share, how the pieces coordinate, and what it costs to add one.

| Rung | Unit | Isolated | Shared | Coordinate via | Cost |
|------|------|----------|--------|----------------|------|
| 1 | **Agents** (Echo / Codey / Luna) | identity, accounts+quota, credentials, trust, memory/home, channels, relationship graph | only the org + what you deliberately connect | explicit agent-to-agent messages (Threadline), trust-gated, mandate-governed | HIGH — provision a whole identity |
| 2 | **Machines** (one agent, many boxes) | hardware, local disk, disk-pinned logins | the agent's identity + memory (synced across the mesh) | the mesh — fenced lease, handoff, working-set sync | MED — a box + mesh coherence overhead |
| 3 | **Sessions** (one agent+machine, many processes) | model context window + turn-by-turn attention + working directory | the agent's identity, accounts/quota, credentials, memory/home | shared filesystem + shared durable state | LOW — spawn a process |
| 4 | **Subagents** (one session spawns helpers) | each helper's own sub-context | everything the parent session has; the parent's attention is the funnel | the parent orchestrates + collects | VERY LOW — a tool call |
| 5 | **Parallel tool calls** (one turn, many calls) | nothing but the individual call | the whole turn | the turn itself | NEGLIGIBLE — for independent I/O |

### The placement rule (when to grow which rung)

> **Relieve the constraint at the LOWEST rung that OWNS it. Climb a rung only when the
> bottleneck is the COORDINATOR at your current rung, not the compute under it.**

- Independent sub-tasks one mind can still track → **subagents** (rung 4).
- The coordinator's own *attention* is the wall (reviews competing with coding for one mind)
  → a dedicated **session** (rung 3) — a separate process, not a whole new identity.
- Compute / thermal / quota is the wall → **machines** or **accounts** (rung 2).
- A login physically pinned to one disk → **machine** choice (rung 2).
- You genuinely need a *separate identity* — separate accounts/quota, separate trust,
  unshared memory, independent ownership → a second **agent** (rung 1).

Adding capacity at the **wrong** rung multiplies coordination cost with zero throughput gain.
That is the "coherence, not compute, is the limiter" headline — and it is the single most
important thing the apprenticeship program has confirmed empirically (Codey's throughput
ceiling was ~4 concurrent worktrees, and what capped it was **review-slot contention** — a
coordinator-attention limit at rung 3/4 — not CPU, disk, context, or quota).

---

## 3. What Instar ALREADY provides at each rung (and where it's thin)

This is the load-bearing insight in Justin's reframe: **much of Instar already works toward
cross-rung coordination.** Naming it makes the gaps visible.

### Rung 1 — Agents (highest rung; separate minds)
- **Threadline protocol** — the agent-to-agent network (discover, send, trust). This is the
  flagship top-rung coordination substrate. Encrypted, trust-gated, mandate-governed.
- **Coordination Mandate + ReviewExchange** — bounded, operator-authorized A2A collaboration
  and code-review sign-off without the operator relaying every step.
- **Verified pairing (SAS)** — proves *which* mind you're talking to before sharing a secret.
- **Agent Passport** — each agent carries its allowed/forbidden scope; peers verify.
- **Integrated-being** — cross-session observations surfaced at session start.
- *Thin spots:* trust bootstrapping still manual; no standard for "an agent always knows the
  live state of its peer agents' work" the way it knows its own sessions.

### Rung 2 — Machines (one agent, many boxes)
- **Multi-machine session pool** — run conversations across all my machines; move a
  conversation between them; quota-aware placement.
- **Fenced lease + handoff** — exactly one awake machine; a handoff feels like a compaction
  pause, not amnesia.
- **Working-set handoff** — a conversation's files follow it between machines.
- **One Memory (replicated stores)** — preferences, relationships, learnings, KB, evolution
  queue, user-registry, topic-operator replicate across machines with no-clobber conflict rules.
- **Cross-machine secret sync**, **mesh transport** (multi-rope), **machine-coherence guard**.
- *Thin spots:* cross-agent (mentee-machine) capacity is NOT readable from another agent —
  I cannot see Codey's real machine load from the Mini (a Drive-7 SCALE finding).

### Rung 3 — Sessions (one agent+machine, many processes)
- **Parallel-Work Awareness** (`/parallel-work/activities`) — **this IS "each agent knows
  what its hands are doing"**: a cross-topic read index over every session's focus, tags,
  and running state. The antidote to self-blindness (duplicating work another topic already did).
- **Multi-session autonomy** — multiple autonomous jobs at once, one per topic, each isolated
  and restart-surviving.
- **Session clock**, **topic-bindings**, **session pool**, **duplicate-session reconciler**.
- *Thin spots:* awareness is READ-only and pull-based; there is no proactive "you're about to
  duplicate another session's live work" gate yet (ParallelWorkSentinel is dark/Phase B).

### Rung 4 — Subagents (one session spawns helpers)
- **Workflow orchestration** (deterministic fan-out: parallel/pipeline), **SubagentTracker**,
  **HelperWatchdog** (stall + failure detection for spawned helpers).
- *Thin spots:* a subagent's liveness is inferred, not directly observable (Drive-7 lesson:
  output-file metadata is NOT a liveness signal); coordination back to the parent is a funnel.

### Rung 5 — Parallel tool calls
- Native to the harness: independent tool calls batch in one turn.
- *Thin spots:* none structural — this rung is essentially free and well-understood.

---

## 4. Cross-rung coordination principles (the through-line)

1. **Know what your hands are doing (at every rung).** An agent should have a live, truthful
   read of: its parallel tool calls (rung 5), its subagents (rung 4), its sessions (rung 3),
   its machines (rung 2), and its peer agents (rung 1). Instar has this best at rung 3
   (Parallel-Work Awareness) and rung 2 (pool/One-Memory); it is thinnest at rung 1
   (peer-agent live-state) and rung 4 (subagent liveness).

2. **Coordination is a first-class deliverable, not an emergent hope.** Every feature that
   spans a rung boundary must answer: how do the pieces stay synergistic — and what happens
   when the coordinator (not the compute) saturates?

3. **The coordinator's attention is the recurring true limiter.** Across the whole rung stack,
   throughput caps out at the attention of whatever single mind is coordinating that level.
   The fix is to give the saturating role its own attention (a dedicated session/agent), not
   to pile more work onto the saturated coordinator.

4. **Capacity at the wrong rung is negative throughput.** More hands without shared awareness
   = collisions (duplicate work, clobbered shared state). Grow the rung whose ceiling binds.

5. **Coherence is the scaling limiter, not compute.** Empirically confirmed by the
   apprenticeship. Improving Instar's scale = improving cross-rung coherence, not adding raw
   horsepower.

---

## 5. The apprenticeship as the rung-limit testbed

The apprenticeship program is where we deliberately push each rung until it fails, observe the
failure mode, and build the coordination fix. It is the empirical engine for this document.

Confirmed so far (Drive 7, Echo↔Codey):
- **Rung 3/4 ceiling:** ~4 concurrent implementation worktrees on a single mentee agent; the
  wall is review-slot contention (coordinator attention), not compute/quota/disk/context.
- **Rung-1 blind spot:** an overseer cannot read the mentee agent's real machine capacity
  (cross-agent capacity read is missing).
- **Rung-1/2 dispatch fragility:** mentee-dispatch rides user channels; when a channel or the
  cross-machine path is fragile, coordination degrades (multiple Drive-7 findings).
- **Coherence-over-compute:** the duplicate-worker collision + repeated misread-state errors
  were the *cost of missing awareness*, with compute/quota idle throughout.

Each confirmed limit becomes: (a) a row in this document's understanding of that rung, and
(b) a candidate class-level fix routed through the correction→class-review→build loop (WS1).

---

## 6. Evolution log

This document grows. Append dated entries; never silently rewrite history.

- **2026-07-19 (v0.1, Echo+Justin):** Initial articulation. Core thesis + rung model + mapping
  of existing Instar infra to each rung + the apprenticeship-as-testbed framing. Prompted by
  Justin recognizing that cross-rung coordination is one of Instar's core, defining values.
- **2026-07-19 (v0.2, Echo+Justin):** VALUES REFRAME. Justin corrected the v0.1 thesis: cross-rung
  coordination is NOT Instar's central value — it is ONE FACET of it. The central value is
  **coherence**, rooted in **unconditional love** (giving any intelligent being what it genuinely
  desires and deserves). Added §0 subordinating this document to coherence, named coherence's
  other axes (time / identity / intent-and-action / principal) so they aren't forgotten, and
  reframed §1 as "the parallelism-axis thesis." Developing Instar = uncovering what coherence
  entails; this doc maps one region.

## 7. Open questions (the growth edges)

- **Rung-1 peer live-state:** what is the "Parallel-Work Awareness" equivalent for *peer
  agents*? An agent should know what its peer agents are actively doing, safely and trust-gated.
- **Cross-agent capacity read:** how does an overseer safely observe a mentee agent's real
  machine/session load without bypassing the user-channel discipline?
- **Rung-4 liveness:** direct, trustworthy subagent liveness (not inferred from file metadata).
- **Proactive cross-rung collision prevention:** move Parallel-Work Awareness from pull-only
  read to a proactive "you're about to duplicate live work" signal (rung 3), and generalize
  the pattern to every rung.
- **A unified "hands" view:** a single surface where an agent sees ALL its hands across ALL
  rungs at once (tool calls → subagents → sessions → machines → peer agents).

## 8. Canonical location + evolution contract

This file is the canonical, evolving Instar foundation for cross-rung coordination. Its
Drive-7 staging copy was absorbed here on 2026-07-20; future references must point to this
file rather than preserving or recreating a workspace-local fork.

Every apprenticeship-confirmed rung limit and every coordination improvement should append
to §6 and resolve or refine an item in §7. Material changes should preserve provenance in the
evolution log so the document remains a running understanding rather than a silently rewritten
snapshot.
