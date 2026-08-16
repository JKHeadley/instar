### 1. Overall Assessment
- **Score**: 9/10 – Exceptionally thorough threat modeling, cryptographic rigor, and bootstrap/migration plans make it production-ready; deducts 1 for unresolved open questions that could lead to minor operational friction.
- **Status**: APPROVE
- This spec defines a robust, tamper-resistant pre-spec verification gate that enforces ecosystem awareness before convergence, addressing a clear failure mode with layered defenses (crypto ledgers, external CI locks, cross-model reviews). It excels in self-application, anti-forgery measures, and migration hygiene, positioning it as a high-assurance addition to the Instar pipeline without overcomplicating the MVP.

### 2. Critical Issues (Must Fix)
- **What**: Open questions (§Open questions) remain unresolved (e.g., Telegram delivery vs. read receipts, canonicalize.mjs idempotency vs. GitHub rendering, key rotation cadence), listed as deferred but impacting acceptance criteria completeness.
  **Why it matters**: Unresolved decisions risk inconsistent enforcement (e.g., consult timeouts too loose/strict, hash mismatches breaking CI), leading to stalled PRs or security gaps post-cutover.
  **Suggested fix**: Resolve explicitly in the spec: (1) Mandate delivered receipts for v1 (faster); (2) Add acceptance criterion #29: "Idempotency test: round-trip canonicalize on all `docs/specs/*.md` preserves GitHub-rendered visuals within 5% whitespace diff"; (3) Set 90-day rotation as default, with `--cadence` flag for tuning.
  **Section reference**: Open questions

- **What**: Consult-ack endpoint (`POST /consult-acks`) verification assumes agent registry has per-agent public keys, but spec doesn't mandate registry schema changes or bootstrap for those keys.
  **Why it matters**: Without registry support, acks fail silently, blocking legitimate scouts and enabling DoS via fabricated failures.
  **Suggested fix**: Add to Decision points touched: "Modifies: agent registry schema to include `ed25519-pubkey` per agent"; acceptance criterion #29: "Registry bootstrap adds Echo/Dawn/Justin pubkeys; test verifies signed ack resets ping counter".
  **Section reference**: §1 New skill: `/spec-scout` (Owner conversations)

- **What**: Bundle-delta ETag uses "semantic ETag = SHA-256 over canonicalized sorted payload excluding timestamps", but excludes non-semantic fields vaguely; no spec for exact exclusion rules.
  **Why it matters**: Ambiguous canonicalization risks false positives/negatives on deltas (e.g., harmless heartbeat changes trigger rescout), stalling convergence.
  **Suggested fix**: Define precisely: "Exclude: `heartbeat-ts`, `last-seen`; sort agents/capabilities by `id` lexicographically; include all else from canonicalize.mjs". Add property test in AC #3.
  **Section reference**: §2 Ecosystem/Premise reviewer (Bundle-delta check)

