---
title: "Welcome banner is framework-aware"
slug: "banner-framework-aware"
author: "echo"
eli16-overview: "banner-framework-aware.eli16.md"
review-convergence: "2026-05-22T00:42:00Z"
review-iterations: 1
review-completed-at: "2026-05-22T00:42:00Z"
review-report: "docs/specs/reports/banner-framework-aware-convergence.md"
approved: true
---

# Welcome banner is framework-aware

## Problem statement

End-to-end Codex install attempt on instar-codey (v1.2.15) surfaced
a cosmetic-but-confusing inconsistency. After picking "Codex CLI" at
the bareword runtime prompt, the wizard's welcome banner printed:

```
  Welcome to Instar

  Note: Instar runs Claude Code with --dangerously-skip-permissions.
  …
```

But the user picked Codex, not Claude. The banner was hardcoded and
didn't read the resolved `framework` value.

Justin's catch: *"we still log a warning for claude code even when
codex is selected"*.

## Proposed design

In `src/commands/setup.ts`, replace the single hardcoded banner line:

```ts
console.log(pc.yellow('  Note: Instar runs Claude Code with --dangerously-skip-permissions.'));
```

with two local consts that derive from the in-scope `framework`
variable (already declared earlier in `runSetup`):

```ts
const runtimeLabel = framework === 'codex-cli' ? 'Codex CLI' : 'Claude Code';
const sandboxFlag = framework === 'codex-cli'
  ? '--dangerously-bypass-approvals-and-sandbox'
  : '--dangerously-skip-permissions';
console.log(pc.yellow(`  Note: Instar runs ${runtimeLabel} with ${sandboxFlag}.`));
```

The rest of the banner (the "operates autonomously" / "behavioral
hooks" / "scoped access" explanation) is framework-neutral and
stays unchanged.

## Decision points touched

Trivial. One log-line edit; the rest of `runSetup` is unaffected.

## Open questions

None.

## Out of scope

- Other places setup.ts hardcodes Claude-specific terminology (if
  any). Scope is the welcome banner Justin called out.
- Banner content beyond the runtime line.
