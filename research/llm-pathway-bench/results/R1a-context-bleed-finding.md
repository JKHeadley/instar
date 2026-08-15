# R1a Finding — CLAUDE.md context bleed (RESOLVED)

**Date:** 2026-07-01 · **Pathway:** claude-code (all claude tiers) · **Model tested:** claude-haiku-4-5

## Symptom
A one-word "PONG" prompt through the benchmark harness reported ~83,000 input tokens
and could exceed 120s wall-clock — measuring "pathway + echo's whole project baggage"
rather than the pathway.

## Root cause
`claude -p` loads the project `CLAUDE.md` as memory context based on the working
directory. The harness spawned claude from the repo root (a very large CLAUDE.md), so
every call ingested the full project profile.

## Measurements (claude-haiku, one-word prompt, --output-format json)
| Variant | total input tokens | raw (non-cached) in | wall / API |
|---|---|---|---|
| Repo root, NO isolation (old harness) | ~83,000 | — | >120s (timed out) |
| Clean temp CWD | 23,566 | 10 | ~9s |
| Clean CWD + strict-mcp + exclude-dynamic + setting-sources user | 23,370 | 10 | ~9s |
| **instar production exact** (repo cwd + `--setting-sources user` + `--max-turns 1`) | 27,900 | 10 | ~2s API |
| **Fixed harness (CLEAN_CWD + `--setting-sources user`)** — verified via harness | 23,665 | — | 10.7s wall |

## Conclusions
1. **instar's production internal claude calls are NOT affected.** `ClaudeCliIntelligenceProvider`
   already passes `--setting-sources user`, which prevents the CLAUDE.md memory load even
   from the repo cwd (~27.9k, ~2s API). No production bug here.
2. The 83k bleed was a **harness artifact** — the harness lacked `--setting-sources user`
   and ran from the repo root.
3. **Fix applied (two independent guards):** the harness now (a) always spawns from a
   clean temp CWD, and (b) passes `--setting-sources user` + `--max-turns 1` to mirror
   production exactly.
4. **Residual ~23k input is inherent** to the claude-code pathway — it is the Claude Code
   harness's own built-in system prompt (tool defs etc.), almost entirely `cache_read`
   (cheap, amortized). The actual prompt is only ~10 non-cached tokens.
5. **Characterization value / guard-rail:** any code path that spawns `claude -p` from a
   repo root WITHOUT `--setting-sources user` pays ~3x the input tokens AND ~60x the
   wall-clock. This is a real cost cliff worth a lint/guard for future callsites.
6. **Cold-start dominates short calls:** ~8s of the 10.7s wall is claude-code CLI startup,
   not API time (~2s). Relevant when comparing pathway latency for tiny prompts.
