# Side-effects review — first benchmark predictions baseline

**Change:** ships `src/data/benchmarkPredictions.json` (the first captured
INSTAR-Bench predictions mirror) and adds two rows to `MODEL_ID_NORMALIZATION`.

## What actually changed

1. `src/data/benchmarkPredictions.json` — new, content-free: per (task, model)
   `passRate`/`passes`/`deterministic`, the benched prompt source, and the benched
   prompt hash. No prompts, no case text, no outputs.
2. `MODEL_ID_NORMALIZATION` — adds `gpt-5.4-mini` and `gemini-2.5-flash`, both
   identity mappings.
3. `tests/unit/benchmarkDivergenceRegistry.test.ts` — the pin that asserted the
   mirror is ABSENT now asserts it is PRESENT and well-formed.

## Why (two real defects, not just "capture a baseline")

**(a) The comparator had no baseline at all.** `GET /benchmark-divergence`
reported `mirror.present: false`, so every finding degraded to
`precondition-failed`. Measured on the serving machine 2026-07-23.

**(b) The production model was unmapped — the one pair with traffic was
structurally unmeasurable.** The live meter reports `messaging-tone-gate` running
on `gpt-5.4-mini` via codex-cli. That id was absent from the normalization table,
and FD5 is (correctly) fail-closed exact-match, so the pair resolved
`no-benched-baseline (unmapped)` — indefinitely, and quietly. A comparator that
reports "nothing to compare" forever looks identical to one reporting health.

**(c) The pre-existing bench results were stale against a drifted prompt.** The
July battery scored a tone-gate prompt of 35,499 chars; the live template is
39,886. Building a mirror from those numbers would have been stale-on-arrival —
the Q0 template-hash precondition would have (correctly) suppressed every finding.
So the battery was **re-run against the current template**, not back-filled.

## How the numbers were produced

The bench task's template file was regenerated from the live
`TONE_GATE_PROMPT_TEMPLATE` export: verbatim rules body + the harness's single
per-case slot, which is exactly the declared `promptFidelity` for this task. The
battery then ran 14 deterministic cases per route.

`benchedPromptHash` is the sha256 of the LIVE exported template, so the detector's
Q0 precondition passes only while the prompt genuinely matches — and starts failing
the moment it drifts again, which is the intended tripwire.

## Blast radius

- **Surface:** one read-only observability route (`GET /benchmark-divergence`).
- **Authority:** none. Findings are `advisory: true` by construction; nothing gates.
- **Data:** a static JSON file read through existing FD9 clamps. A malformed mirror
  is already a first-class `present: false` state, never a throw.
- **Fail direction unchanged:** an unmapped model still resolves fail-closed.

## Risk analysis

**Could this manufacture a false finding?** Only if the real-world side had a rate
to compare — it does not. `messaging-tone-gate` currently settles every decision
`unknown`, so the detector has no real grade-rate and every comparison stays
non-actionable. **This ships one half of a two-halves loop, and that is stated
rather than implied**: the mirror makes the benchmark current; it does not make the
drift comparison useful until outcome grading lands.

**Sample size honesty.** 14 deterministic cases per model is a small battery. FD3's
Wilson half-width term already accounts for that on the prediction side (a 14-case
battery carries roughly ±0.25 at p=0.5), so a small battery *widens* the flag
threshold rather than manufacturing divergence. The counts — not just the rates —
are recorded precisely so that math can run.

**Cost.** The run was intended to use subscription doors only. One metered
OpenRouter route matched the inclusion filter by substring (`claude-haiku` matched
`or-claude-haiku-45`) and billed **$0.87** against a key with a $25 daily / $60
lifetime cap. Disclosed rather than absorbed; that route's result is EXCLUDED from
the mirror, which carries subscription-door results only.

## Migration parity

None required. A shipped data file and a source constant; existing agents pick both
up with the normal version bump. No installed-file, config, hook, or template
surface.

## Testing

Registry suite (14), core (unchanged), analyzer, routes, E2E alive, migration and
job-template suites — 97 green. `tsc --noEmit` clean.

## Rollback

Delete the JSON (the loader returns to `present: false`, today's behaviour) or
revert the commit. Nothing persists; no state to unwind.
