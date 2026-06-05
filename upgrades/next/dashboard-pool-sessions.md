<!-- bump: patch -->

## What Changed

The dashboard sessions list now shows EVERY session across ALL machines in the
multi-machine pool, and every session row states which machine it runs on
(a machine-nickname badge). Sessions on the machine you're viewing stay fully
interactive (live terminal, close button); sessions on other machines appear
as informational rows with a tooltip pointing at the owning machine's
dashboard.

Under the hood: `GET /sessions` self-tags sessions with `machineId` /
`machineNickname` when the pool is wired, and a new `GET /sessions?scope=pool`
aggregates every reachable peer's session list (existing cross-machine Bearer
auth, 5s timeout per peer). A dead or slow peer degrades to a `pool.failed`
entry — the page never breaks. The plain `/sessions` route keeps its
back-compatible array shape.

## What to Tell Your User

Open the dashboard on any of your machines and you'll see all your sessions in
one list — each with a badge saying which machine it's running on. No more
opening one dashboard per machine to find a session.

## Summary of New Capabilities

- Dashboard sessions list shows every session across the pool with a machine badge per row.
- `GET /sessions?scope=pool` → `{ sessions, pool: { peersOk, failed, ... } }` (agents can answer "what's running across my machines?").
- `GET /sessions` sessions carry `machineId`/`machineNickname` on pooled installs.
- CLAUDE.md template bullet + idempotent migration so existing agents learn the capability.

## Evidence

Three tiers green: `tests/unit/dashboard-sessionMachineBadge.test.ts` (8),
`tests/unit/PostUpdateMigrator-poolSessionsVisibility.test.ts` (3),
`tests/integration/sessions-pool-scope.test.ts` (5 — including a REAL second
HTTP server as the peer and a dead-peer degradation case), and
`tests/e2e/sessions-pool-scope-lifecycle.test.ts` (3 — real AgentServer,
feature alive single-machine). tsc + lint clean.
