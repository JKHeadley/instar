---
title: "Graduate the single-instance hostname-flap auto-heal to a fleet-wide default"
date: 2026-08-03
author: echo
status: draft
parent-principle: "A Dark Feature Guards Nothing (G3) — a load-bearing recovery guard must not ship dark on the agents that need it"
review-method: internal-6-reviewer (security, scalability, adversarial, integration, decision-completeness, lessons-aware) + external cross-model panel
approved: false
eli16-overview: single-instance-autoheal-fleet-default.eli16.md
supervision: tier0 (deterministic boot-path predicate; no LLM in the decision)
topic: 29723
tracking: "GitHub JKHeadley/instar#1553 (+ comment 5169879856); evolution action ACT-1210"
---

# Graduate the single-instance hostname-flap auto-heal to a fleet-wide default

## 1. Problem

`SingleInstanceLock` is the boot-time fork-bomb guard (P2 of `forkbomb-prevention-simple.md`). It refuses to start a second server instance of an agent on the same host. When it finds a lock stamped with a **different hostname**, it treats that as a shared-state-dir misconfiguration and refuses — permanently.

macOS `os.hostname()` is **not a stable machine identity**. With `scutil --get HostName` unset (the default), it is derived from DHCP and flaps between forms — e.g. `mac.lan` ↔ `Justins-MacBook-Pro-144.local` — by network, across reboots, on the same physical machine. After a flap, a dead-holder lock stamped with the *previous* name looks FOREIGN, and the agent wedges at every boot.

The recovery for exactly this already exists and is correct: `autoHealStaleHostRename` reclaims such a lock **iff** all hold —

- the holder pid is **DEAD** on this host, **and**
- the heartbeat is older than `staleHostRenameMs` (default 300 000 ms), **and**
- `df -P` confirms the state dir is on a **host-local disk**

— falling through to refuse-loud on any unmet condition. The `df -P` host-local check is the load-bearing one: a host-local disk cannot be shared by a second host, which is the *only* hazard the foreign-host branch exists to prevent.

**The defect is the default, not the logic.** `src/commands/server.ts:3873`:

```ts
autoHealStaleHostRename: silCfg?.autoHealStaleHostRename ?? resolveDevAgentGate(undefined, config),
```

`resolveDevAgentGate` resolves **TRUE on a development agent, FALSE on the fleet**. So the only agent that survives a hostname flap is the dev agent. Every fleet agent fails closed forever into supervisor backoff.

### 1.1 Observed impact

Three separate incidents, all the same mechanism:

| Date | Impact |
|---|---|
| 2026-07-08 | Single agent wedged, crash-looped every boot (`mac.lan` ↔ `Justins-MacBook-Pro-99`) |
| 2026-07-22 | **Fleet-wide: 5 agents down ~11 h** |
| 2026-08-03 | **4 of 6 agents down**; `inspec` logged **109 consecutive bind failures** over ~7 h |

On 2026-08-03 the surviving agents were exactly the ones with the flag on. Verified on live v1.3.1121:

| agent | `developmentAgent` | auto-heal | outcome |
|---|---|---|---|
| echo | `true` | **ON** | survived every flap |
| inspec / ai-guy / indra-instar / sagemind | absent | OFF | **all wedged** |

Echo's survival had previously been attributed to lucky boot timing. It was not — echo is the dev agent and had the fix enabled the whole time.

### 1.2 Why this is the G3 class

`A Dark Feature Guards Nothing` (G3) covers a guard a critical path depends on that sits silently unguarded. Recovery-from-a-stale-lock is load-bearing by definition: its failure mode is a **silent multi-hour outage**, which has now occurred three times. A guard whose entire purpose is restoring service must not default off on the population that needs it.

## 2. Goals / Non-goals

**Goals**

- G1. Fleet default for `autoHealStaleHostRename` becomes `true`.
- G2. Already-deployed agents actually receive it (Migration Parity Standard).
- G3. Every condition of the existing evidence bar is preserved bit-for-bit.

