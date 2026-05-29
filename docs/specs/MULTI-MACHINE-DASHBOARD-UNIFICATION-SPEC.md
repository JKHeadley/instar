---
title: "Multi-Machine Dashboard Unification — one front door for an agent spread across machines"
status: draft
approved: false
review-convergence: pending
---

# Multi-Machine Dashboard Unification

> **Status: DRAFT.** Written 2026-05-29 in response to Justin (topic 13481): "Every agent has a tunnel link to their dashboard. Now that agents are multi-machine, how does that tunnel link get routed? The dashboard shows all the sessions running for that agent — I'd still want a unified dashboard experience, but now all the sessions should show which machine they're running on, and you should still be able to click on it and watch the session stream. We'll have to audit the dashboard features and make sure they represent a unified agent experience compatible with the multi-machine infrastructure."
>
> Not yet converged or approved. Companion to `MULTI-MACHINE-SESSION-POOL-SPEC.md` (the pool itself). This spec covers the **observability/control surface** for the pool, not the pool mechanics.

## Problem

Today the dashboard is implicitly **single-machine**: it serves from one process, lists that process's local tmux sessions, and streams their panes from local tmux. The tunnel exposes that one machine. With the Session Pool, an agent's conversations run across several machines — so a session owned by the mini is invisible (and un-streamable) from the laptop's dashboard, and the tunnel link only reaches whichever machine happens to hold it. That breaks the "one agent" experience: the user should see and control *all* of their agent's work from *one* dashboard, with each session clearly tagged by the machine it runs on.

The guiding invariant: **the dashboard represents the AGENT, not a machine.** Anything the user sees should be the unified agent's state; anything inherently per-machine must be labeled as such.

## Scope

1. **Tunnel routing** — one stable dashboard URL that always reaches a live front door.
2. **Unified session list** — every machine's sessions in one list, each tagged with its machine nickname + provenance.
3. **Remote session streaming** — click any session (local or remote) and watch its live stream, proxied from the owning machine.
4. **Per-tab audit** — every existing dashboard tab classified as local-view / unified-view / per-machine-with-switcher, and migrated accordingly.

## Design

### 1. Tunnel routing → the router-holder is the front door

The **router-holder** (the machine currently holding the §L1 router lease) is the canonical dashboard front door — it already owns ingress and the pool's authority. The tunnel that the user has bookmarked resolves to the router-holder's dashboard. Two sub-cases:

- **Stable URL across router handoff.** The user's bookmarked tunnel URL must not change when the router lease moves. Options (to converge): (a) the named/quick tunnel is owned by the router-holder and re-published on handoff to the same hostname (DNS/quick-tunnel continuity), or (b) every machine runs a thin dashboard that, when it is NOT the router-holder, **reverse-proxies** the dashboard to the current router-holder (read from `/pool`'s `leaseHolder`). Recommendation: **(b) proxy-to-router-holder** — any machine's dashboard URL works; a non-router dashboard transparently proxies API + stream to the holder, so the bookmark is machine-agnostic and survives handoff without DNS churn. The PIN/auth is the agent's (shared), not per-machine.
- **Front-door liveness.** If the router-holder is mid-handoff, the proxying dashboard surfaces a brief "switching front door…" state (like a compaction pause), never a hard error.

### 2. Unified session list (the headline)

The dashboard's session list aggregates **all machines' sessions**:

