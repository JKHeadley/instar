# Convergence Report — Lease flap fix

**Status: converged, 4 October 2026, at spec v45.** Cycle 5 reached two consecutive rounds with zero DESIGN findings (rounds 4 and 5). Approved by the operator on 4 October 2026 (01:55 PDT, Telegram topic 47547), with both sign-offs recorded in the spec's frontmatter.

## Cross-model review: codex-cli:gpt-6-astra

GPT ran in every round of cycle 5, and in every round of cycle 4 from round 2. Gemini never ran: its CLI needs a Google Cloud project, and the operator chose GPT only (3 Oct 2026, 14:24 PDT). Grok is not installed. Internal review was one all-lens agent per round.

## ELI10 overview

When a laptop and a Mac Studio ran the same agent, they took charge from each other every few seconds, and Telegram replies were held while they fought. Two faults fed each other: each machine judged the other dead from a timestamp that never moved, and the Studio stored the lease in a file git ignores, so its writes went nowhere while it believed them. The fix judges liveness from live evidence only, keeps the lease locally wherever the shared file is out of git, and reports quietly when lease writes keep failing or a paired machine is never heard from.

## Original vs converged

The first draft tried to fix every lease weakness it found, and also described Instar's existing behaviour in detail. Each review cycle found errors in those descriptions, and several were claims the author had made that turned out to be untrue. After the third cycle the operator had the spec trimmed to what is actually built. The converged spec states existing behaviour through characterisation tests rather than predictions, and asserts no safety bound it cannot point to in code. Rounds after the trim fixed:
- the ordering of the liveness read in `acquireIfEligible`, switched with `liveness`;
- the coordinator getters that carry the switches;
- the scope of the forged-receipt effects, listed per reader;
- the metric definitions for the characterisation baseline.

## Iteration summary (cycle 5)

| Round | Spec | Internal DESIGN / PRECISION | GPT | Counted |
|---|---|---|---|---|
| 1 | v40 → v41 | 1 / 1 | minor (same getter gap) | DESIGN 1 |
| 2 | v41 → v42 | 0 / 2 | minor (false forged-receipt claim) | DESIGN 1 |
| 3 | v42 → v43 | 2 / 1 | minor (same scope) | DESIGN 2 |
| 4 | v43 → v44 | 0 / 3 | minor (wording) | DESIGN 0 |
| 5 | v44 → v45 | 0 / 1 | minor (proof method wording) | DESIGN 0 |

Earlier cycles: cycle 1 (10 rounds), the fresh set (9 rounds) and cycle 3 (9 rounds) ran on the untrimmed spec. Cycle 4 (10 rounds) ran on the trimmed spec and stopped at its cap. The full round log is kept in the agent's repository at `docs/instar/lease-flap-review-rounds-1-6.md`.

## Decision-completeness

Three decision points, all `invariant` (deterministic, no arbiter): presumed dead/gone, store medium, degradation thresholds. One cheap-to-change-after tag: the unconfirmed-write alert threshold of 5, which drives a signal only; it was contested and survived. The deferrals all carry principal approval in the frontmatter: boot pull, never-accepted detector, restart nonce watermark, window (d), and GitLeaseStore items (i), (ii) and (v).

## Residual risks, accepted

- The windows listed in the spec's Safety posture: partition, boot overlap, restart hand-over, intermittent holding, clock offset. These are ratified by the operator.
- A forged pull receipt can change liveness verdicts. Its effects are listed per reader and recorded by test, and the window (d) change must not rest the hold gate on it.

## Convergence verdict

Converged. Two consecutive zero-DESIGN rounds, no open questions, and approval recorded. Next: build under /instar-dev, then the live proof on throwaway agents before the PR.
