# GPT 5.4 Review: AGENT-WORKTREE-CONVENTION-SPEC.md

**Model**: gpt-5.4
**Date**: 2026-05-17
**Focus**: full document

---

## Raw Model Response

## 1. Overall Assessment

- **Score**: **7/10**
- **Status**: **CONDITIONAL**

This is a strong, pragmatic additive spec with good problem framing, sensible scoping, and an appropriate bias toward low-risk tooling rather than invasive enforcement. The layered rollout, explicit side-effects review, and test plan are all solid. However, for the stated focus areas—especially concurrency, sandbox/permission edge cases, supply-chain trust boundaries, and precision failure modes—the spec is under-specified in several implementation-critical places. The biggest concern is that the design currently leaves too much behavior implicit around path validation, symlink/realpath handling, race conditions during create/symlink operations, and the trust model for `INSTAR_REPO` and fallback repo discovery. Those are fixable without changing the overall design, but they should be nailed down before implementation.

---

## 2. Critical Issues (Must Fix)

### Issue 1: Agent-home detection is vulnerable to false positives / path confusion
- **What**: The spec says to resolve agent home from CWD by “walking up to find a directory containing `.instar/AGENT.md`.” That is too loose. A malicious or accidental directory tree elsewhere could contain `.instar/AGENT.md`, causing the command to treat a non-agent directory as an agent home.
- **Why it matters**: This creates an **under-block / silent bypass** risk. The command could create worktrees in an unintended location while believing it is enforcing the convention. It also weakens the security boundary if “agent home” is inferred from a marker file alone rather than from a canonical root pattern.
- **Suggested fix**: Define agent-home discovery precisely:
  - Canonicalize `cwd` via `realpath`.
  - Walk upward via canonical parents.
  - Require the resolved agent home to match a strict pattern under `~/.instar/agents/<name>/` or another explicitly supported root.
  - Require both `.instar/AGENT.md` and a stable agent-home root invariant.
  - State whether symlinked working directories are allowed and how they are handled.
- **Section reference**: “Layer 1 — `instar worktree create` CLI subcommand”; “Tests”; Residual R-2.

### Issue 2: No canonical path / symlink safety rules for target path
- **What**: The spec says the only output location is `<agent_home>/.worktrees/<slug>/`, but does not define whether checks occur on raw paths or canonicalized paths. It also does not say what happens if `.worktrees` or the destination path is a symlink.
- **Why it matters**: This is a classic **sandbox bypass / precision failure** vector. A symlinked `.worktrees` could point outside the agent home, making the command appear compliant while actually creating a worktree elsewhere. Conversely, overly naive string-prefix checks can over-block valid paths or under-block crafted ones.
- **Suggested fix**: Require:
  - `agent_home_real = realpath(agent_home)`
  - create/verify `.worktrees` as a real directory, not a symlink
  - resolve parent path canonically before create
  - reject if any existing path component that matters (`.worktrees`, target) resolves outside `agent_home_real`
  - use containment checks on canonical paths, not string concatenation
  - explicitly reject symlinked `.worktrees`
- **Section reference**: “Layer 1”; “Idempotency”; “Interactions — node_modules symlink”.

### Issue 3: Concurrency and race behavior is not specified
- **What**: The spec mentions idempotency and “no race window on first creation” for `node_modules` symlink, but does not define behavior when two processes concurrently invoke `instar worktree create` for the same branch/slug or when filesystem state changes between checks and actions.
- **Why it matters**: This is the most obvious operational gap. Without explicit race handling, the implementation may produce partial worktrees, inconsistent symlink state, confusing error modes, or accidental clobber. This is especially likely in agent environments where retries, hooks, or multiple sessions may overlap.
- **Suggested fix**: Add concurrency semantics:
  - destination directory creation must be atomic (`mkdir` lock dir or equivalent)
  - if lock acquisition fails, return a deterministic “already being created / already exists” error
  - define cleanup behavior on partial `git worktree add` failure
  - define postcondition checks after `git worktree add`
  - add integration tests for concurrent same-slug invocation and interrupted creation
- **Section reference**: “Layer 1 — Idempotency”; “Interactions — node_modules symlink”; “Tests”.

### Issue 4: `INSTAR_REPO` trust model is under-specified
- **What**: The repo source is resolved from `INSTAR_REPO`, then `~/Documents/Projects/instar/`, then `~/instar/`. But the spec does not define validation of the chosen path beyond existence.
- **Why it matters**: This is a **supply-chain / trust boundary** issue. An attacker-controlled or mistaken `INSTAR_REPO` could point to an unrelated or malicious repo, causing the command to create a worktree from the wrong source and symlink its `node_modules`. Even if this is a local tool, the spec should state whether `INSTAR_REPO` is fully trusted or minimally validated.
- **Suggested fix**: Define validation rules:
  - path must exist and be a git repo or bare repo
  - optionally verify repo identity (e.g. top-level repo name, configured origin URL pattern, or presence of expected project markers)
  - reject if not a git repository
  - document that `INSTAR_REPO` is a trusted override if identity validation is intentionally omitted
  - never execute code from the repo during validation
