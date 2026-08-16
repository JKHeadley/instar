# Security Review — Iter 4 Convergence Verification

**Spec:** PARALLEL-DEV-ISOLATION-SPEC.md
**Reviewer:** Security
**Iteration:** 4 (final)

## GPT iter-3 critical follow-ups

### GPT C1 — GH ruleset explicit (direct push, admin bypass, force-push, app bypass)
**RESOLVED.** "Authoritative push gate (iter 4 — GH ruleset + offline Ed25519 verify + GH-side cache)" enumerates `restrict_updates`, `restrict_creations`, `restrict_deletions`, `non_fast_forward`, `required_status_checks`, plus `Bypass actors: empty by default`, `Admin bypass: disabled`, narrow allowlist for `github-actions[bot]` only on PR squash-merge commits. Bypass-coverage table covers `--no-verify`, `core.hooksPath`, fresh `/tmp/` clone, `git commit-tree`, libgit2/JGit/isomorphic-git, `gh api` create-commit, `--force`, admin direct push. ACs 40-42 enforce.

### GPT C2 — Rollback contradiction
**RESOLVED.** "Rollback (iter 4 — local vs origin separated)" explicitly states `Critical separation: a local kill-switch cannot disable origin-side enforcement.` Local flag only disables local hooks; origin downgrade requires GH PAT + `key-ops` ratification + audit log + auto-revert ≤4h. AC-59 enforces.

### GPT C3 — Doc-fix auto-merge through PR + check
**RESOLVED.** "Session modes" §doc-fix: `Doc-fix commits push to a topic/<id>-doc-fix branch and open a PR auto-labeled instar-doc-fix; merge queue auto-merges after the same worktree-trailer-sig-check passes. No privileged direct-to-main path.` Doc-only classification re-evaluated server-side at GH check time using actual diff, not just trailer claim.

### GPT C4 — Public verify endpoint hardening
**RESOLVED.** "Hardening of `/gh-check/verify-nonce` endpoint" lists: OIDC-only auth (validates against well-known OIDC config, checks `repository`, `workflow_ref`, `ref` claims), repo-scoping via signed enrolled-repos allowlist, 60 req/min/repo rate limit + 50/min alert, oracle protection (uniform `verifier_says_no` response), idempotency cache keyed `(repo, commitSha, nonce)` for `maxPushDelay` window. ACs 48 + 63 enforce.

### GPT C5 — Destructive-command MANDATORY for managed sessions
**RESOLVED.** "Destructive-command interception (iter 4 — MANDATORY for managed sessions)" — `Auto-installed at session spawn` (PATH + GIT_EXEC_PATH + BASH_ENV/ZDOTDIR + fsnotify fallback). `If snapshot fails: BLOCK the command. No fail-open path.` Day-2 escape hatch is bounded: 30-min cap, audit-logged on `key-ops`, auto-reverts. ACs 31 + 52 + 53 enforce.

## Gemini iter-3 critical follow-ups

### Gemini C1 — `git stash --include-ignored` repo bloat
**RESOLVED.** Force-take protocol step 3: `--include-ignored is intentionally OMITTED — stashing ignored content writes node_modules/ (hundreds of MB) into .git/objects permanently bloating the repo. Ignored WIP (.env, local config) is preserved in step 2's snapshot tarball, not in git.` R7 resolves the open question.

**Note:** AC-11 still says `git stash --include-untracked --include-ignored` — this contradicts the new force-take protocol. **Minor inconsistency to fix in AC-11 wording**, but design intent is clear and resolved.

### Gemini C2 — `cp -al` ext4 inode aliasing
**RESOLVED.** "Cross-platform matrix (iter 4 — `cp -al` removed for all platforms)" with explicit reasoning: `Hardlinks share inodes; in-place file edits (sed -i, fs.writeFileSync, agent rewrites) modify all hardlinked siblings simultaneously, destroying isolation. Git breaks hardlinks on checkout but not on agent file-edits.` Replaced with `cp -R` full copy on ext4 + Windows; APFS clonefile / btrfs reflink retained because they are CoW-safe.

### Gemini C3 — Offline tunnel cache paradox
**RESOLVED.** Cache moved to GH-side: `INSTAR_VERIFY_CACHE` lives as a GH Repository Variable (server-pushed every 5 min via `gh api`); GH workflow reads it directly via API — never touches the agent tunnel during cache-fallback. Cache freshness 1h with fail-closed beyond. AC-44 + AC-45 enforce.

