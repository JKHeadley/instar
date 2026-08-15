# Upgrade Guide — vNEXT

<!-- assembled-by: assemble-next-md -->
<!-- bump: patch -->
<!-- internal-only -->

## What Changed

`scripts/lint-sync-subprocess-chokepoint.js` — the forward ratchet that keeps raw
synchronous subprocess spawns out of the runtime hot path, so a blocked-but-alive
server is never mistaken for a dead one — now resolves bound names.

It matched the spawn NAME on the call line, so two ordinary forms walked past
while the plain call was caught. Measured with a positive control firing in the
same run:

```ts
import { execFileSync as run } from 'node:child_process';  run(...);   // exit 0 — EVADED
const ex = execFileSync;                                   ex(...);    // exit 0 — EVADED
```

A renamed import is not an evasion; it is how a name collision gets resolved.

**Neither form appears anywhere in the scanned directories today** (0 local
aliases, 0 renamed imports, against a control of 53 files carrying plain named
imports), so this is a pure forward ratchet: the frozen baseline does not grow
and nothing existing can break.

**Scope reversed by measurement.** `VIOLATION` also excludes a DOT-prefixed name,
and there are 14 namespace-form occurrences in the scanned dirs — "14 invisible
blocking spawns" would have been the headline. Counting what they *are*:
**13 are `SafeGitExecutor.execSync(`**, i.e. calls THROUGH the audited git funnel
(flagging them would report correct use of the funnel as a bypass of it), and the
**1 remaining sits inside a generated hook script's template literal**, which runs
in its own process and cannot block this event loop. All 14 exclusions are
correct; the dot-exclusion is left alone and pinned by two tests so it is not
"fixed" later.

Added `collectSyncSpawnAliases()` (renamed imports from `(node:)child_process`,
and bare local aliases) and `aliasCallRegex()` (carrying the same dot-exclusion as
the original rule). `VIOLATION`, `FUNNELED`, `ALLOW`, the baseline format and the
exit codes are unchanged.

## What to Tell Your User

None — internal change (no user-facing surface).

## Summary of New Capabilities

None — internal change (no user-facing surface).

## Evidence

- `tests/unit/sync-spawn-alias-resolution.test.ts` — 12/12 green.
- **Negative control: 4 of 12 fail** against the shipped lint (exactly the four
  defect cases). The other 8 pass both ways and are the controls. Script restored
  byte-exact after the control.
- Six anti-over-block controls, because this lint fails builds — the two that
  matter most: an aliased spawn wrapped by `withSyncOp` is still NOT flagged (the
  funnel is the required pattern; overriding it would punish the code the rule
  exists to produce), and an aliased spawn carrying an allow-comment is still NOT
  flagged.
- Real tree: `exit 0` before AND after. `tsc --noEmit` exit 0. Full `npm run lint`
  chain exit 0.
- Declared open in the source: dot-prefixed names (measured correct), cross-module
  aliases, and `const ex = <ns>.execFileSync`.
