---
approved: false
parent-specs:
  - CROSS-MACHINE-SEAMLESSNESS-SPEC.md
  - MULTI-MACHINE-BOOTSTRAP-ROBUSTNESS-SPEC.md
---

# Spec — Lease-Substrate Robustness (durable git renewal + clean bring-up)

## TL;DR

Driving the live cross-machine handoff demo on real hardware (laptop + Mac mini)
surfaced that the fenced lease is never durably renewed: **lease renewal confirms
over the in-memory HTTP tunnel transport and never re-writes the renewed lease to
the durable git substrate.** Because the tunnel transport is always wired,
renewal always takes the tunnel branch, so the git lease keeps its original
acquire-expiry and lapses after one TTL. Any git-based observer — a freshly
joined machine, a restarted server, anyone reading the shared repo — sees the
lease expired and legitimately re-acquires it. Result: the lease bounces between
machines and a fresh join hijacks a live holder. This spec makes the durable git
substrate the renewal source of truth (tunnel as accelerator on top), sweeps the
remaining no-upstream `git pull` callsites, and locks the fix with the live
single-take handoff demo as the E2E gate.

## §1 — Diagnosed root causes (all code-confirmed on the live mesh, 2026-05-28)

1. **Renewal never persists to git (PRIMARY).** `LeaseCoordinator.renew()`:
   ```
   if (this.d.tunnel) { confirmed = await this.d.tunnel.broadcast(renewed); }
   else               { confirmed = this.d.store.refresh(renewed); }   // git
   ```
   `server.ts` ALWAYS constructs the `HttpLeaseTransport` tunnel, so the `else`
   (git refresh) is never taken on renewal. `HttpLeaseTransport.broadcast()`
   returns `true` for a single-machine mesh (no peers = "nothing to fail"), so
   renewal reports success while the durable git lease is never updated. The git
   substrate only ever receives the lease on ACQUIRE (`casWrite`), never on
   RENEW. So to any git observer the lease perpetually expires after one TTL.
   **This is the bounce.** (The spec comment claims "degrades to git-only when
   the tunnel is unavailable" — but the branch makes the tunnel a *replacement*
   for git, not an *accelerator on top of* it.)

2. **No-upstream `git pull --rebase` (SECONDARY).** Multiple callsites do a bare
   `git pull --rebase --autostash` (`GitSync.ts` sync path lines ~310/312/375/661)
   which fails with "Please specify which branch you want to rebase against" when
   the branch has no upstream. The lease store pulls before every CAS/refresh, so
   this can also block renewal. `GitSync.pullRebase()` (lines ~587/591) is already
   fixed upstream-aware; the remaining sync-path pulls are not. (Bug #1 fixed
   PUSH upstream-awareness; PULL has the same gap.)

3. **Sub-TTL renew cadence (already fixed, formalize).** Renewal previously ran
   only on the 2-min heartbeat timer while the lease TTL is ~60s, so even a
   working git renewal lapsed between renewals. `MultiMachineCoordinator`'s
   `leaseTickTimer` now renews at `leaseTtlMs/2`; this spec keeps + tests it.

4. **Fresh-join failover off a stale seed (already fixed, formalize).** A
   freshly-joined standby evaluated failover-eligibility against a stale seed
   `lastSeen`. `LeaseCoordinator.primeFromDurable()` (pull before first decision)
   now closes the local-staleness window; this spec keeps + tests it. With
   root-cause #1 fixed (git lease stays fresh), this becomes belt-and-suspenders.

## §2 — Goal

A fresh two-machine bring-up reaches a STABLE single-holder state with NO manual
intervention, the durable git lease never lapses while the holder is alive, a
freshly-joined/restarted machine never hijacks a live holder, and the live
single-take handoff demo (operator messages the agent; a handoff fires mid-reply;
exactly one reply, no drop/double) passes — driven through the operator's real
Telegram.

## §3 — Solution (tracks; each its own PR + 3-tier tests + migration-parity)

### Track A — Durable git renewal (PRIMARY fix)
`LeaseCoordinator.renew()` ALWAYS persists the renewed lease to the durable
medium (`store.refresh`, git), and ADDITIONALLY broadcasts over the tunnel when
present (low-latency accelerator). Confirmation = durable refresh succeeded
(tunnel broadcast is best-effort). Preserve the self-suspend invariant: a holder
that cannot confirm over the durable medium for > leaseTtlMs self-suspends.
Re-validate the split-brain CAS gate is untouched.
- Files: `src/core/LeaseCoordinator.ts` (renew), possibly `GitLeaseStore.refresh`.
- Unit: renew writes the renewed expiry to the store even with a tunnel wired;
  single-machine renew persists to git; tunnel broadcast remains best-effort.
- Integration: a second reader observes the renewed (unexpired) lease in git after
  a renew cycle.
- E2E: two-machine mesh — holder renews; the durable lease's expiry advances
  every renew interval (never lapses).

### Track B — Upstream-aware pulls everywhere
Make every `git pull --rebase`/`--no-rebase` callsite upstream-aware (explicit
`origin <branch>` fallback), or guarantee branch tracking at home setup. Sweep
`GitSync.ts` (sync path + conflict-retry) + any other callsites.
- Unit/Integration: pull on a no-upstream branch succeeds via explicit origin.

### Track C — Sub-TTL renew cadence (formalize the shipped fix)
Keep `leaseTickTimer` at `leaseTtlMs/2`; invariant test that the renew interval
is strictly < leaseTtlMs.

### Track D — Fresh-join prime (formalize the shipped fix)
Keep `primeFromDurable()`; test with-vs-without priming.

### Track E — Live proof (E2E gate)
Clean two-machine bring-up on real hardware (laptop + mini, Bob/Echo untouched),
no manual git babysitting: stable single holder, lease never lapses, then the
single-take handoff-mid-reply demo through the operator's real Telegram (reply
work isolated to the lighter machine to protect production). Flip nothing until
this passes.

## §4 — Conformance (six Instar standards)
- **Structure > Willpower:** the fix is structural (renewal persists durably by
  construction), not a runbook.
- **LLM-Supervised Execution:** N/A (substrate plumbing); the E2E gate is the
  supervisor.
- **Testing Integrity (3 tiers):** every track ships unit + integration + the
  Track E E2E. The renewal-persists-to-git unit test is the Phase-1 "alive" test.
- **Zero-Failure:** full suite green before merge.
- **Agent Awareness:** no new agent-facing capability; CLAUDE.md unchanged (the
  multiMachine section already documents the lease).
- **Migration Parity:** no agent-installed file changes; fixes ship in the dist
  and reach existing agents on update. No config/schema migration.

## §5 — Rollback
Each track reverts independently; all changes are additive/defensive. Track A
reverts to tunnel-only renewal (the current, buggy-but-known behavior). No data
migration.

## Notes
Partial fixes for #2/#3/#4 already landed on PR #489 (honestly labeled partial).
This spec completes the set with the PRIMARY fix (#1) + the sweep + the E2E gate.
