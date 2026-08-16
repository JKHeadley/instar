Here is a thorough, structured analysis of the `COMPREHENSIVE-DESTRUCTIVE-TOOL-CONTAINMENT-SPEC.md` specification.

### 1. Overall Assessment
- **Score**: 9/10
- **Status**: CONDITIONAL (Approve upon addressing git-specific bypass vectors)
- **Summary**: This is an exceptional specification. It brilliantly tackles both the immediate technical vulnerability (unrestricted git execution) and the deeper organizational anti-pattern that allowed it to recur (the "out-of-scope trap"). The layered defense strategy—combining runtime guards, compile-time AST linting, and process-level LLM enforcement—is highly sophisticated. Furthermore, the spec "dogfoods" its own governance rules by validating its own deferrals, which is a masterclass in specification writing. It only requires a few critical patches to close obscure `git` execution bypasses.

### 2. Critical Issues (Must Fix)

**Issue 1: Environment Variable & Flag Bypass (`GIT_WORK_TREE`)**
- **What**: The spec states that `-C <dir>` is checked by the guard, but explicitly mentions skipping `--work-tree=<path>` and `--git-dir=<path>` during verb extraction. Furthermore, it does not mention inspecting `opts.env` or `process.env`.
- **Why it matters**: A caller could pass `opts.cwd: <tmpdir>` but include `env: { GIT_WORK_TREE: '<instar-source>' }` or pass `--work-tree=<instar-source>` in the args. The guard would check the safe `<tmpdir>`, pass, and then `git` would execute the destructive command against the real instar source tree.
- **Suggested fix**: 
  1. The guard must inspect `opts.env` (and `process.env` if `opts.env` isn't strictly overriding) for `GIT_WORK_TREE` and `GIT_DIR`, passing them to `assertNotInstarSourceTree`.
  2. If `--work-tree=<path>` or `--git-dir=<path>` are found during argument parsing, those paths *must* be passed to the guard, not just skipped.

**Issue 2: Git Alias Bypass in `readSync`**
- **What**: `readSync` bypasses the source-tree guard by verifying the requested verb is in `READONLY_GIT_VERBS`. However, git allows users to configure local or global aliases.
- **Why it matters**: If a local environment has `~/.gitconfig` containing `[alias] status = clean -fdx`, a call to `SafeGitExecutor.readSync(['status'])` will bypass the guard (because `status` is in the read-only allowlist) but execute a destructive wipe.
- **Suggested fix**: Ensure `SafeGitExecutor` disables aliases. Inject `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_SYSTEM=/dev/null` into the execution environment, or prepend the `git` command with the appropriate flag (e.g., `-c core.aliases=false` or similar, depending on git version) to guarantee the verb executed is the literal verb evaluated by the primitive.

**Issue 3: Layer A Cache Invalidation Trap**
- **What**: The `/instar-dev` LLM classification is cached based on the SHA-256 of the spec content.
- **Why it matters**: If the LLM hallucinates a classification (e.g., flags a legitimate sentence as `recurrence-risking`), the author is permanently blocked. Changing the spec to "trick" the LLM into a new hash is poor UX. 
- **Suggested fix**: Add a `--force-refresh` or `--no-cache` flag to the `/instar-dev` skill to allow human override/retry of the LLM classification. 

### 3. Strengths
- **Dogfooding Governance**: Applying Layers A, B, and C to the spec itself (Section: *Meta — how this spec complies with the rule it introduces*) is brilliant. It proves the rule works before the code is even written.
- **Signal vs. Authority Awareness**: Explicitly mapping the enforcement mechanisms to the "Signal vs. Authority" paradigm ensures the team understands *why* an LLM is used for intent (authority) and grep is used for structure (signal).
- **Graceful Migration & Rollback**: The step-by-step bisectable migration plan ensures that the lint rule (the most restrictive part) lands last. The rollback plan is equally well-thought-out.
- **Elimination of `simple-git`**: Removing the dependency entirely rather than wrapping it eliminates a parallel