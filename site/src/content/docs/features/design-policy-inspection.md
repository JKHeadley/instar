---
title: Design Policy Inspection
description: A manual, read-only comparison of the Design Standard and screen registration between two committed versions of a repository.
---

# Design Policy Inspection

Instar keeps a written Design Standard for every screen a person sees, a registry of those screens, and a permanent list of rule identifiers. When a change touches a screen or the standard itself, a reviewer needs to know which screens it affects and whether any rule was removed or reworded. Design policy inspection answers those questions.

```bash
instar design:inspect --repo /path/to/repository --base BASE_COMMIT --head HEAD_COMMIT
```

## What it checks

The command compares two committed Git trees. You choose the trusted comparison commit (`--base`) explicitly; `--head` defaults to `HEAD`. It reads Git objects only, never working files, and never runs or imports code from either tree.

It reports four things:

- **Standard structure**: whether the Design Standard still parses into rules.
- **Permanent rule history**: any rule present at the base and missing at the head is reported as removed, including a rule whose heading no longer parses.
- **Screen registration**: which registered screens the change affects, and any user-facing source that is not registered.
- **Rules earned from feedback**: both versions of any reworded earned rule, so an independent reviewer can judge the change.

## What it does not do

The inspection has no merge authority. It does not approve a change, judge how a screen looks, run rendering or accessibility checks, grant exceptions, or block a merge. Even a clean result leaves every visual and review obligation in place. Those later stages belong to the design standards enforcement project.

## Results

The output is JSON with `scope: manual-design-policy` and `mergeAuthority: false`, the checks it ran, and the ones it did not. The status is one of `structurally-valid`, `findings`, `review-required`, `invalid-policy` or `unavailable`. The exit code is 0 for structurally valid, 1 for findings or review, and 2 when the inspection could not run, for example when a baseline predates the design files or a read budget is exceeded.

The full operating limits are in `docs/design/manual-inspection.md` in the Instar repository.
