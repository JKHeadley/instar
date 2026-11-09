# Upgrade Guide — vNEXT

<!-- internal-only -->
<!-- bump: patch -->

## What Changed

The threadline-mcp publish workflow no longer bumps and publishes a patch on its own. It publishes only when `packages/threadline-mcp/package.json` carries a version newer than npm, and a matching version skips with a notice. Its packed-package smoke test no longer calls the terminal `pair` CLI that 0.5.1 removed; it checks that the installed package is the version the tree builds. Only source, manifest, lockfile, tsconfig and workflow changes trigger it now (#2243).

## Evidence

New `tests/unit/publish-threadline-mcp-workflow.test.ts` runs the workflow's own check step against a stub npm and fails 10 of 10 on the old workflow. Both smoke steps of the test job pass locally on a fresh build, and the check step against the live registry reports 0.6.1 equal to npm with `publish=false`. Nothing in the instar package changes.
