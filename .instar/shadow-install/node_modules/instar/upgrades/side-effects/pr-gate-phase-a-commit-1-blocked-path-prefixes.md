# Side-Effects Review — BackupManager BLOCKED_PATH_PREFIXES

**Version / slug:** `pr-gate-phase-a-commit-1-blocked-path-prefixes`
**Date:** `2026-04-17`
**Author:** `Echo (instar-developing agent)`
**Second-pass reviewer:** `required — will append after build`

## Summary of the change

Adds a `BLOCKED_PATH_PREFIXES` Set to `BackupManager` (single entry: `.instar/secrets/`) with `path.normalize(entry).startsWith(prefix)` semantics. The existing `BLOCKED_FILES` Set keeps its equality semantics for the three literal names it already protects (`config.json`, `secrets`, `machine`); the new prefix set is additive and catches arbitrary paths under `.instar/secrets/` that the equality check would miss.

Files touched:
- `src/core/BackupManager.ts` — adds the prefix Set + an additional check inside the snapshot loop.
- `tests/unit/backup-manager.test.ts` — three new test cases: prefix blocking with nested secrets paths, `path.normalize` handling of redundant segments, and a defense-in-depth assertion that `DEFAULT_CONFIG.includeFiles` contains no entry under `.instar/secrets/`.

This is the first commit in the Phase A landing of `docs/specs/PR-REVIEW-HARDENING-SPEC.md`. The spec's iter4 convergence round flagged this as a critical finding: `BLOCKED_FILES` is literal-equality, not glob, so the spec's earlier-written "add secrets path to BLOCKED_FILES" instruction would have been a no-op at runtime. The prefix set closes the hole.

## Decision-point inventory

- `BackupManager.createSnapshot()` entry-iteration check — **modify** — adds a prefix-based skip alongside the existing equality-based skip. Both are hard-invariant safety guards (see section 4 below).

No new decision points are added at the judgment-call level; this is a mechanical check.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

A legitimate user-configured backup of something located under `.instar/secrets/` would be rejected. That is the intended behavior — `.instar/secrets/` is by design the directory where credentials, canary keys, pre-shared peer keys, PRNG server secrets, and the forthcoming pr-gate eligibility DB live. Shipping any of those into a git-synced snapshot is exactly the attack vector the change defends against.

No legitimate use case currently stores non-secret data under `.instar/secrets/`. If one emerges later, the right response is to move that data out of the secrets directory, not to loosen the block.

---

## 2. Under-block

**What failure modes does this still miss?**

