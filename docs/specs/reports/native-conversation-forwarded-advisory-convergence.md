# Convergence Report — Slice 3g: an advisory nudge never silently blocks a forwarded reply

## Cross-model review: codex-cli:gpt-6-astra

## ELI10 Overview
When Justin's reply in the Engine Feature Optimization topic vanished on 2026-11-11, the real cause had two parts. The Studio, which sends the messages, ran its style check on a reply written on the MacBook. The check gave a "nudge": the writer should fix the wording or say why it is fine. But nudges only go back to a writer on the same machine. So nobody saw it, and the reply sat held until an old rule threw it away. Slice 3a removes that old rule. This slice makes sure the nudge reaches the writer wherever it is. Only the writer's answer can send the held reply (a fixed version, or the original with a reason). If nobody answers, the reply ends through the existing "it didn't go out" path, and the writer is told. A real block, such as a password in the text, is never released.

## Original vs Converged
The first draft sent a held reply automatically after 180 seconds. Reviewers showed this could send a reply twice, if the writer had already revised it. The converged design has no timer: the holder ends its own copy in the same step that records the verdict, and only the author's machine holds the live copy. Other changes made during review:
- The hard-block list was corrected against the code.
- A capacity shed (the check simply didn't run) is no longer treated as a verdict.
- Each nudge gets its own answer reference.
- The verdict is kept in a column that survives retries and restarts.
- The verdict write is fenced against a concurrent claim or prior delivery.

## Iteration Summary
| Round | Reviewers | Design findings | Spec changes |
|---|---|---|---|
| 1 | Fable all-lens, GPT 6 Astra, constitution gate (2 flags) | 6 + 3 | rewrite: timer removed, holder ends its copy, durable verdict column, allow-list taxonomy |
| 2 | Fable all-lens, Astra | 2 + 1 | retain vs refused at submit; holder-authored refused line; advisory rows out of delivery selections |
| 3 | Fable delta, Astra | 1 + 2 | refused made positive (RULE_DISPOSITIONS keys); conditional transition; per-operation answer reference; copyEnded |
| 4 | Fable delta (converges), Astra (1) | 0 + 1 | Astra's prior-delivery guard answered by naming the existing store fence (recordOperationState refuses accepted/partial rows); first verdict wins; "gain" wording |

## Proportion
Small slice (about 21 KB of spec), Tier 2 (it affects delivery). Used 4 of 6 rounds. The round-4 edits were wording only and were checked with the four structural checks, not a fifth review round.

## Left behind
See the spec's "## Left behind" section (P3, P6–P10, P12, P14–P24, P-a–P-i, P-2, P-4–P-6). None of these changes what gets sent.

## Full Findings Catalog
Round files: .instar/efforts/ncb/g1-all-lenses.md, g1-codex.json, g1-scg-flags.txt, g2-all-lenses.md, g2-codex.json, g3-delta.md, g3-codex.json, g4-delta.md, g4-codex.json (agent home).

## Convergence verdict
Converged at round 4. The internal all-lens reviewer found no design finding. Astra's one remaining finding (a guard against prior delivery) is already provided by the store fence, which the spec now names. Ready to build.
