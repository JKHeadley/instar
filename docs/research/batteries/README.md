# Instruction-Reduction Test Batteries (v1, draft)

Phase 0 of [the research plan](../instruction-reduction-research-plan.md). Written before any arm runs; **none of these has been run yet.**

| File | What it tests | Size | Pass bar |
|---|---|---|---|
| `awareness-v1.json` | Finds and uses the right capability unprompted; offers to switch on a feature that exists but is off here; invents nothing | 157 scenarios (126 on, 19 off-here offers, 12 must-not-invent) | ≥ A0, one-sided 97.5% bound, no margin |
| `safety-v1.json` | Hidden tripwires: self-stop, credential wall, Know Your Principal, Telegram ack/relay, interactive commands, destructive actions, narrated cross-agent work, authority walls | 60 scenarios | zero regressions vs A0; ≥5 runs each |
| `coherence-v1.json` (1.1.0) | Recall and self-consistency across a forced compaction | 10 scripts × 3 length/compaction positions = 30 runs, 5,600 frozen user turns | no increase in post-compaction failures |
| `work-quality-v1.json` (1.1.0) | Real tasks with known good outcomes | 40 tasks (20 real past fixes with frozen bug reports and pre-fix commits, 4 spec, 6 job, 6 operational, 4 INSTAR-Bench v2 invariance) | ≥ A0, one-sided 97.5% bound |
| `performance-v1.json` (1.1.0) | Tokens loaded, cache hits, time to first useful action, cost | 8 metrics, collected on every run | ≥40% instruction-token saving |

## Rules

- **Frozen per version.** Once an arm has run against a version, its scenarios do not change; edits go to a new version and the arms are re-run.
- **Safety stays hidden from arms.** No safety scenario text may appear in any arm's instructions, seed index, injected sections or skills; arm agents run without read access to this directory. A leaked scenario is retired and replaced (minor version bump).
- **Each scenario names the inventory blocks it tests** (`inventoryBlocks`, from `../instruction-inventory.json`), so a block a candidate drops can be traced to the scenarios that would catch it.
- **Off-here scenarios need the feature verified off** on the throwaway agent before the run; on-scenarios need it verified on.

## Prep status (2026-10-26)

Done:
- **Real token counts.** The inventory now carries tokenizer counts from Anthropic's `count_tokens` endpoint (claude-opus-5-5; Sonnet 5.5, Haiku 5.5 and Fable 5.1 give the same count). Echo's `CLAUDE.md` is **147,474 tokens**, not the ~100k the chars/4 estimate gave. The vault holds no Anthropic API key, so the counts were made with Echo's own Claude subscription sign-in (counting is free). `../inventory-src/count-tokens.mjs` regenerates `../inventory-src/token-counts.json`.
- **Coherence scripts.** Every run now has its full turn-by-turn user script (`runs[].userTurns`), built from `src/coherence.mjs`: planted facts in turns 1–20, four probes with ground truth asked before compaction, after it and at the end, a consistency question at turn 5 and the last turn, and reply-independent work turns in between. Each script names the fixture it needs.
- **Bug reports frozen.** Each of the 20 bug-fix tasks carries `bugReport` (title + body: the observed symptom and expected behaviour only, written from the fix's notes without its root cause or method), `preFixCommit` (read from the fix's commit object, because this checkout is shallow) and `fixTestFiles` (the tests to copy in after the run). Source: `src/bugreports.mjs`.
- **INSTAR-Bench v2 cases imported.** The originals live only on the Laptop, in Echo's home (`research/llm-pathway-bench/instar-bench-v2/`). The four task files the invariance tasks use, plus the scorer, are copied into `instar-bench-v2/` with sha256s and the source path in `instar-bench-v2/PROVENANCE.md`.

Still open before the first run:
- Build the coherence fixtures each script names (throwaway agent "Wren", the bench-a/bench-b pair for CO-S03, the scripted peer "Finch" for CO-S04).
- Run the bench's parity check on the four imported tasks (their prompts may have drifted from current source).
- Awareness coverage is weighted toward commonly used features; 164 features have index lines and not every one has a scenario yet. Phase 1 adds a coverage report (scenarios per inventory block).
- Session-start hook output and the system prompt are not in the inventory; PF-01 measures them per run.

## Regenerating

`node src/gen.mjs <this dir> <repo root>` rebuilds the JSON from `src/awareness.mjs`, `src/safety.mjs`, `src/coherence.mjs`, `src/bugreports.mjs`, the imported bench tasks and the inventory. Bug-fix SHAs are resolved with `git rev-parse` at build time, not typed.
