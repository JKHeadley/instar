# Side-Effects Review: asdf detection convergence fixes (memoize + dead-fallback)

## Change
Two fixes to `src/core/Config.ts detectFrameworkBinary`, surfaced by the /spec-converge
review of the approved master spec (`docs/specs/codex-full-parity-fixes.md` §7, C1+C2):

1. **C2 — memoize detection.** `detectFrameworkBinary` is now a thin cache wrapper over
   `detectFrameworkBinaryUncached`, with a per-process `Map` caching positive AND negative
   results per framework name (+ a test-only `_resetFrameworkBinaryCache()`). `loadConfig` calls
   both `detectClaudePath` + `detectCodexPath` on every invocation and isn't cached; uncached, a
   Claude-only host paid the full `asdf which` + `which` subprocess cost for codex on every config
   load. Binary locations don't change within a process lifetime, so caching is safe.
2. **C1 — fix the dead `asdf which` fallback.** It shelled out to `asdf` by bare name, but `asdf`
   is itself off the stripped launchd/login PATH — the exact headless env the asdf shim search
   exists for — so the fallback threw and did nothing ("looks like a fallback, does nothing"
   anti-pattern). Now it resolves the `asdf` binary by ABSOLUTE path (`$ASDF_DATA_DIR/../bin/asdf`,
   `~/.asdf/bin/asdf`, homebrew, /usr/local) and only shells out if found.

## Why
The PRIMARY fix (the `$ASDF_DATA_DIR/shims/<name>` existence check) is PATH-independent and was
already correct + live-proven. These two fixes harden the surrounding code the review flagged: the
fallback now actually works when present, and the added asdf probe no longer inflates the cost of
the (uncached, hot) `loadConfig` path on hosts where codex isn't found.

## Scope / blast radius
- Pure runtime function. Memoization changes nothing observable except fewer subprocesses; the
  negative-cache means a binary installed mid-process-life isn't detected until restart — acceptable
  (matches reviewer guidance; binary locations are stable per process). `_resetFrameworkBinaryCache`
  is test-only.
- The absolute-asdf resolution only adds a few `fs.existsSync` checks; behavior unchanged on
  non-asdf hosts. No migration needed (runtime code, ships with dist).

## Signal vs Authority / Over-block
- N/A — detection only, no gating.

## Rollback
- Revert the Config.ts wrapper + asdf-bin resolution. No data/config/on-disk artifact.

## Tests
- `detectFrameworkBinary.test.ts`: +1 memoization test (repeated calls return the same cached
  result); the asdf-shim test now resets the cache before asserting. 9 green. tsc clean.

## Publish
- Feature branch `echo/codex-parity-audit` (rebased onto JKHeadley/main before PR). Patch release.