- **Section reference**: “Layer 1 — Resolve the instar repo location”; “Interactions — Bare-mode instar repo”.

### Issue 5: `node_modules` symlink behavior is too casual for supply-chain and compatibility risk
- **What**: The spec says to symlink from the instar repo’s `node_modules` when present so tests run without per-worktree install. It does not define whether the source must be canonicalized, whether cross-device/symlinked source is acceptable, whether package-manager layout assumptions are stable, or how to handle existing destination content.
- **Why it matters**: This is a **supply-chain and correctness** hot spot. Symlinking dependency trees can create subtle breakage, stale dependency leakage, architecture mismatch, or trust confusion if the source repo is not the intended one. It can also create race conditions if one process is installing while another is linking.
- **Suggested fix**: Tighten this behavior:
  - canonicalize and validate source repo path first
  - create the symlink only after successful worktree creation
  - only if destination `node_modules` does not exist at all
  - reject or warn if destination exists and is not a symlink to the expected source
  - document that this is an optimization, not a guarantee
  - add tests for source missing, destination exists as dir, destination exists as symlink, and broken symlink cases
- **Section reference**: “Layer 1 — node_modules symlink”; “Interactions — node_modules symlink”; “Tests”.

### Issue 6: Branch/base behavior is ambiguous and may fail in common repo states
- **What**: The spec says “if branch exists, `git worktree add` it; if not, create from `main`.” It does not specify whether “exists” means local branch, remote branch, or any ref; nor does it specify what happens if `main` does not exist locally or remotely.
- **Why it matters**: This creates precision failure modes and potentially surprising behavior. A branch that exists only on `origin/<branch>` may be treated as absent and recreated from the wrong base. Repos using a different default branch would fail or misbehave.
- **Suggested fix**: Specify exact branch resolution:
  - check local branch first, then remote-tracking branch if desired
  - define whether to create local branch tracking remote
  - resolve default base branch from symbolic `origin/HEAD`, configured default branch, or fall back to `main`
  - fail clearly if no base branch can be resolved
  - add tests for local-only, remote-only, and missing-`main` cases
- **Section reference**: “Layer 1 — Branch behaviour”; “Tests”.

### Issue 7: Failure handling and cleanup semantics are incomplete
- **What**: The spec promises “no silent failures” but does not define what happens if `git worktree add` partially succeeds, if symlink creation fails after worktree creation, or if permissions fail mid-command.
- **Why it matters**: For a command intended to improve reliability in sandbox-sensitive environments, partial-state behavior is crucial. Otherwise users may be left with a half-created worktree and uncertain next steps.
- **Suggested fix**: Add explicit failure-mode rules:
  - if worktree creation fails, report exact failing step and leave no created target dir if safe to clean
  - if worktree succeeds but symlink fails, keep worktree and emit warning, not hard failure
  - if cleanup fails, say so explicitly
  - define exit codes or at least error categories
- **Section reference**: “Layer 1”; “Over-block risk”; “Acceptance criteria”.

---

## 3. Strengths

1. **Clear problem statement grounded in observed failures**
   - The spec does a good job distinguishing this from generic macOS/TCC issues and tying it to the actual sandbox boundary behavior. That makes the rationale concrete rather than speculative.

2. **Good scoping discipline**
   - The non-goals are strong. In particular, not trying to enforce this via bare-repo hooks or reorganize the `worktree` command group keeps the change small and realistic.

3. **Layered rollout is practical**
   - The split between CLI, scaffold, fallback helper, and docs is thoughtful. It avoids a flag day and respects the reality that existing agents won’t automatically pick up scaffold changes.

4. **Side-effects review is unusually explicit**
   - The “signal vs authority” framing is helpful and honest. The spec clearly acknowledges it is not a complete enforcement mechanism.

5. **Rollback is cheap**
   - The additive nature and low rollback cost are accurately described and reduce adoption risk.

6. **Test intent is good**
   - The use of tmp bare repo + tmp agent home for integration tests is the right direction and avoids over-coupling to the real environment.

7. **Precision about what is and is not being changed**
   - The spec is careful not to overclaim. It explicitly says raw `git worktree add` remains possible and that existing unsafe worktrees are not migrated.

---

## 4. Gaps & Missing Elements

### Missing edge cases
- **Symlinked CWD / symlinked agent home / symlinked `.worktrees`**
- **Case-insensitive filesystem edge cases** on macOS: path comparisons must not rely on naive string semantics
- **Slug collisions**:
  - `feature/x` and `feature-x` collide under `/ -> -`
  - branch names with spaces, unicode, shell-significant chars, `..`, leading dots, reserved names
- **Nested invocation**: running from inside an existing worktree under `.worktrees/...`
- **Existing path states**:
  - target exists as file
  - target exists as symlink
  - target exists as non-empty dir but not a worktree