- A secret stored OUTSIDE `.instar/secrets/` remains unprotected by this check. Example: a developer who writes a token into `.instar/config/custom-api-token.json` would not hit this prefix check. Defense against that requires either keeping the prefix tree comprehensive (by moving such files under `.instar/secrets/`) or adding additional prefixes in the future. The new `DEFAULT_CONFIG.includeFiles` assertion test makes it harder for a bug to introduce a secrets path into the defaults, but it does not constrain arbitrary user config.
- A symlink pointing from a non-secrets path to a secrets path would bypass the string-prefix check. BackupManager uses `fs.statSync`, not `fs.lstatSync`, so a symlink from `backup-me` → `.instar/secrets/tokens.json` would be followed. This is the same gap the existing `BLOCKED_FILES` check has; closing it is out of scope for this commit and belongs in a future `lstat-based traversal` commit (noted in the iter5 non-blocking clarifications list of the spec).
- Path normalization on Windows uses `\` separators; the hardcoded prefix string `.instar/secrets/` uses `/`. This codebase is macOS/Linux-oriented (instar currently ships LaunchDaemon/LaunchAgent infrastructure for macOS), so Windows is out of scope. If Windows support is added, the prefix string must be normalized with `path.sep` at startup.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The check lives inside `BackupManager.createSnapshot()` — the boundary where files become durable snapshot content. Any higher (a pre-migrator assertion) would fail to cover user-config-driven entries; any lower (filesystem layer) doesn't exist in Node's core API. The check is a detector-level structural validator, not a judgment call — per `docs/signal-vs-authority.md` section "When this principle does NOT apply" bullet 2, safety guards on irreversible actions are explicitly allowed as brittle blockers because the cost of a false pass (secrets in git) is catastrophic and the cost of a false block (user reconfigures their backup target) is trivial.

No higher-level gate exists for "should this file ship into a backup snapshot" that this should feed into. The prefix check IS the authority, and that's the correct shape for this domain.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no judgment-call block/allow surface. It is a hard-invariant safety guard on an irreversible action (writing secrets into a git-synced backup snapshot), explicitly carved out in signal-vs-authority.md section "When this principle does NOT apply" bullet 2.

Narrative: the principle applies to *judgment* decisions — blocking based on what a message *means* or what an agent's *intent* appears to be. "Does this path start with `.instar/secrets/`" is not a judgment call. It is a structural fact about the path string. The cost of the wrong answer is asymmetric: a false pass means secrets leak to paired machines over git-sync; a false block means the user sees a warning and reconfigures. Brittle blocking is the correct shape for this trade-off.

The existing `BLOCKED_FILES` equality check is the same shape (hard safety guard, not judgment) and has lived here since the module was introduced. The new set extends the same pattern to cover a larger surface area — it does not introduce a new kind of authority.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** the new prefix check runs *after* the existing `BLOCKED_FILES` equality check. A path blocked by `BLOCKED_FILES` short-circuits and `continue`s the loop, so the prefix check is never evaluated for those entries. No shadowing concern — the two checks are disjoint by intent (equality for literal names, prefix for secrets-tree paths).
- **Double-fire:** no. An entry that matches both `BLOCKED_FILES` and a prefix in `BLOCKED_PATH_PREFIXES` is skipped once, not twice — the equality check fires first and continues.
- **Races:** none. `createSnapshot` is synchronous and runs in a single call stack. No shared state is mutated outside the snapshot directory, and the prefix set is a module-level constant (not mutable at runtime).
- **Feedback loops:** none. The check has no side effects other than a `console.warn` log line and a `continue` statement.
- **Interaction with `resolveIncludedFiles`:** the check runs inside the consumer loop, after glob expansion. If a glob pattern matches a secrets path, that expanded path is then rejected. No known glob pattern in the current defaults would expand into `.instar/secrets/`, but the check covers that case anyway as defense in depth.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine:** none. The check is local to the BackupManager instance.
- **Other users of the install base:** on the next `npm update`, existing agents pick up this change. Any user who had somehow configured a backup to include `.instar/secrets/` will see new warning log lines saying `Skipping blocked-prefix path: ...` — they would be strictly better off (secrets protected) and the behavior change is purely additive-block. Realistic likelihood of anyone having such a config: effectively zero, since the secrets directory has been off-limits since BackupManager was written.
- **External systems:** none.
- **Persistent state:** snapshots created AFTER this change will not contain `.instar/secrets/` entries. Snapshots created BEFORE this change that contain such entries remain on disk until manually pruned — the change does not retroactively scrub old snapshots. If this matters for any existing agent, it's a one-off operational cleanup, not a runtime concern.
- **Timing:** none.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Pure code change. `git revert` the commit and ship as next patch. No persistent state depends on the prefix check. No user-visible regression during the rollback window — the prior behavior (equality-only blocking) is what shipped before and would simply return.

Rollback cost: zero operational complexity. One commit revert, one patch release.

---

## Conclusion

This commit closes an iter4-critical convergence finding in the approved PR-hardening spec: the BackupManager's secrets-defense cannot be implemented as the earlier spec draft described because `BLOCKED_FILES` is equality-only. The prefix set is the correct structural fix, placed at the right layer, with no new judgment-call surface. Tests verify both the expected block behavior AND a defense-in-depth assertion that the defaults never introduce a secrets-path entry themselves.

Clear to ship as the first commit in Phase A. Subsequent Phase A commits (BackupConfig plumbing, PostUpdateMigrator additions, shipped pipeline files, dashboard tab, phase='off' kill-switch) will each get their own artifact.

---

## Second-pass review (if required)

**Reviewer:** independent subagent (general-purpose agent, fresh context)
**Independent read of the artifact: concur**

Independent checks performed:

- **Ordering**: `BLOCKED_FILES` check runs first (continues on match); prefix check runs second. Confirmed sequential, prefix only evaluates when equality check passes.
- **path.normalize behavior** (verified on darwin): `.instar/./secrets/x.json`, `./.instar/secrets/x.json`, `.instar//secrets/x.json`, and `.instar/foo/../secrets/x.json` all collapse to a prefixed form that the check catches.
- **Absolute-path entries**: `path.normalize('/Users/foo/.instar/secrets/tokens.json')` keeps the leading `/` and does NOT match the relative prefix. However, `path.join(stateDir, absolutePath)` on POSIX treats the second arg as relative, producing a non-existent path that `fs.existsSync` rejects. Net effect: absolute-path entries become no-ops, not silent leaks. Not an exploitable gap. Noted for a future iteration (also listed in the iter5 non-blocking clarifications of the spec as "BLOCKED_PATH_PREFIXES edge cases: absolute paths, leading-slash").
- **resolveIncludedFiles / expandGlob path integrity**: `expandGlob` rejects glob shapes with `/` in prefix or suffix and returns only basenames from `fs.readdirSync(stateDir)`. No glob can expand into a subpath containing `.instar/secrets/`. No upstream path manipulation bypasses the prefix check.
- **Defense-in-depth test target**: constructor does `{ ...DEFAULT_CONFIG, ...config }`. When no config is passed, the test is correctly checking the DEFAULT_CONFIG's includeFiles.
- **Signal-vs-authority**: `docs/signal-vs-authority.md` Section "When this principle does NOT apply" bullet 2 explicitly carves out "safety guards on irreversible actions." Writing secrets into a git-synced snapshot is irreversible (leaks to paired machines and git history). Prefix string match is structural fact, not judgment. Carve-out applies correctly.

Sign-off: the artifact's key conclusions — post-BLOCKED_FILES ordering, correct `path.normalize` handling, right layer, signal-vs-authority carve-out applied, zero rollback cost — all hold under independent verification. Clear to ship.

---

## Evidence pointers

- BackupManager source: `src/core/BackupManager.ts` — `BLOCKED_PATH_PREFIXES` constant lines ~22-32, check block lines ~180-190 (approximate after rebase).
- Tests: `tests/unit/backup-manager.test.ts` — three new cases + default-config assertion; 42 tests total pass locally.
- TypeScript: `tsc --noEmit` clean.
- Sibling test suite `BackupManager-sharedState.test.ts` — 3 tests still pass.
