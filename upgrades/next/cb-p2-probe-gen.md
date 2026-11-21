<!-- bump: patch -->
## What Changed

Second piece of the context budget's Phase 2 (shadow folding, still switched off): the quiz questions a practice fold is graded by (`src/monitoring/foldProbe.ts`).

- **Material.** The folded stretches go through the existing span sampler. Every decision and every "keep word for word" item is always included. An extra independent sample, stratified across the stretch, comes from what the sampler left out, so the quiz can catch losses nobody named.
- **Generation.** One model call (`FoldProbe`, with all inputs fenced as data), and at most one re-ask naming what is missing.
- **Validation in code.** Questions are typed. A question about a decision, a kept item or the next step is never treated as a lookup-able detail. A question citing material the generator wasn't shown is dropped. The floor of one question per finished stretch and per open thread is checked. The question ceiling comes from the `FoldProbe` budget.

No route, config key or live behaviour. Nothing calls it yet.

## What to Tell Your User

Nothing changes yet. This is more groundwork for letting long conversations shrink their working memory safely (the quiz questions for practice runs). It stays switched off until the practice runs are proven.

## Summary of New Capabilities

- None user-visible yet. Internal building block for Phase 2 shadow folding.

## Evidence

- Unit: `tests/unit/fold-probe.test.ts` (20) covers the floor always sampled, the independent sample only from excluded entries, stratified and deterministic, prompt fencing and tag stripping, retype, drops, floor gaps, the ceiling keeping floor questions, the re-ask, no-judge, error and unparseable.
- Integration: `tests/integration/fold-probe-material.test.ts` (2) runs a real transcript through the real archive. Only archived entry ids are citable, the re-read samples identically, and a floor entry survives a tiny ceiling.
