# Side-Effects Review — Codex usage over HTTP (GET /codex/usage)

**Version / slug:** `codex-usage-visibility`
**Date:** 2026-05-30
**Author:** Echo (instar-dev agent)
**Second-pass reviewer:** not required (no block/allow/lifecycle decision surface)

## Summary of the change

Adds a read-only way to see codex account rate-limit usage (the codex `/status`
windows) without the interactive TUI. A new reader
(`src/providers/adapters/openai-codex/observability/codexRateLimitReader.ts`)
finds the newest codex rollout, tail-reads its freshest `token_count`
`rate_limits`, and returns a structured snapshot. A new route
(`src/server/routes.ts` → `GET /codex/usage`) surfaces it. Discoverability +
awareness via `src/server/CapabilityIndex.ts` (capabilities entry),
`src/scaffold/templates.ts` (new-agent CLAUDE.md section), and
`src/core/PostUpdateMigrator.ts` (existing-agent back-fill). Also registers two
prior dark/operational migrator sections in
`tests/unit/feature-delivery-completeness.test.ts` that were untracked
(pre-existing red on main). No runtime decision point is touched.

## Decision-point inventory

- No decision point. The reader returns data; the route returns it over HTTP.
  Nothing is gated, blocked, filtered, or routed based on the result. The route
  is read-only (GET) and Bearer-gated by the existing auth middleware (not new
  logic).

---

## 1. Over-block

**No block/allow surface — over-block not applicable.** The route is a read-only
GET that returns 200 with either the snapshot or `available:false`. It rejects
nothing.

## 2. Under-block

**No block/allow surface — under-block not applicable.** There is no failure
mode the change is meant to catch-and-stop; it only reports.

The closest "miss" is data freshness: the snapshot reflects the last
`token_count` codex wrote, which can lag the true account state by up to one
codex turn. This is acceptable and documented — it is the same data the `/status`
screen shows, which is also turn-stamped. Callers that need to react to a hard
exhaustion should treat `rateLimitReachedType` as the authoritative "we are
limited now" flag (codex sets it when a window is actually hit).

## 3. Level-of-abstraction fit

Correct layer. It sits in the openai-codex observability namespace alongside
`sessionPaths`/`usageMeterProvider` (it reuses `listAllRollouts`), and is exposed
through the same HTTP routes layer as the other read-only observability surfaces
(`/tokens/*`, `/sessions/reap-log`). It does NOT belong in the
`UsageMeterProvider` interface, because that interface's `read()` is a generic
token-accounting contract and this is codex-specific authoritative rate-limit
data — conflating them would muddy the `isAuthoritative()` semantics (the meter
is correctly non-authoritative; these windows ARE authoritative). A future
refactor could expose this through a dedicated authoritative-windows method, but
the standalone reader is the right minimal surface now.

## 4. Signal vs authority compliance

**Compliant.** This is a pure signal producer with zero blocking authority (ref
`docs/signal-vs-authority.md`). It reads on-disk data and returns it. The
model-swap policy that will *consume* this signal is a separate change; keeping
the reader authority-free is exactly the prescribed split (brittle/cheap signal
at the edge, decisions made by a downstream consumer).

## 5. Interactions

- **Shadowing:** none. No other route serves `/codex/usage`; no existing reader
  parses `rate_limits`. It reuses `listAllRollouts` (read-only) but does not
  change it.
- **Double-fire / race:** none. Stateless per-request disk read; no writes, no
  locks, no shared mutable state. Concurrent requests each open + close their own
  file handles.
- **Adjacent cleanup:** the codex rollout files it reads are owned/rotated by the
  codex CLI; this reader never deletes or mutates them, so it cannot race
  rollout rotation destructively (a rotated-away file just yields the next
  newest, or `null`).
- **Capabilities lint:** the new `/codex` prefix is now classified in
  `CapabilityIndex`, satisfying the capabilities-discoverability lint (verified
  green).

## 6. External surfaces

- **New HTTP route** visible to any Bearer-authenticated caller: `GET
  /codex/usage`. It exposes the account's codex rate-limit percentages, reset
  times, plan type, and active model — the same information the account owner
  already sees on the codex `/status` screen. No secrets, tokens, or message
  content are exposed.
- **CLAUDE.md** gains a "Codex Usage" section for new agents (templates.ts) and
  existing agents (migrator back-fill, idempotent content-sniff). This changes
  agent-visible instructions, handled per Migration Parity.
- **Timing dependence:** only freshness (see §2) — bounded by codex's per-turn
  write cadence. No dependence on conversation state or uncontrolled runtime
  conditions.

## 7. Rollback cost

Low. Pure additive feature. Back-out = revert the route + reader + the
CapabilityIndex/template/migrator/test entries. No data migration, no agent-state
repair, no release coordination beyond a normal patch. The migrator block is
idempotent (content-sniffed on `/codex/usage`), so partial application or re-run
is safe.
