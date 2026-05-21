# Side-effects review — SafeFsExecutor agent-runtime-state carve-out

**Scope**: `SafeFsExecutor.guard()` now bypasses `assertNotInstarSourceTree`
when the canonicalized target path is under a `.instar/` subdirectory of the
source root. New helper `isUnderAgentRuntimeState()` performs the check.

**Root cause of original issue**: When instar is deployed in "agent" mode (e.g.
`~/.instar/agents/<name>/`), the agent dir IS a checkout of the instar source
— same `.git`, same `.instar-source-tree` marker file, same `package.json`
with `name: "instar"`. The source-tree guard's three layers (marker, canonical
remote URL, source-identity signature) all correctly identify the agent root
as the instar source. But the agent's runtime artifacts live at
`<root>/.instar/` (sockets, locks, logs, audit trail, shared-state JSONL),
which are explicitly `.gitignored` and are NOT source code. Destructive ops
on those paths (e.g., `WakeSocketServer.stale-socket-recovery` unlinking a
stale `listener.sock`) are a normal part of operation, not a 2026-04-22-class
incident.

Before this fix, every unlink-the-stale-socket attempt in agent mode failed
with `SourceTreeGuardError`, the supervisor declared the server unhealthy,
escalated to its bind-failure recovery path, force-rebuilt better-sqlite3 on
every restart cycle, and the agent never bound to its socket. Observed in
the field 2026-05-21 on dawn-macbook Echo, immediately after v1.2.4.

**Files touched**:
- `src/core/SafeFsExecutor.ts` — added `isUnderAgentRuntimeState()` helper
  (interior-`/.instar/`-segment predicate, returns false when the marker is
  trailing) and a carve-out branch in `guard()` that audits as `allowed` with
  `reason: "agent-runtime-state-carveout"` when the predicate matches.
- `tests/unit/SafeFsExecutor.test.ts` — added `SafeFsExecutor agent-runtime-state
  carve-out` describe block with five tests (3 positive carve-outs, 2 still-blocked).
- `upgrades/NEXT.md` — release notes.

**Under-block (what's no longer caught)**: Operations on individual files and
nested directories under `<source-root>/.instar/<anything>`. Specifically:

1. **`.instar/listener.sock` (and other `.sock` files there)**. `.sock` files
   are agent runtime IPC endpoints; the project's own `.gitignore` covers the
   parent directories these would live under. The 2026-04-22 incident did not
   touch this path; risk is low.

2. **`.instar/lifeline.lock` (and other lockfiles there)**. Lockfile cleanup
   is mandatory for any LaunchAgent-style supervisor. Under-block is required
   for the supervisor to recover from stale locks.

3. **`.instar/state/*`, `.instar/logs/*`, `.instar/audit/*`,
   `.instar/instar-dev-traces/*`**. All four directories appear in the
   project's `.gitignore`. None contain source code. Destructive ops on stale
   entries here are normal house-cleaning. Under-block is intentional.

4. **`.instar/shadow-install/`**. The agent's pinned vendored copy of the
   instar package. Modified by `instar update` and `AutoUpdater`. Treated as
   runtime state, not source. The auto-updater needs to wipe-and-reinstall
   this directory; the carve-out unblocks that path under agent mode.

The carve-out is intentionally interior-only — the `.instar` directory itself
is still protected by the guard. A `safeRmSync` targeting `<source-root>/.instar`
still throws `SourceTreeGuardError`. This is verified by the
`still BLOCKS rm on the .instar directory itself (not its contents)` test.

**What stays caught**:

1. **All source files at the tree root** — anything in `src/`, `tests/`,
   `docs/`, `scripts/`, root-level files like `package.json`, `README.md`,
   `tsconfig.json`. The 2026-04-22 incident damage (`README.md`, `src/auth.ts`,
   `src/middleware.ts`) is still blocked. Verified by the `still BLOCKS unlink
   on source files at the tree root` test.

2. **The `.instar` directory itself** — `safeRmSync` on `<root>/.instar` with
   `recursive: true` is still rejected. The carve-out predicate requires
   `/.instar/` followed by at least one additional path segment; `<root>/.instar`
   alone does not satisfy that.

3. **All three detection layers** are unchanged. The marker file, canonical
   remote URL, and source-identity signature checks all still run for paths
   outside `.instar/`.

**Audit trail**: The carve-out leaves a positive `outcome: "allowed"` entry
with `reason: "agent-runtime-state-carveout"` in `.instar/audit/destructive-ops.jsonl`
on every match. This makes the false-positive rate (operations that would have
been wrongly blocked before) directly observable: `grep
agent-runtime-state-carveout .instar/audit/destructive-ops.jsonl | wc -l`.
Operators can confirm the carve-out is being exercised exactly when expected
(WakeSocketServer recovery, AutoUpdater install, etc.) and not in unexpected
places.

**Tests**: 5 new tests under `describe('SafeFsExecutor agent-runtime-state
carve-out', …)` in `tests/unit/SafeFsExecutor.test.ts`. All 17 SafeFsExecutor
tests pass (12 existing + 5 new). No existing tests modified.

**Spec impact**: `docs/specs/DESTRUCTIVE-TOOL-TARGET-GUARDS-SPEC.md` is not
modified by this change. The spec's tactical-guardrail design is preserved
exactly. The carve-out lives one layer below the guard (in `SafeFsExecutor`)
and is documented in the new helper's doc-comment with the reasoning above.

**Rollback**: Revert this commit. The carve-out is a single function and a
single branch in `guard()`. Rollback restores the brittle-block behavior
exactly; no migration needed.