**Non-goals (explicitly out of this change)**

- N1. Re-keying the lock on `machineId` / `LocalHostName` instead of `os.hostname()`. A stable identity key is the deeper fix and is worth doing, but it changes the lock record format and its compatibility story — a materially larger blast radius than flipping a default whose logic is already dogfooded. Tracked separately. <!-- tracked: JKHeadley/instar#1553 -->
- N2. The **detection** gap: 109 consecutive refusals produced zero attention items, only exponential backoff into silence. Independent of this fix — a lock that refuses N times running should surface once. Tracked separately. <!-- tracked: ACT-1210 -->
- N3. Any change to `resolveDevAgentGate` itself, or to any other flag that uses it.

## 3. Design

### 3.1 The default flip

```ts
// Hostname-flap auto-heal. Operator override wins; otherwise ON for every agent.
// Graduated from the dev-agent gate 2026-08-03 — see
// docs/specs/single-instance-autoheal-fleet-default.md.
// Fail-closed inside acquire(): dead holder + stale heartbeat + df -P host-local.
autoHealStaleHostRename: silCfg?.autoHealStaleHostRename ?? true,
```

Precedence is unchanged and explicit:

1. `monitoring.singleInstanceLock.autoHealStaleHostRename` (operator, either direction) — wins.
2. Otherwise `true`.

An operator who has deliberately set `false` keeps `false`. This is a `??` on an optional key, so only `undefined` falls through — an explicit `false` is honored.

### 3.2 Migration (required)

A code default reaches **new installs only**. Every already-deployed agent has a config written before this change; without a migration they stay wedge-prone, which is precisely the failure this spec exists to end.

`PostUpdateMigrator.migrateConfig()` gains an idempotent entry:

- If `monitoring.singleInstanceLock.autoHealStaleHostRename` is **absent**, set it to `true`.
- If it is **present** (either value), leave it untouched — an operator's explicit `false` is a deliberate choice and is never overwritten.
- Idempotent: a second run is a no-op (existence check, not value check).

This writes the key explicitly rather than relying on the code default, so the agent's on-disk config states its posture — and a later default change cannot silently flip an install that has already been migrated.

### 3.3 What is NOT touched

`SingleInstanceLock.ts` gets **no logic change**. Specifically preserved:

- `deps.autoHealStaleHostRename ?? false` — the class default stays `false`. The class is the mechanism; the *policy* lives at the wiring site. A test constructing the class directly still gets the conservative default.
- All three conditions of the bar, unchanged.
- The `df -P` host-local classifier, unchanged.
- The refuse-loud `else` branch, unchanged.
- `duplicate-live-instance` handling, unchanged.

## 4. Safety analysis

The question that matters: **does this weaken the fork-bomb guard?**

No. The guard has two distinct refusal reasons, and this change touches only one path within one of them:

| Scenario | Before | After |
|---|---|---|
| Same host, holder **alive** | refuse (`duplicate-live-instance`) | **unchanged** — refuse |
| Same host, holder dead, host-local | reclaim | **unchanged** — reclaim |
| Same host, holder dead, **not** host-local | refuse (fail-closed) | **unchanged** — refuse |
| Foreign host, holder **alive** | refuse | **unchanged** — refuse (`holderDead` false) |
| Foreign host, holder dead, heartbeat **fresh** | refuse | **unchanged** — refuse (`hbStale` false) |
| Foreign host, holder dead, stale, **not** host-local | refuse | **unchanged** — refuse (`df -P` false) |
| Foreign host, holder dead, stale, host-local | **refuse (the bug)** | **reclaim** |

Only the last row changes. In that row a genuine second host is **impossible**: `df -P` has confirmed the state dir is on local physical media (`/dev/*`, rejecting `//` SMB and `host:` NFS forms), so no second machine can be holding that lock. The record is provably this machine under a former name.

The true fork-bomb hazard — **two live instances on one host** — is gated by `pidAlive`, which this change does not touch. A live holder refuses on every path, before and after.

