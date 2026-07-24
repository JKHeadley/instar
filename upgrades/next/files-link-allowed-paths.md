---
slug: files-link-allowed-paths
summary: Fix the dashboard file deep-link endpoint 403ing every request under the default allowedPaths config; unify the allowed-path policy into one shared check.
---

# File deep links work under the default config

## What Changed

`GET /api/files/link` carried a private, drifted copy of the allowed-path
check that never learned the `'./'` project-root convention — so on default
installs (`allowedPaths: ['./']`) every link request answered
`403 Path not in allowed directories`. The Layer 1–4 policy (normalize,
absolute/traversal rejection, never-served deny, allowedPaths match) is now
one exported helper used by both `validatePath` and the link route; the
duplicate is deleted. The link route is also stricter where the duplicate
was loose: traversal, absolute paths, and segment-boundary bypasses are now
rejected.

## What to Tell Your User

Dashboard file links work now. When your agent hands you a link straight to a
file in the dashboard's Files tab, it opens instead of failing — this was
broken on default settings. Nothing to configure.

## Summary of New Capabilities

- File deep links (`/api/files/link`) work under the default file-viewer
  config; the allowed-path policy has a single implementation shared by all
  file endpoints, so the two can no longer drift apart.
