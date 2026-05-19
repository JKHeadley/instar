# Side-effects review — Real enabledFrameworks field + framework gate (Gap 5)

Per L6. Seven dimensions.

## 1. Over-block / under-block

Before: UNDER (and inert) — no working way to skip Claude-only steps for a
Codex install. After: precisely targeted. Default config → `['claude-code']`
→ zero skips → byte-identical to today for every existing/dual install. Only
an explicit `enabledFrameworks: ['codex-cli']` causes `migrateSettings` to
skip — exactly the intended case. No over-block.

## 2. Level-of-abstraction fit

Framework resolution is now one private helper (`getEnabledFrameworks`) — the
single source of truth. The previously-duplicated inline logic in
`migrateParityRenderings` was refactored to call it, removing drift risk.

## 3. Signal vs Authority compliance

`enabledFrameworks` (persisted config) is the SIGNAL of operator intent;
`getEnabledFrameworks()` is the one AUTHORITY that resolves it with a safe
default. No brittle inline re-derivation remains.

## 4. Interactions with adjacent systems

- **migrateParityRenderings** — behavior preserved; the 11 existing
  parity-renderings tests pass unchanged after the DRY refactor.
- **FrameworkParitySentinel.enabledFrameworks** — separate config object
  (sentinel's own interface); this PR adds the *persisted InstarConfig*
  field the migrator reads. Names intentionally mirror; no shared mutable
  state, no coupling introduced.
- **migrateSettings** — only new behavior is the early skip for non-Claude;
  all downstream `.claude/settings.json` logic is untouched for the default
  path.
- **Remaining 48 `.claude/` refs** — unchanged; they can adopt
  `getEnabledFrameworks()` incrementally. Not touching them now is a
  deliberate regression-risk decision, not an oversight.

## 5. Rollback cost

Low. One new optional type field + one helper + one DRY refactor + one early
return + one test file. `git revert` restores prior behavior. The new config
field is optional and ignored by older code, so a mixed-version fleet is safe.

## 6. Backwards compatibility / drift surface

Fully backward-compatible: optional field, safe default. Older instar
versions ignore an `enabledFrameworks` they don't know about. Drift surface
*reduced* — the duplicate inline framework logic is now a single helper.

## 7. Authorization / Trust posture

No new authority. The helper only reads config and returns a string array.
The gate only *prevents* writes for non-Claude installs — it never grants a
new write. Unreadable config fails safe to `['claude-code']` (status quo).

## Outcome

Ship. Corrects an inert audit finding into a real, reachable, tested gate;
default-safe; drift-reducing; trivial rollback. Fifth of the v1.0.9–v1.0.14
hardening series.
