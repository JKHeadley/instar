# Conformance source freshness

## The problem

The standards audit checks whether every guard named by the constitution exists. It used
the agent's configured project directory. An agent home can contain an old copy of
`src/` with all the expected landmarks, so the audit confidently counted missing guards
that exist in current code.

Landmarks answer “could this be source code?” They do not answer “is this the source code
that belongs to the constitution and package I am auditing?”

## The repair

The build now creates a deterministic index of every audit-relevant file, route, and
symbol from the real source checkout. It stamps that index with:

- its own SHA-256;
- the constitution SHA-256; and
- the package version.

At runtime the audit checks a small, bounded set of plausible checkouts. A checkout wins
only if recomputing its complete guard index exactly matches the packed same-build index.
The configured agent home, `repo/` convention, current working directory, executing
package root, and sibling development-agent `repo/` directories are candidates; there is
no broad home-directory crawl.

If a matching checkout exists, the audit reads that live tree and reports its real path.
If an install has no checkout, it can still use the verified packed evidence rather than
deleting the capability. If neither basis verifies, landmark-only results are explicitly
untrustworthy.

## Why this catches the real failure

A stale tree may still contain `src/server/routes.ts` and `src/core`, so it passes the old
probe. It cannot reproduce an index containing current guard files, routes, and symbols.
The semantic test creates exactly that state: the stale tree passes both landmarks but is
rejected, while the matching checkout is selected.

On the measured machine, resolving with Echo's stale home configured selects the current
Codey worktree, reports zero dangling references, and exposes the selected path, basis,
index SHA, registry SHA, and package version in `summary.guards`.

## Limits

The index proves equality for the evidence this audit consumes, not byte-for-byte identity
of every source file. That is the correct boundary: this audit measures named-reference
existence, not source equivalence or guard execution. The SHA stamps are build consistency
checks, not adversarial signatures.
