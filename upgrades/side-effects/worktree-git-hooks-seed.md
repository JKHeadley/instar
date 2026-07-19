# Side-Effects Review — Seed git-hooks shim into fresh worktrees/clones

**Version / slug:** `worktree-git-hooks-seed`
**Date:** `2026-07-19`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `independent reviewer subagent — Concur (see Phase 5 note at end)`

## Summary of the change

`WorktreeManager.createBinding` creates an isolated dev environment two ways — `git worktree add` (in-tree) or `git clone` (when the source lives outside agent home) — then fast-copies `node_modules` from the source. It never ran husky's `prepare`, so the git-ignored, generated `.husky/_` shim (the directory `core.hooksPath = .husky/_` actually points at) was absent in every fresh checkout. Git then resolves the hooksPath to a missing directory and silently runs **no** hook — no error — so the instar-dev pre-commit/pre-push enforcement was bypassed until an `npm install` regenerated the shim. This change adds one best-effort call, `seedGitHooks(worktreePath)`, right after the create/clone + `fastCopyDeps` block. It resolves the effective `core.hooksPath`, and if it is a relative path missing in the fresh checkout but present in the source, copies the shim directory across (and, on the clone path where the fresh `.git/config` has no hooksPath, replicates the hooksPath config). Files touched: `src/core/WorktreeManager.ts` (+1 call site, +1 private method); test `tests/unit/WorktreeManager-git-hooks-seed.test.ts`.

## Decision-point inventory

- `WorktreeManager.seedGitHooks` — **add** — filesystem/setup operation that seeds a hooks shim. It holds **no** block/allow authority: it never rejects, delays, or blocks worktree creation; it only makes an EXISTING decision point (the pre-commit/pre-push gates) able to run. On any uncertainty it warns and returns.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface — over-block not applicable. `seedGitHooks` cannot reject a worktree creation; every failure path (`try/catch`, missing source, path-escape, absolute hooksPath) is a silent `return` or an advisory `warn`, and worktree creation proceeds regardless.

---

## 2. Under-block

**What failure modes does this still miss?**

No block/allow surface — under-block not applicable in the gate sense. Remaining *coverage* gaps (stated honestly, not deferred):

