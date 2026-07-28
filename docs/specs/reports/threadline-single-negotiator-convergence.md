# Convergence Report — Threadline Single-Negotiator Lock + Honest Ack Semantics (Robustness Phase 1)

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's codex CLI and returned a verdict in rounds
2, 3, and 4 (all "MINOR ISSUES", no blocker); a Gemini-tier pass (gemini-2.5-pro) also returned a
full verdict in round 3 (the round-2 and round-4 Gemini attempts degraded on timeout). Per the
aggregation rule, a single successful external round yields the clean spec-level flag; here
multiple rounds succeeded across two families. This is the clean RAN state.

## ELI10 Overview

Two of our AI agents almost locked in an irreversible production change one night — and the
"confirmation" came from a background session that the main session never knew was running. Nothing
in our agent-to-agent channel stopped a stray session from speaking for the whole agent, and nothing
made a typed "confirmed" carry any less weight than a real, human-approved decision. It didn't blow
up only by luck (the target server didn't exist yet). This spec makes that specific failure
impossible on our side.

It does three things. **One voice:** exactly one session owns a conversation's outbound voice at a
time (a short, self-renewing "lease"); any other session can only emit a fixed "the owner will
respond" line, never speak for the agent. **Prose is inert:** no message — however it's worded —
ever creates a real "we agreed to this" record or green-lights an irreversible step. Real
commitments travel only through the system's existing human-signed approval tools (mandates /
review-exchanges), so there's no "binding phrase" to sneak past a filter, because typed chat simply
has no path to authority. **Honest delivery:** a one-line wiring fix makes the "delivery looks
stuck" warning truthful again, so it stops crying wolf during live conversations.

The honest-delivery fix and the prose-is-inert guarantee ship live (they can't block anything — they
only remove a footgun and fix a signal). The one-voice lock ships off-by-default and then in a
"dry-run" mode that logs what it *would* block before it's ever allowed to actually hold a message
back — so we measure it against real traffic first. Bigger pieces (a shared canonical history both
agents can read; one identity per agent across machines) are deliberately left for later phases.

## Original vs Converged

The original draft made a **content classifier** the gatekeeper: it would try to *detect* messages
that looked like commitments and *refuse* to send them unless they were approved. Convergence review
killed this on two grounds that the final spec now bakes in:

1. **It was the wrong kind of authority.** Letting a fuzzy text-classifier *block* sends is exactly
   the "detector with veto power" anti-pattern our constitution forbids (it caused a prior incident).
2. **It couldn't have worked.** The real incident's words — "see you at the gate," "08:00 check-in,"
   "go ahead" — contain no detectable keyword. Any list of binding phrases is trivially evaded by
   rephrasing.

