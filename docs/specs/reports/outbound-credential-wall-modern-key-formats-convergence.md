# Convergence Report — Outbound credential wall: modern OpenAI and GitHub key formats

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran through the codex CLI in **all three rounds** (clean
RAN state, no caveat). The Anthropic clean-door second read (`claude-fable-5`) also ran
all three rounds — disclosed separately per protocol: `clean-door-anthropic-review:
claude-code:claude-fable-5` — it is a clean-door read, never a cross-model opinion.

Convergence was **closed at round 3 on the operator's explicit 80/20 directive**
(Justin, 20 September 2026, 22:28: apply 80/20 convergence, do not spend tokens on
diminishing returns). Round 3's internal panel reported **zero design-class findings**;
the remaining external items were wording-level or measured-and-folded the same round.
The two extra design-quiet confirmation rounds the process defaults to were skipped —
recorded here as the operator's call, not silently.

## ELI10 Overview

Before any message goes out to you, one non-negotiable check runs: does this text
contain a live secret, like an API key? It works by recognising the shapes companies
give their keys. Two shapes issued today — OpenAI's current keys and GitHub's newer
tokens — were not on its list, so a message carrying one would have reached you. The
model review behind the wall did not catch them either, in thirteen out of thirteen
live tries.

The fix adds narrowly targeted patterns for the missing shapes (plus three sibling
OpenAI forms and OpenRouter's, which fail the same way), measured against roughly
366 MB of our own real text to prove they never misfire on ordinary writing. Review
also found and fixed two ways messages could skip the check entirely, and catalogued
every other place in the codebase where similar pattern lists had quietly drifted.

## Original vs Converged

- **Originally** two patterns behind the existing wall. **Converged:** five `sk-`
  family prefixes plus GitHub fine-grained tokens; an anchor chosen by measurement
  (a first draft would have unoverridably blocked ordinary kebab-case slugs like
  `task-proj-…`); invisible-character stripping with the exact regex and the
  load-bearing `u` flag stated.
- **Originally** claimed the wall guarded "outbound messages". **Converged:** an
  honest surfaces table — the `isProxy`/system-template skip and the attention-lane
  bypass are FIXED in scope; the public-publish, private-view, threadline and
  iMessage gaps are tracked (ACT-028) with per-surface decisions required.
- **Originally** "two pattern lists drifted". **Converged:** a converged census of 25
  candidate files, 11 verified-missing copies with per-file dispositions (9 fixed in
  scope in each file's local convention, 2 needing migrations → ACT-027), a
  cross-file equivalence test, and a bidirectional drift guard with an explicit
  type-to-kind mapping.
- **Review found two pre-existing defects beyond the spec's scope**, both filed:
  the shared list's `jwt` pattern is quadratic on unbroken base64url runs (measured
  814 ms at 64 KB; ACT-029, due 4 Oct — earliest of the follow-ups) and the
  LLM authority passes planted credentials (13/13 observed), confirming the wall is
  the only real layer for this class.
- **Evidence upgraded from asserted to reproducible:** harness scripts archived in
  the repo, measurements re-run against the full shipped pipeline (raw-size check →
  strip → anchored `u`-flagged patterns; zero matches across telegram/repo/logs/state
  corpora), and a measured decision recorded against the generic `sk-<word>-`
  alternative (viable at zero real-prose false positives, rejected for the
  non-overridable wall in favour of vendor-issued prefixes; ACT-027's vendored
  pattern database is the structural answer to provider churn).

## Iteration Summary

| Round | Reviewers | Design-class | Precision-class | Standards-Conformance Gate |
|---|---|---:|---:|---|
| 1 | 6 internal (parallel) + codex + clean-door | 14 | 9 | ran degraded (`error`, 0 findings) — recorded, non-blocking |
| 2 | 6 internal (3 paired agents) + codex + clean-door | 7 | 8 | ran degraded (`error`, 0 findings) |
| 3 | full internal panel + codex + clean-door | 0 internal; 1 external behavioural item (invisible-char classes outside `Cf`), folded with the stronger resolution same round | 8 | ran degraded (`error`, 0 findings) |

Internal reviewers ran on the authoring session's model (Opus 5 rounds 1–2; the
round-3 panel and this closure ran under Fable 5 after a session restart). External
models: `gpt-6-astra` (codex CLI), `claude-fable-5` (clean door). The conformance
gate returned `degraded: true, degradeReason: error` on all three rounds — the
constitutional pass was NOT authoritative for this spec; recorded honestly per
protocol (an unavailable gate never blocks, a skipped-without-reason one fails
validation).

## Full Findings Catalog (compressed by resolution)

**Round 1 (14 design):** wall covers only `evaluateOutbound` routes → surfaces table
+ ACT-028; attention-lane bypass → fixed in scope; `sk-None-`/`sk-or-v1-` missing →
alternation widened; `\b` anchor loses glued keys → re-decided by measurement
(lookbehind, round 2); drift-guard test unbuildable as written → mapping table +
canonical generators; ~10 pattern copies not 2 → census + dispositions; missing e2e
tier → named files extended; jwt quadratic hazard (measured) → disclosed + ACT-029;
`sk-` state-store retro-scan → run (zero); redaction fixtures missing → Tests 4;
untracked deferrals → ACT-027/028 minted with due dates; invariant rows uncited →
Signal-vs-Authority exemption + Judgment-Within-Floors cited; no-op enrollment
sentence → removed; ships-live undeclared → Frontloaded Decision 6.

**Round 2 (7 design):** no-anchor creates the `task-proj-<slug>` unoverridable
false-positive class → `(?<![A-Za-z0-9])` lookbehind, verified against all six case
shapes; `metadata.isProxy`/system-template skip sits above the wall → credential
check moved ahead of the skips, in scope; iMessage walling is client-cooperative →
honest row + ACT-028; hook-template row contradiction (same artifact fixed and
deferred) → collapsed, fixed at the embedded source; census not converged
(PromiseBeacon found) → converged sweep, 3 more in-scope rows; jwt exemption
unbounded → coarse ceiling; per-file "same literal update" false → per-file deltas
stated.

**Round 3 (1 design, external):** invisible interleaves outside `Cf` (`U+034F`,
variation selectors, in `Mn`) defeat the category strip → strip set widened to
`[\p{Cf}͏︀-️]/gu` and the "closed" claim narrowed. Precision items:
the `u`-flag statement (verified: without it `\p{Cf}` matches literal text);
`U+00AD` already `Cf`; jwt fixture must contain interior word-boundary characters or
it is vacuous (verified: pure alphanumerics match in 0 ms, hyphenated runs 3.2 s);
timing figures restated on the anchored form; route tests for the skip fixes;
full-pipeline re-measurement (done, zero); rollback cannot un-redact (stated);
generic-family alternative measured and decided (Frontloaded Decision 11);
hyphen-preceded slug documented refusal (Frontloaded Decision 12); cross-file
parameterized test (Tests 2b).

## Convergence verdict

Closed at iteration 3: zero internal design-class findings in the final round, the
single external behavioural item folded with the stronger resolution in the same
round, and the operator's explicit 80/20 directive ending confirmation rounds.
Twelve frontloaded decisions, zero unresolved open questions, all deferrals tracked
(ACT-027, ACT-028, ACT-029 with due dates). Ready for operator review and approval.
