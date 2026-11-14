# Threadline MCP over local HTTP: measurements and live checks

Spec: `docs/specs/threadline-mcp-local-http.md` (acceptance criteria 2, 6 and 11).
Machine: Mac Studio (macOS 25.5, 16 cores), 2026-10-31. Claude Code 2.1.310, codex-cli 0.156.1.
Server: a throwaway agent built from this branch's `dist` (`node dist/cli.js test-as-self --keep --no-roundtrip`, port 4041), relay off, `threadline.mcpHttp.enabled: true`.

## How it was measured

`node scripts/threadline-mcp-http-measure.mjs latency --agent-home <throwaway> --runs N --server-pid <server pid>`

- **stdio (today):** the script starts `dist/threadline/mcp-stdio-entry.js` exactly as a session does, times `initialize` (connect) then `tools/list` then one `threadline_agents` call, and reads the helper's memory while it is still running: macOS physical footprint (`vmmap --summary`, the analogue of Linux `RssAnon`) and RSS (`ps`).
- **HTTP (new):** the same three calls with the MCP SDK's streamable-HTTP client against `POST /mcp/threadline` with the local secret. There is no per-session process, so the per-session memory cost is what the server grows by while all N clients are connected at once (server physical footprint before, and with every client connected, divided by N).
- First-call latency = connect + `tools/list` + first tool call, median of N.

The machine was under heavy load the whole time (`load-assess.sh`: SATURATED; other agents' test suites were running). Memory is not load-sensitive; latency is, so every run is listed.

## Results

| Run | N | stdio first call (median ms) | HTTP first call (median ms) | stdio private MB (median) | stdio RSS MB (median) | server growth per HTTP session MB |
|---|---|---|---|---|---|---|
| 1 | 9 | 164.7 | 16.9 | n/a (RSS-only run) | 96.9 | not measured |
| 2 | 9 | 580.4 | 8.4 | 59.8 | 96.3 | 8.38 |
| 3 | 15 | 292.1 | 12.1 | 60.0 | 96.4 | 5.87 |
| 4 | 15 | 371.0 | 13.1 | 59.9 | 96.4 | 0.08 |
| 5 | 15 | 1236.0 | 10.5 | 60.2 | 96.6 | -0.61 |

Summary, per session:

- **stdio helper:** about **60 MB private** (macOS physical footprint; spread 59.5–60.3 MB over 54 helpers) and about **96 MB RSS**, one process each. First reply took **165 ms** in the least-loaded run and up to 1.2 s under load.
- **HTTP path:** **no process**. The server's growth while 9–15 sessions were connected was 8.4, 5.9, 0.1 and -0.6 MB per session across runs: within the server's own garbage-collection noise, under 9 MB in every run. First reply took **8–17 ms** in every run, load or not.
- Per-request tool-server construction cost on the real server: **1.2 ms median** (`/health` → `threadline.mcpHttp.constructionMedianMs`), under the spec's 5 ms threshold, so no pre-built registration table was needed (D1).

The 2026-10-27 reference (Linux, Mama PC, `RssAnon`): 155 ms first reply, 44.6 MB private, 93.1 MB RSS. The macOS footprint figure is higher than Linux `RssAnon` because it also counts compressed memory; RSS agrees (96 vs 93 MB).

## Live checks with real clients (criteria 2 and 6)

All against the throwaway server, from a directory with no project MCP config, using the exact entries the launcher builds (`buildClaudeThreadlineHttpEntry`, `buildCodexThreadlineHttpArgs`).

| Check | Result |
|---|---|
| `claude -p` (2.1.310) with the per-agent `--mcp-config` HTTP entry calls `threadline_agents` | answered; **0** `mcp-stdio-entry` processes for this agent during the 30 s run (sampled every 0.5 s) |
| `codex exec` (0.156.1) with `mcp_servers.threadline_local` + `mcp_servers.threadline.enabled=false` calls `threadline_agents` | `threadline_local/threadline_agents (completed)`; the process tree held no `mcp-stdio-entry` (only the shared config's Playwright server) |
| Shared `~/.codex/config.toml` with a quoted `[mcp_servers."threadline"]` table | `detectCodexSharedThreadlineEntry` → `present`, so the disable is added |
| Interactive Claude Code in tmux: call, **restart the server**, call again | CALL1 and CALL2 both answered |
| Interactive Codex in tmux: call, **restart the server**, call again | CALL1 and CALL2 both answered |
| Real server boot with the flag on | `/health` → `readiness.ready: true`, URL `http://127.0.0.1:4041/mcp/threadline` |

Both frameworks recover after a server restart, so neither needs to stay on stdio under D5.
