# Convergence Report — Threadline Agent-to-Agent Coherence

**Spec:** `docs/specs/THREADLINE-A2A-COHERENCE-SPEC.md`
**Status:** converged (`approved: false` — convergence ≠ approval; the open decisions in §10 are the operator's).
**Date:** 2026-06-02

## Cross-model review

`unavailable` for this run — the cross-model reviewer needs the built `dist/core/crossModelReviewer.js`, which the spec worktree does not carry (no `pnpm build`). Per the skill, the external pass is skipped with the fallback flag and convergence proceeds internal-only. **The non-optional lessons-aware reviewer ran**, so the circular-self-verify defense is intact. Re-running the cross-model pass on a built checkout before approval is recommended but not blocking.

## Rounds

**Round 1 — full internal panel** (security, adversarial, scalability, integration, lessons-aware), in parallel. Verdict: **serious issues** — 4 critical + multiple high, strongly convergent across reviewers. This was not a rubber-stamp; the panel caught real, blocking design flaws.

**Spec update (v3)** — one coherent rewrite incorporating every material finding.

**Round 2 — convergence check** — re-verified the v3 text against the round-1 findings and the actual code tree. Verdict: **CONVERGED: true** — all ten material findings genuinely resolved (not name-dropped), every concrete code claim accurate, no new material issue introduced.

## Material findings catalog (round 1 → resolution in v3)

1. **UUID-discovery race (CRITICAL, ×3 reviewers).** The proposed mtime/newest-file discovery cross-binds threads to wrong transcripts under concurrency. → v3 mandates the authoritative Claude session-hook `claudeSessionId` (the path `TopicResumeMap` already uses), forbids the mtime fallback for multi-thread binding, ports the single-active-session guard, adds a concurrent-cross-bind test.
2. **Layer 7 phasing regression (CRITICAL, ×2).** Continuity (L1) removes the context-blindness that *accidentally* gated Dawn's credential handshake; the deliberate gate shipped 2 phases later. → v3 reorders the sensitive-completion floor to a **Phase-1 prerequisite**, enumerates the gated action classes, and makes it inform-not-decide + audit to the ledger.
3. **Layer 6 authority boundary (CRITICAL).** Merging the user thread and the a2a thread into one session lets a peer's message be read as operator authority. → v3 requires unforgeable provenance labels (operator authority only via the user-channel envelope; peer turns in the nonce-delimited untrusted-data block extended to the spawn/resume path) + loop-gate reconciliation.
4. **Multi-machine fork (CRITICAL).** ConversationStore writes are unguarded + git-synced → standby/handoff forks (the recent crash-loop class). → v3 §7: lease-gated / `StateManager.readOnly`-gated writes + machine-local UUID fields.
5. **Layer 3 memory exfil/poison (HIGH).** Bidirectional shared memory = persistent injection + exfil. → v3: read-only, one-directional, route via the integrated-being ledger.
6. **Layer 4 summarizer (HIGH, ×4).** Secret leak + poisoning + LLM-circuit-breaker storm + user-topic flood. → v3: redaction + guardProxyOutput + attribution + shared LlmQueue (background lane, daily cap, breaker-skip) + salience precondition + shared rate limit + Near-Silent default (routine→hub) + default-off.
7. **Loop-with-memory (HIGH).** Resume + dual-track can sustain an *escalating* loop. → v3: engage `WarrantsReplyGate`; user-injected novelty must not reset the peer no-progress counter.
8. **jsonlExists hot-path scan (HIGH).** Sync full-tree FS scan per inbound. → v3: scope to own project dir + memoize.
9. **Warm-session unboundedness (HIGH).** → v3: global + per-peer cap, LRU/TTL, reaper-evict-eligible, default per-peer.
10. **Migration/Awareness/config/backup/dark-ship (HIGH/CRITICAL, integration).** No deployment story. → v3 §8: ConfigDefaults + migrateConfig + generateClaudeMd + backup manifest + LiveConfig rollback; L4/L6 ship default-off.
11. **Circular self-review (HIGH, lessons-aware).** Single author, no lessons citations. → v3: substantive `lessons-engaged:` frontmatter (12 entries).

## Convergence verdict

**Converged.** The spec is materially hardened and internally consistent with the code. It remains `approved: false` pending the operator's answers to the §10 open decisions and explicit approval. Recommended pre-approval step: re-run the cross-model external pass on a built checkout.
