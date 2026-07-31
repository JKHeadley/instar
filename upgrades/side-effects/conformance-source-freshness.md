# Side effects: conformance source freshness

## Scope

- `npm run build` emits two additional generated files in both `src/data/` and
  `dist/data/`: `standards-guard-index.json` and its meta file.
- `GET /conformance/coverage` and `/conformance/coverage/health` keep their existing
  routes and top-level compatibility fields. `summary.guards` adds checkable freshness
  provenance: configured and resolved paths, basis, freshness verdict/reason, index SHA,
  registry SHA, and package version.
- No config, database, migration, network call, notification, or write to an agent's
  project tree is added.

## Runtime behavior

The read-only audit performs a bounded candidate lookup when first requested. For each
landmark-complete candidate it computes only the evidence the audit already consumes.
The existing route cache avoids repeating the work on unchanged inputs.

When a live checkout exactly matches the packed evidence, refs are evaluated against that
real path. With no checkout, verified packed evidence preserves analysis. A marker-only
tree with no matching index is never allowed to earn a trustworthy ratio.

## Compatibility and rollback

The change is additive on the HTTP payload and generated package data. Existing clients
that read `summary.guards.projectDir`, `analyzable`, or `markersFound` continue to work.
Rollback is code-only: older versions ignore the extra packed files. Removing the new
resolver restores configured-tree probing but also restores the stale-tree defect.

## Failure and observability

Missing, malformed, hash-mismatched, registry-mismatched, or version-mismatched index
artifacts do not get guessed around. The report carries
`basis: configured-tree-unverified`, `freshnessVerified: false`, and a reason; with a
package-stamped registry that state is `assessmentConfidence: untrustworthy`.

All new best-effort catches are narrow candidate failures and include inline
`@silent-fallback-ok` justifications. They never convert absence into freshness.

## Verification

- Unit: stale landmark-complete tree rejected; exact matching tree selected; no-match
  boundary returns null; real report carries a 64-hex index SHA and zero dangling refs.
- Integration: production `/conformance/coverage` exposes the resolved real checkout and
  freshness provenance.
- Packaging: source-only setup and real generator remain byte-identical; a real npm
  tarball contains the index and matching meta.
