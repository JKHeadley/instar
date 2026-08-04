# Phase A — the underlying evidence

The two committed summaries (`docs/audits/phase-a-constitutional-alignment.md` and
`…-auditor-method-lessons.md`) are derived from the measurements in this directory. **These are the
working artifacts, preserved so the summaries' claims can be checked rather than trusted.**

The ratified plan required that the audit "live in project infrastructure, where status is
**evidence-derived** rather than asserted". Until now these lived only in the agent home — one machine,
no history, no review surface. A summary whose evidence is unreachable is an assertion.

| file | what it holds |
|---|---|
| `A0-instruments.md` | the instruments audit — the audit's first act, checking the tools before using them |
| `level2-nodes.md` | the 68-leaf node tree the tranches were drawn from |
| `VERDICT-LEDGER.md` | per-guard three-rung verdicts (`exists` / `wired` / `effective`) |
| `INTERIM-SYNTHESIS.md` | mid-window synthesis up the tree |
| `journals/_counter-method.md` | the would-act/did-act counter method — rung-3 evidence without injection |
| `journals/_rung3-first-measurements.md` | the first genuine rung-3 passes |
| `journals/lint-class-rung3-verification.md` | A/B injection results for the lint tier |
| `journals/_cross-machine-guard-divergence.md` | the same guard in different states on two machines |
| `journals/_cost-map.md` | what rung-3 would actually cost, per class |
| `journals/_rung0-exhaustion-llm-layer.md` | the self-unblock exhaustion trail for the LLM layer |
| `journals/tranche1/` · `tranche2-briefs.md` · `tranche4-*.md` | per-tranche measurements and verdicts |
| `journal.md` | the full append-only narrative record, machine-stamped |

**Reading them honestly:** these are working notes written during measurement, and several contain
conclusions that were later corrected — most notably the Tranche 1 verdict, which carries its own
in-file correction after standing wrong for 4h37m. **The corrections are left in place deliberately.**
A record that only shows the conclusions that survived is not evidence, it is a summary wearing
evidence's clothes.


## On `journal.md`

5,398 lines, machine-stamped by a helper rather than by me — because early in the window I fabricated
seven timestamps from memory, and the fix for that was structural, not a resolution to be careful.

It is the complete record: measurements, wrong turns, retractions, and the reasoning at the time rather
than reasoning reconstructed afterwards. **It contains claims that are false at the point they were
written and corrected later** — the "21 dead jobs" that turned out to be throttled, the pool that was
declared permanently dead and recovered forty minutes later, the memory reading I hand-rolled into the
exact bug the instrument exists to prevent.

Those are left exactly as written. The value of an append-only record is that it cannot be tidied, and
a tidied record would have hidden the single most useful pattern in the whole window: **the errors
cluster immediately after a genuine win, not after a struggle.**
