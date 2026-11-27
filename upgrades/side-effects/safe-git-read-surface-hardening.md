# Side-Effects Review — SafeGitExecutor read surfaces mean read; `run` routes past pre-verb flags (EVO-029)

**Version / slug:** `safe-git-read-surface-hardening`
**Date:** `2026-11-05`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Implements `docs/specs/safe-git-read-surface-hardening.md` (EVO-029 items 1, 3, 4, 5, 6; converged in 6 rounds with a GPT-tier external pass every round). Tier 2, security-sensitive. Files: `src/core/SafeGitExecutor.ts` (per-verb admit grammars with one option scanner, a `refused` invocation class, the universal `--output` rule, `-c` and `opts.env` admit lists on the read surfaces, source-tree opt-outs limited to reads and `fetch`, `parseVerb` so `run` routes on the real verb, git-accurate resolution of relative `-C`/`--git-dir`/`--work-tree`), `src/commands/machine.ts` (the never-run force-wakeup commit + push removed; the printed line chosen from four configuration outlooks), `src/core/GitStateManager.ts` (never-run `update-index` call removed), `scripts/lint-no-direct-destructive.js` (object-database writers and shape-verb write forms), `scripts/run-migration.js` (deleted), and tests. Effort: 6 spec rounds (the Tier-2 cap; every round found a measured bypass until round 6).

## Decision-point inventory

- Funnel verb/argument classification (`classifyGitInvocation`, `isReadOnlyShape`, `scanReadGrammarDetail`) — modify — admit grammars replace deny checks; adds `refused`.
- Read-surface `-c` / `opts.env` admission (`refuseReadSurfaceOverrides`) — add — exact-membership lists.
- Source-tree opt-outs (`isSourceTreeCheckBypassed`, `isSourceTreeWorktreeManagerInvocation`) — modify — the read opt-out now requires a `read` classification (or `fetch`); the worktree-manager opt-out admits `symbolic-ref` only in read form.
- `run` dispatch — modify — routes on the verb past pre-verb flags.
- Force-wakeup lease propagation (`claimLeaseForSelf`) — remove — the never-run commit + push, and the `git add` of the registry that did run before them (the CLI no longer stages the file; `GitSync` stages what it commits).

---

## 1. Over-block

Newly refused on the read surfaces, none used by any caller in `src/` (checked by the author and three reviewers): abbreviations and short clusters of options in the admit-grammar verbs; `branch -l` (old meaning `--create-reflog`); a one-positional `config <key>` (a read in git, classed write here; no funnel read uses it); `format-patch` without `--stdout`; a path literally named `--output…` (reclassified write, runs on a write surface); `-c` values other than the twelve `HARDENED_GIT_CONFIG` pairs; caller-added `opts.env` keys outside the seven admitted ones. Refused on every surface: `grep -O`, `ls-remote --upload-pack/--exec`, `help <topic>`, `config --edit`/`-e` (also in a cluster), `branch --edit-description`. One existing test used a caller-changed `PATH` in `opts.env` to inject a fake git into `readStream`; it now sets `process.env.PATH` (inherited) instead.

---

## 2. Under-block

Stated boundaries, each in spec section 4: repository-local config (and the choice of repository via `-C`/`--git-dir`/`--work-tree` or a local path given as a remote) can still run programs under read verbs; the inherited process environment is not judged; a URL scheme can select a transport helper from `PATH`; git's own index stat refresh under `status`. Git-version drift: admit grammars reject new option spellings; the canary watches the test machine's git for the parse-options read verbs; revision-parser verbs (`log`, `diff`, `show`, `rev-list`, `rev-parse`) and the `stash`/`worktree`/`reflog` subcommand checks are covered only by the universal `--output` rule and the subcommand allowlists. Write surfaces are unchanged: they still accept any `-c`, run hooks, and run write verbs that can name a program.

---

## 3. Level-of-abstraction fit

Right layer: `SafeGitExecutor` is the single funnel for git, and argument classification belongs in it. The grammars are hard-invariant validators over already-structured `argv`; no smarter gate exists that this should feed. The lease change removes a duplicate (and never-working) propagation path in favour of the server's own lease machinery.

---

## 4. Signal vs authority compliance

