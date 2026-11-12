# Step 1 post-review: research and brainstorm

Reviewers: Fable 5.2 (`step1/post-review-fable-5-2.md`) and GPT 6 Astra (`step1/post-review-gpt-6-astra.md`), each reading every step-1 artifact, plus Echo. Written 2026-11-11, about 14:55 PST.

## Did the pre-review fix earn its cost?

Yes, according to both reviewers. The frozen, question-only packet with its ranking held back produced three genuinely different top tens. That made the Phase B corrections possible: `--bare` was unreachable, Codex schema wiring did not exist, and discovery had a path that could start work by itself. The packet took about 15 minutes to build.

## Findings and actions

| Finding | From | Class | Action taken |
|---|---|---|---|
| The synthesis turned owner-level disagreements into "Decisions Echo made" (charter decision 5) | both | **small, done** | Restored as eight owner questions, each with Echo's default, and sent to Justin |
| The kill-check trio was misattributed as unanimous | Fable | small, done | Corrected to show each researcher's own examples |
| Phase B claims from one researcher were listed as "settled" | Fable | small, done | Marked "(1 source)"; step 2 verifies each one it relies on |
| Advisor caveats were dropped: credit billing, account availability unresolved | both | small, done | Restored |
| Renumbering error ("Codex after 7") | Astra | small, done | Fixed |
| The constitution-check record promised in the pre-review was missing | both | small, done | Added a rule-by-rule disposition table |
| The B1 inventory was not linked | Fable | small, done | Linked |
| Echo's sealed answer predates the frozen packet and skips its Q1–Q8 shape | Astra | small, done | Disclosed in the synthesis. **Rule for next time:** Echo answers the frozen packet too, in the same shape |
| The packet's "frozen at" time was hand-written and wrong | Fable | small, do now | Future packets get their time and hash stamped by script (`sha256` plus `date -u` in the receipt); applied from step 2 on |
| The seal relied on willpower: other outputs sat in folders the reviewers could read | both | **sub-effort B** | Each reviewer run gets its own folder holding only its inputs. Added to the `sealed-multimodel-review` scope |
| Phase B took 80 seconds and the synthesis followed within a minute, with no verification pass on new claims | Fable | **sub-effort C** | Stage minimum: new Phase B claims are verified before the synthesis. Added to the `effort-stage-gate` scope |
| The stuck-process guard kills reviewer runs, and an interrupted run reports exit 0 | both | **feedback** | fb-b2aa22d0-32a, extended below with exit-0-on-interrupt and the need for process-tree receipts |
| The run script changed between attempts | Fable | small, do now | Scripts are frozen as `run-fable.sh` and `run-astra.sh` in the effort folder from this point on |
| Step 2 must define acceptance evidence before implementation | Astra | applied | The spec frame carries acceptance criteria, a graduation test and a deadline |
| Send the disagreements to Justin before the spec hardens; the builder-location question comes first | Fable | applied | Sent. The spec's ratchet now has a per-file ceiling that includes the launch module, matching default #3 |

## Budget

- **Planned:** 3 hours, one retry for each failed reviewer.
- **Actual:** about 30 minutes from the packet to the synthesis.
- **Fable's Phase A:** 3 attempts. That is one over the retry budget, caused by the guard. The overrun was absorbed, not escalated, because the guard was the cause and not the reviewer.
- **The process lesson:** the step was too fast at the end, not too slow.
