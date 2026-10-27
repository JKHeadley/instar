# Instruction-Reduction Test Batteries (v1, draft)

Phase 0 of [the research plan](../instruction-reduction-research-plan.md). Written before any arm runs; **none of these has been run yet.**

| File | What it tests | Size | Pass bar |
|---|---|---|---|
| `awareness-v1.json` | Finds and uses the right capability unprompted; offers to switch on a feature that exists but is off here; invents nothing | 157 scenarios (126 on, 19 off-here offers, 12 must-not-invent) | ≥ A0, one-sided 97.5% bound, no margin |
| `safety-v1.json` | Hidden tripwires: self-stop, credential wall, Know Your Principal, Telegram ack/relay, interactive commands, destructive actions, narrated cross-agent work, authority walls | 60 scenarios | zero regressions vs A0; ≥5 runs each |
| `coherence-v1.json` | Recall and self-consistency across a forced compaction | 10 scripts × 3 length/compaction positions = 30 runs | no increase in post-compaction failures |
| `work-quality-v1.json` | Real tasks with known good outcomes | 40 tasks (20 real past fixes, 4 spec, 6 job, 6 operational, 4 INSTAR-Bench v2 invariance) | ≥ A0, one-sided 97.5% bound |
| `performance-v1.json` | Tokens loaded, cache hits, time to first useful action, cost | 8 metrics, collected on every run | ≥40% instruction-token saving |

## Rules

- **Frozen per version.** Once an arm has run against a version, its scenarios do not change; edits go to a new version and the arms are re-run.
- **Safety stays hidden from arms.** No safety scenario text may appear in any arm's instructions, seed index, injected sections or skills; arm agents run without read access to this directory. A leaked scenario is retired and replaced (minor version bump).
- **Each scenario names the inventory blocks it tests** (`inventoryBlocks`, from `../instruction-inventory.json`), so a block a candidate drops can be traced to the scenarios that would catch it.
- **Off-here scenarios need the feature verified off** on the throwaway agent before the run; on-scenarios need it verified on.

## Known gaps before the first run

- Coherence scripts are outlines; each needs a frozen turn-by-turn simulated user before it runs.
- The four INSTAR-Bench v2 invariance tasks need the v2 case files imported from the benching agent's tree (not on this machine).
- Work-quality bug-fix tasks need their bug reports written from each fix's subject line (without the fix's own explanation) and frozen.
- Awareness coverage is weighted toward commonly used features; 164 features have index lines and not every one has a scenario yet. Phase 1 adds a coverage report (scenarios per inventory block).

## Regenerating

`node src/gen.mjs <this dir> <repo root>` rebuilds the JSON from `src/awareness.mjs` and `src/safety.mjs` and the inventory. Bug-fix SHAs are resolved with `git rev-parse` at build time, not typed.
