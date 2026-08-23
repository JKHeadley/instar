# Completion-Evidence Pathway Characterization — refreshed 2026-08-22

## Status

This report characterizes seed candidates. It does **not** admit a semantic judge. The closest
existing task is transcript-shaped `completion-judge`; the proposed runtime input is a new
canonical evidence envelope. Every route therefore remains `candidate-prior-only`.

## Live surface reads

Authenticated freshness reads against Instar-codey v1.3.1180 on port 4044 returned:

| Surface | Result | Meaning |
|---|---|---|
| `GET /doorways` | HTTP 503, `registry-unavailable-no-instar-source` | The agent project configured as `projectDir` is not the Instar source worktree, so the source manifest cannot be resolved. |
| `GET /decision-quality?sinceHours=720` | HTTP 503, uniform seam dark | No live completion-route grade window is available. |
| `GET /benchmark-divergence` | HTTP 503, detector dark | Absence of a finding cannot be read as “not diverged.” |

The same three authenticated reads were repeated on 2026-08-22 against the live Instar-codey
server on port 4044. They returned the same status and reason codes: doorway registry unavailable
because this install has no Instar-source manifest, decision-quality uniform seam dark, and
benchmark-divergence detector dark. The recheck therefore supplies no new evidence that can
promote, reorder, or reject any candidate route below.

The August freshness pass therefore cannot promote, reorder, or reject a candidate from live
quality data. The most recent direct free probe (July 24) found Claude Code, Anthropic headless,
Codex, and pi runnable; Gemini's asdf shim returned no selected version. That probe was executor
liveness only, not completion-specific decision quality. Fresh spec-review detection on August 18
found `codex-cli`/GPT-5.5 and `gemini-cli`/Gemini 3.1 Pro Preview available for review, but those
are not substitutes for the dark characterization endpoints or the benchmark's fixed routes.

## Benchmark prior

Canonical task battery:

- task: `completion-judge`
- battery SHA-256: `c903528bbbbc80293ee1bb6301c00b87050c68287bc49c00b0e155309a858c6b`
- cases: 10, covering canonical, boundary, adversarial, degenerate, and context-pressure axes
- source: Echo research tree,
  `research/llm-pathway-bench/instar-bench-v2/tasks/completion-judge.json`

Relevant corrected runs:

| Door/model | Completion slice | Run | Result artifact SHA-256 | Captured |
|---|---:|---|---|---|
| `pi-cli` / `openai-codex/gpt-5.5` | 20/20 | `crit-cli2` | `de3ad83b685e563793ab502b33081257574fff5fc10419eefe5dd9f7bc9fc51f` | 2026-07-02 |
| clean `claude-code` one-shot / `claude-sonnet-4-6` | 20/20 | `crit-cli2` | `de3ad83b685e563793ab502b33081257574fff5fc10419eefe5dd9f7bc9fc51f` | 2026-07-02 |
| `codex-cli` / `gpt-5.5` | 20/20 | `crit-cli2` | `de3ad83b685e563793ab502b33081257574fff5fc10419eefe5dd9f7bc9fc51f` | 2026-07-02 |
| `gemini-api` / `gemini-3.1-flash-lite` | 20/20 | `crit-gnat` | `72ed59112efb71fac71a12150b67b7ae9224be1975133e4a88b33ca0841e1d4` | 2026-07-02 |

The run manifests record dirty benchmark worktrees, so the battery and result hashes—not an
unstated git commit—are the reproducibility anchors. The full corrected matrix also measured
pi→GPT-5.5 at 335/335 overall and Sonnet 4.6 at 217/218 overall. Opus through the Claude coding
harness scored 178/218 overall (81.7%) with completion credulity and format failures; it is
disqualified for bounded completion judgment.

The benchmark artifact names this Gemini door `metered:metered_gemini_bench`; the source doorway
registry normalizes that key reference to the report's `gemini-api` label and
`gemini-3.1-flash-lite` model.

## Candidate per-author-engine routes

| Authoring engine | Primary seed | Backup seed | Current state |
|---|---|---|---|
| Claude Code | pi / GPT-5.5 | Gemini API / 3.1 Flash-Lite | backup not live-probed on this host; unadmitted |
| Codex CLI | clean Claude one-shot / Sonnet 4.6 | Gemini API / 3.1 Flash-Lite | backup not live-probed on this host; unadmitted |
| Gemini CLI | pi / GPT-5.5 | clean Claude one-shot / Sonnet 4.6 | author engine locally unrunnable; unadmitted |
| pi CLI | clean Claude one-shot / Sonnet 4.6 | Gemini API / 3.1 Flash-Lite | backup not live-probed on this host; unadmitted |
| Grok Build | pi / GPT-5.5 | clean Claude one-shot / Sonnet 4.6 | no completion-specific Grok row or live quality label; unadmitted |
| Instar-native | pi / GPT-5.5 | clean Claude one-shot / Sonnet 4.6 | nested origin engine can select a stricter row; unadmitted |

For these research seeds, every listed backup is outside both the author and primary model
families. “Best” means best supported by the immutable July completion slice after excluding the
author family and the disqualified Opus coding-harness route; it does not mean a current production
winner. The August endpoints supplied no evidence that could honestly change the ordering. The
report does not set a future activation policy for same-family alternate doors.

## Missing evidence before admission

- canonical-envelope benchmark cases and immutable prompt/serializer hash;
- one future-spec-defined full quality/divergence key, numeric correctness floors, and independent
  live labels;
- a fresh executor-local doorway probe;
- independent label-authority evidence and an authenticated promotion record;
- a separately converged and approved v2 activation spec.

Until all are present, residual ambiguity returns `unknown`.
