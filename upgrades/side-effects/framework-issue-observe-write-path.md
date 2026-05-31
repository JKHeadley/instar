# Side-effects artifact — framework-issue ledger write path (POST /framework-issues/observe)

## 1. What files/state does this change touch at runtime?
Only the existing `framework-issue-ledger.db` SQLite file (under `<stateDir>/server-data/`),
via the ledger's existing `recordObservation` + `updateIssue` methods (WAL, busy_timeout
already configured). No new files, tables, or schema. No config keys added.

## 2. Does it gate, block, or constrain any agent/session/message?
No. The ledger is observability-only and this is a write surface for it. It never gates a
job, blocks a message, kills a session, or influences any decision path. Purely additive
record-keeping.

## 3. What happens on bad/malicious input?
Required fields missing → 400. Invalid bucket/severity/status enum → the ledger's
`assertEnum` throws → 400. `status:'wont-fix'` without a reason → ledger throws (§13.7) → 400.
Free-text fields are length-bounded + secret-scanned by the ledger's existing
`sanitizeFreeText`/`scanForSecret` (unchanged). No SQL injection surface (parameterized
statements inside the ledger). Bearer-auth required (same middleware as all non-/health routes).

## 4. Migration parity — do existing agents get it?
The route ships in code (no migration needed for the endpoint itself — it rides the existing
`ctx.frameworkIssueLedger` wiring that GET routes already use). Agent awareness IS migrated:
templates.ts registry row (new agents) + an idempotent, content-sniffed migrateClaudeMd
paragraph (existing agents) guarded on `framework-issues/observe`. Re-running the migration is
safe (content-sniff). The feature-delivery-completeness allowlist was updated so CI tracks it.

## 5. Could it spam / flood / burn resources?
No. A write is one SQLite upsert. There is no loop, no polling, no LLM call, no message send,
no spawn. Idempotent on dedupKey, so repeated imports collapse. No notification is emitted.

## 6. Rollback / off-switch?
The route is dormant when the ledger is unavailable (returns 503 — same as the GET routes).
Reverting the PR removes the route with zero residual state (any recorded rows remain valid
ledger data and are harmless; they can be left or pruned). No flags, no dark-launch needed —
the surface is inert until called.

## 7. Concurrency / multi-process safety?
The ledger uses WAL + busy_timeout=5000 (existing). The server is the in-process writer; the
backfill importer writes THROUGH the server's HTTP route (not a second DB handle), so there is
a single writer. The one-shot importer is run manually, not on a schedule. No new concurrency.

## Blast radius
Minimal. New additive HTTP route + one CLAUDE.md awareness paragraph + a one-shot importer
script + tests. No change to any existing route, gate, sentinel, schema, or decision path.
