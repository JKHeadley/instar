# Side-Effects Review — build-stop-hook.sh deployment + settings-reference validator

**Version / slug:** `build-stop-hook-deployment`
**Date:** `2026-04-19`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Moves `build-stop-hook.sh` from a one-shot conditional copy in `src/commands/init.ts` into the canonical `PostUpdateMigrator.migrateHooks` pattern — unconditional overwrite on every upgrade, shared content with `init.ts` via `getHookContent('build-stop-hook')`. Adds `PostUpdateMigrator.validateHookReferences` which scans `.claude/settings.json` after `migrateHooks` completes and reports any hook `command:` path under `.instar/hooks/instar/` that does not exist on disk.

Files touched:
- `src/core/PostUpdateMigrator.ts` — new `getBuildStopHook()`, new `validateHookReferences()`, wired into `migrateHooks` and `getHookContent`.
- `src/commands/init.ts` — replaced inline copy block with `migrator.getHookContent('build-stop-hook')` write.
- `tests/unit/PostUpdateMigrator-buildStopHook.test.ts` — 7 new tests covering install-when-missing, idempotent overwrite, getHookContent round-trip, validator flags missing refs, validator passes when refs exist, validator ignores custom/ hooks and external commands, validator is no-op without settings.json.

Decision points touched: none on runtime message flow. The new validator is a structural invariant check at upgrade-time (file existence), not a message/judgment gate.

## Decision-point inventory

- `PostUpdateMigrator.validateHookReferences` — **add** — structural invariant: every `command:` referenced in settings.json pointing to `.instar/hooks/instar/*` must exist on disk. Emits `result.errors` entries; does not throw, does not block upgrade.

---

## 1. Over-block

No block/allow surface on runtime behavior — over-block not applicable to message flow.

Validator-level: the regex `(?:^|\s)(\.instar\/hooks\/instar\/[^\s"]+)` only matches paths under `.instar/hooks/instar/` — the instar-owned subtree. Custom hooks at `.instar/hooks/custom/` and external commands (`/usr/local/bin/foo`, shell builtins) are deliberately skipped. Test coverage: `ignores hooks outside the .instar/hooks/instar/ tree (custom hooks)`.

---

## 2. Under-block

No block/allow surface on runtime behavior — under-block not applicable to message flow.

Validator-level: the validator only inspects `command:` strings. Hooks registered via `type: "http"` would not be checked, but those have their own failure signal (HTTP error) and are outside the "file on disk" invariant this validator owns. A hook referenced through a variable expansion (e.g. `$INSTAR_HOOKS_DIR/foo.sh`) would not be caught — none currently exist in the default settings template.

---

## 3. Level-of-abstraction fit

The build-stop-hook deployment change is pure mechanics — moves one hook into the same installation path already used by the other 18 instar-owned hooks. No new abstraction; removes the one-off conditional copy in init.ts that was the root cause.

The validator lives on `PostUpdateMigrator` alongside `migrateHooks`, which is the correct layer: `PostUpdateMigrator` already owns installing hooks and verifying hook content (see `migrateHttpHooksToCommandHooks` for precedent). Running the check at upgrade time catches drift both when upgrading instar *and* when the user hand-edits settings.json. A runtime-side check (on each Claude Code hook firing) would be lower-level but redundant — Claude Code's own "non-blocking status" already reports missing-file failures, they just aren't surfaced to the user. The upgrade-time check puts the signal where a human or agent will read it.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface (on runtime messages/decisions).
- [x] Yes — but validator is a hard-invariant structural check (file existence at the system boundary), explicitly permitted per doc §"When this principle does NOT apply": *"Hard-invariant validation. 'This field must be a number.' Typing and structural validators at the boundary of the system are not decision points in the sense this principle applies to — they don't evaluate messages, they reject malformed input."*

The validator is not a message-flow authority and has no brittle judgment call — "file exists on disk" is an enumerable binary fact. It emits into `result.errors` (surface, not block), specifically to avoid wedging upgrades on references we don't own (custom hooks outside the matched path prefix).

---

## 5. Interactions

- **Shadowing:** `migrateHooks` runs before `validateHookReferences`, so the validator sees the post-install state — it won't flag `build-stop-hook.sh` as missing after this change (by construction, the write preceded the check). Confirmed by running `migrateHooks` end-to-end in the new test suite — `result.errors` is empty for the happy path.
- **Double-fire:** No. init.ts writes the hook once at init; `migrateHooks` overwrites on every upgrade. Same content both paths.
- **Races:** None. Synchronous fs operations, single-threaded.
- **Feedback loops:** None.
- **Existing migrators:** `migrateHooks` already contains 17 try/catch blocks that each write one hook. The new `build-stop-hook.sh` block follows the exact same pattern; failures are reported into `result.errors` without aborting the rest of the migration.

---

## 6. External surfaces

- **Other agents on the machine:** none directly. Each agent's `PostUpdateMigrator` runs against its own `stateDir`. This change only affects what that agent's migration produces.
- **Install base:** on next `instar upgrade-ack`, every agent gets the hook deployed (overwriting any local edits — consistent with existing migrator semantics for instar-owned hooks). Agents that never ran an upgrade post-this-change keep seeing the "No such file" errors until they upgrade.
- **External services:** none.
- **Persistent state:** writes one file (`.instar/hooks/instar/build-stop-hook.sh`, 755). Does not touch the build-state ledger, dashboard, or any server state.
- **Timing:** none.

---

## 7. Rollback cost

Pure code change on the installer path. Back-out: revert the three files and ship as a patch release. No persistent state to migrate back. Agents that already received the file on upgrade keep it — functionally a no-op (the hook only fires when a `/build` is active and its state file exists), so no user-visible regression during the rollback window.

If the validator starts emitting a false-positive for some install shape we didn't anticipate, the effect is a noisy `result.errors` entry in upgrade logs — not a broken install. Revertable in isolation.

---

## Conclusion

Change is scoped to one deployment bug with a narrow structural guard to prevent the same shape from recurring. No runtime message flow touched. Test coverage: 7 new unit tests + existing 63 migrator tests all green. TypeScript clean. Ready to ship as a patch release after merge.

---

## Evidence pointers

- Live reproduction (pre-fix): `echo-instar-agent-robustness` tmux pane captured 2026-04-19 ~19:00 PT showing 6× `Stop hook error: bash: .instar/hooks/instar/build-stop-hook.sh: No such file or directory`.
- Missing file verified on echo's state dir: `ls .instar/hooks/instar/ | grep build-stop-hook` → empty.
- Post-fix test evidence: `tests/unit/PostUpdateMigrator-buildStopHook.test.ts` 7/7, full PostUpdateMigrator suite 70/70.