The funnel's blocking authority predates this change; this change narrows what it admits and adds deterministic refusal conditions over a closed schema. Grounding: `docs/STANDARDS-REGISTRY.md:230` (below the threshold, a closed enum, type or schema may refuse malformed input), `:296` (validating already-structured input against a fixed, closed enum), `docs/signal-vs-authority.md:75-76` (hard-invariant validators; safety guards on irreversible actions). The Standards-Conformance Gate flagged Signal vs. Authority in every round (registry wording names only the emergency-stop floor); the documents' disagreement is the one already reported as `fb-69615365-30f`. Wrong-block cost per refusal: a `write` reclassification moves the call to `execSync`; a `-c`/env/source-tree refusal is retried without the value; a `refused` form needs a reviewed grammar change.

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals decision point is added. Every classification is exact membership of an argument in a fixed grammar; the force-wakeup line is a fixed mapping from configuration facts, with an explicit unknown line.

---

## 5. Interactions

- `run`'s callers (`GitSync.gitExec`, `GitStateManager.git`, `BranchManager.git`, `HandoffManager.git`, `SyncOrchestrator`, `localVerify` `realGit`, `releaseReadinessWiring`, `featureRolloutScan`, `ProjectRoundWorktrees`): only `machine.ts` passed a pre-verb flag first, and that call is removed. `branch --list <pattern>` (BranchManager, HandoffManager) now routes to `readSync` instead of `execSync`; it runs either way.
- `PrHandLease.ts:168` passes `{ ...process.env, GIT_TERMINAL_PROMPT: '0' }` to `readSync`: admitted (inherited keys are not judged; `GIT_TERMINAL_PROMPT` is admitted).
- Source-tree opt-out: every `sourceTreeReadOk` caller is a read or `fetch` (three `fetch` sites, unchanged).
- `localVerify` and the feedback executor's carve-outs call `isReadOnlyConfigInvocation(...) === 'read'` (type change only).
- Relative `-C` now resolves against `opts.cwd` (git's behaviour) instead of this process's cwd; no `src/` caller passes a relative `-C` with a different `cwd`.

---

## 6. External surfaces

No route, config key, notice or agent-installed file changes. The `instar wakeup --force` CLI line changes from the false "Lease claimed + pushed…" to one of four accurate lines. Audit log gains three reasons: `program-running-form`, `read-surface-config-not-admitted`, `read-surface-env-not-admitted`. Error messages for refusals name the verb or key, never values (which can hold credentials).

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface (dashboard, approval page or form) is touched — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Classifier: in-process code, identical on every machine; no state. Lease: the machine registry (`unified`) is written locally exactly as it effectively always was; the server carries it as before (unchanged). Pre-existing gaps in that carrying are filed as `fb-c5958717-00b`. **Status surfaces:** none added or changed.

---

## 8. Rollback cost

Revert the commit. No stored state, config, migration or route. After a revert the read surfaces accept the write forms again and `run` misroutes again; the dead lease commit returns, still unable to run.

---

## Conclusion

Ships as specified. Every newly refused form was measured to write or run a program (or fails closed by construction), no `src/` caller is refused, and the one behaviour change outside the classifier is a truthful CLI line in place of a false one.

## Second-pass review (if required)

**Reviewer:** independent subagent
**Independent read of the artifact: concur**

Concur with the review. The reviewer checked all 84 `readSync`/`readStream`/`run` call sites in `src/` (including every dynamic wrapper) and found each live form still classifies `read`; no read surface passes a `-c`; the only read-surface `opts.env` (`PrHandLease.ts:168`) is admitted; every `SOURCE_TREE_READ_TIER_VERBS` caller is a read or `fetch`; `leaseObserveOnly` and `leaseKeptInGit` match the coordinator and server. One correction, applied: the old code's `git add` of the registry did run (only the `-c` commit and push failed), so the CLI no longer stages `registry.json`.

## Evidence pointers

- Spec + convergence report: `docs/specs/safe-git-read-surface-hardening.md`, `docs/specs/reports/safe-git-read-surface-hardening-convergence.md`.
- Tests: `tests/unit/SafeGitExecutor-read-surface-hardening.test.ts` (real git; disconfirmation set), `tests/unit/machine-claim-lease-local-only.test.ts` (sandbox repo + bare remote), `tests/unit/lint-no-direct-destructive.test.ts` (table-driven), updated `SafeGitExecutor.test.ts`, `SafeGitExecutor-verb-classifier.test.ts`.
- Feedback filed: `fb-c5958717-00b` (pre-existing lease-sharing gaps).

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. (The change fixes code in the git funnel and a CLI command; it adds no self-triggered controller.)
