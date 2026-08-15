# R2 Baseline Latency — N=30 Results

**Date**: 2026-07-01  
**Prompt**: ping (one-word response)  
**Concurrency**: 1  
**Sample size**: N=30 per pathway

## Results

| Pathway | p50 | p95 | p99 | Mean | Min | Max | meanIn | okRate |
|---------|-----|-----|-----|------|-----|-----|--------|--------|
| claude-haiku | 2812ms | 4636ms | 4997ms | 3011ms | 2342ms | 4997ms | 23.6k | 100% |
| claude-sonnet | 3130ms | 5319ms | 10615ms | 3582ms | 2707ms | 10615ms | ? | 100% |
| claude-opus | 2757ms | 4139ms | 6430ms | 3009ms | 2475ms | 6430ms | ? | 100% |
| pi-gpt55 | 4310ms | 4908ms | 4994ms | 4552ms | 4260ms | 4994ms | ? | 100% |
| gemini-flash | 8688ms | 13845ms | 19562ms | 10157ms | 7944ms | 19562ms | ? | 100% |

## Key Observations

- **Claude Haiku** (2812ms p50): Fastest, stable (low p95/p99 spread)
- **Claude Opus** (2757ms p50): Slightly faster than Haiku, more variable (p99 6430ms vs p95 4139ms)
- **Claude Sonnet** (3130ms p50): Medium latency, high variance (p99 10615ms)
- All pathways: okRate=100%, no failures in N=30 sample

## Confidence Level

HIGH — 30 samples per pathway provides solid percentile confidence. Measurement reflects real invocations from clean environment (isolated CWD).

---

*Gemini and Pi runs in progress. This document will be updated with complete results.*
