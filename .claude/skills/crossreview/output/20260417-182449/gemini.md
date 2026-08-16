# Gemini 3.1 Pro Iter 2 Review: PARALLEL-DEV-ISOLATION-SPEC.md

**Model**: gemini-3.1-pro-preview
**Date**: 2026-04-17
**Focus**: iteration 2 convergence check

---

### 1. Overall Assessment
- **Score**: 9/10
- **Status**: CONDITIONAL APPROVE
- **Summary**: This iteration is exceptionally strong and demonstrates a mature approach to agentic parallel development. The shift to a server-mediated authority model, combined with the local bare-mirror push gate, elegantly solves the fundamental untrustworthiness of local environment variables. The resolutions to Iteration 1 findings (per-machine bindings, force-take stash protocols, and semantic trailers) are implemented flawlessly. The remaining issues are primarily mechanical (POSIX filesystem constraints and git hook lifecycles) rather than architectural flaws.

### 2. Critical Issues (Must Fix)

**1. POSIX Directory Hardlink Violation**
- **What**: The spec proposes `cp -al <main>/node_modules <wt>/node_modules` (APFS hardlink, ~2s).
- **Why it matters**: Standard POSIX filesystems strictly forbid hardlinking directories to prevent infinite loops in filesystem traversal. `cp -al` will fail immediately with `cp: cannot hard link a directory`.
- **Suggested fix**: Use modern Copy-on-Write (CoW) reflinks instead. Update the spec to use `cp -R --reflink=auto <main>/node_modules <wt>/node_modules` (Linux/Btrfs/ZFS) or `cp -Rc <main>/node_modules <wt>/node_modules` (macOS APFS).
- **Section reference**: *Disk strategy*

**2. The Push-Gate "Black Hole"**
- **What**: The bare mirror at `.instar/git-mirror.git/` acts as the `origin` push URL and uses a `pre-receive` hook to validate commits. The spec does not define how the commit gets from the local mirror to the actual remote (e.g., GitHub).
- **Why it matters**: If a user or agent pushes to this mirror, the commit will be accepted locally by the mirror but will never reach the remote team or trigger CI.
- **Suggested fix**: Add a `post-receive` hook to the mirror that automatically executes `git push <real-upstream-url> <ref>` upon successful validation. Alternatively, use a pre-push hook in the main repository instead of a full mirror, though the mirror is more secure.
- **Section reference**: *Server-side push gate (authoritative layer)*

**3. Git Hook Lifecycle Mismatch**
- **What**: The spec states: "Pre-commit hook also injects signed trailer via interpret-trailers".
- **Why it matters**: The `pre-commit` hook runs *before* the commit message is created or editable. You cannot inject trailers at this stage because the message file doesn't exist yet. Additionally, calculating the `treeHash` at this stage requires explicitly running `git write-tree`, as the final tree isn't written.
- **Suggested fix**: Move the trailer injection and signature generation to the `commit-msg` hook. The `pre-commit` hook should retain the preflight authorization checks, while `commit-msg` handles the cryptographic stamping.
- **Section reference**: *Pre-commit fence (advisory layer)*

**4. Threat Model Inaccuracy regarding Bypass**
- **What**: The spec claims the mirror "can't be bypassed without root-level config changes the user has to make explicitly."
- **Why it matters**: Changing a git remote (`git remote set-url origin <url>`) or pushing directly to a URL (`git push https://github.com/...`) does not require root privileges. Any user or compromised agent can do this.
- **Suggested fix**: Correct the threat model. Acknowledge that the mirror prevents *accidental* bypass and standard tooling bypass, but a malicious agent executing arbitrary shell commands can still bypass it by explicitly pushing to an external HTTPS/SSH URL.
- **Section reference**: *Server-side push gate (authoritative layer)*

