# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Next increment of the **Feedback Factory Migration** (Dawn → Echo; spec `docs/specs/feedback-factory-migration.md`, approved). Ships the **live Portal adapter** behind the dry-run/compare seam after a clean architectural pivot from Dawn (committed Portal-side at `d65136b3b6`): Prisma Data Platform forbids `CREATE ROLE`/`GRANT` for any account, so a read-only Postgres role can't be minted. Dawn replaced direct DB access with a Portal-internal endpoint `GET /api/instar/read` — Bearer-token-authed (`instar:read` scope), max 1000 rows per request, returns the same three tables (feedback, clusters, dispatches) with paging metadata.

New module:

- **`src/feedback-factory/dryrun/HttpParitySource.ts`** — implements the existing `ParitySource` interface via that endpoint. Async `prepare()` pre-fetches a consistent snapshot (walking pages, deduping clusters by `clusterId`, stopping when `returned_count < limit`). Sync `readPortalClusters()` returns the snapshot. The runner's seam, the parity comparator, the three order-independent invariants, and the JSONL audit trail are all unchanged — only the read adapter swaps.

Still internal — not yet wired into any route or job. Live verification waits on the `instar:read` token landing via Secret Drop.

## What to Tell Your User

- Dawn hit a database-platform limitation (Prisma Cloud refuses to mint a read-only user) and pivoted to an internal HTTP endpoint instead. It's actually a cleaner seam — my dry-run tests against the same contract her Phase-2 work will use, with no Prisma-admin dependency.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| HTTP-backed live ParitySource for Phase-1/3 dry-run | Internal `src/feedback-factory/dryrun/HttpParitySource.ts` — `await new HttpParitySource({baseUrl,token}).prepare()`, then pass to `runDryRunCompare` |

## Evidence

- **10 new unit tests**, all green; full feedback-factory unit dir green; `tsc --noEmit` clean.
- **Both-sides-of-boundary**: Bearer auth + field mapping (camelCase AND snake_case tolerance), single-page snapshot + multi-page pagination with `clusterId`-dedup + `returned_count < pageSize` stop signal, `maxPages` safety cap, error-status preservation, malformed-row rejection (no silent skip of contract violations), prepare-before-read invariant, defensive-copy snapshot.
- **Faithful to the existing seam**: `HttpParitySource` is purely additive — implements the same `ParitySource` interface as `InMemoryParitySource`, so the runner / comparator / invariants / cutover gate are byte-identical for in-memory tests and the live Portal path.

Side-effects: `upgrades/side-effects/feedback-factory-http-source.md`.
