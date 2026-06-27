# Side-effects review — dynamic-MCP real offload primitives (capture-then-reap)

**Change:** Complete the offload path (elevated from follow-up to required by the
operator's full-lifecycle directive). Two edits:
- `src/core/mcpPidCapture.ts` (new, pure): `captureHeavyMcpPidsForSession` — given the
  live MCP process scan + process tree + tmux pane map, returns the heavy MCP child
  PIDs belonging to a specific session AND server. Conservative: unknown/non-heavy
  server or unresolvable session ⇒ no pid.
- `src/server/AgentServer.ts`: replace the three conservative offload stubs in the
  DynamicMcpService construction with REAL primitives — `captureHeavyPids` (reaper
  ps-listing + the pure capture), `reapPids` (the reaper's `killProcess`), and
  `isMidToolUse` (live pane frame + `looksActivelyWorking`).

## 1. Blast radius
Dark by default (`sessions.dynamicMcp.enabled`); when off, the service is built but
its methods are never invoked (the routes 503). When ON, the offload path can now
actually drop a server + reap its orphaned heavy process. Service construction stays
fail-safe (a throw ⇒ null ⇒ routes 503), and the e2e boot is unaffected (verified).

## 2. Reversibility
Reversible — revert the stubs. No persisted state beyond the existing loaded-set file.

## 3. State / data touched
`captureHeavyPids` READS the process table (ps) + tmux pane map (read-only).
`reapPids` sends SIGTERM/SIGKILL to the captured PIDs (the reaper's audited
`killProcess`). No new files; the reaper audit path is reused.

## 4. Failure modes — THE destructive-authority review
`reapPids` is the only destructive op. It is tightly bounded: it kills ONLY the PIDs
`captureHeavyPids` returned, which are ONLY procs that (a) match a HEAVY MCP signature
mapped from the offloaded server name, AND (b) resolve via the ppid-walk to the EXACT
target session. An unknown/non-heavy server captures nothing; an orphan or
wrong-session proc captures nothing — so the worst case is "reap nothing" (a missed
reclaim the generic reaper still backstops), never "kill the wrong process". The kill
only runs AFTER an authorized offload's restart is CONFIRMED (the old session is gone),
and the offload aborts entirely if the session is — or might be — mid-tool-use. Every
step is fail-safe (capture ⇒ [] on any error; reap ⇒ best-effort per-pid try/catch;
mid-tool-use ⇒ null ⇒ abort on any uncertainty).

## 5. Security / authority
No new authority surface — the change only makes the already-gated offload actually
reclaim. The kill is gated behind: feature enabled + an authorized offload (live
preapproval or operator nonce) + a confirmed restart + not-mid-tool-use. The agent
cannot trigger an unauthorized kill.

## 6. Framework generality
The MCP-server processes are framework-agnostic (a Chromium is a Chromium); the
mid-tool-use probe passes the session's framework to `looksActivelyWorking` (which is
framework-aware). The capture/reap is claude-code-relevant in practice (only
claude-code sessions get a trimmed/dynamic MCP set), but the pid-capture itself is not
Claude-specific.

## 7. Tests
7 unit tests for the pure capture (target-session-only, unknown/light server ⇒ none,
wrong-session ⇒ none, orphan ⇒ none, multiple pids, the conservative server→signature
map). The e2e AgentServer boot + the routes integration remain green with the new
wiring. tsc clean.