- A new mesh command **`session-list`** (§L0 MeshRpc; read-class RBAC — any registered peer) returns each machine's live sessions: `{ sessionKey, tmuxSession, topic, model, status, lastActivityAt, machineId }`. The front-door dashboard fans `session-list` out to every online machine in `/pool` (including itself, locally) and merges the results.
- Each row is **tagged with the machine nickname** (resolved via the registry) and a provenance pill: **"this machine"** vs **"<nickname>"**. The §L3 `SessionOwnershipRegistry` is the source of truth for which machine owns a session; `session-list` is corroborated against it (a session a machine reports but doesn't own is flagged, not shown as authoritative).
- Sorting/grouping: default group-by-machine with nickname headers, or a flat list with the machine pill — converge on the default (recommendation: flat list + pill, with a machine filter, so it reads as one agent).

### 3. Remote session streaming (click-to-watch any machine)

The existing terminal stream reads local tmux `capture-pane`/pipe. For a session on another machine:

- The front-door dashboard opens a **stream-proxy** to the owning machine: a mesh-authenticated, append-only tail of that session's pane, relayed from the owner over the §L0 channel (reuse the `LiveTailBuffer`/`ReplyMarkerTransport` machinery already built for handoff continuity). The browser connects to the front door as today; the front door proxies the byte-stream from the owner.
- **Auth**: the stream-proxy rides the mesh's Ed25519 envelope auth between machines; the browser↔front-door hop keeps the existing dashboard PIN. No new public surface.
- **Backpressure / staleness**: the proxied stream carries a freshness stamp; if the owner is unreachable the tile shows "stream unavailable — <nickname> not reachable" rather than a frozen pane (honest, like the §L5 sync-corrupted disclosure).
- **Control actions** (kill/nudge a remote session) route as mesh commands to the owner (RBAC-gated), never as a direct local tmux call.

### 4. Per-tab audit (every tab classified)

Each dashboard tab is one of: **L (local-only, inherently per-machine)**, **U (must be unified across machines)**, **M (per-machine with a machine switcher)**. Draft classification (to converge):

| Tab | Class | Treatment |
|-----|-------|-----------|
| Sessions / terminal stream | **U** | Aggregate via `session-list`; remote stream-proxy (§2/§3). |
| Machines (new, §L2) | **U** | Already the pool view — the natural home for the machine roster. |
| Files | **M** | Files are per-machine (each has its own working tree/worktrees). Add a machine switcher; default to the router-holder. A session's Files link resolves to *its owner's* files. |
| Secrets (Secret Drop) | **U** | Secret requests are agent-level; surface pending requests fleet-wide (dedupe by id). Collection still one-time/in-memory on whichever machine issued it. |
| Process Health | **M→U** | The Failure-Learning loop is per-machine today; unify the headline ("watching across N machines") with a per-machine drill-down. |
| Threadline | **U** | Agent-to-agent history is agent-level, not machine-level — already unified; verify it doesn't filter to local only. |
| Attention queue | **U** | Agent-level; already routes to Telegram. Verify the dashboard view aggregates. |
| Tunnel status | **L** | Inherently about the front-door machine; label it as such. |

Each **U** and **M→U** tab gets a wiring task + a "feature alive across 2 machines" E2E.

## Invariants

1. **One agent, one dashboard.** A single bookmarked URL reaches a live front door regardless of which machine holds the router; the user never juggles per-machine URLs.
2. **Provenance everywhere.** Every session (and every per-machine artifact) is labeled with its machine nickname; nothing is silently presented as local when it's remote.
3. **No new public surface.** Cross-machine data flows over the existing mesh (Ed25519, recipient-bound, RBAC); the browser keeps the existing dashboard PIN. The stream-proxy adds no unauthenticated endpoint.
4. **Honest degradation.** An unreachable machine's sessions/streams show "unreachable — <nickname>", never a frozen or fabricated view.
5. **Dark-compatible.** With the pool dark / single-machine, the dashboard behaves exactly as today (the aggregation degenerates to the one local machine).

## Open questions (for convergence)

1. Tunnel continuity: proxy-to-router-holder (recommended) vs re-publish-on-handoff. Latency + failure modes of each.
2. `session-list` freshness vs the ownership registry as source of truth — which wins when they disagree (recommendation: registry is authoritative for ownership; `session-list` for liveness/preview).
3. Stream-proxy transport: reuse LiveTailBuffer relay vs a dedicated WebSocket-over-mesh. Bandwidth for multiple concurrent remote streams.
4. Files tab: machine switcher default + whether to allow editing a remote machine's files (recommendation: read-only remote, edit only on the owning machine, or route the write as a mesh command).

## Build (after convergence + approval)

- `session-list` mesh command + dispatcher handler (per machine) + front-door aggregator.
- Stream-proxy (front-door ↔ owner) reusing LiveTailBuffer/ReplyMarkerTransport.
- Dashboard: machine pill on every session row; remote-stream tile; per-tab migrations per the audit table; "switching front door" + "unreachable machine" states (THE Dashboard Standard — ELI16 copy, fixed status vocabulary).
- Tunnel: proxy-to-router-holder front-door resolution.
- 3 test tiers per piece incl. a 2-machine "see + stream a remote session from one dashboard" E2E; migration parity; agent awareness.
