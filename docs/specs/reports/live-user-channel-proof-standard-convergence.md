# Convergence Report — Live-User-Channel Proof (the Instar Gold-Standard Testing Standard)

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass (the agent's codex CLI) ran on every round and a
Gemini-tier pass ran on round 1; both sit OUTSIDE the Claude family. The
externals materially shaped the design (see "Original vs Converged"). Gemini
degraded on the round-2 retry (rate-limited), but codex ran cleanly every round,
so the spec received genuine cross-model review throughout — the clean
`codex-cli:gpt-5.5` flag.

## ELI10 Overview

We're making a rule, with real teeth, that stops me from calling a feature you
use through chat "done" until I've actually tested it the way *you* would — by
acting as a human user and driving it through the real channels (Telegram AND
Slack) — before you ever touch it. Today my tests stop at the edge of my own
code, so they can all pass while the real thing is broken. That's how the
"move a conversation to the other machine" feature reported success but never
moved, and *you* found it first.

Three pieces: (1) a constitutional standard saying user-facing features need
live-user-channel proof before "done"; (2) a gate that blocks an autonomous
work-session from declaring "done" unless a real, signed, machine-written test
record exists proving it ran live on both channels — and I can't hand-write that
record to sneak past; (3) a harness that drives features as a real user and
writes that record, running anything risky on throwaway demo accounts, never
yours. Then we point all of it at the first feature: fixing and live-proving the
broken cross-machine move.

The main tradeoff: real live testing is slower and needs real (practice) accounts
to log into, versus fast fake tests that miss real-world breakage. We chose the
slower, realer path for the final "is it really done?" proof, while keeping fast
tests for quick breadth. The gate also ships carefully — first it just logs what
it *would* block, then warns, then blocks — so it never slams a door shut cold.

## Original vs Converged

The review process changed the design in four load-bearing ways:

1. **The transfer fix was re-architected.** Originally I leaned toward a
   hand-rolled "cooperative push handoff" — push the ownership record to the other
   machine during a move — justified as lower-latency. **Both external models
   (GPT-tier and Gemini-tier) independently flagged this as reinventing
   distributed consensus** ("roll your own crypto" for ownership). Converged to
   the durable, replicated ownership store the code's own comment always intended
   (mirroring the existing lease store), kept OFF the routing hot path with an
   in-memory cache, with the existing fenced lease as the split-brain authority.
   This is the single most important change the review produced.

2. **The gate's blocking authority moved off the classifier.** Originally a
   keyword classifier decided "is this user-facing?" and could block. The
   constitutional Signal-vs-Authority gate flagged that a brittle low-context
   filter must not hold blocking authority. Converged so the hard block rests only
   on *objective* facts (an author-declared `userFacing` + the presence/absence of
   a verified signed artifact); the classifier is pure signal that surfaces a
   mismatch, never blocks alone.

3. **"~90% of scenarios" became enforceable risk-category coverage.** "~90%" is
   subjective and ungateable; converged to a concrete required category set
   (happy-path, channel-parity, lifecycle, permission/volatile, failure/rollback,
   concurrency, idempotency, regression) plus an empirical "operator-found escapes"
   metric that ratchets thin matrices.

4. **The artifact got real integrity + an honest threat model.** Originally just a
   content hash. Converged to Ed25519 signing + runner identity + per-machine
   hash-chained ledger segments + recency/replay rejection + a `seatMoved:false`
   poison rule + mandatory deterministic platform evidence (real message/channel/
   machine ids) — with an explicit statement that this is drift-correction, NOT a
   security boundary against a deliberately compromised runner (mirroring the
   existing stop gate's honesty).

Other converged changes: credential/demo-channel isolation (separate vault
namespace, signed bindings, ID-checked refusal of live channels, ToS-sanctioned
automation modes); environment-readiness separated from feature-completion so a
platform outage doesn't deadlock shipping; a Tier-1 LLM supervisor confined to
semantic-only checks (deterministic evidence is primary); effectiveness metrics
(Observable Intelligence); a bounded, tracked dry-run→veto promotion (so the teeth
don't rest in dry-run forever).

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | conformance, security, decision-completeness, lessons-aware, adversarial/integration/scalability, codex (SERIOUS), gemini (MINOR) | ~25 (deduped to ~13 themes) | Full rewrite: D3 reversal to durable store; signal-not-authority gate; signed/hash-chained artifacts; risk-category coverage; credential/demo isolation; multi-machine posture; glossary |
| 2 | conformance (Observability, LLM-Supervised, Structure-beats-Willpower), codex (SERIOUS) | 7 | Threat-model honesty; signal-only surface-contradiction; CP-leased distributed contract; env-readiness/feature-completion split; Tier-1 supervisor; observability §11; bounded gate promotion |
| 3 | codex (MINOR) | 5 | Resolved fails-closed contradiction (signal-only); deterministic protocol evidence primary; supervisor NL-only; concrete lease authority/fencing; timeout=FAIL |
| 4 | codex (MINOR) | 5 | Per-machine ledger segments; ToS-sanctioned automation; veto-mode waiver attestation; narrowed lease claim; escape-metric ratchet |
| 5 | codex (MINOR) | 1 new (ledger naming) + 2 re-raises | Fixed §10 ledger-naming consistency; userFacing:false always-surfaced |
| 6 | (converged) | 0 material-new (remaining = non-material re-raises of addressed tradeoffs) | none |

## Full Findings Catalog (by theme, with resolution)

- **Transfer architecture (gemini r1, codex r1/r4, decision-completeness, lessons-aware, integration×2, scalability).** SERIOUS. Push-handoff reinvents consensus. → Durable replicated store off hot path + cache + fenced lease (§7.2), CP-leased, refuse-on-partition; narrowed claim to "exactly-one-owner under a healthy lease."
- **Signal vs Authority — classifier blocking (conformance r1, lessons-aware×2, decision-completeness, adversarial, codex r2-r5).** HIGH. → Block on objective facts only; classifier signal-only; veto-mode attestation; userFacing:false always surfaced (§4.2-4.3).
- **Artifact integrity / forgery (security×4, adversarial×2, codex r1-r3).** HIGH. → Ed25519 signing + runner identity + per-machine hash-chained ledger segments + recency/replay + tamper re-verify + deterministic protocol evidence primary + seatMoved poison (§4.4); honest drift-correction-not-security-boundary threat model.
- **"~90%" unenforceable (codex r1, lessons-aware, decision-completeness).** → Required risk-category coverage + per-category rationale + escape-metric ratchet (§4.6, §11).
- **BLOCKED rows too permissive (codex r1/r3, adversarial, decision-completeness).** → Machine-verifiable external blocker taxonomy; timeout=FAIL unless attributed; BLOCKED never satisfies happy-path/parity (§4.6, §5.5).
- **Credential model + demo isolation (security×3, codex, gemini, decision-completeness, lessons-aware, adversarial).** CRITICAL. → Separate vault namespace, signed demo bindings, ID-checked live-channel refusal, permission-scenario isolation, transcript masking, ToS-sanctioned automation modes (§5.3-5.4).
- **Multi-machine posture / replication (integration×2, decision-completeness, lessons-aware, codex r4-r5).** CRITICAL. → Explicit §10: replicated artifacts + per-machine segmented ledgers (union-on-read), gate-runs-on-executing-machine with not-proven-on-stale (never false pass).
- **Crash-safety (security, lessons-aware, decision-completeness).** → Epoch + reconciler + conservative queueing + step-by-step crash test (§7.3, §9.4).
- **Live-test brittleness / ToS (gemini r1, codex r1/r3-r5, scalability).** → Flake mgmt (retry/timeout=FAIL/quarantine), env-readiness separation + operator-gated time-bounded waiver, platform-approved automation modes.
- **Observability (conformance r2).** → §11 effectiveness metrics incl. operator-found escapes.
- **LLM-Supervised Execution (conformance r2).** → Tier-1 supervisor, confined to semantic-only checks (codex r3); deterministic evidence primary.
- **Structure-beats-Willpower / dry-run permanence (conformance r2).** → Bounded, tracked dry-run→warn→veto promotion (§4.8).
- **Consistency fixes (codex r3/r5).** → Resolved fails-closed contradiction; §10 ledger naming aligned to segments.

Remaining (non-material, acknowledged tradeoffs, recorded honestly): real-account
automation is operationally harder than fake tests (the inherent, operator-demanded
cost of the standard); userFacing scope-declaration ultimately relies on author
honesty until the path→surface manifest is built (mitigated by always-surfaced +
veto-mode attestation). Neither is a design flaw; both are stated in the spec.

## Convergence verdict

Converged at iteration 6. The external verdict descended SERIOUS → SERIOUS →
MINOR → MINOR → MINOR and the final round produced no material new issues — only
re-raises of explicitly-addressed tradeoffs plus one naming inconsistency, now
fixed. Zero unresolved entries in `## Open questions`. The spec is ready for user
review and approval.
