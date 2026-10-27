# Rust in Instar — measured trial (2026-10-27)

**Question (operator, topic 131280):** many projects report large gains from moving to Rust; where would Instar gain?

**Answer in one line:** not where the time goes today. Instar's own code is a small share of CPU and memory; the measurable wins came from native *tools* (TypeScript 7) and from removing repeated work, all inside TypeScript. Two narrow places were measured for Rust; in both, a Node-only change saves as much or more without a second implementation.

## Where the time and memory actually go (Mama PC, 10 cores, 24 h ResourceLedger)

| Process | Avg CPU | Memory |
|---|---|---|
| Instar agent server | 11 % of one core | ~650 MB RSS |
| Claude Code sessions (Anthropic's binary) | up to 50 % each, peaks > 1 core | 300–400 MB each |

Waiting is dominated by model calls, network, Telegram and git. Rust cannot shorten those. Instar is ~727,000 lines of TypeScript; a rewrite would cost months and put the accumulated safety behaviour at risk for a gain users would mostly not see.

## What shipped instead (dev/test pipeline)

| Change | Before | After | PR |
|---|---|---|---|
| Type-check with TypeScript 7 (native) | 68.0 s | 15.4 s | #2405 |
| Build (emit) with TypeScript 7 | 92.9 s | 23.3 s (byte-identical `.js`) | #2405 |
| Standards measurement: memoize immutable git reads | 54.9 s, 891 git processes | 21.7 s, ~283 (identical output) | #2406 |
| Lint chain run in parallel | 153.9 s serial | 105.9 s; 67.8 s with TS 7 | #2406 (+#2405) |
| Supertest loaded only where imported | ~0.3 s setup per test file for all ~2,500 unit files | only in the ~470 that use it | #2407 |
| Event-reporter hook exits on reply | fixed 50 ms wait per tool call | ~7 ms server reply | #2408 |

## Trial 1 — the per-session Threadline MCP helper

Every Claude Code / Codex session starts its own `threadline/mcp-stdio-entry.js` (identity keys, registry auth, trust, ~9 tools).

Measured with `mcpbench.mjs` (below; median of 7, `THREADLINE_REGISTRY=false`, fresh state dir):

| | Rust probe (initialize + tools/list only) | Node helper |
|---|---|---|
| time to first reply | 3 ms | 155 ms |
| private memory (RssAnon) | 0.2 MB | 44.6 MB fresh; 17–31 MB in long-running live helpers |
| total RSS | 2.2 MB | 93.1 MB (≈48 MB is the shared, file-backed Node binary) |

Correction recorded: the "80 MB per session" first quoted counted shared file-backed pages; the private cost is 17–45 MB.

The probe is a floor: a real port carrying HTTP, TLS and Ed25519 signing would be a few MB more. So a Rust helper would save roughly **15–40 MB private memory and ~150 ms start-up per session** — at the price of a second implementation of identity, signing and registry-auth code in a second language, plus native binaries for every platform in the npm package.

**Better option (Node only, recommended):** serve the Threadline MCP tools over MCP's HTTP transport from the agent server that is already running. Sessions then reference a URL instead of starting a helper, removing **100 %** of the per-session cost (more than Rust's ~95 %) with one implementation. This is a Tier-2 change (new authenticated route, session config migration) and needs its own spec; it is queued as a proposal, not built in this run.

## Trial 2 — the per-action hook scripts

A single Bash tool call starts 12 Node hook processes (9 PreToolUse, 3 PostToolUse) plus 2 shell scripts. Claude Code runs matching hooks in parallel, so this is mostly CPU, not wall time.

Measured with `hookbench.mjs` (median of 15–20 runs, 10 ms resolution, realistic Bash payload):

| | wall | CPU |
|---|---|---|
| `/bin/true` (native process floor) | ~0 ms | ~0 ms |
| bare `node -e 0` | 20 ms | 10 ms |
| each guard hook | 30–70 ms | 20–70 ms |
| `hook-event-reporter` (posts to the server) | 180 ms | 160 ms |

Sum ≈ **0.6 CPU-seconds per Bash call**, almost all Node start-up. A per-hook Rust rewrite would duplicate every guard's logic (these are safety guards shipped to every agent). **Better option (Node only, recommended):** one dispatcher process per hook event that runs every matching guard in-process — 12 starts become 2, cutting ~0.4–0.5 CPU-s per Bash call with a single implementation. It touches every guard's packaging and Claude Code's per-hook decision merging, so it needs its own spec; queued as a proposal. The one cheap, safe fix (the reporter's fixed 50 ms wait) shipped as #2408. Node's on-disk compile cache was tried and gave no measurable gain for scripts this small.

## When Rust *would* be worth it