- **Permissions edge cases**:
  - agent home writable but `.worktrees` not writable
  - repo readable but git metadata inaccessible
- **Repo state edge cases**:
  - bare repo vs non-bare repo specifics
  - no `main`
  - detached HEAD only
  - remote-only branch

### Unaddressed failure modes
- **TOCTOU races** between validation and creation
- **Partial state** after interrupted `git worktree add`
- **Broken `node_modules` symlink** after source cleanup or reinstall
- **Silent use of wrong repo** via `INSTAR_REPO`
- **Incorrect branch base** due to simplistic existence check
- **Raw git bypass remains likely**, but the mitigation is mostly documentation rather than tooling

### Implicit assumptions that should be explicit
- That all valid agent homes are under `~/.instar/agents/`
- That `.instar/AGENT.md` is authoritative enough to identify an agent home
- That sharing `node_modules` across worktrees is safe in this repo
- That `main` is the correct default base
- That `npx instar` installation/update cadence is sufficient to distribute the fix

### Missing sections
- **Security / trust model**
  - What inputs are trusted? `cwd`? `INSTAR_REPO`? existing filesystem layout?
- **Error taxonomy**
  - Which failures are hard errors vs warnings?
- **Concurrency model**
  - Single-writer assumptions need to be stated or removed
- **Operational telemetry / observability**
  - Even basic logging guidance would help detect recurrence and misuse
- **Migration guidance for existing unsafe worktrees**
  - Even if migration tooling is out of scope, a short operator playbook would help

---

## 5. Industry Comparison

### Compared to existing solutions in the same space
This resembles common internal-dev tooling patterns: a wrapper command around `git worktree` that standardizes placement and local conventions. That is a reasonable approach. Many organizations use scripts or dev CLIs to create worktrees in a controlled tree under a user workspace.

### Compared to industry best practices
Best practice would usually include:
- canonical path validation
- strict handling of symlinks
- atomic creation / lock semantics
- explicit trust boundaries for environment variables
- deterministic branch/base resolution
- structured error handling and cleanup

This spec gets the high-level workflow right but is currently light on those implementation-hardening details.

### Known patterns and anti-patterns
**Good patterns here**
- Additive wrapper rather than trying to globally intercept git
- Documentation + tooling + fallback bridge
- Testing against temp repos rather than production state

**Anti-patterns currently at risk**
- Marker-file-only root detection
- naive path-prefix enforcement
- unvalidated environment-variable override
- branch creation from hardcoded `main`
- optimistic statements like “No race window” without specifying atomicity

---

## 6. Scalability Assessment

### Phase 1 (MVP, 10-50 users): Will it work?
Yes, likely. For a small number of users on similar machines, this should materially reduce the sandbox failure mode. The additive nature and local-only scope make it easy to adopt.

### Phase 2 (Growth, 50-500 users): What breaks?
Several assumptions become brittle:
- different repo locations and custom layouts
- nonstandard agent-home structures
- branch naming collisions from simplistic slugging
- more frequent concurrent invocations
- more varied git repo states
- more stale or inconsistent `node_modules` symlinks across environments

At this stage, lack of strict validation and error taxonomy will create support burden.

### Phase 3 (Scale, 500-5000 users): Architecture changes needed?
Yes. You would likely want:
- a formal workspace registry rather than heuristic discovery
- stronger repo identity validation
- lock files / transactional create semantics
- richer telemetry
- optional policy enforcement or startup health checks
- maybe a generalized “safe worktree manager” abstraction rather than a single-purpose command

### Spike handling: What happens under sudden load?
Because this is a local CLI, “load” mostly means many concurrent local invocations or widespread rollout. The current spec does not define concurrency behavior, so spikes could produce races and confusing failures. Distribution-wise, the helper + CLI model is fine, but support load may spike if edge cases are not handled.

---

## 7. Recommendations (Prioritized)

1. **Specify canonical path validation and symlink rejection rules**
   - Define all path checks using `realpath`, require `.worktrees` to be a real directory under the canonical agent home, and reject symlink-based escapes.

2. **Add an explicit concurrency / atomicity section**
   - Define lock acquisition, same-slug concurrent invocation behavior, and cleanup semantics for partial failures. Add tests for races and interruption.

3. **Tighten the trust model for `INSTAR_REPO` and repo validation**
   - At minimum require that the path is a git repo/bare repo; ideally also verify project identity or clearly document that `INSTAR_REPO` is a trusted override.

4. **Make branch/base resolution deterministic and robust**
   - Specify local vs remote branch lookup, default-base discovery, and behavior when `main` is absent. Add tests for remote-only and non-`main` repos.

5. **Harden slug and existing-path handling**
   - Define slug sanitization, collision behavior, invalid-name rejection, and behavior for existing file/symlink/non-worktree directory states to avoid over-block and under-block surprises.

If those five areas are addressed, this becomes a much stronger and safer spec without changing its overall low-risk, additive design.