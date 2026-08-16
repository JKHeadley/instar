# GPT 5.4 Iter 3 Review: PARALLEL-DEV-ISOLATION-SPEC.md

## 1. Overall Assessment

- **Score**: 8/10
- **Status**: CONDITIONAL

This is a strong iteration and it clearly resolves most of the iteration-2 critical findings. In particular, the spec now correctly makes the GitHub-side check the authoritative enforcement point, fixes the hook lifecycle by moving trailer injection to `commit-msg`, adds replay defense fields, isolates read-only sessions from `main`, resolves the same-topic concurrency contradiction by making it exclusive, hardens force-take with snapshot + `--include-ignored`, and introduces explicit server-down behavior. The design is much more internally coherent than iter-2. However, I would still block final approval on a small set of material issues: the "required GitHub check on push to protected branches" model is not actually non-bypassable for direct pushes unless branch protection settings explicitly forbid them; the rollback section appears to overclaim that a local flag can neutralize a GitHub-required check; the doc-fix auto-merge path to `main` conflicts with the stated branch protection model; the verification architecture still has a central trust/availability bottleneck with underspecified auth and abuse controls on the public verify endpoint; and the destructive-command protection remains too optional relative to the severity of the motivating incident. So: substantial convergence, but not yet fully closed.

---

## 2. Critical Issues (Must Fix)

### Issue 1: "Authoritative push gate" is still overstated unless direct pushes to protected branches are explicitly impossible
- **What**: The spec says the GitHub Actions check is "the only non-bypassable enforcement layer" and that any push reaching origin is rejected by the required check. That is only true if branch protection/rulesets are configured to prevent direct updates unless required checks have passed. On GitHub, required status checks protect merges and, depending on ruleset configuration, can restrict pushes—but the document does not precisely specify the needed branch/ruleset semantics, actor restrictions, admin bypass policy, tag protection, or whether topic branches are protected against direct updates at all.
- **Why it matters**: This is the core security claim. If topic branches or `main` can still receive direct pushes from actors exempt from rulesets, or if admins/bots can bypass, the "authoritative gate" is not authoritative. That would reintroduce the exact class of bypass the iteration claims to have fixed.
- **Suggested fix**: Add a concrete GitHub ruleset/branch protection section specifying:
  - direct pushes to `main`, `topic/*`, `platform/*` are denied unless ruleset conditions are satisfied;
  - no admin bypass by default;
  - no bypass for GitHub Apps except explicitly allowlisted automation;
  - force-push disabled;
  - branch creation/update restrictions for `topic/*` and `platform/*`;
  - behavior for tags and merge queue;
  - exact event model: whether pushes are blocked pre-receive by GitHub rulesets or only merges are blocked.
  If GitHub cannot truly enforce this for topic branches in your plan, weaken the claim and state the actual guarantee.
- **Section reference**: "Authoritative push gate (iter 3 — GitHub-side)", "Authority model — restated for iter 3", Acceptance Criteria AC-6/7/8/23, Rollback.

---

### Issue 2: Rollback section conflicts with the claimed authority model
- **What**: Rollback says `.instar/local-state/isolation-disabled.flag` "disables preflight + commit-msg hook + GH check enforcement (sets check to neutral)." A local flag cannot directly cause a GitHub-required check to become neutral unless the GitHub workflow itself is designed to query that state from some shared service and trust it. That is not described, and it would be dangerous if it were.
- **Why it matters**: This is a major control-plane contradiction. Either the GitHub-side check is authoritative and closed on invalid/unavailable, or a local file can disable it. Both cannot be true as written. This creates ambiguity around emergency bypass, auditability, and attacker abuse.
- **Suggested fix**: Redesign rollback semantics explicitly:
  - local flag disables only local enforcement;
  - GitHub enforcement can only be downgraded by a separate audited admin action (e.g. `branch-protection downgrade`);
  - if there is a server-mediated emergency bypass mode, define who can activate it, how GitHub learns it, TTL, audit trail, and blast radius.
  Remove the implication that a local file can neutralize origin-side enforcement.