A CPU-bound hot path inside Instar's own process: none was found (server ≈ 11 % of a core). Revisit if one appears — e.g. a parser or scanner that profiling shows dominating the event loop — and prefer a native Node addon or an existing native tool over a rewrite.

## Method notes

- Load on the test machine swung between ~1 and ~11 on 10 cores during the day; single timings varied 2–3×. All figures above are medians of repeated runs taken at the same time as their comparison, and A/B pairs were run back-to-back.
- A first hypothesis (that the reporter hook's ~170 ms was mostly its fixed wait) was disproved by profiling: it is mostly Node start-up.

## Appendix — probe and harnesses

### `Cargo.toml`
```toml
[package]
name = "rust-mcp-probe"
version = "0.1.0"
edition = "2021"

[dependencies]
serde_json = "1"

[profile.release]
opt-level = 3
lto = true
codegen-units = 1
panic = "abort"
strip = true
```

### `rust-mcp-probe.rs`
```rust
// Measurement probe only: the minimal shape of an MCP stdio server (newline-delimited
// JSON-RPC 2.0 on stdin/stdout) answering initialize and tools/list, to measure the
// memory and start-up floor a Rust threadline helper would have.
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

fn main() {
    let tools: Vec<Value> = ["threadline_discover", "threadline_send", "threadline_history", "threadline_agents",
        "threadline_delete", "threadline_trust", "threadline_relay", "threadline_pair", "threadline_request_secret"]
        .iter()
        .map(|n| json!({"name": n, "description": "probe", "inputSchema": {"type": "object", "properties": {}}}))
        .collect();
    let stdin = io::stdin();
    let mut out = io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let Some(id) = msg.get("id").cloned() else { continue };
        let result = match msg.get("method").and_then(Value::as_str) {
            Some("initialize") => json!({"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "threadline", "version": "probe"}}),
            Some("tools/list") => json!({"tools": tools}),
            _ => json!({}),
        };
        let _ = writeln!(out, "{}", json!({"jsonrpc": "2.0", "id": id, "result": result}));
        let _ = out.flush();
    }
}
```

### `mcpbench.mjs`
```js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const [label, ...cmd] = process.argv.slice(2);
const N = 7, rows = [];
const kb = (s, k) => Number((s.match(new RegExp(`${k}:\\s+(\\d+)`)) || [])[1] || 0);
for (let i = 0; i < N; i++) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpbench-'));
  const args = cmd.map((a) => a.replace('{STATE}', state));
  const t0 = performance.now();
  const p = spawn(args[0], args.slice(1), { env: { ...process.env, THREADLINE_REGISTRY: 'false' }, stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '', tInit = 0, tList = 0;
  await new Promise((resolve) => {
    p.stdout.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n').slice(0, -1)) {
        try { const m = JSON.parse(line); if (m.id === 1 && !tInit) { tInit = performance.now() - t0; p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n'); } if (m.id === 2 && !tList) { tList = performance.now() - t0; resolve(); } } catch {}
      }
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
    });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bench', version: '0' } } }) + '\n');
    setTimeout(resolve, 15000);
  });
  await new Promise((r) => setTimeout(r, 1500)); // settle
  const st = fs.readFileSync(`/proc/${p.pid}/status`, 'utf8');
  rows.push({ tInit, tList, rss: kb(st, 'VmRSS'), anon: kb(st, 'RssAnon'), file: kb(st, 'RssFile') });
  p.kill();
}
const med = (k) => rows.map((r) => r[k]).sort((a, b) => a - b)[Math.floor(N / 2)];
console.log(`${label}: first reply ${med('tInit').toFixed(0)} ms, tools/list ${med('tList').toFixed(0)} ms, RSS ${(med('rss') / 1024).toFixed(1)} MB (private ${(med('anon') / 1024).toFixed(1)} MB, shared file-backed ${(med('file') / 1024).toFixed(1)} MB) [median of ${N}]`);
```

### `hookbench.mjs`
```js
import { spawnSync } from 'node:child_process';
const [N, ...cmd] = process.argv.slice(2);
const w = [], c = [];
for (let i = 0; i < Number(N); i++) {
  const r = spawnSync('/usr/bin/time', ['-f', 'BENCH %e %U %S', ...cmd], { input: process.env.IN ?? '', encoding: 'utf8' });
  const m = (r.stderr || '').match(/BENCH ([\d.]+) ([\d.]+) ([\d.]+)/);
  if (m) { w.push(+m[1]); c.push(+m[2] + +m[3]); }
}
const med = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log(`wall=${(med(w) * 1000).toFixed(0)}ms cpu=${(med(c) * 1000).toFixed(0)}ms (n=${w.length})`);
```
