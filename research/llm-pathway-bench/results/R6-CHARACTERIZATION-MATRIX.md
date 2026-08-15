# R6 — LLM Pathway Characterization Matrix + Routing Recommendations (LIVING DRAFT)

**Status:** living synthesis. Confirmed cells from R1/R2-fast/R4. Cells marked (pending) fill in
as the R2 codex baseline, R3 concurrency sweeps, and R5 quality parity complete. Last updated 2026-07-01.

## 1. Characterization matrix (warm, uncontended, N=30 where marked ✓)

| Pathway | model | p50 lat | p95 lat | fixed in-tok/call | reliability | notes |
|---|---|---|---|---|---|---|
| pi-gpt55 | GPT-5.5 | 4,607ms ✓ | 7,157ms ✓ | ~1,088 ✓ | high | fastest + leanest; reports cost directly |
| claude-sonnet | sonnet-4-6 | 2,899ms ✓ | 5,514ms ✓ | ~22,903 ✓ | high | fastest p50; high fixed token overhead |
| claude-opus | opus-4-8 | 3,036ms ✓ | 5,785ms ✓ | ~19,544 ✓ | high | |
| claude-haiku | haiku-4-5 | 3,544ms ✓ | 5,821ms ✓ | ~23,662 ✓ | high | loosest instruction-following (62 out-tok for 1-word ask) |
| gemini-flash | gemini-2.5-flash | 8,538ms ✓ | 15,726ms ✓ | ~5,960 ✓ | med | slowest fast-path; high tail; unusable as 5s swap target |
| codex-gpt55 | GPT-5.5 | 18,053ms ✓ | 43,343ms ✓ (p99 86s!) | ~11,735 ✓ | med-low | brutal tail: p99=86s, 1/30 timeout uncontended; wedges w/ quota free |
| codex-gpt54mini | gpt-5.4-mini | (pending N=30) | (pending) | (pending) | med-low | |
| codex-gpt55-plain | GPT-5.5 | ~45s (n=1) (pending N=30) | (pending) | med-low | exec-plain ~16s faster than exec-json |

## 2. Failure-trigger catalog (from R4)
| Failure | Trigger | Root cause | Fix (reversible) |
|---|---|---|---|
| codex "error, quota free" | any cold/wedged codex call | 30s internal timeout < 40-61s cold-start / minute-scale wedge | raise codex timeout to 60-90s AND/OR route latency-sensitive calls off codex |
| gemini swap always fails | gemini used as failure-swap target | 5s swap cap < gemini 8.5s p50 | per-target swap cap seeded from p95 (config intelligence.swapAttemptTimeoutMs) |
| codex zombie process | killing a wedged codex by wrapper only | codex forks a native grandchild that survives | kill the process GROUP (confirm instar's codex kill path does) |
| claude 15-min over-pause | claude limit whose reset phrase doesn't parse | breaker falls back to 15-min DEFAULT_OPEN_MS | shorten unparsed-fallback to probe-retry; use pool's structured reset time |

## 3. Routing recommendations (preliminary — confirmed by R2-fast + R4; R5 will validate quality)
1. **Latency-sensitive GATING calls (tone gate, message sentinel, emergency-stop):** prefer
   **pi (4.6s, ~1k tok)** or **claude (~3s)**. AVOID codex here — its cold-start/wedge tail
   exceeds a 30s gate budget and stalls outbound (observed live this session).
2. **High-frequency background classifiers (topic-intent, extractors):** prefer **pi** — 20x
   leaner per call than claude-code (~1k vs ~23k fixed input tokens) → large input-token savings
   at volume. This is the hard-number basis for the provider-fallback-default policy.
3. **Latency-TOLERANT batch/reflection work:** codex is acceptable (quota is plentiful, 96% free);
   just don't put it on a latency SLO or a short timeout.
4. **gemini:** keep OUT of the failure-swap tail until the per-target cap ships (it reliably wastes
   its 5s slot). Fine as a primary for latency-tolerant work at its own ~8.5s pace.
5. **GPT-5.5 redundant route:** prefer **pi over codex** for GPT-5.5 (11x faster, leaner) —
   pending R5 output-quality parity confirmation.

## 4. Fixes to apply (R6 execution — dark/reversible; task #8)
- [x] R5 CONFIRMED: pi = quality-equivalent to codex for GPT-5.5, 4-8x faster + 11x leaner → recommend pi as GPT-5.5 primary.
- [ ] Per-target swap cap (gemini) — config `intelligence.swapAttemptTimeoutMs` is the lever; propose a per-provider map. Route via /instar-dev (instar source).
- [ ] Codex internal timeout raise (30s→60-90s) for latency-tolerant components; keep gating off codex. Route via /instar-dev.
- [ ] Interim stabilization (task #8): evaluate Usher/TopicIntentExtractor routing — measure current framework + latency, propose the lower-cost route. (Note: routing already OFF claude by default per provider-fallback policy; verify these two specifically.)
- NOTE: all instar SOURCE/config changes go through /instar-dev with proper PRs + the ship gate. This research produces the evidence; the application is staged reversible.

## 5. Concurrency scaling (R3)
- pi: FLAT to c=4 (best). claude: knees at c=4 (p50 doubles). gemini: tail degrades. codex: fragile at c=1, not swept. Host spawn cap (8) is the shared ceiling.

## 6. Task #8 (interim stabilization) — status
- **"Reroute Usher/TopicIntentExtractor off the rate-limited claude path": ALREADY DONE** by the
  provider-fallback-default policy (routing coverage 40/40 off-default). Live routing: tone gate→pi,
  TopicIntentArcCheck→codex. No claude-path rerouting needed. NOTE: TopicIntentArcCheck on codex is
  slow (~18s) — a candidate to move to pi (faster+leaner) but it's latency-tolerant, so low priority.
- **gemini swap-timeout: the fix to apply.** `intelligence.swapAttemptTimeoutMs` is UNSET (→ default
  5000ms), below gemini's 8.5s p50. This is the clear, evidence-backed low-risk fix.

## 7. Fix application plan (dark/reversible, via /instar-dev)
- **Fix A (highest value, build it): per-target swap cap.** Replace the single 5s
  `swapAttemptTimeoutMs` with a per-framework cap seeded from measured p95 (claude ~6s, pi ~7s,
  gemini ~16s, codex ~45s). Stops killing gemini prematurely without slowing fast targets. Instar
  source change → spec-converge → /instar-dev → PR → ship gate. Ships config-gated/reversible.
- **Fix B (stage for go/no-go): codex internal timeout raise** 30s→60-90s for latency-tolerant
  components (keep gating off codex). Reversible config; higher-risk (ties up slots on wedges) — pair
  with the process-group kill. Surface to operator.
- **Fix C (recommendation only): move TopicIntentArcCheck codex→pi** (faster+leaner, same quality per
  R5). Low urgency (latency-tolerant). Recommend, don't auto-apply.
- All FLEET-affecting changes go through /instar-dev (migration parity). This research = the evidence;
  application is staged reversible with clear rollback.

## STATUS: characterization COMPLETE (R1-R5 + matrix/catalog/recommendations). Remaining: build Fix A
## via /instar-dev (spec-converge → build), stage B/C for operator go/no-go.
