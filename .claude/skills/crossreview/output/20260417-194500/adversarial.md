# Adversarial Review — Iter 4 (Final Round)

## Part 1 — Iter-3 Vector Resolution

| # | Vector | Status | Evidence |
|---|--------|--------|----------|
| 1 | Direct-push via admin/app/bot exemption | **RESOLVED** | Ruleset `bypass_actors: []`; `noreply@github.com` allowed only for squash-merges whose parents pass (lines 382-383). AC-41/AC-46. |
| 2 | Local kill-switch claimed to disable GH check | **RESOLVED** | Rollback section line 765 explicit; `isolation-disabled.flag` only disables local hooks. AC-59. |
| 3 | Doc-fix-merge-to-main bypassing protection | **RESOLVED** | Doc-fix pushes to `topic/<id>-doc-fix` branch through PR + same check (line 218). Server re-evaluates doc-only at GH check time. |
| 4 | GH-runner cross-repo oracle abuse | **RESOLVED** | OIDC + enrolled-repo allowlist; uniform `verifier_says_no` (line 401); 60 req/min limit. AC-63. |
| 5 | Tunnel SPoF | **PARTIAL** | Named tunnel + 1h `INSTAR_VERIFY_CACHE` fallback. If both down >1h → fail-closed = total push block. No multi-region path. |
| 6 | Online-verify race / replay-on-retry | **RESOLVED** | Idempotency cache on `(repo, commitSha, nonce)` (line 402); AC-48. |
| 7 | Offline commit window 5min | **RESOLVED** | `maxPushDelay` default 7d, ceiling 30d. AC-49. |
| 8 | Push-time HMAC key on GH | **RESOLVED** | Public Ed25519 baked into workflow; private key never leaves machine. |
| 9 | `git stash --include-ignored` repo bloat | **RESOLVED** | Permanently dropped (line 296, R7). **DOC BUG:** AC-11 still references `--include-ignored` — contradicts design. |
| 10 | `cp -al` cross-worktree inode aliasing | **RESOLVED** | Removed all platforms; matrix uses `cp -c` / `--reflink=auto` / `cp -R` (lines 522-534). |
| 11 | Headless-daemon keychain hang | **RESOLVED** | Flat-file fallback, AES-GCM, 0600 (line 314-315). AC-61. (See V1 below.) |
| 12 | Tunnel-cache paradox | **RESOLVED** | Cache lives on GH side, reachable independent of tunnel. |
| 13 | `/quick-doc-fix` mode-switch promotion | **RESOLVED** | All mode-switches require ratification (line 498); AC-57. |
| 14 | IDE bypass of PATH shim | **PARTIAL** | Acknowledged (lines 472-474); fsnotify best-effort. >50 deletes in <50ms may capture partial state. Not closeable without root. |
| 15 | GH-created merge commit lacks trailer | **RESOLVED** | Bypass-actor allowlist for `noreply@github.com`; AC-46. |
| 16 | Multi-machine binding-history blindness | **RESOLVED** | Signed append-only `binding-history-log.jsonl` git-synced; AC-55. |
| 17 | Snapshot tarball as secrets store | **RESOLVED** | 0600 + age-encrypted via HKDF-derived per-machine key. AC-54. |
| 18 | Disk-imaging machineId collision | **RESOLVED** | Server-generated `crypto.randomUUID()` in keychain at first-start (line 317-320). AC-60. **DOC BUG:** lines 540-546 duplicated; second copy still cites old OS-derived `system_profiler`/`/etc/machine-id`/`wmic` derivation. |
| 19 | Day -2 prerequisite-PR TOFU | **PARTIAL** | TOFU explicitly acknowledged; 2-approval ruleset on workflow file; side-effects artifact documents. Cannot eliminate by definition. |

**Spec defects to fix in iter 5:**
1. Lines 540-546 contain duplicated/contradictory `machineId` block citing rejected OS-derived path.
2. AC-11 wording contradicts line 296's drop of `--include-ignored`.

---

## Part 2 — NEW Iter-4 Attack Vectors

### V1 — Ed25519 private-key extraction via flat-file fallback (CRITICAL)

Headless fallback derives AES-GCM key from `/etc/machine-id` + `.boot-salt`, both colocated with `keys.enc` on the same disk. An attacker with **read-only filesystem access** (lost laptop, disk image, backup tape, container `/etc` mount) reconstructs the key offline. Spec acknowledges in R10 ("lean: passphrase for production") but defers. Until R10 is resolved, headless fallback is **plaintext-equivalent to disk-thief**. Extracted Ed25519 private key signs trailers indefinitely; revocation requires a PR + 4-eyes the attacker may also forge.

**Recommend:** passphrase REQUIRED for headless mode (not "lean yes"); on Linux with TPM, prefer TPM-sealed key; documented fallback to ephemeral in-memory key (rotated on restart, accept rebinding cost).

### V2 — Workflow public-key-version rollback via subsequent PR

Workflow YAML lists "allowed key version set." Day -2 PR has 2-approval requirement on `.github/workflows/worktree-trailer-sig-check.yml` (line 558), but **subsequent edits don't appear permanently gated** — line 558 reads as Day-2-specific. Attacker who compromises one approver later adds `keyVersion: 0` (retired) to allowlist, signs anything with leaked old key. AC-62 only covers Day -2.

**Recommend:** make 2-approval rule a **permanent** ruleset entry on that workflow path; add CODEOWNERS requiring security-team review.

