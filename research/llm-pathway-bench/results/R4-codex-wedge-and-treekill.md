# R4 Finding — codex `exec` wedges for minutes + spawns a survivor process (+ harness fix)

**Date:** 2026-07-01 · surfaced while running the R2 codex baseline.

## Observation
- The 2nd call of a codex `exec --json` baseline sequence WEDGED for 5+ minutes (the 1st
  completed in 18s). Codex's latency is not just high (R1b), it has a heavy, unpredictable
  TAIL — a call can hang for minutes with no output.
- `codex exec` forks a NATIVE vendor grandchild (`@openai/codex-darwin-arm64/.../bin/codex`)
  under the node wrapper. Killing only the wrapper ORPHANS the grandchild, which keeps
  running and holds the stdout pipe open.
- Concurrently, instar's OWN codex intelligence calls (`instar-codex-intel-scratch-*`,
  `project_doc_max_bytes=0`) were running — real contention between the benchmark and the
  agent's live sentinels/gates on the same codex account.

## Why it matters (characterization)
- Codex's minute-scale tail + wedge risk is a strong candidate for the "codex slow killed
  outbound" symptom: an outbound gate routed through codex can stall for minutes on a wedged
  call, not just be "a bit slow". Combined with the R4 gemini finding, the failover tail
  (codex → … → gemini) can burn large fixed time before falling closed.
- The surviving-grandchild behavior means any caller that kills a codex call by killing the
  wrapper leaks a process — worth checking instar's own codex timeout/kill path handles the
  tree (instar's codexSpawn uses spawn; confirm it kills the group on timeout — follow-up).

## Harness bug fixed (was masking the data)
- The harness SIGKILLed only the direct child on timeout, so a wedged codex call orphaned its
  grandchild and the harness hung FOREVER (never recorded the timeout, never advanced). Fix:
  spawn `detached:true` (child = process-group leader) and kill the whole group
  (`process.kill(-pid)`) on timeout, plus a 2s grace force-settle. Verified: a forced 4s
  timeout on codex now records `timeout` and advances in ~5s, leaving ZERO orphaned processes.
