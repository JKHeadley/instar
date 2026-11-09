# Linux unit test environment fixes

## What Changed

Fixed unit test fixtures and timing assumptions so Linux results do not depend on `TMPDIR`, ambient temp-parent git directories, host scheduling delay, or source-poller cadence. Agent-owned memory now uses the established fixed OS temp-root rule instead of treating a configured home-based `TMPDIR` as a throwaway location.

## What to Tell Your User

Agent memory works consistently when a Linux machine has its temporary directory configured under the user's home. Test checks on Mac and Linux also behave consistently. No action is needed.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| Consistent agent-owned memory classification | Runs automatically when linking a login to an agent's memory. |

## Evidence

Targeted tests with `TMPDIR` set and unset, plus the full unit suite with at most six workers, are recorded in the PR and report.