- **Section reference**: "Rollback", "Authoritative push gate", "Server-down / availability mode".

---

### Issue 3: Doc-fix auto-merge-to-main conflicts with required checks and branch protection
- **What**: Session modes say doc-fix "auto-merges to main on push (no PR required) if change is doc-only." Elsewhere, `main` is protected by the required `worktree-trailer-sig-check`, and "the only commits to main are merge commits from PR auto-merge." These statements conflict.
- **Why it matters**: This leaves an undefined privileged path into `main`. If doc-fix can push/merge directly, it may bypass the same review and branch protection assumptions the rest of the design relies on. If it must still go through PR or merge queue, the current text is misleading.
- **Suggested fix**: Pick one model and make it consistent:
  - either doc-fix uses a PR-less automation path via a GitHub App with tightly scoped permissions and required checks, documented explicitly;
  - or doc-fix still opens a lightweight PR and auto-merges after checks pass.
  Also define whether doc-fix commits require the same trailer verification and whether the doc-only classification is re-evaluated server-side at merge time.
- **Section reference**: "Session modes", "Authoritative push gate", "Side effects", Acceptance Criteria AC-13/14.

---

### Issue 4: Public verification endpoint is under-specified and creates a trust/abuse bottleneck
- **What**: GitHub Actions calls `/public/worktrees/verify-trailer-by-id` over Cloudflare Tunnel, and the server performs HMAC verification plus nonce/binding checks. But the spec does not define:
  - authentication/authorization of GitHub callers;
  - replay/rate-limit protections on the public endpoint;
  - how commit ranges are bound to repository identity;
  - whether the endpoint can be abused as an oracle to probe valid nonces/bindings;
  - what happens if multiple repos/environments exist;
  - whether Cloudflare origin exposure is restricted to GitHub IPs, signed requests, or OIDC.
- **Why it matters**: This endpoint is now critical-path for push authorization. If abused or spoofed, it can become a DoS vector or information leak. If not strongly bound to the calling repository/workflow identity, another repo could potentially query and learn verification state.
- **Suggested fix**: Specify a hardened verification protocol:
  - GitHub workflow authenticates using OIDC or a shared secret scoped per repo/environment;
  - server validates repository, workflow, ref, and commit SHAs;
  - endpoint is rate-limited and returns minimally informative errors;
  - nonce verification is idempotent and race-safe;
  - Cloudflare policy restricts origin access to authenticated requests only.
  Consider moving toward signed verification artifacts rather than online HMAC verification if availability remains a concern.
- **Section reference**: "HMAC key management", "Authoritative push gate", "Server-down / availability mode", Open Question R4.

---

### Issue 5: Destructive-command protection is still too optional for a spec motivated by destructive data loss
- **What**: The PATH shim for `git clean`, `git reset --hard`, `rm -rf`, etc. is explicitly opt-in. Without the shim, "destructive commands proceed as normal" and only a later reaper alert is generated.
- **Why it matters**: This leaves the original user-harming failure mode largely intact for many realistic paths. An alert after deletion is not a mitigation. Since the motivating incident involved destructive cleanup outside commit hooks, this remains a material gap.
- **Suggested fix**: Make destructive-command interception mandatory for managed sessions, not optional. Options:
  - wrap the shell/exec environment for spawned sessions so managed aliases/shims are always first in PATH;
  - add explicit server-mediated cleanup commands and require agents to use them;
  - at minimum, block known destructive commands in managed sessions unless a snapshot succeeds.
  If full interception is impossible, the spec should clearly downgrade the guarantee and add compensating controls.
- **Section reference**: "Destructive-command audit gate", "Side effects", Acceptance Criteria AC-31.

---

## 3. Strengths

1. **The authority model is much improved**
   - The spec explicitly demotes the local mirror to fast feedback and elevates the origin-side check. That directly addresses the prior "push-gate not truly authoritative" finding.
   - Section: "Authority model — restated for iter 3", "Authoritative push gate".

