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

6,477 lines, machine-stamped by a helper rather than by me — because early in the window I fabricated
seven timestamps from memory, and the fix for that was structural, not a resolution to be careful.

It is the complete record: measurements, wrong turns, retractions, and the reasoning at the time rather
than reasoning reconstructed afterwards. **It contains claims that are false at the point they were
written and corrected later** — the "21 dead jobs" that turned out to be throttled, the pool that was
declared permanently dead and recovered forty minutes later, the memory reading I hand-rolled into the
exact bug the instrument exists to prevent.

Those are left exactly as written. The value of an append-only record is that it cannot be tidied, and
a tidied record would have hidden the single most useful pattern in the whole window: **the errors
cluster immediately after a genuine win, not after a struggle.**

## `tools/` — the guards, and WHEN to reach for them

Two shell guards live in `tools/`. They exist because this window's sharpest method finding was that
**prose lessons got repeated and the one that became a script never did** — so these are the two
error shapes that cost the most, converted from rules into refusals.

They are **invoked deliberately**; nothing enforces them. That is a real limit and it is the same
limit this whole audit documents — a correct mechanism with nothing running it. Better than prose,
weaker than a gate. The triggers below are what make them reachable at all, so they are written as
*"when you catch yourself about to…"* rather than as descriptions.

| tool | reach for it WHEN | what it refuses |
|---|---|---|
| `watch-for.sh` | you are about to watch for something to change — a file to grow, a job to run, a value to move | a baseline captured AFTER the event it was meant to precede (`--not-before`), which makes "unchanged" meaningless |
| `spans-window.sh` | you are about to say "nothing found" / "zero" / "no occurrences" over a time range | a corpus that does not SPAN the window your claim describes |

**Both were verified with a control per output path**, because a checker that cannot fail is this
audit's founding subject:
- `watch-for.sh` — refusal (exit 2), unchanged (exit 1), **and changed (exit 0)**. The third is the
  one that matters: a watcher that always says "unchanged" is output-identical to a working one.
- `spans-window.sh` — spans (0), empty (1), **and does-not-span (2)**, the last replayed against a
  real error from this window rather than a synthetic case.

**The measured need.** Five instances in one day, one of them published to the operator and retracted
25 minutes later. The rule against it was written into durable memory and **failed again ninety
minutes later, on the exact case it was written for** — which is the whole argument for these being
executables rather than another paragraph.

**A hazard `spans-window.sh` surfaced on its first run:** a fixed row-cap query over a busy scheduler
is a *moving* window. The same 400-row job-history query covered `09:00Z →` at one point in the
evening and `09:35Z →` ninety minutes later. A query that legitimately answered a question silently
stops being able to, with no change to the query and nothing in the response saying so. Re-measuring
at claim time catches a changing VALUE; it does not catch a shrinking CORPUS.