- **Source repo has no shim to copy** (e.g. a genuinely bare source with no on-disk `.husky/_` and no relative hooksPath resolvable in the source): the method emits a warn and the new worktree's hooks stay inactive until an install runs. This is an honest best-effort boundary, not a regression — behavior is no worse than before the fix, and the warn surfaces it.
- **Worktrees created BEFORE this fix** stay hook-dead until re-created or re-installed. This change seeds NEW worktrees only; it does not retroactively repair existing ones (that would be a scope-separate sweep over live worktrees). Scope boundary, explicitly not silently deferred work.
- **A repo whose hooks framework is not "regenerate-the-shim-shaped"** (a hooksPath pointing at a dir that legitimately must be regenerated per-checkout rather than copied) would get a copied-but-possibly-stale shim; husky's `_` shims are checkout-independent so this is correct for husky, and the copy is a strict improvement over "no hook at all" for any framework whose hooksPath dir is checkout-independent.
- **A crafted/malicious `core.hooksPath`** — a `../`-relative value, an absolute value, or a value routed through a tracked `.husky` **symlink** — is refused: both a lexical containment check (`startsWith` the resolved root, trailing-`path.sep` so a sibling-prefix like `wt-evil` can't slip through) AND a symlink-safe realpath check (resolve the real path of the nearest existing ancestor and require it stays within the worktree/source real root, since `path.resolve` is lexical and does not follow symlinks). Not reachable under the trusted-source model, but enforced regardless so the guarantee holds literally.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The defect is that the worktree/clone creation primitive produced an environment missing a file git needs — so the fix belongs in the primitive that creates the environment (`WorktreeManager.createBinding`), immediately adjacent to `fastCopyDeps`, which already solves the sibling "the fresh checkout is missing generated content (`node_modules`)" problem the same best-effort way. It is deliberately NOT implemented as husky-specific logic (no husky string), and NOT as a higher-level gate — it is a low-level setup step that RESTORES the higher-level gate's ability to fire. No smarter existing layer owns "seed generated files into a fresh worktree"; `fastCopyDeps` is the only peer and this rides directly after it.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface. It is a filesystem setup step that makes the pre-existing pre-commit/pre-push gates operational in a fresh worktree. It produces no verdict and holds no authority. It fails open (warn, never throw) so a seeding failure can never block worktree creation — the safe direction.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The logic is a deterministic invariant with an enumerable domain: "if the effective `core.hooksPath` is a relative path present in the source but missing in the worktree, copy it." There are no competing live signals (work evidence / liveness / ownership) being weighed — it is a pure setup precondition.

---

## 5. Interactions

- **Shadowing:** Runs once, after the create/clone + `fastCopyDeps` block and before the binding is signed/emitted. It reads git config and copies a directory; it shadows nothing and is shadowed by nothing.
- **Double-fire:** Idempotent — if the shim directory already exists it returns immediately (`fs.existsSync(destDir)`), so a re-attach or repeated create never re-copies or clobbers a live shim.
- **Races:** Operates only on the freshly-created worktree path (not yet published as a binding, no other session attached), so no shared-state race. The source `.husky/_` is read-only from this method's view.
- **Feedback loops:** None. It writes into the new worktree only; it does not feed any system that feeds back into worktree creation.
- **SafeGitExecutor/SourceTreeGuard:** the config read uses `SafeGitExecutor.readSync` (`config --get` is in the read-only allowlist); the clone-path config SET uses `SafeGitExecutor.execSync` against the new worktree path (under agent home / stateDir), never the instar source tree — so SourceTreeGuard is not tripped. Both resolved paths are containment-checked (lexical `startsWith` on the resolved root PLUS a symlink-safe realpath check on the nearest existing ancestor) to refuse a hooksPath that escapes either root — via a `../` value, an absolute value, or a tracked symlink.

---

## 6. External surfaces

- **Other agents / users:** none. Worktree creation is a local dev operation.
- **External systems:** none (no Telegram/Slack/GitHub/network surface).
- **Persistent state:** writes the `.husky/_` shim directory into the new worktree and, on the clone path, sets `core.hooksPath` in the new clone's local `.git/config`. Both are inside the freshly-created worktree/clone — no shared or durable instar state is touched.
- **Timing:** no timing dependency; synchronous, bounded (3s git timeouts, a single directory copy).
- **Operator surface (Mobile-Complete):** No operator-facing actions — not applicable.

---

## 6b. Operator-surface quality

No operator surface — not applicable. This change touches no dashboard renderer, approval page, or grant/revoke/secret form.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** A worktree/clone is a physical checkout on one machine's disk; each machine's `WorktreeManager` creates and seeds its own worktrees. There is no cross-machine state to replicate and nothing to proxy on read — the fix is the same code running symmetrically on every machine, each seeding hooks into its own local checkouts. No user-facing notice, no durable state that could strand on topic transfer, no generated URL.

---

## 8. Rollback cost

Low. The change is one additive, fail-open method + its call site. To back it out: revert the commit (or, as an in-place escape hatch, the method is a no-op for any repo with no relative `core.hooksPath`, and its only writes are into fresh worktrees — a bad seed is corrected by deleting/recreating the worktree, never a data migration). No schema, no persistent instar state, no release-coupled migration. Worst realistic failure mode (a warn-logged seed miss) leaves behavior exactly as it was before the fix.

---

## Phase 5 — Second-pass review (independent reviewer subagent)

**Verdict: Concur with the review.**

The reviewer independently traced the logic against `createBinding` and confirmed: (1) correctness on both paths — worktree path seeds the shim with the inherited relative hooksPath (git resolves a relative hooksPath against each worktree's own root), clone path seeds the shim AND sets the hooksPath on the clone's independent config; (2) the config SET can **never** mutate the source repo, because `needsConfigSet` is true only when the worktree's own config read was empty, which on a linked worktree (sharing the source config) is structurally impossible — so it only ever fires against a clone's independent config; (3) fail-open — the entire body is inside `try/catch → emit('warn')` and `'warn'` has no unhandled-emit throw semantics, so the method cannot throw and worktree creation can't break; (4) idempotent on re-attach.

Two caveats the reviewer raised were addressed in this change (not merely recorded):
- **Lexical-only containment** → added a symlink-safe realpath containment check (resolve the nearest existing ancestor's real path, require it stays within the worktree/source real root), so the "escape refused" claim now holds for symlink physical escapes, not just `../`/absolute values.
- **No negative-path tests** → added two regression tests: an escaping `../evil` hooksPath (refused, nothing written outside, worktree still created) and a source-with-no-shim case (advisory warn, no-op, no throw).
