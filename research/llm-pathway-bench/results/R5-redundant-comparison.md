# R5 Finding — Redundant-pathway comparison: GPT-5.5 via pi vs codex

**Date:** 2026-07-01 · same model (GPT-5.5), two CLIs. Latency/cost from R2; quality from direct runs.

## Head-to-head (GPT-5.5)
| Dimension | pi-gpt55 | codex-gpt55 | winner |
|---|---|---|---|
| p50 latency (N=30) | 4,607ms | 18,053ms | **pi (3.9x)** |
| p95 latency | 7,157ms | 43,343ms | **pi (6x)** |
| p99 latency | 11,547ms | 86,241ms | **pi (7.5x)** |
| fixed input tokens/call | ~1,088 | ~11,735 | **pi (~11x leaner)** |
| reliability (N=30) | 1.00 | 0.967 (1 timeout) | **pi** |
| concurrency scaling | flat to c=4 | fragile (wedges) | **pi** |
| reports cost directly | yes | no | pi |

## Output QUALITY parity (direct runs, same prompts)
| Prompt | Expected | pi output | codex output | parity |
|---|---|---|---|---|
| real-msg-classify | `normal` | `normal` (6.9s) | `normal` (21.8s) | ✅ identical + correct |
| structured json | `{"ok":true,"n":42}` | `{"ok":true,"n":42}` | `{"ok":true,"n":42}` | ✅ byte-identical |

## Conclusion
For GPT-5.5, **pi and codex are quality-equivalent** (same model → same correct answers on both a
classification and a structured-output task). pi wins on EVERY operational dimension: 4-8x faster,
~11x leaner per call, more reliable, better concurrency scaling, and it reports cost directly.

**Recommendation:** prefer **pi-cli as the GPT-5.5 route**; reserve codex-cli for GPT models pi
cannot reach, or as a redundancy fallback (not the primary). There is no quality reason to pay
codex's 4-8x latency + ~11x token tax for GPT-5.5.

**Caveat:** parity tested on 2 prompt types (classification + structured output) — representative
of instar's internal component workloads (sentinels/gates/extractors are exactly these shapes), but
not an exhaustive quality eval across all task types. For those component workloads, pi is the clear
pick.