### Gemini C4 — OS keychain hangs in headless daemons
**RESOLVED.** Key management §Storage step 2: keychain-probe-on-startup with fallback to `.instar/local-state/keys.enc` (chmod 0600, AES-GCM, machine-id-derived key + boot-salt). One-line warning logged. AC-61 enforces. **Caveat surfaced in R10:** machine-id-derived encryption re-introduces disk-imaging collision risk. Spec leans toward optional passphrase for production; flagged as still-open.

## Internal iter-3 must-fixes

### Cloudflare Tunnel SPoF
**RESOLVED.** "Tunnel SPoF mitigation (iter 4)": named tunnel REQUIRED for any repo opting in. Server polls own external URL every 10 min and auto-updates `INSTAR_VERIFY_TUNNEL_URL` GH variable on change. AC-56 enforces.

### GH-runner can't verify signature → Ed25519 + baked public key
**RESOLVED.** "Key management" §Two key types — Ed25519 keypair, public key baked into workflow YAML at install time, GH workflow verifies offline. AC-43 enforces.

### Per-machine binding-history.db blind to other machines
**RESOLVED.** New section "Multi-machine binding-history sync (iter 4)": `binding-history-log.jsonl` git-synced, signed, append-only, union-merge driver, 90d compaction. Server merges local + synced for nonce lookups. AC-55 enforces. Cross-machine collision recovery documented (`nonce-collision-cross-machine` → re-commit).

### /quick-doc-fix needs ratification
**RESOLVED.** "Auto-creation policy & promotion": `/quick-doc-fix also requires ratification (iter 4 — closes mode-switch attack vector). Ratification is lightweight... but mandatory.` UI auto-prefills 3-line diff preview. AC-57 enforces.

### rotate-keys requires ratification + keychain prompt
**RESOLVED.** Key management §Rotation: requires (a) keychain prompt for user presence, (b) `key-ops` ratification (rate-limited 1/hr), (c) re-signs all artifacts; Ed25519 rotation auto-opens PR for workflow public key update. AC-58 enforces.

### Snapshot files chmod 0600 + encrypted
**RESOLVED.** Force-take §step 2 + Destructive-command §step 2: `chmod 0600, optionally age-encrypted using a per-machine snapshot key derived from the keychain HMAC key (HKDF expand)`. AC-54 enforces. **Partial gap:** "optionally" age-encrypted leaves a path where snapshots are plaintext-on-disk if keychain unavailable. The HKDF derivation requires HMAC key, but headless fallback uses machine-id-derived flat-file key — chained derivation should still work, but spec doesn't explicitly say "encryption is mandatory in headless mode too." **Recommend tightening to "MANDATORY age-encryption; in headless mode, key derived from flat-file HMAC."**

### Day -2 PR trust-on-first-use acknowledged
**RESOLVED.** Migration §Day -2 explicitly tagged "TRUST-ON-FIRST-USE acknowledged"; 4-eyes rule via ruleset entry requiring 2 approving reviews on `.github/workflows/worktree-trailer-sig-check.yml` paths; sentinel signed with new key to anchor future trust. AC-62 enforces.

### Branch protection auto-config via gh API
**RESOLVED.** Migration §Day -2 step 5: `the GH ruleset is configured via gh api calls embedded in the migration script (creates the ruleset, sets required check, sets bypass actors, etc.)`.

### machineId server-keychain UUID, not OS-derived
**RESOLVED.** Key management §"machineId derivation (iter 4 — server-keychain UUID, NOT OS-derived)": `crypto.randomUUID()` at first-start, stored in keychain. AC-60 enforces. **Inconsistency:** "Cross-platform matrix" still has dangling lines at L546 referencing OS-derived `machineId` (`system_profiler` etc.) — these appear to be leftover paragraphs not deleted in iter 4. **Cosmetic but confusing — should be removed.**

## NEW critical issues introduced by iter-4