2. **Replay defense is materially better**
   - Adding nonce + parent + expiry is the right direction and directly responds to trailer replay concerns.
   - Section: "Commit trailer (iter 3 — replay defense + correct hook)".

3. **Hook lifecycle bug is correctly fixed**
   - Moving trailer injection from `pre-commit` to `commit-msg` is the right fix and shows good understanding of Git's lifecycle.
   - Section: "Hook lifecycle (iter 3 fix)".

4. **Read-only isolation is now conceptually correct**
   - "Main checkout is never used as a session cwd" is a major design improvement and directly closes one of the more dangerous contradictions from iter-2.
   - Section: "Session modes (iter 3 — no session ever cwds main)".

5. **Same-topic concurrency is now internally consistent**
   - The spec now clearly chooses exclusive locking with sequential attachment, which is coherent with the lock model and easier to reason about.
   - Section: "Same-topic concurrency model (iter 3 — pinned exclusive)".

6. **Force-take preservation is significantly more robust**
   - FS snapshot before stash plus `--include-ignored` is a strong response to the `.env` / ignored-file loss issue.
   - Section: "Force-take protocol (iter 3 — FS snapshot + scoped stash)".

7. **Cross-platform handling is more realistic than before**
   - Replacing a simplistic `cp -al` assumption with a platform matrix is a meaningful improvement.
   - Section: "Cross-platform matrix (iter 3 — explicit)".

8. **The spec is test-aware**
   - The acceptance criteria are concrete and broad, and the two-session harness is a good sign that the authors understand concurrency bugs need dedicated test infrastructure.
   - Section: Acceptance Criteria AC-1 through AC-39.

9. **Threat model is unusually explicit**
   - It names many bypass vectors and operational failure modes rather than hand-waving them away.
   - Section: "Threat model".

10. **Migration and rollback are at least thought through**
    - Even though rollback has a contradiction, the spec does include a practical migration path, dark launch, grandfathering, and operational controls.
    - Section: "Migration", "Rollback".

---

## 4. Gaps & Missing Elements

### A. Commit signing semantics still overclaim provenance
The spec is better, but the server verification still cannot prove the tree was "produced inside the worktree" in a strong forensic sense. It proves that a session with a valid lock asked the server to sign a tuple involving a tree hash and parent. A user could still construct the index/tree through alternate mechanisms and request signing. The doc partly acknowledges this in the threat model, but some wording still implies stronger provenance than is actually possible.

**Need**: Tighten language everywhere to "authorized under a valid session binding/lock" rather than "produced inside the worktree."

---

### B. Nonce consumption semantics are unclear for retries/races
The GH check verifies "nonce not previously seen for this binding." But what is the exact state transition?
- Is a nonce consumed at sign time or first successful verification?
- What if the same commit is pushed twice?
- What if two GH workflow runs race on the same push/PR event?
- What if a push partially fails and is retried?

**Need**: Define nonce uniqueness over `(repo, commitSha)` or `(binding, nonce, treeHash, parentSha)` and make verification idempotent for the same commit while still preventing replay into a different commit.

---

### C. Expiry window may be too short and operationally brittle
A 5-minute trailer expiry with ±10 minute receive skew is awkward. A developer can create a commit locally, go offline, and push later; under this design it fails unless emergency cache paths are used. That may be intentional, but it is a pretty severe UX and reliability tradeoff.

**Need**: Explicitly justify the expiry choice and document expected user flows. Consider binding trailer validity to commit creation time plus stronger nonce semantics rather than a very short wall-clock expiry.

---

### D. Force-verify-cache is underspecified and potentially dangerous
This cache is introduced as outage fallback, but:
- what exact artifact is cached?
- where is it stored?
- how is it distributed to GitHub?
- how does GH verify it independently?
- how is replay prevented if a valid pair is cached?
- why does this not become a bypass path broader than the outage window?

**Need**: A full protocol section or removal until designed.

