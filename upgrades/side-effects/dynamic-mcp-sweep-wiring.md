# Side-effects review — dynamic-MCP idle-offload sweep wiring

**Change:** Wire McpIdleOffloadSweep into AgentServer on a timer so the automatic
idle-offload actually runs. Two edits:
- `src/server/AgentServer.ts`: build the sweep with real deps (heavy-live-proc
  listing via the reaper deps + resolveOwningSession; session→topic via
  getTopicForSession; signature→server via the reverse map; mid-tool-use via the
  live pane frame; requestOffload via the gated driver) and tick it on an
  `.unref()`'d interval; clear it in `stop()`.
- `src/core/dynamicMcpConfig.ts`: add the `sweep` config block type.

## 1. Blast radius
Dark + dryRun-first. The sweep timer is created ONLY when BOTH
`sessions.dynamicMcp.enabled` AND `sessions.dynamicMcp.sweep.enabled` are true; and
`sweep.dryRun` defaults true, so even then it only LOGS "would offload". Construction
is wrapped (a fault ⇒ no sweep, never a broken boot). The e2e boot is unaffected
(verified — no sweep config ⇒ no timer).

## 2. Reversibility
Fully reversible — remove the block + the config type. The timer is `.unref()`'d and
cleared on stop, so it never holds the event loop or leaks across a restart.

## 3. State / data touched
Read-only at the host level (ps + tmux pane map + pane capture). When NOT dryRun and
a server is eligible, it calls the gated `requestOffload`, which is the SAME path an
explicit request uses (loaded-set state write + restart + capture-then-reap).

## 4. Failure modes
Fail-closed throughout: a busy/unknown mid-tool-use resets the idle clock; an
unmapped server or non-topic session is skipped; a thrown tick is swallowed; the
timer never keeps the process alive. The sweep adds NO new destructive path — it only
DECIDES and delegates to the authorization-gated driver (which itself aborts on
mid-tool-use, requires authorization, and reaps only captured pids).

## 5. Security / authority
No new authority. An idle-offload it triggers on a non-preapproved session returns
needs-approval (no silent restart) exactly like an explicit request. dryRun (default)
takes no action at all.

## 6. Framework generality
The timer/sweep are framework-neutral; the mid-tool-use probe is framework-aware.

## 7. Tests
The sweep orchestration has 9 unit tests (committed prior). This wiring is verified
by the e2e AgentServer boot remaining green (no sweep config ⇒ no timer ⇒ unchanged),
and tsc clean. A live run is part of the operator live-channel proof (the gate).
