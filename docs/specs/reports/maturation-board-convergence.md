# Convergence Report — Maturation Board

## Cross-model review: codex-cli:gpt-6-astra

A GPT-family external pass (GPT-6 Astra, through the agent's codex CLI) ran in all three rounds and
returned findings each time. Gemini was not installed; Grok is not enabled on this agent.

## ELI10 Overview

Instar ships lots of features switched off first and turns them on as evidence comes in. Three times
a week a review job on the Studio grades about 180 of them (live, on track, blind, stalled,
regressed, too new) and writes down what it decided and which follow-up item is fixing each one.
That record was a long text file on one machine plus a five-line Telegram summary. Justin asked for a
page he can open on his phone that shows every maturing feature, its stage, what measures it, what
the evidence says, whether it's moving, what's being done, and expected-versus-actual dates.

The board is a view only. It reads the review files and the live records that already exist (the
follow-up items, the dark-switch registry with its first-seen dates and deadlines, the six-hourly
readiness checker, rollout records, safety-check posture), joins them by feature name and shows them
with colours, filters and sorting. It stores nothing, changes nothing and has no opinion of its own:
the progress verdict is the review's, word for word, labelled as a model's assessment. The review job
now also saves its table as data and links the page from its Telegram message.

The main tradeoff: most features have no written expected date yet, so the "expected" half of the
timeline starts thin, and the page says so instead of guessing.

## Original vs Converged

- **Who judges progress.** The first draft had the board map owner states to its own progress labels
  (on-track, behind, stalled). Review showed that would be a second "is it ready?" judge beside D7
  and the review job. Now the board shows the review job's verdict verbatim and adds only arithmetic.
- **"Nothing is being done."** The first draft found follow-ups by searching text for the feature
  name and said "Nothing is being done" when it found none. Now only explicit links count, and the
  answer is linked / no linked follow-up / can't tell.
- **Dates.** Commitment deadlines now come from the promised date (`checkInAt`), not the beacon's
  moving nudge marker. A "delivered" commitment reads "handed off", because delivery means the work
  was assigned, not that it landed. Review-written dates are labelled model-assessed. Stage
  history comes only from the dark-switch registry, the one owner that records dated stage changes.
- **Several machines.** Facts are tagged with the machine they came from and never merged into one
  value. One fixed rule picks which machine's review is shown; peers send small summaries; a missing
  machine is named on the page; an offline review machine is labelled, and its old follow-up
  statuses are never shown as current.
- **Safety.** Text-only rendering, real-path checks on the reviews folder and each file, byte caps on
  peer answers, a response cache, and an explicit `advisory: true, authority: 'none'`.
- **First view.** A headline and five tiles instead of the full table (Dashboard UX standard), with
  no combined "stuck" label, since judging "stuck too long" belongs to the planned D4.
- **Proof before done.** A user-role drive of the real page through the tunnel, plus a deterministic
  parity test, before the weekly message links it.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|---|---|---|---|---|
| 1 | GPT-6 Astra, security+adversarial, scalability+integration, lessons+decision-completeness, standards gate (3 flags) | 32 | 8 | Rewrote progress, follow-up, deadlines, pool, page, tests, rollout gate, posture |
| 2 | GPT-6 Astra (4), security/adversarial/scale (2), integration/lessons/completeness (3), standards gate (2 flags) | 9 | 7 | One selection rule, commitment projection, timeline fields, F10 tiles, checkInAt, no rollout-phase dates |
| 3 | GPT-6 Astra (2), combined internal pass, standards gate (1 flag) | 2 | 2 | Typed transition/deadline projection; cached commitments never shown as current; stable tie-break |

Standards-Conformance Gate: round 1 ran (3 flags), round 2 ran (2 flags), round 3 ran (1 flag).
Internal reviewers ran on the authoring session's model (Opus 5.5) in all rounds; lenses were paired
across three subagents in rounds 1–2 and combined in round 3.

## Proportion

Tier 1 (read-only, dark, reversible view; spec ~390 lines). 3 rounds of a 3-round cap. The round-3
design findings were small and were fixed in place at the cap; none concerned safety, security or
data loss.

## Left behind

- The standards gate's remaining flag (review history lives on one machine): not introduced by this
  spec; accepted and tracked as ACT-006 (make the review job replicate its files, due 2026-11-06).
- A peer with a fast clock can win review selection for up to a day (peers are the agent's own
  machines; every candidate is listed in `sources[]`).
- D7 metric descriptors stay as scalar owner facts; richer descriptor display is a later page change.
- The answer line's example numbers in §7 are illustrative; real counts come from the response.
- Round-3 precision notes folded: dark-flag `load()` missing/corrupt/foreign reported as can't-tell; `part=review` own 3 s budget; hash mismatch during a review rewrite fails cleanly, no fallback.
- Precision items folded in passing: per-file realpath, facts key limits, 16,384 projection cap,
  C3 simplification, commitment status enum named, verdict `other` colour.

## Full Findings Catalog

Round 1 — GPT-6 Astra: stage enum dropped observed stages (→ verbatim per owner); pool merge lacked
provenance (→ machine-tagged owner entries); deadline rules inconsistent (→ per-source deadlines);
no closed conflict table, "nothing being done" (→ C1–C4, three-state follow-up); review schema
unspecified (→ §2 contract, newest-valid selection). Security/adversarial: newest-review takeover;
text-match remediation; XSS; peer allowlist; no caching; reviewsDir escape; unsupported verdicts;
board as authority; ambiguous joins (all resolved as above). Scalability/integration: caching; peer
body size; Studio-offline posture; dark-flag registry not on RouteContext (→ hoist); gate not hiding
page/tile; per-machine conflicts; text-match cost; legacy dashboard tests; DEV_GATED registration.
Lessons/completeness/P20: model-written fields shown as fact (→ labelled); D4 duplication (→ D4
named owner, display-only dates); proofOfLife unknown (→ "not measured"); stale dark-flag file (→
24 h marker); carried verdicts counted as stagnation; single-machine history; no user-role drive;
self-grading graduation (→ parity test); published interface (→ schema maturation-board/1); fleet
behaviour. Standards gate: recall-by-meaning, multi-machine, live-user proof.

Round 2 — GPT-6 Astra: two selection rules (→ one algorithm); ambiguous-join over-triggers (→ row
key + true ambiguity definition); commitments lacked a transport (→ projection on `part=review`);
actual dates dropped (→ `shippedAt`, `transitions`). Internal: offline rule relied on memory (→
"may be superseded" label); review payload cap/contents (→ defined, 4 MB, hash-bound);
`nextUpdateDueAt` is a moving nudge marker (→ `checkInAt`); rollout-phase dates are task phases (→
dropped); "stuck" adds a verdict (→ named verdicts only). Standards gate: multi-machine, F10.

Round 3 — GPT-6 Astra: transitions not representable in peer facts (→ typed bounded projection);
cached commitments could pass as live (→ follow-up `unknown` from cache, last-known shown with
fetch time, excluded from counts); tie-break contradiction (→ lowest machine id). Standards gate:
multi-machine (accepted, ACT-006).

## Convergence verdict

Converged at round 3 (the Tier 1 cap). The round-3 design findings were fixed in place; nothing
remaining would change what gets built. Ready for approval and build.