---

### E. "Read-only fallback" is not fully enforceable against arbitrary local writes
The spec says existing sessions continue in read-only fallback and commits are blocked. That controls Git commit/push paths, but not arbitrary file mutation by subprocesses or external tools. Since the document previously recognized "read-only sessions can still write via subprocess," this needs stronger wording.

**Need**: Clarify that "read-only" means "cannot produce authorized commits," not OS-level filesystem immutability. If stronger guarantees are desired, mount/ACL/sandbox mechanisms would be required.

---

### F. No explicit treatment of merge commits, rebases, cherry-picks, amend, and squash
The trailer scheme signs `treeHash` and `parentSha`. But:
- merge commits have multiple parents;
- `git commit --amend` changes parent/message semantics;
- rebase rewrites commit ancestry;
- squash merges into `main` create new commits without original trailers.

**Need**: Define support matrix:
- Are merge commits on topic branches allowed?
- For merge commits, sign all parent SHAs in order.
- For amend, require a new trailer.
- For PR squash/rebase merges, define whether the check applies to pre-merge branch commits only or to merge-result commits on `main`.

This is especially important because the workflow triggers on pushes to `main`.

---

### G. Branch/worktree naming and path limits are not fully handled
On Windows in particular, nested `.instar/worktrees/topic-<id>-<slug>/...` plus repo paths can exceed path limits. Slug max 30 helps but may not be sufficient depending on checkout root depth.

**Need**: Add path-length budget checks and fallback shortening strategy.

---

### H. Optional local mirror forwarding semantics remain fuzzy
The threat model mentions "Push-mirror → origin forwarder — undefined; commits reach mirror but never origin." The mirror is now optional and demoted, but forwarding semantics are still lightly specified.

**Need**: Define transactional behavior, retry policy, divergence handling, and user-visible state if mirror accepts locally but forwarding fails.

---

### I. Security of `.instar/state/topic-branch-map.json` needs more detail
This file is git-synced and signed, but:
- who verifies signatures and when?
- what prevents stale-but-valid entries from dominating after branch renames?
- how are concurrent updates merged?
- what protects against rollback to an older signed map from history?

**Need**: Add versioning/monotonicity and merge conflict resolution rules.

---

### J. Snapshotting strategy may leak secrets and create compliance issues
The design snapshots entire worktrees, including ignored files like `.env`. That is correct for preservation, but it also creates compressed archives of secrets under `.instar/worktrees/.snapshots/`.

**Need**: Add security controls:
- local encryption at rest for snapshots;
- permissions/ownership requirements;
- explicit exclusion/inclusion policy;
- secure deletion/reaper behavior;
- user warning that ignored secrets may be archived.

---

## 5. Industry Comparison

### Compared to existing solutions in the same space
This resembles a hybrid of:
- Git worktree-based local isolation,
- server-backed session/lease management,
- and CI-enforced policy verification.

That is more sophisticated than typical local dev tooling. Most systems stop at local hooks, branch naming conventions, or IDE workspace isolation. This spec goes further by trying to make origin-side policy authoritative, which is directionally aligned with how serious policy enforcement is usually done.

### Compared to industry best practices
**Aligned with best practices**
- Enforce critical policy server-side / origin-side, not just client-side.
- Treat local hooks as advisory because they are bypassable.
- Use explicit leases/heartbeats/fencing for concurrency.
- Separate local machine state from synced repo state.
- Add auditability around destructive operations.

**Less aligned / risky**
- Using a live local agent server as a dependency for GitHub verification is unusual and fragile. Industry systems usually prefer:
  - signed attestations verifiable offline in CI;
  - centralized, highly available verification services;
  - or native Git server hooks where available.
- HMAC with online verification is operationally simpler but creates a trust bottleneck and availability dependency.
- Optional interception for destructive commands is weaker than the risk profile suggests.

