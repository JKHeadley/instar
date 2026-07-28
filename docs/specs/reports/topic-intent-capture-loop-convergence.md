# Convergence Report — Topic-Intent Auto-Capture Loop

## ELI10 Overview

Instar keeps a per-topic "filing cabinet" of the facts and decisions a conversation establishes,
and hands the agent a summary at the start of each session so it stays grounded. The cabinet was
built and installed, but the clerk that actually files things — reads each message and writes
notes — was never switched on, so the cabinet sits empty (the exact reason the original drift
incident found "no record for the topic"). This spec switches the clerk on.

The smart refinement: the clerk doesn't judge a message in isolation. It reads each new message
together with a rolling summary of the whole conversation (which Instar already maintains) and
the notes already on file, so it judges significance well instead of guessing from one sentence.

The main tradeoff is cost and safety: this is the first feature that calls an AI on (nearly)
every message. The review round forced that to be bounded (a cheap pre-filter skips trivial
messages, a per-topic ceiling, a daily cap, subscription-not-raw-API) and hardened it against
prompt-injection, concurrent-write corruption, and a runaway bill — none of which the first draft
handled.

## Original vs Converged

The first draft was directionally right but **overstated readiness and under-handled safety**.
Review changed it materially:

- **Honesty fix:** the draft claimed the LLM helper (`createLlmExtractFn`) and the
  `rollingSummary` input were "already built." They weren't (the helper lived only in an
  abandoned worktree). The converged spec treats both as real, tested build work.
- **Security:** the draft fed old notes + summary back into the AI's prompt with no protection.
  A crafted message could smuggle in fake instructions that then propagate. Converged spec fences
  all user text as data-never-instructions, truncates it, and adds an injection-resistance test.
- **Correctness:** the draft ignored that two concurrent sessions writing the same topic file
  would clobber each other (silent note loss). Converged spec requires atomic writes / single-
  writer CAS + a concurrency test.
- **Cost & transport:** the draft hand-waved cost. Converged spec defines the spend estimate,
  makes a cap breach degrade quietly (not crash the chat), adds a per-topic ceiling, respects the
  quota load-shedder, and REQUIRES the subscription transport (never raw API) with a test.
- **Wiring order:** the draft's wiring point couldn't actually reach the LLM queue (built ~2,300
  lines later). Converged spec names the real seam and the hoist needed.
- **Robustness:** the pre-filter is now a registered state-detector with a canary; the briefing
  must render refs as user-asserted claims (truth ≠ confidence); the capture helper is
  adapter-agnostic (framework-agnostic floor).

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security, scalability/integration, lessons-aware | 4 HIGH/CRITICAL + 6 medium | readiness correction; prompt-injection hardening §8; concurrent-write safety §4; wiring-order fix §1; cost controls §5; Anthropic-transport constraint + test; pre-filter canary/registry §3; truth≠confidence §9; adapter-agnostic helper; QuotaTracker respect |
| 2 | (converged) | 0 | none — every material finding resolved |
| 3 | user feedback (observability) | 1 | §10 strengthened: metering extended from capture-only to the WHOLE loop (captured → surfaced → used → corrected) — added briefing_served / arccheck_fired+signalled / refs_decayed counters + full-funnel capture-metrics; new acceptance criterion + Tier-2 test |

Abbreviated convergence (internal reviewers incl. the mandatory lessons-aware pass; externals
skipped — this is the first rung of an in-house north-star effort, not a contract-boundary change).

## Full Findings Catalog

**Iteration 1 — material:**
- **[Security · CRITICAL] Prompt injection** — ref text + rolling summary re-enter the extractor
  prompt unsanitized; a crafted message becomes a self-propagating instruction. → §8 (delimited
  data blocks, truncation, injection test).
- **[Integration · HIGH] Overstated readiness** — `createLlmExtractFn`/`rollingSummary` claimed
  built; they're net-new. → readiness-correction note + relabelled as build work.
- **[Scalability · HIGH] Wiring-order** — LLM queue built ~2,300 lines after the capture seam. →
  §1 (hoist queue or construct at queue site; seam named at ~3349).
- **[Scalability · HIGH] Concurrent-write corruption** — `appendEvidence` is load→mutate→write
  with no lock; concurrent sessions drop events. → §4 (atomic/CAS + concurrency test).
- **[Security · MEDIUM] Truth ≠ confidence** — a user can drive a false fact to authoritative. →
  §9 (briefing renders user-asserted claims; one contradiction demotes; test).
- **[Security/Scalability · MEDIUM] Cost exhaustion + non-durable cap that throws** → §5 (define
  costCents, degrade-not-throw, per-topic ceiling, cap-is-best-effort).
- **[Lessons · MEDIUM] Anthropic-path** — first always-on per-turn LLM path must use subscription
  transport. → §1 transport constraint + acceptance #6 + test.
- **[Lessons · MEDIUM] Pre-filter = unguarded state-detector** → §3 (canary + registry entry).
- **[Lessons · LOW] Framework-agnostic** — capture helper must be adapter-neutral. → §2.
- **[Scalability · LOW] `getTopicContext` does 3 queries** → §2 uses `getTopicSummary` alone.
- **[Security · LOW] `sourceMessageId` trust** — id must be server-assigned/non-forgeable → §2.

**Sound as-drafted (no change):** the user-authority clamp + signal caps resist numeric gaming;
agent-only refs are structurally capped below the briefing floor (now test-confirmed); migration
parity / additive schema / kill-switch / inert-rollback; wiring-integrity test is mandated.

## Convergence verdict

Converged at iteration 3. All four HIGH/CRITICAL + the medium findings from iter 1 are resolved,
and the iter-3 user-feedback finding (observability must cover the whole loop, not just capture)
is folded into §10. No material findings remain. Ready for user review and approval.
(Implementation detail — exact costCents value, the atomic-write mechanism choice — is left to
the build, which carries its own tests + the wiring-integrity, injection, concurrency, transport,
and full-funnel-metrics gates.)
