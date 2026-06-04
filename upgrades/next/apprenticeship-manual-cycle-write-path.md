# Upgrade Guide - vNEXT

<!-- bump: patch -->

## What Changed

- Apprenticeship cycle capture now has a stricter manual HTTP write path: `POST /apprenticeship/cycles` rejects non-object bodies and rejects unknown `channel` values instead of silently recording typos as `unknown`.
- `/capabilities` now lists the apprenticeship cycle routes alongside the instance routes, including manual create, list, fetch, overdue, role coverage, and close operations.
- Generated and migrated CLAUDE.md guidance now explains when to record a manual overseer cycle and names the supported `kind` and `channel` values.

## What to Tell Your User

- **Apprenticeship cycle capture**: "I can now record manual overseer review cycles in the apprenticeship program with a clear source channel, so the program keeps better evidence about how each mentorship loop actually ran."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Manual apprenticeship cycle recording | Use the apprenticeship cycle route to record an overseer or manual review cycle with the instance, task, output, findings, coaching, and channel. |
| Apprenticeship cycle discovery | The capabilities view now advertises the cycle routes instead of only the instance lifecycle routes. |

## Evidence

Focused local verification passed: apprenticeship route integration, AgentServer apprenticeship lifecycle, and CapabilityIndex tests all passed together. Full dev preflight passed with lint and capability discoverability checks. The requested smoke command ran against the committed branch diff and exited successfully, but its affected-test listing timed out and it reported CI as the authority.
