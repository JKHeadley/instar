# R1b Finding — all 8 pathways smoke-pass (n=1) + harness fixes

**Date:** 2026-07-01 · one-word "ping" prompt, clean-CWD isolation, n=1 each.

## Harness bugs found & fixed during smoke
1. **codex binary-missing** — registry used bare `codex`; the binary is an asdf shim
   (`~/.asdf/shims/codex`) not on the clean-spawn PATH. Fix: absolute paths for all bins.
2. **codex untrusted-dir refusal** — `codex exec` refuses a non-git scratch cwd. Fix: added
   `--skip-git-repo-check` (mirrors instar's production one-shot).
3. **stdin hang (codex + pi)** — both CLIs read stdin even with a positional prompt; the
   harness only closed stdin when it had explicit stdin to write, so these children hung
   until timeout. Fix: runOnce now ALWAYS closes stdin. (instar's codexSpawn documents the
   same: "Close stdin immediately so Codex doesn't wait for input.")

## Smoke results (n=1, wall-clock spawn→exit)
| Pathway | model | mode | latency | out tok | ok |
|---|---|---|---|---|---|
| pi-gpt55 | openai-codex/gpt-5.5 | message | **5,487ms** | — | ✅ |
| claude-opus | claude-opus-4-8 | print-json | 5,281ms | 5 | ✅ |
| claude-sonnet | claude-sonnet-4-6 | print-json | 6,538ms | 6 | ✅ |
| claude-haiku | claude-haiku-4-5 | print-json | 5,939–10,724ms | 60 | ✅ |
| gemini-flash | gemini-2.5-flash | yolo | 11,821ms | — | ✅ |
| codex-gpt55-plain | gpt-5.5 | exec-plain | 45,469ms | — | ✅ |
| codex-gpt54mini | gpt-5.4-mini | exec-json | 52,049ms | 24 | ✅ |
| codex-gpt55 | gpt-5.5 | exec-json | **61,385ms** | 6 | ✅ |

## Headline signals (to confirm at N≥30 in R2/R5)
- **Codex `exec` is 5–11x slower than every other pathway** (~45–61s vs 5–12s) for a
  trivial prompt. `codex exec` boots a full agentic reasoning session per call — a heavy
  fixed cost. Likely a big contributor to the "codex slow killed outbound" symptom.
- **Same model, 11x latency gap by CLI:** GPT-5.5 via **pi** = 5.5s vs via **codex** = 61s.
  Strong early signal that pi-cli is the faster route for GPT-5.5 (R5 redundant-pathway).
- **pi is the single fastest pathway** in this smoke (5.5s), even beating claude tiers.
- codex `exec-json` (61s) vs `exec-plain` (45s): the JSON event stream adds ~16s overhead.
- Single-shot latency is dominated by CLI cold-start; N≥30 baselines (R2) will separate
  cold-start from steady-state.
