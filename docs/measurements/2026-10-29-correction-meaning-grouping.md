# Correction meaning grouping — measurement (2026-10-29, CMT-1034)

Corpus: the live correction ledger of the development agent (Echo, Mac
Studio), copied read-only on 2026-10-29: 131 open records (106
user-preference, 25 infra-gap). Measured on the analyzer's real `learning`
field, not the served summaries. Spec: `docs/specs/correction-meaning-grouping.md`.

## 1. Word overlap on the learning field

Same-kind pairs: 5,865. Normalized-token Jaccard (the analyzer's own measure):

| Jaccard ≥ | pairs |
|---|---|
| 0.65 (current floor) | 0 |
| 0.30 | 2 |
| 0.20 | 8 |
| 0.10 | 91 |
| 0.05 | 583 |

True repeats sit far below 0.65: "approval only for constitution changes"
(061/080) 0.50; the test-bottleneck trio (038/039/040) 0.07–0.25; "keep going
until done" pairs 0.10–0.18. Word overlap cannot separate them from unrelated
pairs at any floor, so it is used only as a cheap prefilter (≥ 0.05).

## 2. Question wording (Jev 1.13.0, 26 then 38 hand-picked pairs)

- "Following one means following the other" (strict): most true repeats
  answered `related` (P(same) 0.01–0.17 for 130/131, 055/056, 005/007, 027/037).
  Rejected.
- "The same core rule; one note may add extra detail" (shipped): true repeats
  0.75–1.00 (061/080 1.00, 038/039 1.00, 036/057 1.00, 039/040 0.88), clear
  non-repeats ≤ 0.15 (064/065 0.01, 090/091 0.00, 084/118 0.00), a middle band
  of genuinely close calls (027/037 0.53–0.64, 005/007 0.52–0.63).

## 3. Full candidate run (shipped code path, real Jev + real Luna referee)

The production `CorrectionAnalyzer` + `JevCorrectionGrouper` over a copy of the
ledger: 583 candidate pairs, 583 Jev calls, 0 failures; 22 pairs unsure
(0.30–0.70) went to GPT-6 Luna (Codex fast tier), 0 failures; 46.9 s total.

- Jev confident `same` (> 0.70 both option orders): 12 pairs.
- Luna `true` on unsure pairs: 4 of 22 (014/062, 036/069, 038/040, 130/131).
  Luna `false`: 18 (e.g. 007/004, 037/027, 105/104, 083/094).
- Same edges: 16. Edges used inside groups: 9. The other 7 (mostly around
  record 057, "do not leave work stalled", which matched 8 different records)
  were left unused by complete-link because those records do not match each
  other — the hub cannot chain them.

Jev is not deterministic between calls (049/054 scored 0.81 in the wording
probe and 0.54 in the full run). The cache keeps the first verdict per pair, so
grouping is stable across runs.

## 4. Groups formed, each read

Word overlap alone: 0 groups. Meaning grouping: 7 groups (largest 3):

1. 002 + 057 — keep making progress; do not leave work stalled. One preference.
2. 004 + 005 — answer the convergence question plainly (yes/no). One preference
   (004 adds "one extra check").
3. 014 + 062 — treat review convergence as 80/20. One preference (each adds
   context: Instar 2.0 priority; triage routing).
4. 036 + 069 — keep working through to completion when asked. One preference.
5. 038 + 039 + 040 — find and remove the shared test-wait bottleneck. One
   preference (040 also asks for direct links).
6. 061 + 080 — require the user's approval only for constitution changes. One
   preference.
7. 130 + 131 — specific headlines, no redundant wording. One preference (130
   adds "link to the item").

No group merges two different preferences.

## 5. Gate outcome

No group crosses the unchanged preference gate (4 qualifying occurrences, 2
days, 2 sessions). Closest: 038/039/040 (3 occurrences, 1 day); 061/080 and
014/062 (2 occurrences, 2 days, 2 sessions). The two-record groups need two
more repeats each. Group 1 has 0 qualifying occurrences: both records carry
Layer-0 weight 2, below the provenance threshold 3 (unchanged).
