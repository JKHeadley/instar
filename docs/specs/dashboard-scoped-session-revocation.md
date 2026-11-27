---
title: "Dashboard scoped-session revocation completeness (SEC-044 + SEC-045)"
slug: "dashboard-scoped-session-revocation"
author: "echo"
date: 2026-11-16
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
parent-principle-fit: "SEC-002b (#3214, dark) gave the dashboard a short-lived, revocable scoped token (dst_) so a stolen browser session is no longer the permanent master key. But the REVOCATION side of that promise is incomplete: a PIN rotation does not end live dst_ families, and a consumed token can no longer be used to revoke its own family — so after a thief refreshes once, the owner's logout is a silent no-op and the owner cannot evict the thief short of a server restart. This closes those gaps so the dst_ model actually delivers the revocability it claims, BEFORE the feature is ever flipped on."
binding-standards:
  - "Signal vs Authority — the scoped-token family membership is the authority for 'is this session still alive'; a revocation must act on the family, not on a single live token digest that a refresh can consume out from under it."
  - "Verify the State, Not Its Symbol — a logout/revoke must prove it invalidated the FAMILY (the real state), not merely that it found a still-live token digest (a symbol that a thief's refresh erases); reuse of a token whose chain has already forked is the signal of theft and invalidates the family."
  - "No single-device lockout (operator rule 2026-09-29) — the owner's eviction paths (PIN rotation, explicit revoke-all, per-family logout) all work from any owner surface; none depends on one device."
eli16-overview: dashboard-scoped-session-revocation.eli16.md
approved: false
review-convergence: "2026-11-16T08:40:52.128Z"
review-iterations: 7
review-completed-at: "2026-11-16T08:40:52.128Z"
review-report: "docs/specs/reports/dashboard-scoped-session-revocation-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 0
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Dashboard scoped-session revocation completeness (SEC-044 + SEC-045)

## Problem statement

