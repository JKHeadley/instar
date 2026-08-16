Here is a thorough, structured analysis of the `PRE-BUILD-SCOUTING-SPEC.md` document.

### 1. Overall Assessment
*   **Score**: 9/10
*   **Status**: CONDITIONAL (Approve upon resolving git-merge and CI enforcement clarifications)
*   **Summary**: This is an exceptionally rigorous, adversarial-minded specification. It successfully translates the human concept of "doing your homework before designing" into a cryptographically verifiable, machine-enforceable state machine. The threat modeling is outstanding, specifically the defenses against TOFU (Trust On First Use), agent rubber-stamping, and scope contraction. It borrows heavily from secure software supply chain (SLSA) and transparency log concepts. The primary areas needing refinement are concurrency handling in the git-backed ledgers and ensuring local pre-commit checks cannot be bypassed via GitHub Web/API commits.

### 2. Critical Issues (Must Fix)

*   **Issue 1: Ledger Fork Resolution (Data Loss Risk)**
    *   **What**: §Multi-machine, backup, and restore states: *"git-sync merge-helper prefers the longer chain when both sides extend the same parent record."*
    *   **Why it matters**: If Agent A and Agent B concurrently generate scouts on different machines, their local ledgers will fork from the same parent. If the merge helper simply "prefers the longer chain," the shorter chain's records are discarded. The discarded agent's scout signature will fail pre-commit validation because its issuance record is missing from the canonical ledger.
    *   **Suggested fix**: The merge helper must *rebase* the shorter chain onto the head of the longer chain, recalculating `prev-record-hash` and re-signing (or appending the valid detached records as new sequences).
    *   **Section reference**: `Multi-machine, backup, and restore`

*   **Issue 2: CI Enforcement vs. Local Pre-commit Bypass**
    *   **What**: The spec relies heavily on `scripts/instar-dev-precommit.js` to verify hashes, signatures, and ledgers.
    *   **Why it matters**: Pre-commit hooks run locally. An agent (or human) can bypass them using `git commit --no-verify` (which is caught by pre-push, as noted), but they can also bypass them entirely by committing directly via the GitHub API or Web UI. The GitHub Actions workflows mentioned (§Deployment prerequisites) check branch protection and bootstrap locks, but do not explicitly state they run the full signature/ledger validation script.
    *   **Suggested fix**: Explicitly add a CI workflow (e.g., `.github/workflows/scout-integrity-check.yml`) that runs the exact same validation logic as `instar-dev-precommit.js` on every PR and push to `main`.
    *   **Section reference**: `3. /instar-dev pre-commit hook extension` & `Deployment prerequisites`

*   **Issue 3: Systemic LLM API Outage Deadlock**
    *   **What**: The Cross-model review requires 2-of-3 providers (GPT, Gemini, Grok) to respond within 5 minutes. If they fail, it transitions to `pending-crossreview` and auto-fails in 72h.
    *   **Why it matters**: If a major systemic outage occurs (e.g., an internet routing issue affecting multiple LLM APIs, or an Anthropic outage breaking the Haiku classifier), all spec development is hard-blocked for 72 hours with no explicit bypass mentioned for this specific state.
    *   **Suggested fix**: Explicitly state that Justin can use the `ecosystem-contested-override` mechanism (or a similar cryptographic override) to force-clear a `pending-crossreview` or `classifier-unavailable` state during systemic API outages.
    *   **Section reference**: `4. Cross-model review of self-certifying claims` & `Async state machine`