### 3. Strengths
- **Comprehensive threat model**: Explicitly maps every design element to threats (e.g., forgery → Ed25519 + ledger chaining; drift → canonicalization + recompute at commit), closing vectors like scope contraction, rot, and authority co-location with justifications.
- **Bootstrap self-application**: Unified `BOOTSTRAP_TRIGGERS` + CI checks (e.g., grandfather-lock, crossreview-pending-bootstrap) + re-attestation (#13, #23) elegantly ships the gate without chicken-egg problems, including revert-handling regression.
- **Layered verification**: Pre-commit (local), CI workflows (external), server endpoints (auth'd), cross-model (3 providers with citations/anti-priming), and Justin pinning create defense-in-depth; actionable errors and escapes (env-var with audit) prevent deadlock.
- **Migration hygiene**: Grandfather list regenerated from repo state, external lock via dual-file CI refusal, closed at cutover – zero theater, verifiable.
- **Axis separation in states**: Orthogonal handling of `pending-owner-reply`, `ecosystem-contested`, etc., with SLAs and precedence rules minimizes blast radius.

### 4. Gaps & Missing Elements
- **Missing edge cases**: No handling for concurrent rescouts (v2/v3 racing); git-sync merge conflicts on ledgers if >1 machine appends simultaneously (prefers longer chain, but tiebreaker needed).
- **Unaddressed failure modes**: Haiku classifier persistent outage → `classifier-unavailable` auto-fails at 72h, but no fallback (e.g., skip for micro-scouts); Telegram API outage cascades to all consult evidence without per-path graceful degradation.
- **Implicit assumptions**: Assumes single repo (no multi-repo out-of-scope handling beyond list); Bearer auth token lifetime/refresh not specced (risks expiration mid-convergence); disk GC for convergence-cache lacks size cap enforcement details (50 entries LRU + 30d sweep, but no max-dir-size trigger).
- **Missing sections**: No explicit security audit plan (e.g., external review of Ed25519 impl); no cost analysis (e.g., cross-model API $ per scout); limited observability (attention queue details deferred).

### 5. Industry Comparison
- **Existing solutions**: Mirrors crypto protocol specs (e.g., Signal's prekey bundles with TOFU + rotation) and formal verification pipelines (e.g., Agda/Lean proofs with git-tracked hashes); ledger chaining akin to IPFS/Carml content-addressed logs or Ethereum light-client sync.
- **Best practices**: Aligns with GitHub's branch protection + CODEOWNERS (external enforcement); Ed25519 + key ceremony follows NIST SP 800-57 / libsodium patterns (TOFU defense via countersign); anti-injection via classifiers matches OpenAI moderation APIs. Avoids anti-patterns like HMAC secret sync (uses pubkey) or TOFU without pinning (bootstrap key pinned).
- **Known patterns**: Bootstrap via triggers = Linux kernel self-hosting patches; cross-model = ensemble methods in ML safety (e.g., Anthropic's constitutional AI with multi-LLM checks); hash-chained append-only = audit logs in PCI-DSS compliance.

### 6. Scalability Assessment
- **Phase 1 (MVP, 10-50 users)**: Fully works – pre-commit O(10k) ~100ms negligible; 20/hr rate-limit per author handles 50 specs/day; bundle cache hits after first run.
- **Phase 2 (Growth, 50-500 users)**: Minor friction from cross-model timeouts (5min/provider x3 =15min scout delay if slow); ledger sharding caps pre-commit at 100ms; weekly full-verify CI ok for 100k records/year.
- **Phase 3 (Scale, 500-5000 users)**: Pre-commit bounded but git ops slow at 10k+ files; changes needed: async ledger verify offload to CI-only, ETag caching with Redis (per-machine ephemeral insufficient), shard size to 50k. Multi-repo extension via repo-scoped ledgers.
- **Spike handling**: Sudden 100-spec burst → rate-limit throttles to 20/hr/author (queue via attention); ledger append serializes but git-push queues; cross-model bursts risk provider rate-limits (mitigate: cache green results 24h per scout-hash).

### 7. Recommendations (Prioritized)
1. **Resolve open questions immediately**: Add resolved decisions (delivered receipts, idempotency test, 90-day cadence) as new §Resolved questions; update AC #1 to enforce; land before cutover to unblock.
2. **Add consult-ack registry dependency**: Explicitly modify agent registry schema in Decision points; bootstrap keys in AC #20; regression test #26 to verify cross-identity reset.
3. **Specify bundle-delta ETag exclusions**: Define exact fields/timestamp sorts in §2; integrate into canonicalize.mjs property tests (AC #3); prevents false rescout storms.
4. **Handle ledger merge ties**: Extend git-sync merge-helper: on chain-length tie, prefer higher `seq`; test in AC #14 multi-machine case.
5. **Add observability metrics**: New AC #29: "Prometheus metrics for scout issuance latency, cross-model timeouts, pre-commit duration; dashboard exposes last-30d override/escalation counts."