SEC-002b (PR #3214, shipped **dark** behind `security.dashboardScopedToken.enabled`) replaced the dashboard's permanent master token with a short-lived, refreshable, revocable **scoped session token** (`dst_…`), grouped into a `familyId` per unlock, with a per-token TTL and an absolute family cap. The point of the feature is that a stolen dashboard session is time-bounded and **revocable** rather than a permanent master key.

Two defects (found by the security-review job, Pass 2, 2026-11-15 23:00 PST; code-confirmed by two model families) make the revocation side of that promise hollow. Both are in **dark** code — the feature is not yet flipped on anywhere — so they are fixed before graduation, not after an incident.

- **SEC-044 — a PIN change does not end live scoped sessions.** `AgentServer.syncDashboardPinVersion()` (src/server/AgentServer.ts:589-593) clears `dashboardOperatorSessions` and `phoneDesktopSessions` on a PIN-version bump, but never touches `dashboardSessionStore`. `DashboardSessionStore.revokeAll()` exists but has **no production caller**. A stolen `dst_` therefore survives a PIN rotation for the life of its family. The owner's most natural "lock everyone out" action silently leaves the thief's scoped session alive.

- **SEC-045 — a consumed token cannot revoke its own family, and chain-forking is undetected.** `DashboardSessionStore.refresh(token)` (src/server/DashboardSessionStore.ts:82-92) **consumes** the presented token (deletes its digest) and mints a successor, with no record that the old digest existed. `revokeFamily(token)` (lines 94-99) resolves the family **only via a still-live token digest**. So once a thief refreshes (consuming the original token the victim still holds), the victim's logout finds nothing and silently no-ops while still answering `{revoked:true}`; the thief's successor chain stays alive to the absolute cap. Combined with SEC-044, the owner has **no** eviction path short of a server restart.

Neither defect is a delete/credential bypass; both are **availability/authority-integrity** failures of the revocation model SEC-002b sold. They are closed before `dashboardScopedToken` is flipped on (a pre-flip gate for SEC-002b graduation).

## Proposed design

All changes are **inside the dark feature's own surface** (`dst_` tokens only). With `security.dashboardScopedToken.enabled` false, nothing here is reachable: the master-token path is unchanged, byte-for-byte.

### 1. SEC-044 — PIN rotation ends every scoped session

In `syncDashboardPinVersion()`, alongside the existing `dashboardOperatorSessions.clear()` + `phoneDesktopSessions.clear()` on a version change, call `this.dashboardSessionStore.revokeAll()`. `revokeAll()` already invalidates every family (firing the `onFamilyInvalidated` listeners that close open WS/SSE streams) and clears the token + family maps. A new PIN is the owner's "end every active human-is-here proof" action; the scoped sessions are exactly such proofs and must end with it. One added call; no new method.

### 2. SEC-045 — tombstones and STRICT reuse-triggered family invalidation

Add a **tombstone map** to `DashboardSessionStore`: `consumed: Map<digest, { familyId }>` — the family each spent token belonged to.

**`refresh(token)` is a three-way decision:**

1. **Live token (normal path):** consume it (delete its live digest), mint successor `T'`, record `consumed.set(digest(token), { familyId })`, enforce the global tombstone budget (below), return `T'`.
2. **Consumed token (digest in the tombstone) → REUSE → treat as a FORK:** any second presentation of an already-spent token invalidates the family — `invalidateFamily(familyId)`, return `null`. STRICT: there is no "benign retry" exception (see the declaration below for why a replay window would be a hole, not a kindness).
3. **Neither live nor tombstoned → `null`** (never issued, or pruned after its family died).

**`revokeFamily(token)`:** resolve the family via the live-token map **OR** the tombstone, then `invalidateFamily`. The owner's logout with their original (now-consumed) token therefore still ends the family. A token in neither map is a safe no-op.

**Reuse-detection symbol→state declaration (Verify the State, Not Its Symbol), and why NO idempotency window.** The SYMBOL is "a consumed token is presented again"; the STATE it proves is "this session has forked." The store sees token presentations, not principals, so it cannot distinguish a legitimate client's **lost-ACK retry** (its refresh succeeded server-side but the response dropped, so it retries the same token) from a thief presenting a stolen copy. A tempting "idempotency window" — remember the minted successor and hand it back on a repeat of the consumed token — was explicitly REJECTED: it would return the live successor to *whichever* party re-presents the old token, so a thief holding a copy of `T` could exchange it for `T'` after each rotation and **shadow the owner's chain undetected to the absolute cap** (codex round-3 HIGH). No server-side signal binds a retry to the original client, so the window cannot be made safe. The design therefore resolves the unmeasurable case with the **least-harmful action: invalidate the family, owner re-PINs** — the standard refresh-token-rotation model (RFC 6819 §5.2.2.3 / mainstream IdPs). The residual cost is a rare re-PIN when a refresh *response* is dropped (not every refresh; only the refresh whose response is lost, every ~0.75×TTL); false-block is cheap, false-pass (a thief shadowing the chain, or an undetected fork) is catastrophic.

**Endpoint wiring — the refresh/logout routes must accept a CONSUMED token (codex r4 HIGH-1).** A consumed `dst_` fails the live-only `verify()`/`dashboardSessionVerify`, so the `refresh` and logout (`revokeFamily`) endpoints must NOT gate behind that live-token auth check — they take the presented `dst_` from the request and pass it straight to the store, which authoritatively classifies it live / consumed / unknown. Otherwise `authMiddleware` would 401 a consumed token BEFORE reuse-detection or the owner's old-token logout could ever run, silently defeating both. (The `revoke-all` control of §3 is the exception: it is step-up-gated and needs a valid step-up proof, not the possibly-consumed session token.)

**Store lifecycle invariants (so revocation is actually COMPLETE).** The guarantee this fix must hold is: *while a family is alive (not past `absoluteMaxMs`, not invalidated), every token digest ever issued in it resolves to that family, and the family's open streams close within one prune interval (≤60s) of its deadline — immaterial against the 7-day absolute cap, and immediate for any ACTIVE revocation (PIN rotation / revoke-all / logout / reuse-detection all fire `invalidateFamily` synchronously).* Four base-store behaviors are tightened to hold it — each is a path where the merged SEC-002b code removes a digest or defers cleanup, which would otherwise re-open a revocation gap:

- **Tombstone on EVERY live-map removal while the family lives (codex r5).** A digest leaves the live map not only on `refresh`-consume but also on TTL-expiry (`lookup()`) and capacity-eviction (`mint()`'s `maxTokens` bound). Each such removal, if its family is still alive, writes a tombstone `digest → { familyId }` first. So the owner's `revokeFamily(token)` still resolves the family even when their (unconsumed) token expired or was capacity-evicted — the base code's silent deletes otherwise orphan the revocation anchor and leave an open stolen stream un-killable.
- **Check-before-mint, per-family cap, contain the offender (codex r4).** The per-family tombstone count is checked BEFORE minting; a breach `invalidateFamily`s THAT family (never a global "heaviest" that could punish an innocent — codex r4 MEDIUM-1) and returns `null` (re-PIN), so nothing is minted-then-revoked (codex r4 MEDIUM-2). Cap `8 × maxTokens` per family, config-tunable, NOT security-load-bearing (strict reuse already stops attacker accumulation; the cap only bounds a pathologically-reconnecting legitimate client, cost one re-PIN).
- **Bound the family COUNT, not just per-family tombstones (codex r5).** Each unlock creates a family, so the number of live families is itself capped (at `maxTokens`); a new unlock beyond the cap `invalidateFamily`s the OLDEST family (closing its streams). This bounds AGGREGATE memory to (family cap)×(per-family cap), which per-family caps alone do not.
- **Deadline enforcement is scheduled AND per-delivery, not lazy (codex r5/r6).** Two mechanisms together make a past-deadline stream stop promptly: (a) pruning runs on a periodic timer (e.g. every 60s), NOT only on the next `issue()` — it `invalidateFamily`s (firing `onFamilyInvalidated`, closing open WS/SSE streams) any family past `absoluteMaxMs`, then discards its tokens + tombstones; AND (b) each stream delivery re-checks its family's liveness, so a past-deadline (or revoked) family's stream stops at its **very next delivery attempt**, between prune ticks. So an active stream stops immediately on its next message and an idle one within the prune interval — the timer is a floor, not the only guard. Pruning is against the FAMILY deadline, not `consumedAt + duration` (codex round-3).

**Tombstone retention is TIME-bounded, never count-evicted.** Prune a tombstone when `now >= consumedAtMs + absoluteMaxMs` (its family's absolute cap — past which the family is dead and unrevocable anyway) OR when its family is invalidated (purge that family's tombstones; `revokeAll()` clears the whole map). There is **no oldest-first count eviction**: the owner's revocation anchor is their *original* token's tombstone, created at unlock — the oldest entry — so oldest-first eviction would discard exactly the entry revocation depends on, re-creating the SEC-045 no-op one layer up. Time-bound retention keeps every anchor alive for exactly as long as it can still matter. Memory bound: (live families) × (refreshes within the absolute cap), with the per-family rate-limit bounding the refresh rate; `consumedAtMs` is the pruning key (it is consumed, not dead state).

### 3. SEC-045 — an explicit owner "sign out this agent's dashboards" control

Add `POST /dashboard/session/revoke-all` → `dashboardSessionStore.revokeAll()`.

**Wiring (named, not inferred):** the route path is added to the `isDashboardCredentialRoute` set (so a plain `dst_` without step-up is refused) **and** requires the `X-Instar-Step-Up` PIN-proof the other credential routes require; it is dark-gated — returns 404 when `dashboardScopedToken` is disabled (same pattern as SEC-002b's step-up endpoint) — so it adds no surface to the master-only configuration.

**Scope is THIS agent-server only** — named "sign out all dashboard sessions on this agent", NOT "everywhere." Each machine runs its own dashboard, its own PIN unlock, and its own scoped-session store; a `dst_` minted on machine A is meaningless to machine B's process. The one genuinely fleet-wide eviction is **PIN rotation**: the owner's PIN change replicates through its existing channel, and each machine's `syncDashboardPinVersion` independently detects the version bump and fires its own `revokeAll()`. The spec states this explicitly so the control is never mistaken for a fleet-wide "sign out everywhere." *(F4.)*

## Decision points touched

| decision point | classification | justification |
|---|---|---|
| On refresh, how is a re-presented consumed token handled? | **invariant; basis: enumerable-domain; evidence: a digest is in exactly one of {live, consumed-tombstoned, unknown}** | Deterministic three-way STRICT reuse detection (see §2): a live token mints a successor; ANY re-presentation of a consumed token invalidates the family; neither is a no-op/null. No idempotency window — it was rejected because it would let a thief shadow the rotation chain. The residual false-positive (a dropped refresh *response* → lost-ACK retry → re-PIN) is declared per Verify-the-State: false-block is a rare re-PIN, false-pass leaves a stolen session live. |
| Which authority resolves a family for revocation — live token only, or live-or-tombstoned? | **invariant; basis: irreversible-consequence; evidence: a missed revoke leaves a stolen session alive to the absolute cap** | The family is the durable authority; a live-token digest is a symbol a refresh erases. Revoke resolves via live OR tombstone. |
| Tombstone retention bound | **invariant; basis: external-constraint; evidence: the family's own absoluteMaxMs is the exact window in which a tombstone can still matter** | Time-bound (`consumedAtMs + absoluteMaxMs`), never count/oldest-first — the owner's anchor is the oldest entry, so oldest-first eviction re-creates the SEC-045 no-op. |
| Tombstone memory bound | **invariant; basis: external-constraint; evidence: a flat per-family cap (`8 × maxTokens`) is a concrete memory ceiling; pruning is against the family deadline and fires invalidation** | Checked BEFORE mint (never return a then-revoked token); a breach invalidates the OFFENDING family only (not a global "heaviest", which could punish an innocent family); pruning calls `invalidateFamily` (closing streams), never a silent delete. No per-request rate-limit, so no individual legitimate refresh is rejected; strict reuse-detection already stops an attacker accumulating tombstones, so the cap only bounds a pathologically-reconnecting legitimate client (cost: one re-PIN). |
| Gate on `POST /dashboard/session/revoke-all` | **invariant; basis: enumerable-domain; evidence: the request carries either a valid step-up proof or it does not** | Reuses the deterministic credential-route gate (master OR step-up-proven `dst_`); a plain `dst_` is denied. |

## Multi-machine posture

`DashboardSessionStore` and the `revoke-all` control are **machine-local BY DESIGN**.

`machine-local-justification: physical-credential-locality` — a `dst_` session is a live, in-memory browser-session credential bound to the specific agent-server process the browser unlocked against (the PIN proof happened against that process; the token digests, family map, and tombstones live in that process's heap). A `dst_` minted on machine A cannot be presented to machine B's server (different process, different token map), so there is **no cross-machine dashboard session to revoke**, and replicating live session tokens across machines would WIDEN the stolen-credential blast radius, not shrink it. This matches the existing per-process posture of `dashboardOperatorSessions`/`phoneDesktopSessions`, which are already cleared per-process on a PIN change. The STATE (the tokens) is machine-local because it must be; the revocation ACTION, however, is already unifiable and unified: a fleet-wide "sign out everywhere" exists today as **PIN rotation**, which fans out through the PIN's existing replication channel so each machine's `syncDashboardPinVersion` independently fires its own `revokeAll()`. So the honest posture is: the per-machine `revoke-all` control is the complement to that existing fleet-wide path, NOT a failed attempt at one — which is exactly why it is named for its real scope ("this agent") rather than "everywhere." A dedicated cross-machine revoke-all RPC is deliberately NOT added here: it would duplicate the fleet-wide eviction PIN rotation already provides, and this change is a dark completeness fix, not a new multi-machine subsystem. (Bidirectional check: a `unified` posture for the STATE is infeasible — replicating live heap-bound session credentials across machines is the wrong direction — while a `unified` posture for the ACTION already exists via PIN rotation, so nothing fleet-wide is silently missing.)

## Maturation plan

This fix is not an independent feature — it completes the revocation side of `security.dashboardScopedToken` (SEC-002b) and matures together with it, never ahead of it.

- **test-agent-live:** enabled (`security.dashboardScopedToken.enabled: true`) on a throwaway test agent, with every revocation path exercised live: PIN rotation ends `dst_` sessions; reuse of a consumed token → family invalidated → re-PIN; logout with an old/consumed/expired token ends the family; a family's streams close at the deadline (timer) and on next delivery.
- **dev-agent-live:** enabled on Echo (the development agent) only as part of the SEC-002b full live dashboard proof — the scoped-token feature and its revocation are proven together end-to-end before any fleet flip.
- **fleet:** enabled fleet-wide only after dev-agent-live passes AND the SEC-002b graduation criteria are met; revocation is per-machine, so each machine graduates its own store.
- **graduation criterion:** the SEC-002b live dashboard proof passes AND all four store-lifecycle invariants are verified live on the dev agent against a real browser plus real WS/SSE streams (not only unit tests).
- **dark-window:** ships dark behind `security.dashboardScopedToken.enabled` (default false); it flips only together with SEC-002b, never independently, so it has no standalone dark window of its own.
- **ladder:** not applicable: this revocation-completeness fix adds no feature flag of its own; it hardens the existing dark `security.dashboardScopedToken` feature (SEC-002b), whose own ladder entry is a separate follow-up.

## Open questions

*(none)*
