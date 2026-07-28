# Side-effects review — analysis-paralysis-guard on the fresh-init path

**Change:** one `fs.writeFileSync` in `installHooks()` (`src/commands/init.ts`), mirroring the sibling
line for `self-stop-guard.js` directly above it.

| Surface | Effect |
|---|---|
| Fresh init | **Now writes `analysis-paralysis-guard.js`** — the fix. |
| Existing agents (migrator) | Unchanged — already installed it. |
| Hook behaviour | None. Same content from the same `getHookContent()` source. |
| Other hooks | None. |

## Why parity rather than the allowlist

The test offers `INSTALL_VS_MIGRATE_KNOWN_GAPS` — add the filename with a rationale and it passes.
That is the wrong instrument here. It exists for hooks that *genuinely should not* ship on fresh init;
this one has no such reason. Using it would have converted an oversight into a documented decision
nobody actually made, and left new agents without the guard indefinitely.

One line, and both paths now install the same file from the same source, so they cannot drift.

## Blast radius

`installHooks()` is the single seam every init path funnels through (fresh, existing, standalone,
`refreshHooksAndSettings`), so one line covers all of them — and it is idempotent, which is the
property that makes writing on every path safe.

The hook itself is advisory: it injects a checklist, never blocks a tool call, never fails a session.

## Verification

- `tests/unit/migration-parity-hooks.test.ts`: **5/5 green**; the parity assertion failed before with
  `Newly-unaccepted: [analysis-paralysis-guard.js]`.
- Placed immediately after the `self-stop-guard.js` line so the two guards stay visibly adjacent.
