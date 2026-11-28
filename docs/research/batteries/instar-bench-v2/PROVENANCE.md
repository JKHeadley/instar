# INSTAR-Bench v2 case files (imported copy)

These are the four INSTAR-Bench v2 task files that the work-quality battery's invariance tasks (WQ-037 to WQ-040) run, plus the bench's scoring scripts.

**Where the originals live:** Echo's home on the **Laptop** (machine `m_cc2ec651…`, Tailscale `100.94.220.125`), in `/Users/justin/.instar/agents/echo/research/llm-pathway-bench/instar-bench-v2/`. This research tree is not part of the instar repository and exists on no other machine checked (Mac Studio: absent). Fetched 2026-10-26 through the Laptop Echo server's file route (`GET /api/files/download`), byte for byte, and checked for credentials before committing (none found).

| Work-quality task | Gate under test | Bench task file | Component (as recorded in the file) | Cases |
|---|---|---|---|---|
| WQ-037 | tone gate (B1–B7 + walls) | `tasks/tone-gate.json` + `tasks/tone-gate.template.txt` | MessagingToneGate | 14 |
| WQ-038 | message sentinel (emergency stop) | `tasks/sentinel-classify.json` | MessageSentinel | 15 |
| WQ-039 | correction classifier | `tasks/correction-distiller.json` | CorrectionCaptureLoop (`correction-learning`) | 8 |
| WQ-040 | coherence reviewer | `tasks/gate-triage.json` | CoherenceReviewer / GateReviewer | 9 |

The mapping follows `src/data/llmBenchCoverage.ts` (`MessagingToneGate → tone-gate`, `MessageSentinel → sentinel-classify`, `correction-learning → correction-distiller`, `CoherenceReviewer → gate-triage`).

`score2.mjs` is the bench's case scorer (`scoreCase`) and `aggregate.mjs` its pass-rate roll-up. The runner (`run2.mjs`) is not copied: it depends on the bench's model matrix and route discovery, which the invariance tasks do not need (they run each gate's prompt the way the agent under each arm calls it, then score with `score2.mjs`). `aggregate.mjs` expects a `results/instar-bench-v2/<stamp>/raw.jsonl` layout beside it; adjust the path when running from here.

**Not re-checked:** whether each task's prompt still matches the current source line it cites (the bench's `parity-check.mjs` does that and lives only on the Laptop). `docs/audits/llm-decision-accountability.md` notes some batteries cite drifted lines. Run a parity check before the first invariance run; a drifted task is refreshed from source under a new battery version, not edited here.

## sha256 of the imported files

```
bf735db9426998b2a7c7e102bb55a99039f23dcdb4f23bcd5a31ffab917ce2d8  tasks/correction-distiller.json
7722f5b1030f2c534f9027b0c21aa2e57ef4674816030c62deaa8c990ab6b839  tasks/gate-triage.json
514335fd90521b5e61d0ae41cca80f90c497032dc861a703d6eff4ed33eda50e  tasks/sentinel-classify.json
ecb4954a922055a1f006ebb2a754051c182403bba0f94e9356e2abd6ee0c828c  tasks/tone-gate.json
c0cb475b70ca105c8169b044bb28c1727ad70ec7b505ddf9ad261b49c3cca764  tasks/tone-gate.template.txt
f57e57db389b2dde214ebaab2463c1296a4105a7eea4366c49dab03f7ea193e0  aggregate.mjs
3f545a6429d75cfb141f1ac17213018ab3e16d87140d15d64caced61659dfbe0  score2.mjs
```