**Fail-closed direction is preserved.** `isStateDirHostLocalForLock` returns `false` when `df` fails, times out, or is unparseable. A degraded environment therefore refuses rather than reclaims.

**Blast radius of being wrong.** If the analysis above were wrong, the failure mode would be two servers for one agent on a shared volume. Mitigations: the flag is per-agent revertible in one key with no restart of anything else, and the shared-volume configuration it protects against is explicitly documented as unsupported.

## 5. Signal vs authority

This change does not add authority. `SingleInstanceLock` already holds blocking authority over server boot. The change **narrows an over-block**: it removes a false-positive refusal driven by a brittle input (`os.hostname()`) in the one case where three independent pieces of evidence prove the refusal is wrong. Movement is toward less brittle blocking, which is the direction `docs/signal-vs-authority.md` requires.

The decision remains fully deterministic — no LLM, no heuristic scoring. Tier 0.

## 6. Test plan (three tiers)

**Tier 1 — unit (`tests/unit/`)**

Each condition of the bar, both directions:

1. Foreign host + dead holder + stale heartbeat + host-local → **reclaims**.
2. Foreign host + **live** holder + stale + host-local → refuses `foreign-host-conflict`.
3. Foreign host + dead + **fresh** heartbeat + host-local → refuses.
4. Foreign host + dead + stale + **not** host-local → refuses (the shared-volume case that must still fail closed).
5. Foreign host + dead + stale + host-local, but flag explicitly `false` → refuses (operator override honored).
6. `df` throws / times out / returns garbage → refuses (fail-closed).
7. Heartbeat absent / zero / non-numeric → refuses (`hbStale` false).
8. Class default remains `false` when `autoHealStaleHostRename` is omitted from deps.
9. Wiring: `silCfg` absent → resolves `true`; `silCfg.autoHealStaleHostRename === false` → resolves `false`; `=== true` → `true`.

**Tier 2 — integration (`tests/integration/`)**

10. `migrateConfig()` adds the key when absent; leaves an explicit `false` untouched; leaves an explicit `true` untouched; is idempotent across two runs.
11. A config with no `monitoring` block at all is migrated without clobbering sibling keys.

**Tier 3 — E2E (`tests/e2e/`)**

12. Production-shaped boot: write a lock stamped with a foreign hostname whose pid is dead and heartbeat stale, on a host-local state dir → the server **boots** and acquires the lock (before this change it exited 1). This is the "feature is alive" test — it is the exact scenario that took four agents down.

## 7. Rollback

Per agent, one key, no code change, no restart of unrelated services:

```json
"monitoring": { "singleInstanceLock": { "autoHealStaleHostRename": false } }
```

Fleet-wide: revert the one-line default and the migration entry. No data migration, no state repair — the lock file format is unchanged, so a rolled-back binary reads existing locks normally.

## 8. Decision points touched

| # | Decision point | Class | Justification |
|---|---|---|---|
| D1 | **Foreign-hostname lock: reclaim or refuse boot?** (`SingleInstanceLock.acquire()`) | `invariant` | Deterministic by design and correctly so. The predicate is three objective, independently-measurable facts — pid liveness, heartbeat age against a fixed threshold, and a `df -P` filesystem-source classification. There are no competing signals to weigh and no ambiguity for an arbiter to resolve: either the disk is local physical media or it is not. Introducing judgment here would add a failure mode (an LLM in the boot path) to a decision that has a provably correct deterministic answer. Fail-closed on every unmeasurable input. |
| D2 | **Default value of `autoHealStaleHostRename` when the operator has expressed no preference** | `invariant` | A static policy default, not a runtime decision — evaluated once at wiring time from config, with no inputs to weigh. This spec changes the constant; it does not introduce a decision. |

No decision point in this change gates information flow, filters messages, or chooses among competing signals. Nothing here is a `judgment-candidate`.

## 9. Verify the State, Not Its Symbol (P20)

The guard's whole defect is a symbol/state confusion, so this section is load-bearing.

