# Convergence Report — Feature Maturation Ladder

## ⚠ Cross-model review: codex-cli:gpt-6-astra (Gemini unavailable: not signed in on this machine)

GPT-6 Astra ran on rounds 1, 2 and 3. Gemini reported `gemini-not-authed` and did not review.

## ELI10 Overview

Instar ships new features switched off until they are proven, and many stay off forever. This work gives every switched-off feature numbers it must hit, records good enough to judge it, and something that notices when it hits them. The last step is being on by default, unless someone records a decision that it should stay off as a matter of user preference.

The numbers never flip anything by themselves. They raise the feature to the recurring review, whose AI model decides. A guarded route applies that decision and can only refuse. Moves to everyone stay reviewed code changes.

## Original vs Converged

Originally a server-side advancer flipped reversible settings by itself when numbers were met and flipped them back on harm. All three reviewers and the constitution's *The Body and the Mind* article said no: a counter must not decide. So the advancer became a raiser, and the review's model decides every move.

Review also found real defects, now fixed in the design: D7 silently drops dotted ids; a clean harm count of zero could never pass; a crashed feature read as fresh; truncated logs could pass a harm bar; the scorer would stall at 250 features; the gate would have refused every spec on installed agents; the post-move harm watch stopped at the moment it mattered; switched-off features could never earn a first number; and a flag read at boot looked live before a restart.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | adversarial, foundation, lessons, integration, scale, security, GPT | 27 | 3 | Cut automatic apply and revert; schema, reads, scoring, moves, gate rewritten |
| 2 | one all-lens reviewer, GPT | 11 + 4 | 7 | Exposure samples, start action, rung-change watch, raise brakes |
| 3 | one all-lens reviewer, GPT | 3 + 3 | 10 | Implementation bugs and small rules; no new design problem |

Standards-Conformance Gate: round 1 ran (5 flags: mind's authority, cut data, rung as a symbol, retry brakes, preference exit), all addressed; round 2 ran (2 flags: test-agent rung, cut data), both addressed; round 3 not re-run on the small rule changes.

Per-round model: internal reviewers ran on this session's model, claude-opus-5-5.

## Proportion

Tier 2, about 570 spec lines, 3 rounds of a cap of 6. Round 3 found bugs rather than design problems, so the review stopped changing what gets built.

## Left behind

- **Concurrent config writers (GPT r3).** A move checks, writes through `LiveConfig`, then re-reads, with no compare-and-swap. A concurrent writer in the same window could be overwritten. Accepted: `LiveConfig` is one process, moves run a few times a week, and a model is in the loop.
- **Evidence loss accounting (GPT r3).** The 60-a-minute limit answers 429 to the caller but keeps no loss counter, and an append that fails is silent. Accepted: a missing row reads as fewer samples; no count decides anything.
- **`DarkFlagMaturationRegistry.proofOfLife` stays `unknown`.** The ladder's `ran` metric now answers that question on the board. Queued for the review to retire or feed it.
- A review move on a machine other than the one the job runs on has no actor (standby-only ready). The review sees it on the pool board.
- `reviewTopic` must be set per machine or raising stops on failover.
- One feature at 60 rows a minute could fill the shared evidence log in days, reading as `evidence-cut` for others.
- A partial multi-key `set` leaves revert refusing, by name.
- A stage-style flag reads `dark` at intermediate stage values.
- The raise cooldown runs from the raise, not the close.
- `maturation:<id>` commitments ignore aliases.
- `record` appends synchronously; "never blocks" means never waits on anything but the append.

## Full Findings Catalog

Round 1 reviewers: adversarial and foundation (8), integration, scale and security (8), lessons and decision-completeness (8), GPT-6 Astra (4). Round 2: all-lens (11), GPT (4). Round 3: all-lens (3), GPT (3). Each was folded into the spec sections named above, or listed under Left behind.

## Convergence verdict

Converged at round 3. The last round found nothing that changes the design; its three bugs were in the code and are fixed with tests. Eleven items left behind. Gemini did not review. The spec is ready to build; only the article amendment in §12 needs the operator.
