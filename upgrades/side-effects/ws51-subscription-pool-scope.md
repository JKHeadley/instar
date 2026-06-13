# Side-Effects Review — WS5.1 (subscription-pool pool-scope visibility)

## Summary

Adds a read-side, additive `scope=pool` branch to `GET /subscription-pool` — the operator's
ONE view of "how much quota is left across ALL my machines / accounts." It mirrors the merged
WS4.1 `GET /sessions?scope=pool` fan-out exactly: fan out to every online mesh peer's PLAIN
`/subscription-pool` (no recursion), tag each account with the machine that holds it, and merge
into a dark-peer-tolerant object with a classified `pool.failed` list. No replication, no PII
machinery, no HLC, no new config flag. The placement tie-breaker half is DEFERRED (CMT-1416).

## Files changed

- **`src/server/routes.ts`** — the `GET /subscription-pool` handler gains an
  `if (req.query.scope === 'pool')` branch (registered BEFORE the plain return). Self accounts
  tagged `remote:false` + machine identity; a `Promise.all` fan-out over `resolvePeerUrls()`
  fetches each peer's PLAIN route carrying THIS machine's Bearer with a 5s timeout; remote
  accounts tagged `remote:true` + machineId/machineNickname; a non-OK/down/slow/unauth peer
  pushes a NORMALIZED `pool.failed` row (`unauthorized`/`error`/`timeout`/`unreachable`). The
  new peer-fetch catch is tagged `// @silent-fallback-ok`. The handler signature changed from
  sync `(_req, res)` to `async (req, res)` (the fan-out awaits). The plain (no-scope) path is
  byte-identical.
- **`src/scaffold/templates.ts`** — a "Quota across ALL my machines (pool-scope read)" bullet
  on the Subscription Pool section in `generateClaudeMd()` (new agents).
- **`src/core/PostUpdateMigrator.ts`** — the same bullet added to the section-install template
  AND an idempotent, content-sniffed additive-bullet patcher (`!content.includes('Quota across
  ALL my machines')`, anchored on the "poll all now" line) for existing agents that already
  carry the section. Mirrors the existing proactive-swap bullet patcher.
- **Tests**: `tests/unit/subscription-pool-scope.test.ts` (merge/tag/classify + 3 adversarial
  lenses), `tests/integration/subscription-pool-scope.test.ts` (real peer + 401 peer + dead
  port), `tests/e2e/subscription-pool-scope-lifecycle.test.ts` (feature-is-alive on the
  production AgentServer path).
- **Spec + ELI16 + release fragment**: `docs/specs/ws51-subscription-pool-scope.md` +
  `.eli16.md` + `upgrades/next/ws51-subscription-pool-scope.md`.

## Signal vs. Authority

This surface is a pure READ — it reports state, it never mutates or gates anything. The
fan-out carries THIS machine's own Bearer (its own authority, the same as the sessions route),
never a caller-supplied token (auth-boundary lens, tested). A peer that is down/slow/unauth is
the DESIGNED tolerant degrade reported up-stack in `pool.failed` (no-silent-fallbacks: the
catch is tagged `@silent-fallback-ok`); it never blocks, never 500s, never silently omits a
machine. The placement DECISION is untouched (the tie-breaker is deferred), so nothing in this
slice can move a live session.

## Framework generality

The capability is framework-agnostic — it reads the subscription pool registry + the mesh peer
set, neither of which is Claude-specific. A Codex/Gemini agent running a multi-account pool
gets the same pool-scope view. The CLAUDE.md awareness rides the existing Subscription Pool
featureSection whose shadow markers already mirror it to AGENTS.md / GEMINI.md (the section
heading is unchanged, so Codex/Gemini parity is preserved with no marker edit).

## Operator surface quality

The operator never types a curl. The conversational trigger is "how much quota is left across
ALL my machines?" — the CLAUDE.md bullet (new + existing agents) teaches the agent to reach for
`GET /subscription-pool?scope=pool` and to explain a dark peer honestly (a classified
`pool.failed` row, never a silent omission). The response is plain JSON the agent narrates; the
normalized failure reasons (`timeout`/`unreachable`/`unauthorized`/`error`) are
operator-legible and carry no internal URL or token.

## Blast radius / risk

- **Additive route-branch, no config flag.** The dark-gate line-map is UNCHANGED (verified
  16/16 green without editing the EXPECTED map) — no ConfigDefaults enabled-path was touched.
- **Back-compat preserved.** The plain `GET /subscription-pool` (no `scope`) returns the exact
  `{ enabled, count, accounts }` shape as before — verified by the existing
  `subscription-pool-routes` + `subscription-pool` unit suites staying green and an integration
  assertion that the plain route has no `pool`/`scope` keys.
- **Single-machine = strict no-op superset.** No peers / no `resolvePeerUrls` → the self-only
  view tagged `scope:'pool'` with empty `pool.failed`. An unwired pool → `enabled:false`,
  `accounts:[]`, still `scope:'pool'`.
- **No amplification.** The peer fetch hits the PLAIN route (no `scope=pool`), `Promise.all` is
  bounded by the live peer set, each fetch has its own 5s timeout — no fan-out storm on an
  N-machine pool.

## Deferred / tracked

- The placement tie-breaker (prefer the machine with more account-pool headroom on an
  otherwise-equal tie) is DEFERRED as `<!-- tracked: CMT-1416 -->`. `MachineCapacity` carries
  `quotaState.blocked` only — no per-account remaining%; plumbing aggregate account-pool
  headroom through the capacity heartbeat is larger than a clean small slice. The pool-scope
  READ ships alone. WS5.2 (account follow-me) / WS5.3 (escalation rides the topic) are separate
  surfaces.

## Rollback

Revert the single `feat` commit. The change is purely additive (a new query-branch + two
awareness bullets); reverting restores the prior sync handler and the prior CLAUDE.md template
with no migration cleanup needed (the additive migrator patcher is content-sniffed and simply
stops running once the source no longer carries the bullet template).
