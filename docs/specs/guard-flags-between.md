---
title: "Dangerous-command guard catches destructive git forms with flags in between"
slug: "guard-flags-between"
author: "echo"
parent-principle: "Structure beats Willpower"
eli16-overview: "guard-flags-between.eli16.md"
status: "draft"
approved: true
approved-by: "echo, on the coordinator's direction after the 2026-11-05 agent-home incident. Widens an existing floor; no constitution change."
review-convergence: "2026-11-05T21:30:00.000Z"
review-iterations: 1
review-completed-at: "2026-11-05T21:30:00.000Z"
review-report: "not applicable: a pattern widening with behaviour tests on both sides, recorded in the side-effects file."
---

- **ladder:** not applicable: no off-by-default switch; a safety pattern widening, shipped on.

## Problem

The guard matched literal phrases. On 2026-11-05 a hard reset with `-q` before the flag ran in a live agent home after a failed `cd`.

## Design

Three extended-regex patterns join the risky list in all three writers (template, `init.ts`, `PostUpdateMigrator`), allowing flags and global options between `git`, the verb and the destructive flag, without crossing a `;`, `&` or `|`. Covered: hard reset, clean with force, force-push. `--force-with-lease` is not matched by the new push pattern, and the existing own-branch carve-out is unchanged. The hook is always overwritten on update, so existing agents receive it.

## Tests

`tests/unit/dangerous-command-guard-flags-between.test.ts` runs the rendered template and migrator guards on blocked and allowed forms.
