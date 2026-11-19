# Room in the core instruction file again

<!-- bump: patch -->

## What Changed

The core part of an agent's instruction file (CLAUDE.md) had reached its 84,000-character limit (83,999 on main), so any change that added a row or an awareness entry failed the size test at the end of a full test run. The longest rows of the "Registry First" table and the "Feature Proactivity" list are now short: each keeps its question or trigger, the first lookup, and any "never" rule, and ends "(→ Lookup details)". Their full text, unchanged, is in a new reference section, "Lookup details". Fourteen further rows name the route (`GET /jobs`) in place of a full curl command; the table's first sentence explains that this means the agent's own server with the auth header. The core is now 77,990 characters. A new unit test fails when a row under those two headings exceeds 400 characters or when less than 2,000 characters remain under the limit. The limit itself is unchanged.

## What to Tell Your User

Nothing changes in what your agent can do. Its starting instructions are a little shorter, and the longer explanations it used to carry at all times are now looked up when needed.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Lookup details reference section | Automatic: short rows in the core point to it |
| Early warning when the core instruction file is nearly full | Automatic in the unit tests (`tests/unit/claude-md-core-headroom.test.ts`) |

## Evidence

Measured by generating a fresh agent and running one update: before, 82,187 after init and 83,999 after update; after, 76,178 and 77,990. Longest row under the two headings: 303 characters (was 1,037); none over 400 (was 13). Unit tests: the new guard plus `awareness-entry-registry`, `claude-md-reference-layout`, `report-delivery-as-document` and `migrate-context-budget-sentinel-row`, 5 files, 99 tests passed; twenty further unit files that match row text pass unchanged. `tsc --noEmit` clean.