### 3. Strengths
- **Force-Take Stash Protocol**: Using `git -C <wt> stash push --include-untracked` before a lock takeover is a brilliant, complete resolution to the data loss incident from Iteration 1.
- **State Reconciliation Matrix**: This is the strongest architectural artifact in the spec. By explicitly mapping the union of disk state, git state, and binding state, you have eliminated edge cases and race conditions in worktree lifecycle management.
- **Per-Machine Bindings**: Moving `topic-worktree-bindings.json` out of git-sync closes a massive cross-tenant security hole while allowing multiple machines to correctly maintain independent physical worktrees for the same logical topic.
- **Semantic Signed Trailers**: Switching from path-based trailers to signed semantic identifiers (`Instar-Topic-Id`, `Instar-Session`) completely resolves the path-leakage concern while providing a robust audit trail.

### 4. Gaps & Missing Elements
- **Offline Commit vs. Push Race Condition**: If Session A commits (getting a valid signed trailer), loses its lock to Session B, and then tries to push, the push gate verifies the signature (which is valid) and the binding (which is active). The spec relies on `.lock-history.jsonl` to block this, but needs to explicitly define the logic: *Does the push gate reject pushes if the committing session is no longer the lock owner at push time?*
- **Doc-only Fast Path Push Destination**: If a read-only session commits a doc fix from `main`, does it push to the upstream `main` branch? The spec doesn't clarify if these commits are subject to branch protection rules or if they automatically spawn a PR.
- **Stashing Ignored Files**: `git stash --include-untracked` (`-u`) deliberately skips `.gitignore`d files. If an agent creates a `.env` file or local config that isn't committed, the force-take will *not* stash it, and subsequent cleanups will destroy it. (Consider if `-a` / `--all` is needed, though that risks stashing `node_modules`).
- **Disk Space Doubling for the Mirror**: A full bare mirror of the repo will double the `.git` directory size.

### 5. Industry Comparison
- **Virtualization vs. Physical Paths**: While Meta's Sapling uses virtualized working directories to swap branches instantly, your physical worktree approach is much safer for Node/JS ecosystems where `node_modules` and heavy build caches are highly path-dependent.
- **Gerrit/Enterprise Push Gates**: Using a local bare repo as a strict enforcement boundary mirrors how enterprise environments use Gerrit to enforce commit policies before they reach the canonical remote. It is a highly effective, battle-tested pattern.
- **Locking Mechanisms**: The combination of `flock`, `O_NOFOLLOW`, `fstat`, and boot-ID validation is exceptionally rigorous, matching patterns used in high-reliability databases (like PostgreSQL's postmaster.pid checks).

### 6. Scalability Assessment
- **Phase 1 (MVP, 10-50 users)**: Will work seamlessly. The 5s wall-time cold start for new topics is acceptable.
- **Phase 2 (Growth, 50-500 users)**: The 8GB disk budget will be consumed rapidly. A typical modern JS monorepo can easily exceed 1.5GB per worktree (with `node_modules`). You will likely need to implement aggressive background reaping (e.g., dropping to a 3-topic limit).
- **Phase 3 (Scale, 500-5000 users)**: The local git mirror will cause disk pressure and clone latency on large repositories. You will need to configure the local mirror to use git alternates (`objects/info/alternates`) pointing to the main checkout's `.git/objects` to prevent storing duplicate blobs.
- **Spike handling**: The atomic `rename(2)` swap for bindings file updates will perfectly handle concurrent attach spikes without corruption.

### 7. Recommendations (Prioritized)

1. **Fix OS-level Hardlink Compatibility**: Change `cp -al` to `cp -R --reflink=auto` / `cp -Rc` to prevent immediate failure on POSIX systems when copying `node_modules`.
2. **Implement Push Forwarding**: Define a `post-receive` hook in `.instar/git-mirror.git/` that executes `git push <real-remote> <refs>` so authorized commits actually reach the team.
3. **Correct Git Hook Assignments**: Move the trailer injection and tree hashing logic from `pre-commit` to the `commit-msg` hook, keeping only the preflight validation in `pre-commit`.
4. **Use Git Alternates for the Mirror**: When initializing `.instar/git-mirror.git/`, run `git clone --bare --reference .git <url>` to use object alternates, saving massive amounts of disk space.
5. **Clarify Push Gate Lock Verification**: Update the push gate logic to explicitly reject pushes if the session that signed the commit trailer is not the current lock owner in `.lock-history.jsonl` (preventing offline-commit race conditions).
