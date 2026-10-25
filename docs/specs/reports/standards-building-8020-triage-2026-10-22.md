# Standards family delta review — Building: fractal 80/20 convergence, proportion and found-problem triage

## Scope and operator authority

This review covers one change to `docs/STANDARDS-REGISTRY.md`: a passage added to the existing **In practice** field of *Occam's Razor — Simplest Robust Route* in the **Building** family. The operator asked for it in topic 127831 on 2026-10-22 (08:56 and 09:01 PDT) and tracked it as CMT-917. The operator approved an earlier head of JKHeadley/instar #2305. This revision changes the wording after that approval, so the direction guard needs the operator's approval on the new head again.

## The delta

- No article is added, removed or moved. Building keeps 42 articles, and no other family changes.
- The passage defines convergence for design, spec and single-artifact reviews as a round that finds nothing that would change what gets built. Audit-shaped sweeps keep the zero-new bar of *Iterative Audit to Convergence*.
- Findings that are left behind are recorded as accepted decisions or sent to a named queue.
- Effort is proportioned to the change. The push and merge test gates still apply.
- A problem found during work is fixed now if it blocks that work. A major one gets its own topic and session. Anything else goes to a named queue.
- The passage asserts no running machinery, names no guard file and adds no dangling reference. Building's recorded floor (34 enforced of 40) is unchanged.

## Areas attested

| Family | areaSha256 | Verdict |
|---|---|---|
| Building | `be51d9c29b466d195839613ef45e7d0edbdf6f7e3599658f9f8606c83c699890` | accepted |

## Independent acceptance

An independent verifier reviewed the Building family against the change. On the first candidate it raised three precision findings and accepted the change once they were fixed:

1. **"Converged" had two meanings.** It clashed with *Iterative Audit to Convergence*. Fixed: the bar is limited to design, spec and single-artifact reviews, and audits keep zero-new.
2. **"Listed as left behind" was not durable.** It conflicted with *Deferral = Deletion* and *Close the Loop*. Fixed: such findings are recorded as accepted decisions or sent to a named queue.
3. **"Targeted tests" could be read as skipping the suite gate.** That would contradict *Zero-Failure*. Fixed: the push and merge test gates still apply.

It re-checked the revised text and accepted it, finding no new contradiction. Its one non-blocking wording point ("the same named queue" became "a named queue") was also applied.

Reviewers: `echo:claude-code`, `independent-verifier:claude-code`.
