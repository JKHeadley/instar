# Side-effects review — mirror resolves from the installed package

**Change:** `resolveExistingMirrorPath()` (new, filesystem-probing) resolves the
benchmark predictions mirror from the agent tree FIRST and the installed package
SECOND. `resolveMirrorPath()` stays a pure join.

## Why — the baseline I shipped hours earlier was unreadable

`BenchmarkDivergenceAnalyzer.mirrorStatus()` resolved via
`resolveMirrorPath(this.config.projectDir, …)` — the AGENT HOME only. That was
honest while no mirror shipped ("a dist-only install simply reports
`present:false`"). It stopped being honest the moment a baseline shipped INSIDE the
package at `src/data/benchmarkPredictions.json`.

Verified on the live pool, 2026-07-23:

- The published tarball contains `package/src/data/benchmarkPredictions.json`.
- The serving machine's agent home is **not** a source checkout: no `.git`, and its
  `src/data/` holds three unrelated files (`builtin-manifest.json`,
  `http-hook-templates.ts`, `pr-gate-artifacts.ts`).
- So `GET /benchmark-divergence` there reported `mirror.present:false` — the exact
  benign state it reported *before any baseline existed*.

**The failure mode is the indistinguishability, not the missing file.** A shipped
baseline that cannot be read and a baseline that was never captured produce an
identical observable. That is the third instance of this pattern found in one
session (see ACT-935).

Confirmed the mechanism itself works: placing the merged file into a genuine source
checkout yields `present:true, capturedAt` set, `staleDays:0`.

## Design

**Order is deliberate — the agent tree wins.** A developer with a locally
regenerated mirror must not have it shadowed by the shipped one. The package is the
floor, not the authority.

**Purity preserved.** An earlier attempt made `resolveMirrorPath` itself probe the
filesystem, which broke its existing pure-join contract test — correctly. The probe
now lives in a separate `resolveExistingMirrorPath`; only that one touches disk.

**Absolute paths never fall back.** An explicit `mirrorPath` is an instruction; it
is honored verbatim and `exists` is never consulted (a test asserts the probe throws
if called on that path).

**Package root is derived from this module's own location**, never from config and
never from a mirror field (a mirror field is untrusted data). Underivable ⇒ previous
agent-tree-only behaviour, unchanged.

## Blast radius

- One read-only observability route. Findings remain `advisory: true`.
- No new config key, no write path, no persisted state, no migration surface.
- The only behaviour change: an install that ships a mirror can now read it.

## Risk

**Could it read the WRONG mirror?** Only if an agent tree lacks the file and the
installed package has one — which is precisely the intended case. A stale package
mirror is bounded by the existing `staleDays`/`stale` reporting and the Q0
prompt-hash precondition, both unchanged.

**Test pins flipped, deliberately.** Three assertions pinned `mirror.present:false`
as the shipped state. With a baseline captured, `present:true` is correct, and the
flip is the ratchet doing its job rather than being worked around. A fourth test
(`BenchmarkDivergenceAnalyzer`) needed genuine isolation to keep testing the
missing-mirror path — it now passes an ABSOLUTE `mirrorPath` into a temp dir, which
by design never falls back. That also exposed a latent bug in that file's `config()`
helper: a trailing `...overrides` re-spread `benchmarkDivergence`, silently dropping
injected fields. Fixed by ordering.

## Testing

117 green across the registry, core, analyzer, routes, E2E-alive, migration,
job-template and ledger-byModel suites. `tsc --noEmit` clean. New unit coverage for
the resolver: agent-tree-wins, package-fallback, neither-exists, absolute-passthrough
(probe must not be called), and no-derivable-root.

## Rollback

Revert. Resolution returns to agent-tree-only and the shipped mirror goes back to
being invisible on non-source installs.
