# Gemini Iter-3 Review — PROJECT-SCOPE-SPEC.md

**Model**: gemini-3.1-pro-preview
**Iteration**: 3
**Timestamp**: 20260511-101234

---

### 1. Overall Assessment
- **Score**: 9.5/10
- **Status**: APPROVE
- **Verdict**: This is an exceptionally strong Iteration 3. The critical flaws from Iter 2 (squash-merge SHA mismatches, shared lock files in git-sync, and static stop conditions) have been resolved with precise, production-grade solutions. The use of `gh pr view --json state,mergeCommit` is exactly right for the squash-merge reality, and the `check-defers.sh` pre-commit hook is a brilliant structural enforcement mechanism. I have identified exactly **TWO material new issues**, both of which are mechanical edge-cases introduced by the Iter-2 fixes. They do not require another review iteration, but must be patched in the final implementation.

### 2. Critical Issues (Must Fix)

#### 1. Premature Round Termination on Mid-Round Skip
- **What**: In Phase 1.5 (Run loop, Step 5), if an item is skipped mid-round, the runner "emits a SIGTERM to the autonomous process and recomputes the stop condition." However, Step 6 states "On autonomous exit: ... verify the artifact ... round.status = complete [or partially-complete]".
- **Why it matters**: If SIGTERM causes the autonomous process to exit, and the runner simply falls through to Step 6, skipping one item will instantly terminate the entire round. The remaining unbuilt items will be left hanging, and the round will end as `partially-complete`.
- **Suggested fix**: Explicitly state in Step 5 that after SIGTERM and recomputing the stop condition, the runner **loops back to Step 4** to re-launch the autonomous process with the new condition (unless the new stop condition is already satisfied).
- **Section reference**: Phase 1.5 (Run loop, Steps 4-6)

#### 2. `JSON.parse` Crash on Git Conflict Markers
- **What**: Phase 1.4 / 1.12 defines an elegant OCC reconciliation for git-sync conflicts: "The reconciler: 1. Compares both versions' `version` field...". However, standard Git handles conflicts by inserting `<<<<<<< HEAD` plaintext markers directly into the file.
- **Why it matters**: Before your application logic can read the `version` fields, the backend's `InitiativeTracker` will attempt to `JSON.parse()` the `.instar/initiatives.json` file. The standard git conflict markers will throw a fatal `SyntaxError`, crashing the server and breaking the dashboard before the reconciler ever runs.
- **Suggested fix**: Specify *how* the conflict is parsed. Either: (A) Require a custom git merge driver for `.instar/initiatives.json` that outputs valid JSON with the `awaitingReconciliation` array, OR (B) Specify that the file-read utility uses a regex to detect and split Git conflict markers into two valid JSON strings in-memory before parsing and reconciling.
- **Section reference**: Phase 1.4 (P4) and Phase 1.12

### 3. Strengths
- **Squash-Merge Correctness**: Using GitHub's reported `mergeCommit.oid` via API rather than relying on the PR's local head SHA is the exact right solution for real-world git workflows.
- **Stale-PID Lock Recovery**: Moving the lock to `.instar/local/` (gitignored) and enforcing a `ps -p <pid>` liveness check completely neutralizes the cross-machine lock poisoning threat identified in Iter 2.
- **Structural `defers` Enforcement**: Replacing the success-criterion check with `scripts/check-defers.sh` is a massive upgrade. A pre-commit hook structurally prevents the "out of scope" trap from ever being merged without a registered follow-up.
- **Signal vs. Authority Enforcement**: The way you verify the LLM's cited `byteRange` by physically opening the file and checking the bounds before allowing the signal to pass is top-tier prompt-injection defense.

### 4. Gaps & Missing Elements
- **SIGKILL cleanup**: In Phase 1.5, if the autonomous process ignores SIGTERM and requires a SIGKILL after 5 seconds, the spec doesn't explicitly state if orphaned child processes (e.g., spawned compilers or test runners) are cleaned up. A process group kill (`kill -9 -<pid>`) might be necessary depending on how `/autonomous` spawns its work.

### 5. Industry Comparison
- **OCC in Git-Backed Systems**: Your approach to handling optimistic concurrency over a git-synced JSON file is highly advanced. Most tools in this space (like standard static site generators or flat-file CMSs) simply "last-writer-wins" or corrupt the file. Elevating conflicts to a user-facing `awaitingReconciliation` state matches enterprise-grade distributed database patterns (like CouchDB conflict revisions).

### 6. Scalability Assessment
- **Phase 1 (MVP, 10-50 users)**: Flawless. The $1/day ledger and 50ms compaction hook budgets are well-tuned.
- **Phase 2 (Growth, 50-500 users)**: The `.instar/initiatives.json` file will grow large. The custom conflict-marker parsing (Issue #2) will become slower, and reading the entire file into memory for every sync will eventually require splitting initiatives into a directory of individual JSON files.
- **Spike handling**: The 5/hour rate limit on project creation and the strict mutex on the drift checker will perfectly absorb API abuse or runaway loop spikes.

### 7. Recommendations (Prioritized)
1. **Fix the Mid-Round Skip Loop**: Update Phase 1.5 Step 5 to explicitly state the runner re-launches the autonomous process (GOTO Step 4) after a mid-round SIGTERM.
2. **Handle Git Conflict Syntax Errors**: Add a pre-parser regex to `InitiativeTracker.ts` that safely splits `<<<<<<< HEAD` markers into two JSON strings before calling `JSON.parse()`.
3. [Response truncated at max-tokens cutoff]
