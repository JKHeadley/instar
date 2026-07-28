# Side-effects review — no-empty-catch-blocks lint (post-mortem lever D)

## What changed

A new unit-tier lint refuses any bare `} catch {}` block in `src/**/*.ts`
runtime code unless it carries the existing `@silent-fallback-ok`
annotation (or has a non-empty body).

The seven existing offenders on main are annotated in this same PR, so the
ratchet baseline starts at **zero** — every future bare catch must be
annotated or made non-empty before commit.

This is COMPLEMENTARY to the existing `no-silent-fallbacks.test.ts` lint:
- That lint catches "true fallbacks" (catches that produce a degraded
  value: `return null`, `return []`, etc.) and ratchets at baseline 186.
- THIS lint catches "truly empty" catches (no body at all, no return, no
  comment, no log). The shape that swallows errors into pure nothing.

## Why

Per the 2026-05-29 pipeline post-mortem (PR #545), pattern #4 was
"silent failure caught only by user." The worst recent instance was the
**PromptGate $452 incident** — a bare `catch {}` in a 5-second hot-path
detection loop that swallowed every rate-limit failure for hours,
bypassing both QuotaTracker and LlmQueue spend guards. By the time it
surfaced, it had burned $452 of credits.

The shape is so cheap to write (zero characters of body) that it
happens by reflex when an author wants to bypass a throw without
thinking about WHY. This lint refuses to ship them without a documented
rationale.

This is the post-mortem's lever D: the last of the small remaining
post-mortem PRs (B — real-world-state fixture tests — deserves its own
conversation).

## Risk surface

- **Excludes template-literal hosts.** `PostUpdateMigrator.ts` and
  `commands/init.ts` embed JS code generation that includes `catch {}`
  blocks in the EMITTED output. Those are reviewed via the hook-script
  surface (`migration-parity-hooks.test.ts` from PR #545,
  `secret-externalization-hook-resolver-lint.test.ts` from PR #542) and
  via the shipped hook content. Including them here would create
  noise; the exclusion is documented in the lint's source.
- **Excludes tests.** Test files often use bare catch to ignore expected
  exceptions during assertion setup.
- **The `@silent-fallback-ok` annotation honors both ON-LINE and
  ABOVE-LINE placement.** Matches the existing convention used in
  `TrustRecovery.ts`, `SyncOrchestrator.ts`, and elsewhere.
- **Existing offenders annotated in-PR.** `PasteManager.ts` (×7: unlink
  cleanup, stat-accumulator, audit append, pending-index read) and
  `server/routes.ts` (×1: tunnel-url access fallback). Each annotation
  documents WHY the silent swallow is safe. None were changed
  functionally — only annotated.
- **Ratchet baseline = 0.** New code cannot add an unannotated bare
  catch without the lint blocking the commit.
- **Bonus regression check on `PromptGate.ts`.** A focused
  zero-tolerance test on the file that gave the post-mortem its
  poster-child incident. Even if the global ratchet were ever bumped,
  PromptGate.ts specifically can never have a bare catch reintroduced.

## Bug surfaces eliminated

- A future "swallowed error caused a $X incident" of the PromptGate
  shape is structurally impossible to introduce without the annotation
  forcing a documented rationale.
- The annotation requirement creates a natural code-review checkpoint
  ("why is this swallow safe?") at the point where the silent failure
  would have been introduced — much earlier in the lifecycle than
  "user noticed".

## Migration footprint

None — this is a lint addition. No runtime change, no fleet migration.

## Testing

- Unit: `tests/unit/no-empty-catch-blocks.test.ts` — 4 tests:
  1. Files-to-analyze sanity.
  2. Ratchet baseline of 0 (the seven existing offenders are
     annotated; this asserts the count stays at zero).
  3. PromptGate-specific zero-tolerance regression check.
  4. Annotation-honoring sanity (verifies the parser still respects
     `@silent-fallback-ok` — guards against the parser regressing into
     a state where the annotation stops working).
- Verified positive (passes on current code) and
  destructive-negative (adding a fresh unannotated bare catch makes
  the ratchet trip with a clear message naming PromptGate and the
  post-mortem context).

## Follow-ups

- The existing `no-silent-fallbacks.test.ts` lint has a ratchet baseline
  of 186 but a current count of 403 (drift across May 28+ shipping). Its
  exclusion from the push gate is tracked in
  `[bug_preexisting_main_suite_failures]` memory. Separate workstream;
  not addressed here.
- Post-mortem lever B (real-world-state fixture tests) remains. That's
  the biggest design effort of the five and deserves its own
  conversation rather than a quick-ship.