### 3. Strengths
*   **Adversarial Threat Modeling**: The mapping of architectural decisions directly to specific attacks (e.g., "Closed-loop review," "Brief mis-framing," "Authority co-location") is masterclass-level spec writing.
*   **Cryptographic Architecture**: Choosing Ed25519 over HMAC is the perfect architectural choice, allowing public verification across machines without distributing the signing secret. The TOFU defense (countersigning new keys) is incredibly robust.
*   **Anti-Sycophancy Mechanisms**: The requirement in the cross-model review that a "green vote" must *cite* a specific bundle artifact, combined with the server-side anti-priming check, brilliantly prevents LLMs from blindly agreeing with coherent-sounding but hallucinated text.
*   **Bootstrap / Migration Strategy**: The use of dual-file-edit refusal (e.g., modifying `grandfathered.lock` requires modifying `grandfather-expected.txt`, which is pinned by CODEOWNERS) is an elegant way to prevent an AI with repo access from expanding its own permissions.

### 4. Gaps & Missing Elements
*   **Justin Root Key Compromise**: The spec details how to revoke agent keys, and requires a countersignature or Justin-evidence to do so. However, it does not define the recovery procedure if `JUSTIN_PUBKEY` or Justin's Telegram account is compromised.
*   **Cost/Rate Limiting of Cross-Model Review**: `/crossreview` hits GPT, Gemini, and Grok simultaneously. While agent creation is rate-limited to 20/hr, there is no mention of handling 429 (Too Many Requests) errors from the LLM providers gracefully, other than treating them as a timeout.
*   **Size Limits on Ledgers**: While sharding (10,000 records) bounds the pre-commit walk, the `.instar/` directory will grow continuously. There is no garbage collection or archiving strategy for old ledger shards.

### 5. Industry Comparison
*   **Software Supply Chain Security**: This spec heavily mirrors **SLSA (Supply-chain Levels for Software Artifacts)** Level 3/4 requirements, specifically regarding non-falsifiable provenance and ephemeral, isolated build environments.
*   **Transparency Logs**: The hash-chained `.jsonl` ledger is a localized implementation of **Certificate Transparency (CT) logs** or **Sigstore**. It is an industry best practice for append-only, tamper-evident record keeping.
*   **Zero Trust**: The principle of "Authority co-location" (moving the enforcement mechanism outside the tree the agent can edit) perfectly aligns with Zero Trust architecture principles.

### 6. Scalability Assessment
*   **Phase 1 (MVP, 10-50 users/agents)**: **Excellent.** The local git-backed ledgers and 50-spec LRU cache will perform flawlessly. The ~100ms pre-commit overhead is unnoticeable.
*   **Phase 2 (Growth, 50-500 users)**: **Degradation.** Git merge conflicts on the `.jsonl` ledgers will become a constant friction point for developers/agents. The 50-spec LRU cache for convergence bundles will thrash frequently, increasing API calls to the live agent registry and git log.
*   **Phase 3 (Scale, 500-5000 users)**: **Architecture change needed.** Git is not a database. Storing a high-throughput, hash-chained transparency log in a git repository will cause repository bloat and massive merge contention. The ledger will need to be moved to an external, dedicated append-only datastore (like Trillian or AWS QLDB), and the pre-commit hook will need to query this external service.

### 7. Recommendations (Prioritized)

1.  **Enforce Validation in CI**: Update §Deployment prerequisites to explicitly require a GitHub Actions workflow that runs `scripts/instar-dev-precommit.js` on all PRs. This closes the GitHub Web UI/API bypass loophole.
2.  **Define Ledger Rebase Logic**: Update §Multi-machine, backup, and restore to specify that the git merge-helper must *rebase* concurrent ledger additions rather than simply "preferring the longer chain" to prevent valid scout signatures from being orphaned.
3.  **Add API Outage Override**: Add an explicit Justin-signed override path for `classifier-unavailable` and `pending-crossreview` states to prevent the entire engineering pipeline from deadlocking during a major Anthropic/OpenAI outage.
4.  **Parameterize Cache Limits**: In §Multi-machine, backup, and restore, make the `50 spec-hashes` LRU cache limit configurable via environment variable to allow easy tuning as the system grows.
5.  **Define Root Key Rotation**: Add a brief subsection detailing the manual, human-in-the-loop process for rotating `JUSTIN_PUBKEY` if the human administrator's key is compromised.