# Convergence Report — Self-Unblock Before Escalating

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass (codex `gpt-5.5`) AND a Gemini-tier pass (`gemini-2.5-pro`) both ran successfully through the agent's own CLI logins across the convergence rounds. Both returned reviews that were folded into the spec; the final state has zero material findings from either. (Clean RAN — both external families engaged, not a degraded or unavailable pass.)

## ELI10 Overview
This is a constitutional rule for the AI agents: when you hit a wall, *try to get past it yourself first*, and only ask a human when you genuinely can't — and when you do ask, ask for the smallest possible thing. It came from a real miss where the agent stalled waiting for a human to make a DNS record, when it already had what it needed to solve the goal another way. The rule sets a three-rung ladder for what to ask a human for: nothing (best), a one-tap approval, or — last resort — a credential only an authorized person can give.

The big thing the review process changed: the first design was going to build a whole new bookkeeping system to enforce "you tried before you escalated." Review caught that instar *already has* that system (the "BlockerLedger" already refuses to let the agent call something a human-blocker without a recorded real failed attempt, behind a genuine judgment gate). So the design was rewritten to *extend* that existing system, contributing only the genuinely new pieces: a deterministic checklist of where to look before giving up, the rung ladder with a "capability isn't authority" floor (risky/costly/out-of-scope things always need at least an approval), durable in-memory access to the org password manager so the checklist can reach it, and the constitutional wording every agent reads at startup. It ships dark (off by default), reviewed and reversible before any real agent runs it.

## Original vs Converged
- **Originally:** a parallel self-unblock subsystem — its own `selfUnblockAttempts` field, its own `evaluateSelfUnblock` warn-first gate, its own `logs/self-unblock-ledger.jsonl`, its own `GET /self-unblock/ledger` route, and a top-level `selfUnblock.*` config. Two reviewers independently found this *duplicated* the existing `BlockerLedger`, which already enforces failed-attempt-before-escalation with a Tier-1 LLM authority gate — more rigorously than the new parallel gate.
- **Converged:** the standard now EXTENDS BlockerLedger. The exhaustion gate is BlockerLedger's existing (already-HARD, Tier-1-authority) settle gate; the duplicate warn-gate is gone. The standard adds only the four things BlockerLedger lacks: (1) a deterministic `SelfUnblockChecklist` that *produces* the failed-attempt evidence BlockerLedger already requires (the checklist runner persists each run by an immutable run id; `settleTrueBlocker` is fed the run-id reference and loads+verifies it — closing the "self-asserted/gameable list" attack mechanically); (2) the rung ladder + rung-floor recorded in the existing `AuthorityCheckEvidence`; (3) an in-memory/keychain-only, TTL-bounded durable org-vault session; (4) the constitutional encoding. Config nests under `monitoring.blockerLedger.*` with `enabled` omitted (one dev-gate). The route extends `/blockers` (Bearer-gated, never auth-exempt, 503-after-auth, no-store, untrusted-data envelope). The result is SMALLER and CLEANER than the original.

## Iteration Summary
| Iteration | Reviewers who flagged | Material findings | Spec changes | Cross-model |
|-----------|-----------------------|-------------------|--------------|-------------|
| 1 | integration, lessons-aware (dominant: duplicate of BlockerLedger), security, adversarial, scalability, codex, gemini | 1 dominant + 13 material/minor | full Phase-2 rewrite → EXTEND BlockerLedger | gemini CLEAN; codex 6 findings — ran |
| 2 (converged) | adversarial raised M1 (implicit signature change + missing negative test); folded. security/decision-completeness/scalability/integration/lessons-aware/gemini/codex confirmed resolved | 1 (M1) → folded; 0 remaining | M1 fix (named the one BlockerLedger input-contract change in §0; added the negative anti-gaming test in §8); minors folded (relevance grammar, session TTL, unlock-bw.sh→BitwardenProvider correction) | gemini + codex re-ran — minors only, folded |
| (confirm) | adversarial re-check of M1 fix | 0 | none | — |

Standards-Conformance Gate: ran each round (returned degraded: server error — non-authoritative, fail-open per Signal-vs-Authority).

## Full Findings Catalog (resolutions)
- **DOMINANT (integration + lessons-aware): forks a duplicate of BlockerLedger.** → REWRITE to extend it (§0/§5). RESOLVED + re-confirmed by both.
- **Provenance / gameable list (adversarial + security + codex):** checklist runner persists by immutable run-id; BlockerLedger loads+verifies; old caller-supplied path closed (§5.1, §8 negative test). RESOLVED.
- **Signature change implicit / no negative test (adversarial M1):** §0 names the one BlockerLedger input-contract change; §8 adds the negative HARD-reject assertion. RESOLVED + confirmed.
- **Durable BW session security (security + codex):** in-memory/keychain only, never disk/log/argv/secretSync, TTL+idle-bounded, only-while-run-in-flight, wiring test (§5.3, §8). RESOLVED.
- **Audit scrub (security):** structural — only `{source,reachable,holdsRelevantCred,probedAt}` written; no credential value by construction; rides `<blocker-ledger-data>` envelope. RESOLVED.
- **Route auth (security + integration):** Bearer-gated, never auth-exempt, 503-after-auth (401 for unauth), no-store, bounded read (§7). RESOLVED.
- **Dev-gate enabled-omit + DEV_GATED_FEATURES + enabled-strip migration (integration):** §6/§10. RESOLVED.
- **Rung-floor + Know-Your-Principal (adversarial + lessons-aware):** §3/§9. RESOLVED.
- **Relevance brittleness (gemini + codex):** deterministic scope-tag grammar, wildcard/parent matching, fail-closed on missing metadata (§5.1). RESOLVED.
- **Probe timeouts / latency / route bounding / audit rotation (scalability):** per-class timeouts, early-exit, bounded read, reuse existing log (§5.1/§7). RESOLVED.
- **Decision-completeness:** all decisions frontloaded; no `## Open questions`. CLEAN.

## Convergence verdict
**Converged.** Round 1 surfaced the dominant architectural flaw + 14 findings; the Phase-2 rewrite reframed the standard to extend BlockerLedger; the final full round (all 6 internal reviewers + both external families) confirmed every material finding resolved, with the one new finding (M1) folded and re-confirmed clean. No material findings in the final round; zero unresolved user-decisions. Spec is ready for user review and approval (`approved: true`), then `/instar-dev` build. **The process paid for itself: it prevented building a duplicate of an existing subsystem before any code was written.**