| | |
|---|---|
| **Symbol** | `existing.hostname !== os.hostname()` — a string inequality |
| **Claimed state** | "a *different physical machine* holds this lock" |
| **Is the symbol proof?** | **No — and that is the bug.** `os.hostname()` is DHCP-derived when `HostName` is unset, so the symbol changes while the state does not. Three incidents are the evidence. |
| **Corroboration** | Causally tied and independent of the hostname string: (1) `pidAlive(existing.pid)` — a live process is a direct observation of the claimed state, not a proxy for it; (2) heartbeat age — a running holder refreshes it, so staleness is caused by the holder's absence; (3) `df -P` filesystem source — the *only* way a second host can hold this lock is a shared filesystem, and this reads the mount's actual backing device rather than any name |
| **Symbol present, state absent** | The case this spec fixes: hostname differs, no second machine exists. Caught by all three corroborations agreeing. |
| **State present, symbol absent** | A genuine second host that happens to report the *same* hostname string. Unaffected by this change — such a lock never enters the foreign branch at all, and is handled by the same-host path, where `pidAlive` (cross-host: pid not present locally) and the `df -P` check on a shared mount both still gate it. This change neither improves nor degrades that case. |
| **Unmeasurable** | `df` failing, timing out, or returning an unparseable source ⇒ `isStateDirHostLocalForLock` returns `false` ⇒ **refuse** (the least-harmful action: a refused boot is loud and recoverable; a wrongly-permitted second instance is the fork-bomb). A missing, zero, or non-numeric heartbeat ⇒ `hbStale` false ⇒ refuse. No unmeasurable input is ever collapsed to a permissive value. |

## 10. Multi-machine posture

**Posture: machine-local BY DESIGN.**

`machine-local-justification: hardware-bound-resource`

The lock's entire semantic content is "a server process for this agent is running **on this physical host**". It is bound to hardware in two irreducible ways: it asserts liveness of a **pid in this host's process namespace**, and it lives on **this host's local disk** (`<stateDir>/local/server-instance.lock`), with `df -P` actively enforcing that boundary. Replicating it would be incoherent — another machine's pid number carries no meaning here, and a replicated lock would manufacture exactly the cross-host conflict the guard exists to prevent. A `unified` posture is not merely unnecessary but **infeasible and unsafe** for this surface.

Surface-by-surface:

- **Lock file** — machine-local (above). Never replicated, never proxied.
- **Config key `monitoring.singleInstanceLock.autoHealStaleHostRename`** — per-agent config, following whatever posture the agent's existing config distribution already has. This spec introduces no new replication path and no new merged read.
- **User-facing notices** — none. This change emits log lines only; no attention item, no Telegram message, so no one-voice gating is required.
- **Generated URLs** — none.
- **Durable state that could strand on topic transfer** — none. The lock is boot-scoped and host-scoped; it has no relationship to topics or their placement.

## 11. Frontloaded Decisions

Both questions that would otherwise stop the build mid-run are decided here.

**FD1 — The migration writes the key explicitly rather than relying on the code default.** `migrateConfig()` sets `autoHealStaleHostRename: true` on disk when the key is absent, rather than migrating nothing and letting the new code default carry deployed agents. Rationale: an agent's on-disk config then states its own posture, so a future default change cannot silently flip an already-migrated install, and `GET /guards`-style posture reads reflect reality rather than an implicit constant. Cost is a few lines of migration code, paid once. *(Not cheap-to-change-after: it writes durable state into every deployed agent's config, so reversing it later means a second migration.)*

**FD2 — `staleHostRenameMs` stays at its current 300 s default.** Not touched by this change. Five minutes of a dead pid *plus* a stale heartbeat *plus* a host-local disk is already a conservative bar; widening it only lengthens outages, and narrowing it is unnecessary since the pid-liveness check — not the timer — is what carries the safety. *(Cheap-to-change-after: a single numeric config key, per-agent overridable, no durable side effect.)*

## 12. Open questions

*(none)*
