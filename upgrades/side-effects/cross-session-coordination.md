# Side-Effects Review — Cross-Session Coordination Signal (light, advisory)

**Version / slug:** `cross-session-coordination`
**Date:** 2026-05-28
**Author:** Echo
**Spec:** `docs/specs/cross-session-coordination.md` (approved: Justin, topic 15579)

## Summary of the change

Adds a light, advisory cross-session coordination signal so concurrent Claude Code
sessions on one agent home can see each other's recent high-impact actions before
acting. Never blocks; never mutates target state.

Files:

1. `src/monitoring/CrossSessionCoordinator.ts` — **new.** Append-only ledger
   (`state/cross-session-actions.json`, atomic temp+rename, reload-per-op, TTL prune,
   hard cap) + JSONL audit (`logs/cross-session-events.jsonl`). `record()` computes
   `concurrent` = other recent actions within `windowMs` by a different/unknown actor,
   and returns an advisory `warning`. Advisory catch blocks carry `@silent-fallback-ok`.
2. `src/server/routes.ts` — module helpers (`DEFAULT_SENSITIVE_CONFIG_KEYS`,
   `flattenConfigFlips`, `coordinationActor`); new routes `POST /coordination/intent`
   and `GET /coordination/recent`; `PATCH /config` records sensitive-key flips and
   `POST /commitments/:id/withdraw` records withdrawals, each attaching a
   `coordinationWarning` to its own response. New `RouteContext.crossSessionCoordinator`.
3. `src/server/AgentServer.ts` — constructs the coordinator (own try/catch, always
   alive so reads stay 200) and injects it into the route context.
4. `src/config/ConfigDefaults.ts` — `monitoring.crossSessionCoordination` default
   (enabled, windowMs, retentionMs, sensitiveConfigKeys).
5. `src/server/CapabilityIndex.ts` — discoverability entry under `/coordination`.
6. `src/core/PostUpdateMigrator.ts` + `src/scaffold/templates.ts` — CLAUDE.md awareness
   section (migration + fresh-install template).
7. `src/data/builtin-manifest.json` — regenerated.
8. Tests: unit, integration (routes), e2e (lifecycle), migration-parity, ConfigDefaults.

## Decision-point inventory

- Advisory-only contract (record + warn, never block, never mutate) — **core decision.**
- Single-source recording of withdrawals in the route handler (not the
  CommitmentTracker event) — **decision** (avoids double-count; route is the single
  agent-facing path).
- Actor resolution is SESSION-level only, never agent id — **decision** (agent id is
  shared across a session and would suppress the warning).
- Intents are never deduped; only state-flips dedupe on kind+target+value — **decision.**
- Default-ON, no Telegram in v1 — **decision** (near-silent; avoids topic-spam).

## 1. Over-block

Nothing is blocked — the signal is advisory by contract. The worst over-reaction is a
`coordinationWarning` surfacing when two structural actions by different/unknown actors
land within `windowMs`, including the benign case of one operator running two of their
own sessions. The warning is informational; the action always proceeds. Unknown-actor
is treated as "potentially different," so a session that omits `X-Instar-Session` may
see a warning about its own earlier unattributed action — noisy but harmless, and
fixed by passing the header (documented in the awareness section).

## 2. Under-block

The signal only surfaces a warning, never prevents the opposing action, so the
original incident (two sessions taking opposing durable actions) is *surfaced*, not
*prevented*. That is the intended light-fix scope — Justin explicitly chose advisory
over hard locks. A session that ignores the warning still acts. Code-internal
commitment lifecycle transitions (expiry) are not recorded; only agent-initiated
route-driven withdrawals are.

## 3. Persistence / corruption

Ledger writes are atomic temp+rename and reload-per-op, so a second server process
can't clobber. A missing/corrupt ledger file reads as empty (correct first-run state).
All persistence failures are swallowed (`@silent-fallback-ok`) because a dropped ledger
write must never break the calling route — at worst a future advisory is weaker.

## 4. Migration parity

Config default lands in `SHARED_DEFAULTS`; `applyDefaults` (add-missing deep merge)
propagates `monitoring.crossSessionCoordination` to existing agents on update — no
bespoke config migration needed (unit-tested). CLAUDE.md awareness is added via
`migrateClaudeMd` (content-sniffed, idempotent) for existing agents and
`generateClaudeMd` for fresh installs (both unit-tested). The coordinator is
constructed default-on in AgentServer even when config lacks the key, so existing
agents get the behavior immediately on the new server version.

## 5. Rollback

Set `monitoring.crossSessionCoordination.enabled: false` → passive: `GET
/coordination/recent` still returns 200 (`enabled:false`), nothing is recorded, no
warnings. No data migration, no schema. Reverting the code removes two read/record
routes and an advisory field on two existing responses; no stored state depends on it.

## 6. Blast radius

In-process only. Touches two existing response payloads additively
(`coordinationWarning` is only present when non-null). No external calls, no Telegram,
no session kills, no file mutation outside the agent's own `state/` + `logs/`.
