---
title: Standby-Write Reconciliation
description: Ownership-scoped write admission with typed refusals — how a standby machine saves state for the sessions it owns without ever creating a two-writer conflict.
---

When one agent runs on more than one machine, two models coexist: the **one-awake lease** (only the lease-holding machine may write agent state — every other machine's saving layer is switched off by a single process-wide boolean) and the **active-active session pool** (per-topic custody deliberately places live, serving sessions on "standby" machines). Those two models contradict each other: a standby machine can be actively running your conversations while being forbidden from recording anything about them — observed live as `Failed to record build context … this machine is on standby` for a session that machine owned.

Standby-write reconciliation replaces the single on/off switch with **ownership-scoped write admission**. It ships dark on the fleet and dry-run first on development agents: the legacy blanket guard keeps enforcing byte-for-byte while the new layer logs what it *would* have decided, and it cannot gain refusal authority until a compiled-in inventory latch is deliberately flipped by a reviewed follow-up — a config edit alone can never grant it.

## The decision layer (`WriteAdmission`)

`WriteAdmission` is a single synchronous, in-memory decision point consulted at two seams — the `StateManager` store guard and the HTTP route guard. It never touches disk, the network, or an LLM on the admission path; it answers from a boot-warmed in-memory `OwnershipIndex` that mirrors the session-ownership store (`SessionOwnershipRegistry` / `LocalSessionOwnershipStore`) via an interface-level commit hook registered *before* the warm scan, so no ownership transition can slip between boot and steady state.

Every write is classified into a domain, and each domain has its own rule:

- **Machine-local** — notes a machine keeps about itself (attention items, the evolution action queue, its own sessions' build context). Admitted on every machine, in every mode. Each entry must name its cross-machine convergence story before it may claim this bucket.
- **Session-scoped** — state about one session. Admitted only on the machine that owns that session; a missing custody record admits (a purely local helper session is this machine's own business — you are never blocked from serving your own user by absent bookkeeping).
- **Topic-scoped** — state about one conversation topic. Admitted only on the owner; a missing record falls back to the legacy lease rule, because letting every machine write an unclaimed topic's state would put two writers on one file — the exact conflict this design exists to prevent.
- **Cluster-shared** — genuinely shared state (the lease itself, job schedules). Lease holder only, exactly as strict as before. This bucket never loosens.

A refused write gets a **typed refusal**: an immediate `409` naming the domain, the reason code, the owning machine, and a `Retry-After` — never an open-ended hang, and a refused write mutates nothing. A malformed ownership record fails closed as `ownership-unresolved` rather than mis-attributing an owner. A broken admission layer fails toward today's behavior: store-seam errors fall back to the legacy verdict, and refusal storms are coalesced into a single deduped attention item rather than a notification flood.

## The rulebook (`WriteDomainRegistry`)

`WriteDomainRegistry` is the single source of truth mapping operations, exact key-value keys, and route prefixes to their domain — together with the two-axis convergence story each machine-local entry must declare (how the store converges across machines, and how its file avoids git-sync conflicts). A machine-local classification with no story is structurally refused and downgraded to cluster-shared. The registry also owns the compiled `WRITE_SURFACE_INVENTORY_COMPLETE` latch: until the full write-surface inventory is reviewed and that constant is flipped in code, the layer stays in dry-run regardless of configuration.

## The concrete fix that shipped with it

The per-session build context (`SessionBuildContextStore`) previously wrote both machines' entries into one shared file — a permanent git-sync fight. It is now keyed per machine, and `FileClassifier` excludes the attention-item and evolution stores from git sync (their convergence is owned by their own replication layers), closing a pre-existing fork surface. An event-loop delay gauge was added to the authenticated health surface so future write-endpoint hangs are attributed to the real cause — process stalls — rather than blamed on write rules.
