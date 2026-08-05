# Convergence Report — Bounded Attention-Notification Surface

## ⚠ Cross-model review: codex-cli:gpt-5.5 — RAN, with a disclosure below

Three real external passes ran through this agent's own codex CLI (`gpt-5.5`), on rounds 1, 2, and 3 of the cross-model lane. All three returned findings; the verdict moved SERIOUS → SERIOUS → MINOR, with the third pass stating "the design is coherent and avoids the earlier distributed-rate-limit trap."

**Disclosure the reader must weigh before treating this as a full convergence.** The six *internal* Claude reviewers (security, scalability, adversarial, integration, decision-completeness, lessons-aware) were **not** run as independent subagents. This session operates under a standing instruction not to spawn agents unless the operator requests it, and the operator did not. What ran instead was:

- the **code-backed Standards-Conformance Gate** (`POST /spec/conformance-check`) — 13 rounds, 82 standards evaluated per round; and
- the **cross-model external reviewer** — 3 rounds.

The conformance gate is the structural complement to the lessons-aware reviewer (it reads the living constitution directly rather than a prompt's summary of it), and it carried most of the load here — it produced a real finding in 9 of its 13 rounds. But it is not a substitute for the adversarial and decision-completeness perspectives, and this report does not claim it is. **Treat this as convergence against the constitution plus one external family, not against the full six-reviewer panel.** The Phase 5 second-pass review remains outstanding and is recorded as such in the side-effects artifact.

## ELI10 Overview

Your agent sends you two kinds of message. One kind needs you — a decision, an approval, something broken you can fix. The other kind is housekeeping: "one of my background checks fell back to a simpler method and carried on." Measured over 24 hours, 25 of 64 messages into the attention conversation were the second kind, and none of them named anything you could do.

The awkward part is that the housekeeping *scales with how badly things are going*. The worse the machine gets, the more your agent tells you about it, in exactly the messages worth least. And nothing capped it: there was a hard limit on how many new conversations the agent could start on its own, added after an earlier flood, but nobody ever added the equivalent limit for messages into a conversation that already existed.

This change does four things. Housekeeping stops reaching you by default — still recorded, still readable on request. A limit of four messages an hour per conversation, with the rest waiting their turn and sending themselves when there's room. The agent's memory of "I already told them this" now survives a restart instead of resetting. And an off-switch that existed but was never actually read on this path is made real, so next time it's a setting rather than a release.

Urgent messages are deliberately untouched, and so is the attention queue. What goes quiet is the routine "fell back, still working" report — not your ability to find out something broke.

## Original vs Converged

**The multi-machine design was replaced entirely, after three failed attempts.** The original divided one message budget across machines: each machine works out its fair share and enforces that. Review killed three successive versions of this. Dividing by machine count and rounding down broke the limit for fleets bigger than the budget. Switching to fractional "token buckets" fixed that but only bounded the *average* rate, leaving a burst. Dividing by *registered* rather than *online* machines fixed the partition case but left a window where a machine with an out-of-date count sends too much.

Each rewrite was better arithmetic with a longer list of things it still couldn't promise. That growth was the real signal: **you cannot get an exact shared limit out of machines guessing independently.** The converged design removes the sharing. Every conversation already has exactly one machine that owns it — that's how the agent avoids two machines answering at once. Only the owning machine sends routine notices into a conversation. One counter, one limit, no coordination. The distributed problem isn't solved; it's not created.

**The failure rule was inverted for housekeeping.** The original said "when in doubt, send," inherited from the general messaging principle that an unsent message is unbounded harm. Correct for urgent messages, and exactly backwards here — an extra unactionable message is the entire harm being removed. Routine notices now hold when in doubt, and are still written down.

**Two proposed "N notices held" status lines were removed.** The first asked the operator to request the held messages back, which parks the agent's own work on the user. The replacement was itself unactionable housekeeping — a change built to stop housekeeping was about to add a housekeeping message announcing that it had stopped.

**Guarantees were weakened to true ones.** The spec originally claimed the operator's total was "exactly bounded." That was false for a simultaneous burst and false during a stale-count window; the document said so two paragraphs later. The converged version states precisely what holds and what does not.

**A standards conflict was named rather than resolved by wording.** For an urgent message on a machine that can neither prove it owns the conversation nor reach the machine that does, *Ownership-Gated Side Effects* and *The Agent Is Always Reachable* genuinely conflict. The spec resolves toward reachability with reasoning, marks it as a deviation, and registers the question as constitution-level rather than settling it by author preference. The conformance gate still flags it — correctly.

**The document itself was rewritten from scratch at round 10.** See the verdict section below.

## Iteration Summary

| Round | Reviewer | Model | Findings | Spec changes |
|---|---|---|---|---|
| 1 | Standards-Conformance Gate | code (82 standards) | 1 | Undefended machine-local posture → redesigned toward unified |
| 2 | Standards-Conformance Gate | code | 2 | Held-notice parked work on operator; divisor unsafe under partition |
| 3 | Standards-Conformance Gate | code | 1 | Replacement held-notice was itself housekeeping → removed |
| 4 | Standards-Conformance Gate | code | 2 | No brakes on retry; unbounded held queue |
| 5 | Standards-Conformance Gate | code | 1 | "Exactly bounded" overclaimed |
| 6 | Standards-Conformance Gate | code | 0 | — |
| X1 | Cross-model | codex-cli:gpt-5.5 | 6 (SERIOUS) | Ceiling-vs-bucket mismatch; overclaim; internal contradiction; ambiguous config path; underexplored alternative; missing test controls |
| 7 | Standards-Conformance Gate | code | 1 | Divisor still approximate → **redesigned to single-enforcer ownership** |
| 8 | Standards-Conformance Gate | code | 1 | Failure direction backwards for housekeeping |
| 9 | Standards-Conformance Gate | code | 1 | `IMMEDIATE` ownership exemption too broad |
| 10 | Standards-Conformance Gate | code | 0 | — |
| X2 | Cross-model | codex-cli:gpt-5.5 | 5 (SERIOUS) | **Two incompatible architectures in one document**; mixed rate-limit semantics; stale Frontloaded Decisions; ambiguous ownership fallback; state machine needed |
| — | **Full rewrite** | — | — | Document rewritten from the settled design |
| 11 | Standards-Conformance Gate | code | 0 | — |
| X3 | Cross-model | codex-cli:gpt-5.5 | 5 (**MINOR**) | Non-owner item semantics; `limit: 0` contradiction; conflated failure posture; backlog durability; drain ordering |
| 12 | Standards-Conformance Gate | code | 1 | Non-owner drop violated Ownership-Gated Side Effects → changed to queue-deliberately |
| 13 | Standards-Conformance Gate | code | 1 | `IMMEDIATE` bypass — **acknowledged deviation, not resolved** |

Internal reviewers run per round: **0** (see the disclosure banner). Standards-Conformance Gate: **ran every round**, 82 standards, never unavailable.

## Full Findings Catalog

Every finding and its resolution is recorded in the spec's own `## Review history` table and, for the design-changing ones, in prose at the point of change — deliberately, so a future reader encounters *why* a design is shaped this way at the place they are reading, not in a separate document they may never open. Rather than duplicate that here and risk the two drifting apart (the exact failure mode X2 caught), this section points at it: `docs/specs/bounded-attention-notification-surface.md` → `## Review history`, plus the inline "an earlier draft…" passages in C4.2, C4.3, C3, §The failure direction is per-tier, §Multi-machine posture, and §Frontloaded Decisions.

The five findings that changed the *design* rather than the *document*:

1. **Undefended machine-local posture** (gate, R1) → the whole multi-machine approach was reconsidered, ultimately three times.
2. **Divisor cannot bound a shared quantity** (gate R7, after X1 sharpened it) → single-enforcer ownership.
3. **Failure direction backwards for housekeeping** (gate R8) → per-tier rule: deliver for urgent, hold for batched.
4. **Two incompatible architectures in one document** (X2) → full rewrite.
5. **Non-owner drop violates Ownership-Gated Side Effects** (gate R12) → queue-deliberately, reusing the existing hold and expiry.

## Convergence verdict

**Converged at round 13 of the conformance lane and round 3 of the cross-model lane**, with one finding deliberately outstanding.

The conformance gate's final finding — the `IMMEDIATE` ownership bypass — is **not** resolved and is not intended to be resolved at spec level. It is a genuine conflict between two constitutional standards where every available option violates one of them. The spec names it, resolves toward reachability with reasoning, bounds it (unreachable *and* unclaimable, not merely slow), attributes it (the message is stamped with its origin machine), and audits it. Continuing to reword until the gate went quiet would be gaming a signal-only advisory, which the skill explicitly names as an anti-pattern.

**The most important finding is about the review tooling, not this spec.** At round 10 the conformance gate returned **clean** on a document that described two mutually exclusive architectures. That is not a gate defect — it evaluates one standard at a time and never claims to read for coherence — but it is a real limit: *a clean per-standard pass is not evidence of a coherent document*, and iterative section-by-section patching is precisely the process that manufactures the incoherence it cannot see. Only the whole-document reader caught it. Both reviewer kinds were necessary; neither would have sufficed. This is recorded in the spec itself and in the agent's durable memory.

**Ready for build, with two disclosures already made to the operator in-channel before approval:** the limit is per-topic (a producer spreading across topics is not bounded by it), and the Phase 5 second-pass review is outstanding. Operator approval was given on the plain-English overview at 2026-08-04 16:52 PDT.
