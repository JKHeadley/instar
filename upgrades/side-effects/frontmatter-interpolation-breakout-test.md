# Side-effects review — Frontmatter interpolation breakout test

## What changed

New unit test `tests/unit/scheduler/JobScheduler.frontmatter-breakout.test.ts` asserts the structural defense the spec calls out:

> Frontmatter-field interpolation breakout — any frontmatter field interpolated into prompt must pass slug regex or be JSON-stringified; breakout payload tested.

The current implementation already meets the spec: `JobScheduler.buildPrompt(job)` for `execute.type: "agentmd"` does NOT interpolate any frontmatter field into the prompt. The body is the prompt; framing constants (notification protocol, view metadata) come from source-level string literals, not from job data.

This test ASSERTS that property so a future refactor introducing frontmatter interpolation cannot land without (a) breaking this test and (b) forcing the author to think about breakout surface.

## Side-effects review

### 1. Over-block / under-block

- **Over-block:** none — the test asserts what the code already does. Pass rate today: 100%.
- **Under-block:** the test covers four breakout categories (shell injection, template injection, prompt injection, null-byte / control characters) plus an explicit "rendered prompt contains body verbatim" assertion plus a slug-regex defense assertion. If a future refactor introduces a NEW breakout surface I didn't anticipate, the four-category coverage still catches the common shapes.

### 2. Level-of-abstraction fit

Pure unit test. Calls `JobScheduler.buildPrompt` (private, accessed via type-cast escape — same pattern as other internal tests in the suite). No new code paths, no new behavior.

### 3. Signal-vs-authority compliance

The test is a signal that the no-interpolation property is intact. The authority is `buildPrompt` itself — which is the single point that decides what string becomes the spawn's `--prompt` argument.

### 4. Interactions

- **Phase 1b agentmd dispatch** — the test covers the same path Phase 1b shipped.
- **Phase 2 templates** — the templates themselves are markdown bodies; this test asserts that even if someone shipped a malicious frontmatter alongside a benign body, the malicious content never reaches the spawn.

### 5. Rollback cost

Trivial. Single test file. Delete to revert.

## Test coverage

6 cases in `tests/unit/scheduler/JobScheduler.frontmatter-breakout.test.ts`:

1. Shell-injection frontmatter payload absent from rendered prompt
2. Template-injection frontmatter payload absent
3. Prompt-injection frontmatter payload absent
4. Null-byte / control-character payloads absent
5. Body bytes are present verbatim; frontmatter bytes are not
6. Slug regex rejects all breakout-shaped slugs (defense-in-depth)

All 6 pass locally. Lint + type-check pass.