### N1 — `binding-history-log.jsonl` git-sync as cross-tenant nonce oracle (HIGH)
The new git-synced log contains `{topicId, sessionId, nonce, treeHash, parents[], commitSha, signature}` for every commit signed across all machines. **Anyone with read access to the repo gets the full development metadata trail of every contributor.** For multi-tenant deployments where the repo is shared but topics may be confidential (e.g., security-embargoed topics), this leaks topic existence and commit cadence. Cross-tenant guarantee in "Cross-tenant isolation" said `topic-worktree-bindings.json` is machine-local for this reason — but binding-history-log is git-synced, undermining that boundary for the metadata. **Mitigation needed:** either encrypt entries with a repo-shared key (and key escrow problem), drop session-id-level granularity, or scope log to `instar-private` branch with restricted access.

### N2 — GH PAT (`actions:write`) is undocumented blast-radius (MEDIUM-HIGH)
R13 acknowledges the PAT lives in `.instar/config.local.json` (gitignored). But `actions:write` lets the holder modify workflow YAML, repo variables, and runner secrets — not just the verify cache. A leaked PAT could **silently change the public key baked in the workflow → forge any trailer**. Spec needs: (a) least-privilege fine-grained PAT scoped to specific repo + only `variables:write` (not full `actions:write`), (b) rotation cadence, (c) detection of unauthorized workflow modification (sign workflow file content + verify on every check). Currently this is the single most powerful credential and least-defended.

### N3 — `union-merge` driver registration is install-time TOFU (MEDIUM)
`binding-history-log.jsonl` relies on a `merge=union` git attribute. If `.gitattributes` is not present at clone time on a fresh checkout (e.g., partial clone, sparse-checkout, contributor's first pull), git falls back to default 3-way merge → conflict markers in JSONL → server ingestion crashes or, worse, silently skips conflicted lines, missing nonces. Spec doesn't say where the driver is registered or how `.gitattributes` is bootstrapped pre-first-pull. **Recommendation:** embed `.gitattributes` in Day -2 PR, and have server explicitly validate `git check-attr merge -- .instar/state/binding-history-log.jsonl` returns `union` at startup; refuse to operate otherwise.

### N4 — `INSTAR_VERIFY_CACHE` Repo Variable signed bundle has no key version (LOW-MEDIUM)
The cache bundle is signed but spec doesn't specify which key signs it (HMAC? Ed25519?) or how rotation interacts. If HMAC-signed, the GH workflow can't verify it (HMAC is shared-secret). If Ed25519-signed, rotation must update both workflow public key AND any in-flight cache entries. Risk: stale cache signed under retired key → fail-closed during rotation window. **Spec should clarify Ed25519-signed and treat as part of the same rotation flow.**

### N5 — Fsnotify fallback race vs IDE bulk delete (LOW, acknowledged but underweighted)
"IDE bypass acknowledgment" admits `If the IDE deletes 100 files in <50ms, the snapshot may capture a partial state.` This is honest but the mitigation ("prefer terminal git over IDE git") is documentation-only — for non-developer users (designers in VS Code, e.g.) the de-facto guarantee is "your WIP may not be recoverable." This is acceptable as long as the user-facing message after such an event is accurate. Recommend adding an AC that the post-event attention-queue alert explicitly states "snapshot may be incomplete due to IDE-burst delete; check `.snapshots/` and stash carefully."

### N6 — Day -2 ruleset auto-config has chicken-and-egg ordering (LOW)
Migration step 5 says ruleset is configured *after* Day -2 PR merges. But `restrict_updates` once active immediately requires every subsequent push (including the migration script's own follow-up commits) to carry trailer + pass check. Spec doesn't say how the migration script itself completes its work after enabling enforcement. Likely fine in practice (set `enforcement: evaluate` first, then flip at Day 7) — but "Day -2 ruleset is configured" needs explicit `evaluate` not `active` to avoid bricking the migration mid-flight.

## Convergence summary

- 5/5 GPT criticals: RESOLVED.
- 4/4 Gemini criticals: RESOLVED (one minor AC-wording inconsistency on AC-11).
- 9/9 internal must-fixes: RESOLVED (one partial on snapshot encryption mandate; one cosmetic dangling-paragraph on machineId).
- 6 NEW issues surfaced; N1 (git-synced nonce oracle) and N2 (PAT blast-radius) are MEDIUM-HIGH and warrant a note in the convergence report even though we are not iterating further.

**Overall:** spec has converged on the iter-3 must-fix list. Two new design tensions (cross-tenant metadata leakage via binding-history-log; PAT scope/protection) emerge from the iter-4 architecture and should be tracked as known follow-ups rather than blockers.
