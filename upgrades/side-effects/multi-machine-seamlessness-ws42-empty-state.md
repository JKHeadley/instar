# Side-Effects Review — WS4.2: explicit per-machine empty-state in the pooled sessions view

**Version / slug:** `multi-machine-seamlessness-ws42-empty-state`
**Date:** `2026-06-13`
**Author:** `Instar Agent (echo)`
**Spec:** `docs/specs/MULTI-MACHINE-SEAMLESSNESS-SPEC.md` §WS4.2 (converged + approved)
**Second-pass reviewer:** workflow review lens — CONCUR (1 LOW: a harmless unused dashboard JS param; no behavior impact).

## Summary of the change

WS4.2 (F7): the pooled sessions view now renders an explicit per-machine empty-state
instead of just showing nothing for an idle/dark machine. `GET /sessions?scope=pool`
gains `pool.machines[]` — one entry per REGISTERED pool machine (self + every peer via
`listPoolMachines()`, the same accounting boundary `/guards?scope=pool` uses, NOT just
the online peers `resolvePeerUrls()` yields — that gap was the F7 blind spot). When a
machine has zero active sessions, a new pure classifier
(`src/server/poolEmptyState.ts` → `classifyMachineEmptyState`) derives one of three
states from REAL inputs (registry `online` + last-seen + the fan-out's classified
failure): `online — no active sessions` / `offline since <t>` / `unreachable (last
seen <t>)`. The dashboard renders the server-computed state (mobile-responsive, reusing
existing `.machine-status-row` CSS). Files: `src/server/poolEmptyState.ts` (new),
`src/server/routes.ts`, `dashboard/index.html`, `src/scaffold/templates.ts` +
`src/core/PostUpdateMigrator.ts` (awareness/migration parity).

Note: this PR SUPERSEDED a pre-existing weaker 2-state dashboard scaffold (online /
"not reachable") with the spec-required 3-state server-computed model, and moved the
classification server-side (one poll, not a separate `/pool` round-trip).

## Decision-point inventory

- `pool.machines[]` empty-state classification — **add** — observe-only render data;
  never gates anything. A machine WITH sessions gets no empty-state.

---

## 1. Over-block
N/A — no gate. The classifier is conservative in the SAFE direction: anything not
provably idle-or-offline → `unreachable` (never a fabricated "online"); missing
last-seen → "unknown" rather than a guess.

## 2. Under-block
N/A. A machine with sessions is never given an empty-state (the dashboard skips
`sessionCount>0`).

## 3. Level-of-abstraction fit
Right layer: a pure classifier (server-side, unit-tested) feeding a render field;
mirrors the proven `sessions?scope=pool` fan-out. Per-machine enumeration uses the
registry boundary (`listPoolMachines`), the correct source for "every machine," not the
online-only peer-url set.

## 4. Signal vs authority compliance
Pure observe-only signal. No blocking authority.

## 5. Interactions
- Plain `GET /sessions` (non-pool) unchanged; merged `sessions[]` + back-compat
  `pool.failed[]`/`peersOk`/`peersQueried` unchanged — `pool.machines[]` is additive.
- Dashboard now reads machine states from the SESSIONS response, dropping a weaker
  separate `/pool` round-trip (one poll). The Machines-tab `/pool` loader is untouched.
- The pre-existing tolerant catch in the pool branch was annotated `@silent-fallback-ok`
  (it degrades to a named `pool.failed` entry reported up-stack — the designed tolerant
  behavior, not a swallow).

## 6. External surfaces
- New additive field on an existing route (`pool.machines[]`); old callers unaffected.
- No new config flag, mesh verb, or CLI. Ships with the multi-machine pool.

## Framework generality
No framework-launch abstraction touched (does not modify `frameworkSessionLaunch.ts`).
N/A.

## 7. Multi-machine posture (Cross-Machine Coherence)
**proxied-on-read** — the empty-state is computed over the same pooled fan-out + the
registry membership; a dark/unreachable peer is surfaced honestly (its real reason),
never dropped. Single-machine install = strict no-op (a lone self row; the dashboard
strip only renders for 2+ machines). Phase-C clean: per-registered-machine enumeration,
no 2-peer assumption, honest derivation from real state.

## 8. Rollback cost
Trivial: additive field + a new pure file + a dashboard render refinement. Reverting
restores today's pooled view; no durable state; migrator bullet idempotent +
content-sniffed.

---

## Second-pass review
Workflow review lens: CONCUR — honest 3-state derivation from real registry/fan-out
state (no fabricated "online"); plain view unchanged; tolerant fan-out preserved;
migration+template parity present + idempotent; ratchets (feature-delivery-completeness,
no-silent-fallbacks) confirmed green; tsc clean. One LOW (a now-unused dashboard JS
parameter, `allSessions` on `renderMachineStatusStrip`) — harmless dead-param noise, no
lint failure, no behavior impact; left for an optional cleanup. Ship.
