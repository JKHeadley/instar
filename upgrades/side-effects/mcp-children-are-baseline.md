# Side-effects review — mcp-children-are-baseline

**Change:** add `/\bmcp\b/i` to `BASELINE_PROCESS_PATTERNS` (`src/core/baselineProcessPatterns.ts`), and — after the second-pass review — a framework-neutral tool-shell rule (`TOOL_SHELL_PATTERN` / `isToolShellCommand`: Claude's snapshot shell OR Codex's `zsh -lc`) that is judged BEFORE the baseline list in `SessionManager.computeHasActiveProcesses` (both filters) and in `standDownDrain.drainProcessShape` (a tool shell is never an MCP root and always work). The incident's process tree, a Codex pane running `vitest … mcp-stdio.test.ts` / `grep -rn mcp src/`, and the drain shapes are pinned in `tests/unit/mcp-children-are-baseline.test.ts` (fail-first proven for both the pattern and the precedence).

**Decision point?** Yes. The list feeds `SessionManager.computeHasActiveProcesses` (idle-zombie kill, update-gate idle-job exemption), `standDownDrain` (which descendants are the resident MCP stack) and the PresenceProxy tier-3 "real work running?" filter. It produces a signal ("resident noise" vs "work") that the existing authorities consume; it holds no blocking authority of its own.

## 1. Over-block (what legitimate work could now be mislabeled as idle?)

A descendant of the pane whose command contains the standalone token `mcp` and which is NOT an MCP server. The first draft claimed a Codex tool shell "never matches the list"; the second-pass review showed that was false — Codex runs `/bin/zsh -lc '<cmd>'` with no snapshot token, so `zsh -lc 'npx vitest run tests/unit/mcp-stdio.test.ts'` or `grep -rn mcp src/` would have matched the new pattern and read as idle (ungated consumer: the `killForRecovery` veto in `SessionRecovery.ts`). Fixed in this change: a tool shell of EITHER framework is recognised by shape (`<shell> -c` / `-lc` directly under the main process) and judged before the baseline list, in the idle check and in the drain. The remaining case is a process the framework itself spawned directly under the pane with `mcp` in its name — which is an MCP server. The prompt-gated kills (idle-zombie, age) never fired on a running foreground command either way; the precedence closes the ungated veto path.

## 2. Under-block (what does this still miss?)

- An MCP server whose binary name carries no `mcp` token at all (e.g. a vendor tool configured under a custom name) still counts as work. Still true after this change; the generic token covers the convention, not every possible name.
- Descendants of an MCP server (Chromium under a browser MCP) are classified by their own command, not by their ancestor, in `computeHasActiveProcesses` — unchanged by this change.
- An MCP server configured as `"command": "bash", "args": ["-c", "source … && npx -y @foo/mcp"]` reads as a tool shell and counts as work — exactly as before this change (pre-existing, not a regression; the fix does not reach that config style).

## 3. Level-of-abstraction fit

Right layer: the one leaf module every consumer imports. Reading each session's `.mcp.json` to derive its own helper set would be more precise but adds I/O to a hot probe and a second source of truth; the naming convention is what every MCP launcher already follows.

## 4. Signal vs authority

Signal-producer only (`docs/signal-vs-authority.md`). The kill still routes through the idle-prompt check, the 240-minute threshold, ReapAuthority, the KEEP-guards and the veto backoff.

## 5. Interactions

- Stand-down drain: one more pattern is an MCP root, so the drain waits for fewer processes before closing a duplicate. Correct direction (an MCP server never exits on its own). The review found the drain had NO tool-shell precedence: a Claude or Codex shell whose text carried `mcp` would have become an "MCP root" and its subtree (vitest workers included) read `working:false`. Now a tool shell is never an MCP root and always counts as work there too.
- PresenceProxy tier-3: the filter removes baseline noise before judging "is anything real running?"; an MCP server that previously read as real work no longer does. Correct direction.
- Idle-clock-survives-restart (same day): that change persists the idle clock; this change is what lets the clock START on an agent whose conversations all run such a helper. Together they close the 2026-10-22 pile-up.
- No double-fire: the list is consulted once per probe.

## 6. External surfaces

None. No route, template, config or message changes. Behaviour visible to users: idle conversations on agents with non-"server"-named MCP helpers are now closed on the existing schedule, and resume on the next message exactly as before.

## 7. Multi-machine posture

Machine-local by design: the probe inspects the local process table of the machine running the session. No replication, no proxied read; every machine judges its own panes.

## 8. Rollback cost

Revert the one-line pattern (hot-fix release). No data migration, no state repair: nothing is written by this change.

## Second-pass review

**Round 1 (reviewer):** Concern raised — §1 claimed a Codex tool shell never matches the list; in fact `zsh -lc '… mcp …'` would match the new generic pattern in `computeHasActiveProcesses`, and `drainProcessShape` had no tool-shell precedence at all, so a shell mentioning `mcp` became an MCP root. Narrow blast radius (the kills are prompt-gated) but the `killForRecovery` veto is ungated, and the artifact stated the opposite.

**Author response:** accepted. Added `TOOL_SHELL_PATTERN` / `isToolShellCommand` (framework-neutral) with precedence in both `computeHasActiveProcesses` filters and in the drain (never an MCP root, always work); pinned Codex fixtures (vitest-with-mcp-in-path, `grep -rn mcp src/`, idle-with-only-MCP) and drain shapes; fail-first proven (2 red without the precedence). §1 and §5 corrected above.

**Round 2 (reviewer):** Concur with the review. Verified both `computeHasActiveProcesses` filters and the drain now give tool shells precedence; the `killForRecovery` veto path holds for a Codex session running an mcp-mentioning tool; the four tmux session builders pass the framework binary as argv with no `-c` wrapper between pane and main process, so the new shell pattern cannot mark every session as working; regex sanity checked (`ssh -c`, `fish -c`, `zsh -il`, bare binaries reject; `/bin/zsh -lc`, `bash -c`, `sh -c` accept). One honest pre-existing limit noted in §2.