### Known patterns and anti-patterns
**Good patterns**
- Lease + fencing token pattern to prevent stale writers.
- Quarantine-before-delete for reaping.
- Explicit threat-model-driven design.
- Narrowing "read-only" to a specific workflow mode.

**Anti-patterns or near anti-patterns**
- Overstating guarantees from Git metadata and CI checks.
- Relying on short-lived online verification for core developer workflows without a robust fallback.
- Mixing local kill switches with supposedly authoritative remote enforcement.
- Making critical safety controls optional when the threat is common and severe.

---

## 6. Scalability Assessment

### Phase 1 (MVP, 10-50 users): Will it work?
Yes, mostly. At this scale, a local server + keychain + Cloudflare Tunnel + GitHub workflow verification model is operationally feasible. The worktree isolation model, exclusive locks, and reconciliation matrix should work well. The biggest risks are operational confusion, not scale: branch protection correctness, endpoint auth, and doc-fix/main-path contradictions.

### Phase 2 (Growth, 50-500 users): What breaks?
Several things start to strain:

1. **Verification service fragility**
   - Many pushes trigger many GH workflow calls to per-user or per-machine agent servers.
   - Tunnel reliability, endpoint auth, and latency become a meaningful source of friction.

2. **Operational support burden**
   - Keychain issues across macOS/Linux/Windows multiply.
   - Snapshot storage and cleanup become more visible.
   - Lock recovery and migration edge cases become support-heavy.

3. **Branch/ruleset complexity**
   - Protecting `topic/*` and `platform/*` consistently across many repos/users is easy to misconfigure.

4. **CI cost**
   - Verifying every commit in every push and PR can become expensive and slow.

### Phase 3 (Scale, 500-5000 users): Architecture changes needed?
Yes. At this scale, the current architecture is unlikely to remain viable without centralization.

Likely changes:
- Replace per-agent-server online verification with a centralized verification service or offline-verifiable signed attestations.
- Move from HMAC to asymmetric signatures so GitHub can verify without calling back to a live server.
- Introduce durable, replicated binding/nonce history rather than machine-local SQLite for authoritative verification.
- Formalize multi-repo, multi-tenant authz for verification.
- Potentially integrate with a proper merge queue / policy engine.

### Spike handling: What happens under sudden load?
Under a push storm:
- GitHub check latency spikes due to Tunnel round-trips.
- If the server is down or slow, checks fail closed, which is safe but can halt development.
- The `force-verify-cache` fallback is supposed to help, but it is not sufficiently specified to judge its safety under sustained outage.
- On local spikes, commit-msg signing p99 ≤100ms may be hard if many sessions contend for one server process plus keychain operations.

---

## 7. Recommendations (Prioritized)

1. **Specify the exact GitHub enforcement model and remove any overclaim about "non-bypassable" until it is precisely true**
   - Add a dedicated section for GitHub rulesets/branch protection, actor restrictions, admin bypass policy, and direct-push semantics for `main`, `topic/*`, and `platform/*`.

2. **Resolve the rollback contradiction so local disablement cannot silently neutralize origin-side enforcement**
   - Separate local hook disablement from remote policy downgrade; require an audited admin action for the latter.

3. **Define a hardened verification protocol for the public GH-check endpoint**
   - Add caller authentication, rate limits, repo/workflow binding, idempotent nonce semantics, and failure-mode behavior. If possible, plan a path to offline-verifiable signatures.

4. **Make destructive-command protection mandatory for managed sessions, or explicitly downgrade the guarantee**
   - Given the motivating incident, an opt-in shim is too weak. Ensure all spawned sessions inherit enforced wrappers or blocked destructive commands unless snapshot succeeds.

5. **Normalize the commit model across doc-fix, merge commits, squash/rebase, and `main`**
   - Clarify whether doc-fix uses PRs or privileged automation, how merge-result commits are verified, and how multi-parent commits and amend/rebase interact with trailer signing.

If those five items are resolved, this spec would be much closer to approval-ready. The iteration shows real convergence; the remaining issues are mostly about making the claimed guarantees match the actual enforcement model.
