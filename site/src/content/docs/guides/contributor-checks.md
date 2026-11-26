---
title: Contributor Checks
description: Read-only CLI checks for Instar contributors, run before a build, before a pull request, and when CI turns red.
---

These commands help when you change Instar itself. They only read: they never push, merge, or edit files.

## Before you build: is someone already on it?

```bash
instar dev:claim-check src/core/SessionManager.ts --keywords session reaper
```

Lists open pull requests and recently merged ones that touch the same paths, plus any spec under `docs/specs/` that matches the keywords. Run it before you start. Two sessions fixing the same thing in parallel is the most expensive way to lose a night. By default it only advises and always exits 0. `--strict` exits 1 on any overlap, so a script can stop on it.

## Before a pull request

```bash
instar dev:preflight
```

Runs lint and the CapabilityIndex discoverability tests, and warns about any new route prefix in your diff. It only reports. Fix what it reports before you open the pull request.

## When CI is red

```bash
instar dev:ci-failures 2874
```

Prints the exact failing tests for a pull request (file, line, and assertion), read from the GitHub check-run annotations. Use it when `gh run view --log` comes back empty. Before you patch a failure, check whether `main` fails the same way. A failure that also happens on `main` is not caused by your change. Fix it in its own change, or tell whoever owns `main`.
