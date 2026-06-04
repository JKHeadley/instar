# ELI16 — ESM require() bug fixes + standards-gate re-arm

## What this is, in plain English

Instar's code ships as "ESM" (modern JavaScript modules). In that world there is no
built-in `require(...)` function — the old way of pulling in another file. If code
calls a bare `require(...)` anyway, it doesn't politely fail; it throws a hard error
the instant that line runs.

Three files were doing exactly that, in code paths that DO run:
- `reflect.ts` — used when you run `instar reflect run` (the job-reflection feature).
- `SessionWatchdog.ts` — used every time the watchdog checks on a stuck session.
- `PostUpdateMigrator.ts` — used while detecting whether the Codex CLI is installed.

So these were real, latent bugs: the feature looks fine until that branch executes,
then it blows up (or, in the migrator's case, silently pretended Codex wasn't there).

## The fix

For the first two files, we add the one-line idiom the codebase already uses
elsewhere (`createRequire(import.meta.url)`) which gives back a real, working
`require` in the ESM world. The lazy-loading behavior stays identical — it just stops
throwing. For the migrator, it turned out the function it was lazily requiring was
already imported at the top of the file the normal way, so we just call that. No shim
needed; one redundant, broken line removed.

## Why nobody caught this earlier (the important part)

Instar has a test called `esm-compliance` whose entire job is to catch bare
`require()` calls. There is also a `no-silent-fallbacks` test that enforces a
standard you set: error-swallowing fallbacks must report themselves. Both of these
tests had been quietly moved into a "flaky tests" exclude list, so CI stopped running
them. A gate that doesn't run is not a gate — it's decoration. That is precisely how
three real `require()` bugs walked onto main.

So this change also RE-ARMS both gates (takes them out of the exclude list) after
fixing what they were complaining about. We also taught `esm-compliance` to recognize
the ONE legitimate use of `require` in ESM — `createRequire`, which is needed to
re-load a native database module after a rebuild, something the modern `import`
syntax genuinely cannot do — so it stops false-alarming on correct code.

## What you actually need to decide

Nothing risky here. This is a small bugfix plus restoring two safety nets that should
never have been switched off. The only judgment call already made: the
`no-silent-fallbacks` baseline number was corrected from a bogus 186 (set by a release
that skipped CI, while the true count was 431) to the real current count, with
evidence that no new fallbacks were introduced — just line-number shifts. If a big
mechanical refactor later bumps that number, that's the ratchet doing its job, and
someone bumps it again with a one-line justification, exactly as has happened before.

## Safeguards in plain terms

- The runtime fixes are behavior-preserving: same lazy load, it just no longer throws.
- Rolling it back is trivial — revert the commit and you're exactly where you started.
- The re-armed gates were run under the real CI config and pass before shipping.
