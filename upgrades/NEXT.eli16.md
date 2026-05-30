# vNEXT — plain English overview

## What this change is

In JavaScript/TypeScript, you can write `try { ... } catch {}` — a block
that says "do this, and if anything goes wrong, throw the error away
and continue silently." It's three characters of body and zero
explanation, and it's a really cheap shortcut that almost always means
"I don't want to think about this right now."

The problem: when an error gets thrown away silently, you don't find
out about it from a stack trace or a log line. You find out about it
when something downstream breaks, often hours later, often from a user.

The worst recent example was the **PromptGate $452 incident**. There
was a 5-second loop checking whether the LLM had hit its rate limit.
Inside that loop, a bare `catch {}` was swallowing every actual
rate-limit error. The loop kept burning credits at full speed —
hundreds of times per minute, sometimes for hours — because nothing
ever surfaced the problem. By the time someone noticed, we'd burned
$452 we shouldn't have.

This PR adds a unit-test lint that refuses any bare `catch {}` in
production code (`src/**/*.ts`, excluding tests and code-generation
hosts) unless it carries a comment annotation explaining WHY the
silent swallow is safe.

## What already exists

- An older lint called `no-silent-fallbacks.test.ts` that catches a
  related pattern: catches that return a degraded value (`return
  null`, `return []`, etc.).
- The `@silent-fallback-ok` comment annotation, already used in
  several places (`TrustRecovery.ts`, `SyncOrchestrator.ts`, etc.).
- `DegradationReporter` for emitting properly-tracked degradation
  signals.

## What's new

- A new lint test `tests/unit/no-empty-catch-blocks.test.ts` that
  scans for truly empty `catch{}` blocks and fails on any new ones.
- The seven existing bare `catch{}` sites are annotated in this same
  PR — five in `src/paste/PasteManager.ts` (file cleanup that's
  genuinely safe to silently fail) and three elsewhere. Each carries
  a one-line rationale.
- A focused regression check on `src/core/PromptGate.ts` — the file
  that gave the post-mortem its poster-child incident. It can never
  silently regress.
- The lint's ratchet baseline starts at zero. New bare `catch{}` in
  unannotated form fails the unit suite at commit time.

## What you need to decide

Nothing. Lint-only. No runtime change, no config, no fleet migration.

## How to verify it worked after deploy

Try writing a function with a bare `catch{}` in `src/`. Stage it. The
pre-commit gate's test step will fail with a clear message naming
PromptGate and the post-mortem. Fix: add `// @silent-fallback-ok —
<why>` above the catch, OR put a real body inside it.

## Why this matters more than it might look

This is the fifth post-mortem PR landing in roughly four hours. Each
one closes a recurring bug class, not just one incident:

- #542 — silent-403 on secret-externalization (config-reader didn't
  survive the security upgrade).
- #545 — failure-learning loop wiring + migration-parity tests.
- #550 — failure-learning git reads opt into the source-tree read
  escape hatch.
- #551 — `gh pr merge` refused on red checks (the watch-exit-merge
  class).
- THIS — bare `catch {}` refused in production paths.

Each of these patterns has cost real time + real money. Closing them
at the structural level (a lint, a test, a hook) is much cheaper than
relying on "we'll be careful next time."
