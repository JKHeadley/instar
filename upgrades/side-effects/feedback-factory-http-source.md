# Side-effects review — feedback-factory HttpParitySource adapter

Spec: `docs/specs/feedback-factory-migration.md` (converged v2, approved 2026-05-26).
Increment: the live Portal `/api/instar/read` adapter implementing the existing
`ParitySource` seam. Single new src module + its unit test; zero edits to existing
code.

## What this ships

The HTTP adapter behind the dry-run/compare seam after Dawn's architectural pivot
(committed Portal-side at `d65136b3b6`): Prisma Data Platform forbids `CREATE ROLE`/
`GRANT`/`REVOKE` for any account including superusers, so a read-only Postgres role
couldn't be minted. Dawn replaced direct DB access with a Portal-internal endpoint
`GET /api/instar/read` (max 1000 rows/request, Bearer-token-authed,
`instar:read` scope, JSON envelope with `data.{feedback,clusters,dispatches}` +
`meta.{total_feedback_rows,returned_count,query_time_ms,timestamp}`).

`HttpParitySource` implements `ParitySource` by pre-fetching that snapshot via an
async `prepare()` and serving it through the existing sync `readPortalClusters()`
read. The runner's seam, comparator (parity.ts), invariants, audit trail
(JSONL), and `divergent === true` cutover gate are unchanged — only the read
adapter swaps. This is exactly what the dependency-injection seam was for.

## Over-block / under-block

- **Errors**: any non-OK Portal response throws `HttpParitySourceError` with the
  preserved status code. No silent partial snapshots — a 401/403/5xx surfaces
  immediately and halts the prepare(). This is the right direction (false
  block is recoverable; a silent partial snapshot would produce a phantom
  "divergent" verdict that blocks Phase 4 cutover for the wrong reason).
- **Malformed cluster rows**: a row missing required fields (`clusterId` / `type`
  / `title`) throws, NOT silently skipped. A contract violation from Portal is
  exactly the kind of thing we need to see, not hide.
- **Field naming tolerance**: the mapper accepts both camelCase (Prisma default)
  and snake_case (raw SQL projection) — chosen because Dawn's endpoint contract
  doesn't pin the projection style and over-strictness here would cause
  needless live-rollout friction.
- **Snapshot freshness**: `prepare()` is idempotent — re-calling re-fetches.
  Callers that want a stable snapshot for one dry-run pass simply call it once;
  callers that want a fresh snapshot per pass call it per pass. Neither path is
  blocked.
- **`readPortalClusters()` before `prepare()`**: throws (no silent empty array).
  An empty snapshot would also produce a phantom "divergent: false" verdict that
  would mis-gate cutover.

## Level-of-abstraction fit

- The adapter lives in `dryrun/` next to `dryRunCompare.ts` because it is the
  composition's read-source, not a pure piece of the processor logic
  (`processor/` stays pure / decision-only).
- It implements the existing `ParitySource` interface verbatim — the seam was
  designed for exactly this swap. The runner doesn't know whether it's reading
  from `InMemoryParitySource` or `HttpParitySource`; that's the test/live
  symmetry the migration spec called for.
- `fetch` is injected via `fetchImpl` so unit tests can stub it. The default
  uses the runtime's global `fetch` (Node ≥18 / modern fetch).

## Signal-vs-authority compliance

Still signal-only. The adapter produces data; the runner produces a verdict; no
authority to act flows from this code. Portal stays sole writer (the
read-only API surface does not expose mutation). The cutover authority remains
where the spec puts it: Dawn's line-by-line review + Justin's go/no-go.

## Interactions

- **Portal `/api/instar/read`**: the only external surface this adapter touches.
  Read-only by Dawn's design (no PUT/POST/DELETE in the endpoint contract). The
  Bearer token (`instar:read` scope) sits in the adapter's config — never logged,
  never persisted by the adapter, owned by the caller. Token delivery happens
  out of band via Secret Drop (in-memory only, never on disk, never in chat
  history).
- **`ParitySource` interface, `runDryRunCompare`, `parity.ts`**: unchanged. No
  edits to existing feedback-factory code — additive only.
- **No config, hook, route, template, or migration surface is touched.** No
  Migration Parity / Agent Awareness obligation triggered.
- **Pagination contract**: keyed off the feedback table (`returned_count <
  pageSize` = exhausted). Clusters/dispatches per Dawn's contract accompany
  each page; the adapter dedupes clusters by `clusterId` across pages, so
  repeated clusters across pages cost only the network round-trip, not
  correctness. Safety cap at `maxPages` (default 200 = 200k feedback rows)
  prevents infinite-loop pathology if Portal returned the wrong meta.

## Rollback cost

Trivial. One new `src/feedback-factory/dryrun/HttpParitySource.ts` plus its test.
Nothing imports it from production paths yet. Reverting removes the adapter
without any downstream impact.

## Deferrals

- **Live verification** waits on the `instar:read` token landing via the open
  Secret Drop. The adapter + 10 unit tests fully prove the read shape, mapping,
  pagination, error path, and prepare-invariant against a stubbed `fetch`; the
  live token only exercises the actual Portal endpoint. <!-- tracked: topic-12476 -->
- **Cursor-based pagination** (a Last-Modified-style cursor instead of offset)
  is not used: Dawn's documented contract is offset/limit. If she adds a cursor
  later, the adapter takes one config field and a small page-loop tweak. The
  current offset-with-dedup is correct under offset semantics. <!-- tracked: topic-12476 -->
