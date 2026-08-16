# Gemini 3.1 Pro Review: AGENT-WORKTREE-CONVENTION-SPEC.md

**Model**: gemini-3.1-pro-preview
**Date**: 2026-05-17
**Focus**: full document

---

## Raw Model Response

Here is a structured, cross-model specification review of the `AGENT-WORKTREE-CONVENTION-SPEC.md` document, evaluated specifically against your requested focus areas (concurrency, supply-chain, sandbox edge cases, and precision failure modes).

### 1. Overall Assessment
- **Score**: 7/10
- **Status**: **CONDITIONAL** (Do not ship until the `node_modules` symlink issue is resolved)
- **Summary**: The specification excellently identifies a complex environmental edge case (macOS sandbox dynamic revocation) and proposes a highly pragmatic, minimally invasive solution using the Signal vs. Authority framework. The additive nature of the CLI and the prompt-engineering scaffold updates are well-designed. However, the spec contains a fatal flaw regarding the `node_modules` symlink that directly contradicts the sandbox constraints it aims to solve, while also introducing a severe supply-chain/isolation vulnerability.

### 2. Critical Issues (Must Fix)

**Issue 1: Sandbox Revocation of Symlinked `node_modules`**
- **What**: The spec proposes symlinking `node_modules` from the shared instar repo (`~/Documents/Projects/instar/node_modules`) into the agent's worktree.
- **Why it matters**: The spec explicitly states: *"anything outside [the primary working directory] is subject to revocation when sandbox state shifts"*. A symlink is just a pointer. When the agent attempts to read/execute from the symlinked `node_modules`, the OS resolves the path back to the shared checkout—which is outside the sandbox boundary. The sandbox will revoke access, causing Node to crash with `Operation not permitted`, completely defeating the purpose of this spec.
- **Suggested fix**: Remove the symlink behavior. The agent must perform an isolated `npm ci` / `yarn install` within its own worktree, or utilize a sandbox-safe package cache (like `pnpm`'s content-addressable store, provided the store is initialized *inside* the agent's home directory).
- **Section reference**: Design > Layer 1 > "node_modules symlink"

**Issue 2: Shared State Mutation via Symlink (Supply-Chain / Isolation)**
- **What**: If `node_modules` is symlinked to the human's shared checkout, any package installations or modifications made by the agent affect the shared repo.
- **Why it matters**: If an agent runs `npm install <malicious-package>` or even just updates a dependency to test a fix, it mutates the human developer's primary `node_modules` folder. This violates agent isolation, risks breaking the human's local dev environment, and introduces a lateral supply-chain attack vector.
- **Suggested fix**: Enforce strict isolation. Do not share mutable dependency directories between the human environment and agent sandboxes.
- **Section reference**: Design > Layer 1 > "node_modules symlink"

**Issue 3: TOCTOU (Time-of-Check to Time-of-Use) Race Condition**
- **What**: The idempotency check ("refuse to clobber an existing path") implies checking if the directory exists before calling `git worktree add`.
- **Why it matters**: In highly concurrent agent setups (e.g., a router agent spinning up multiple sub-agents), two processes might check the path simultaneously, see it doesn't exist, and both attempt to create it, leading to a crash or corrupted git state.
- **Suggested fix**: Do not rely on a pre-check. Call `git worktree add` directly and handle its specific "already exists" exit code/stderr output to provide the clear error message. Rely entirely on Git's internal locking.
- **Section reference**: Design > Layer 1 > "Idempotency"

### 3. Strengths
- **Signal vs. Authority Framework**: Explicitly choosing *not* to implement a pre-command git hook is a brilliant decision. It completely avoids the "over-block" risk for human operators and CI systems operating in the shared repo.
- **Root Cause Isolation**: The spec correctly identifies that this is a dynamic macOS Sandbox (App Sandbox) issue, not a static TCC (Full Disk Access) issue, which dictates the correct architectural fix (moving the working directory).
- **Zero Flag-Day Rollout**: Layer 3 (the bash helper fallback) ensures that stranded agents can recover immediately without waiting for a global CLI update or a complex migration of existing state.
- **Rollback Clarity**: The rollback cost is explicitly defined, trivial to execute, and carries zero risk of data loss.

### 4. Gaps & Missing Elements
- **Disk Space / Garbage Collection**: Git worktrees (especially if they require their own `node_modules` once Issue 1 is fixed) are heavy. Creating them in `~/.instar/agents/<agent>/.worktrees/` will rapidly bloat the agent's home directory. There is no mention of a `prune` or cleanup lifecycle.
- **Agent Portability / Syncing**: If `~/.instar/agents/` is synced across machines (via dotfiles, iCloud, or a custom sync tool), syncing `.worktrees/` will cause massive conflicts and upload gigabytes of data. `.worktrees/` must be explicitly added to the agent's `.gitignore`.
- **Git Identity Leakage**: Worktrees share the `.git/config` of the base repository. If the agent commits from this worktree, it will use the human's `user.name` and `user.email`. The CLI should ideally inject a local config (e.g., `git config user.name "Instar Agent (echo)"`) to audit-trail agent commits.

### 5. Industry Comparison
- **Sandboxing Patterns**: Moving executable workspaces strictly inside the designated sandbox boundary is the industry standard for App Sandbox/container escapes (similar to Bazel's execution root enforcement).
- **CLI Wrappers**: Wrapping standard commands (`git`) with organizational conventions (`instar worktree`) rather than aliasing or hijacking the binary is a recognized best practice (seen in tools like Google's `fig` or Facebook's `hg` wrappers).
- **Dependency Management**: The proposed symlinking of `node_modules` is an established anti-pattern in hermetic build systems. Industry standard (Nix, Bazel) dictates that dependencies must be either deeply copied, hard-linked from a read-only global store, or freshly fetched to guarantee isolation.

### 6. Scalability Assessment
- **Phase 1 (MVP, 10-50 users)**: Works perfectly. Agents stop crashing.
- **Phase 2 (Growth, 50-500 users)**: Disk bloat becomes a critical user complaint. Users will find their hard drives filling up with orphaned agent worktrees because agents rarely clean up after themselves.
- **Phase 3 (Scale, 500-5000 users)**: Git lock contention on the shared bare repository will become an issue if multiple agents attempt to create worktrees or fetch concurrently.
- **Spike handling**: Sudden bursts of agent activity will stress the host machine's I/O if multiple worktrees are created simultaneously (especially without the symlink, requiring fresh `npm installs`).

### 7. Recommendations (Prioritized)

1. **Drop the `node_modules` symlink immediately**: Update Layer 1 to perform an isolated dependency install (or rely on the agent to run `npm install` itself). A symlink will trigger the exact sandbox revocation you are trying to fix and introduces a shared-state mutation vulnerability.
2. **Add `.worktrees/` to the agent's `.gitignore`**: Update the scaffold seed (Layer 2) to ensure worktrees are never accidentally committed to the agent's memory/state repository or synced across machines.
3. **Implement Atomic Error Handling**: Update the implementation instructions in Layer 1