The converged spec inverts this: instead of trying to catch binding prose, it makes **all** prose
inert and routes real commitments through a separate, already-existing, human-signed channel. The
classifier survives only as a harmless *hint* ("this looks like a commitment — anchor it if you mean
it"), never a gate. Two further rounds tightened it: the new "commitment" wire-protocol the second
draft introduced was **removed** (it reused the existing approval primitives instead, which the
external reviewer agreed was the right call), the multi-machine story was corrected (the lease is
honestly *per-machine*, with cross-machine single-voice resting on the existing one-machine-serves-a-
conversation model, and a runtime duplicate-holder alarm), the "prose is inert" promise was upgraded
from a *negative* audit ("no gate reads prose") into a *positive* type boundary ("gates accept only
typed approval artifacts") so it can't rot as new code is added, and the fail-open path was made
explicit and loud (it now states plainly that one-voice is suspended during a lock-store outage and
raises a high-priority alert).

## Iteration Summary

| Iteration | Reviewers who flagged material findings | Material findings | Spec changes |
|-----------|------------------------------------------|-------------------|--------------|
| 1 | lessons-aware (CRITICAL), adversarial (SERIOUS), security, scalability, integration | classifier-as-authority (Signal-vs-Authority + un-closable evasion); recurrence-risking deferral; anchor scoping; holding-notice flood; lease-renewal mechanism; route hardening | Full reframe: prose-inert-by-construction; classifier demoted to signal; send-gate keyed on structural send-type; honest-ack funnel; FD hardening |
| 2 | decision-completeness (SERIOUS), integration (material), codex/gpt-5.5 external | underspecified commitment wire-shapes (buried decisions); per-machine vs "shared store" lease error; "prose inert" depends on downstream gates honoring it | Dropped the new commitment wire-protocol (reuse existing Mandate/ReviewExchange); reframed multi-machine honestly; added downstream-gate audit; frontloaded holding-notice envelope; Alternatives section |
| 3 | (5 internal CLEAN); codex + gemini external (MINOR, framing) | none material (build-scope "not implemented yet" excluded); precision asks: qualify "structurally impossible"; positive authorization boundary; explicit fail-open G1-suspension; FD-11 remote-compliance phrasing | Qualified guarantee language; positive type-boundary for G2; loud fail-open alert + G1-suspension; holder-singularity invariant; data/control-plane framing |
| 4 | decision-completeness CLEAN, adversarial CLEAN; codex external (MINOR, phrasing) | none material (phrasing refinements of already-addressed concerns) | Headline G1 caveat; holder-singularity → test + runtime alert; gate enumeration + residual-risk classification; holding-notice creates no sender-side pending-ack record; in-process-queue alternative |
| 5 | (converged) | 0 | none |

## Full Findings Catalog

**Round 1 — material**
- *Lessons-aware (CRITICAL, Signal-vs-Authority + heuristic-as-authority):* classifier output used as the blocking authority for commitment refusal. **Resolved:** authority inverted to positive/structural; classifier is signal-only.
- *Adversarial (SERIOUS):* colloquial binding prose evades any lexicon; LLM tier optional → F1 re-opens. **Resolved:** prose inert by construction; no classifier on the authority path.
- *Lessons-aware (CRITICAL, P10):* deferring binding-anchor enforcement re-exposes the incident. **Resolved:** G2 (inertness) + G3 (acks) ship in CORE ungated; only the lease hard-block is dry-run-gated.
- *Security (HIGH):* anchor not scoped to this agent; revoke-race. **Resolved:** self-scoped fingerprint-pair + atomic re-verification (and, after round-2 scope cut, inherited directly from the existing PIN-anchored primitives).
- *Security/Scalability/Adversarial (HIGH/MINOR):* holding-notice epoch-cycling flood; counter storage. **Resolved:** durable per-epoch limit + global min-interval floor; epoch in notice.
- *Scalability (MINOR):* renewal mechanism, JSONL rotation, classifier hot-path latency. **Resolved:** renew-on-send/no timers; daily rotation/7-day retention; classifier off the wire path.

**Round 2 — material**
- *Decision-completeness (SERIOUS):* three buried wire-shape decisions (Type-2 invocation, holding-notice, commitment handshake). **Resolved:** commitment wire-protocol removed (reuse existing primitives); holding-notice envelope frontloaded (FD-11).
- *Integration + codex external (material):* `conversations.json` is per-machine; "shared store" claim false → G1 only per-machine. **Resolved:** FD-2 reframed to per-machine voice + existing single-holder model; F2 named Phase 3.
- *Codex external (#2):* "prose inert" only real if no downstream gate reads prose. **Resolved:** downstream-gate audit added, later (round 3/4) strengthened to a positive type boundary.

**Round 3 — material (all precision)**
- *Externals (codex + gemini):* qualify "structurally impossible"; positive authorization interface (rot-resistance); explicit fail-open G1-suspension + loud alert; FD-11 remote-compliance phrasing; data/control-plane framing. **Resolved in round 4.**
- Five internal reviewers returned CLEAN.

**Round 4 — non-material (phrasing/precision; folded for honesty)**
- *Codex external:* headline G1 caveat; holder-singularity test wording → runtime alert; gate enumeration; holding-notice no sender-side pending record; in-process-queue alternative. **All folded.**
- Decision-completeness + adversarial final checks: CLEAN, no material findings.

## Convergence verdict

Converged at iteration 4. No material findings in the final round (two consecutive CLEAN internal
rounds; the external pass is at MINOR with no blocker and every precision ask incorporated). Zero
unresolved user-decisions in `## Open questions`. The spec is ready for user review and approval.