### V3 — `INSTAR_VERIFY_CACHE` stale-replay by `actions:write` PAT holder (HIGH)

Anyone with `actions:write` (broader than `repo:admin`) can write any value to `INSTAR_VERIFY_CACHE`. Signature prevents forgery — but attacker can **replay an OLD valid cache** captured earlier (it's a public Repo Variable!). At T+30min they overwrite current cache with C1 from T=0. Workflow verifies a signed-but-stale bundle: false-negatives (legitimate pushes rejected = DoS) or false-positives if `expiresAt` was generous.

**Recommend:** include monotonic `cacheSequence` in signed payload; workflow rejects `cacheSequence < lastSeen` (lastSeen in a separate Repo Variable that only increases).

### V4 — `INSTAR_VERIFY_TUNNEL_URL` SSRF + OIDC token exfiltration (CRITICAL)

Anyone with `actions:write` can change `INSTAR_VERIFY_TUNNEL_URL` to attacker-controlled URL. Workflow POSTs OIDC-authenticated requests to it. Attacker receives a **legitimate GitHub-issued OIDC token** with the victim repo's `repository` claim — replayable against any third-party service that accepts GitHub OIDC for that repo (AWS role assumption, Vault, Cloudflare, npm provenance). The Action then fails, but the bearer token is already exfiltrated.

**Recommend:** pin `INSTAR_VERIFY_TUNNEL_URL` in the workflow YAML itself (not a Repo Variable). URL rotation becomes a workflow-PR subject to V2's 2-approval rule.

### V5 — `binding-history-log.jsonl` rebase rewrite by tampering machine (HIGH)

The log is git-synced and "append-only" by **convention**, not enforcement. A compromised dev machine: (a) `git rebase -i` to drop entries containing nonces it wants to reuse, (b) re-signs artificial entries with its own valid key, (c) pushes. Union-merge driver merges the rewritten history. Each entry is signed individually, so dropped entries are silently absent (no signature to fail). GH check sees "nonce unseen" → accepts replay.

**Recommend:** each entry includes `prevEntrySha` (Merkle chain); ingest verifies chain continuity from last known head; chain-break → quarantine sync. Server periodically pushes chain head to a `INSTAR_BINDING_HISTORY_HEAD` Repo Variable as tamper-evident anchor visible to GH check.

### V6 — `BASH_ENV` shim escape via `env -i` / `--noprofile`

`BASH_ENV`/`ZDOTDIR` only fires in non-interactive POSIX bash with inherited env. `bash --noprofile --norc -c 'git clean -fd'` or `env -i bash -c '...'` opts out entirely. Fsnotify catches large deletions but **not targeted small ones**: `git rm one-critical-file.ts && git commit --no-verify` — fsnotify sees 1-file change (under >5 threshold), trailerless commit caught only on push... unless attacker stashes change and never pushes (corrupting working tree to sabotage another session).

**Recommend:** lower fsnotify threshold to "any deletion of `git ls-files`-tracked file → snapshot"; document `env -i`/`--noprofile` as known-bypass.

### V7 — Public-key swap during rotation auto-PR (HIGH)

`rotate-keys` auto-opens PR to update workflow public key (R12). Window: between rotation start and PR merge. Attacker with momentary machine compromise substitutes their own attacker-generated public key in the PR, gets legitimate maintainer to approve (looks like routine rotation). No out-of-band proof the public key in PR corresponds to a key actually held by the legitimate server.

**Recommend:** rotation PR body includes a **challenge signature** — server signs a freshly-generated UUID with the new private key; PR includes UUID + signature; CI step on the rotation PR verifies challenge against the public key being installed. Without it, approval doesn't establish key authenticity.

### V8 — Latent `pull_request_target` OIDC abuse on fork PRs

Workflow currently triggers on `pull_request` (default = fork's HEAD, no secrets, no OIDC `id-token: write` for fork). If a future maintainer changes to `pull_request_target` (common need: secrets in PR check), **fork's HEAD** runs with **base repo's secrets and OIDC scope**. Malicious fork PR can issue arbitrary `gh-check/verify-nonce` calls with the base repo's `repository` claim — bypasses enrolled-repo allowlist.

**Recommend:** "**MUST NOT use `pull_request_target`**" enforced by lint check in repo CI. Server-side: `/gh-check/verify-nonce` rejects if OIDC `event_name == 'pull_request'` AND `head_ref` doesn't match topic branch pattern.

---

## Part 3 — Convergence Verdict

**Iter 4 closes 16 of 19 iter-3 vectors fully**, with 3 honestly-acknowledged partials (Tunnel SPoF, IDE bypass, Day-2 TOFU).

**Iter 4 introduces 8 new vectors**:
- **CRITICAL (must fix before approval):** V1 (key extraction), V4 (OIDC SSRF)
- **HIGH (small spec additions):** V2, V3, V5, V7
- **MEDIUM (track as follow-up):** V6, V8

**Plus 2 spec defects** (duplicated machineId block lines 540-546; AC-11 contradicts line 296).

**Recommendation:** one more iteration warranted to address V1, V4, V5 and the doc bugs. The Ed25519 + ruleset architecture is structurally sound; remaining gaps are around **key custody under failure modes** (V1), **GH-side configuration as attack surface** (V2-V4), and **append-only that isn't actually append-only** (V5). None is architectural; all are localized hardening.
