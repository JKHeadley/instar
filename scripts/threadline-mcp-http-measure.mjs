#!/usr/bin/env node
/**
 * threadline-mcp-http-measure — evidence for docs/specs/threadline-mcp-local-http.md
 * acceptance criteria 2, 6 and 11 (recorded live checks; this script only
 * MEASURES, it never starts a model session).
 *
 * Modes:
 *   census   — list every running `mcp-stdio-entry` helper with its private
 *              memory (RssAnon, Linux /proc; RSS fallback via ps elsewhere) and
 *              the session it serves (INSTAR_SESSION_NAME from its environment,
 *              when readable). Before/after a flag flip, this is the
 *              "live helper count and summed private memory" comparison.
 *   latency  — first-call latency, stdio vs HTTP, against a running agent:
 *              (a) spawn the stdio helper exactly as a session does and time
 *                  initialize → tools/list → threadline_agents, then read its
 *                  private memory; (b) the same three calls against
 *                  POST /mcp/threadline with the local secret.
 *   health   — print the authenticated /health → threadline.mcpHttp block.
 *
 * Usage:
 *   node scripts/threadline-mcp-http-measure.mjs census
 *   node scripts/threadline-mcp-http-measure.mjs latency --agent-home ~/.instar/agents/echo [--runs 7] [--server-pid <pid>]
 *   node scripts/threadline-mcp-http-measure.mjs health  --agent-home ~/.instar/agents/echo
 *
 * The local secret and the agent token are read from the agent home and are
 * never printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const args = process.argv.slice(2);
const mode = args[0] ?? 'census';
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

function privateKb(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf-8');
    const m = /RssAnon:\s+(\d+)\s+kB/.exec(status);
    if (m) return { kb: Number(m[1]), kind: 'RssAnon' };
  } catch { /* not Linux, or the process is gone */ }
  if (process.platform === 'darwin') {
    // macOS: the kernel's physical footprint (dirty private + compressed), the
    // closest analogue of Linux RssAnon. `vmmap --summary` prints it in M/K/G.
    try {
      const out = execFileSync('vmmap', ['--summary', String(pid)], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      const m = /Physical footprint:\s+([\d.]+)([KMG])/.exec(out);
      if (m) return { kb: Number(m[1]) * ({ K: 1, M: 1024, G: 1024 * 1024 })[m[2]], kind: 'phys_footprint' };
    } catch { /* vmmap unavailable or the process is gone */ }
  }
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf-8' }).trim();
    return out ? { kb: Number(out), kind: 'RSS' } : null;
  } catch { return null; }
}

function rssKb(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf-8' }).trim();
    return out ? Number(out) : null;
  } catch { return null; }
}

function sessionOf(pid) {
  try {
    const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf-8').split('\0');
    return env.find((e) => e.startsWith('INSTAR_SESSION_NAME='))?.slice('INSTAR_SESSION_NAME='.length) ?? null;
  } catch { return null; }
}

function census() {
  let lines = [];
  try { lines = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf-8' }).split('\n'); } catch { lines = []; }
  const helpers = lines
    .map((l) => l.trim())
    .filter((l) => l.includes('mcp-stdio-entry'))
    .map((l) => { const [pid, ...rest] = l.split(/\s+/); return { pid: Number(pid), cmd: rest.join(' ') }; })
    .filter((h) => Number.isFinite(h.pid));
  let total = 0;
  const rows = helpers.map((h) => {
    const mem = privateKb(h.pid);
    if (mem) total += mem.kb;
    return { pid: h.pid, session: sessionOf(h.pid), privateMB: mem ? +(mem.kb / 1024).toFixed(1) : null, measure: mem?.kind ?? null };
  });
  console.log(JSON.stringify({ at: new Date().toISOString(), host: os.hostname(), helpers: rows.length, summedPrivateMB: +(total / 1024).toFixed(1), rows }, null, 2));
}

function readAgent(agentHome) {
  const stateDir = path.join(agentHome, '.instar');
  const config = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8'));
  const secret = fs.readFileSync(path.join(stateDir, 'state', 'local-mcp-secret'), 'utf-8').trim();
  const token = process.env.INSTAR_AUTH_TOKEN || (typeof config.authToken === 'string' ? config.authToken : '');
  return { stateDir, port: config.port ?? 4040, name: config.projectName, secret, token };
}

async function timeCalls(client) {
  const t0 = performance.now();
  await client.listTools();
  const t1 = performance.now();
  await client.callTool({ name: 'threadline_agents', arguments: {} });
  const t2 = performance.now();
  return { listToolsMs: +(t1 - t0).toFixed(1), firstCallMs: +(t2 - t1).toFixed(1) };
}

async function latency() {
  const agentHome = opt('agent-home', process.cwd());
  const runs = Number(opt('runs', '7'));
  const a = readAgent(agentHome);
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const median = (xs) => { const s = [...xs].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const stdio = []; const http = [];
  for (let i = 0; i < runs; i++) {
    const t = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(repo, 'dist', 'threadline', 'mcp-stdio-entry.js'), '--state-dir', a.stateDir, '--agent-name', a.name],
      env: { ...process.env, INSTAR_AUTH_TOKEN: a.token, INSTAR_SESSION_NAME: `measure-stdio-${i}`, THREADLINE_REGISTRY: 'false' },
      stderr: 'ignore',
    });
    const c = new Client({ name: 'measure', version: '1' });
    const start = performance.now();
    await c.connect(t);
    const connectMs = +(performance.now() - start).toFixed(1);
    const calls = await timeCalls(c);
    const mem = t.pid ? privateKb(t.pid) : null;
    const rss = t.pid ? rssKb(t.pid) : null;
    stdio.push({ connectMs, ...calls, privateMB: mem ? +(mem.kb / 1024).toFixed(1) : null, rssMB: rss ? +(rss / 1024).toFixed(1) : null, measure: mem?.kind ?? null });
    await c.close();
  }
  // HTTP path: no per-session process exists. The honest per-session cost is
  // what the SERVER grows by while `runs` sessions are connected at once, so
  // read the server's footprint before and with all clients connected.
  const serverPid = Number(opt('server-pid', '0')) || null;
  const serverBefore = serverPid ? privateKb(serverPid) : null;
  const held = [];
  for (let i = 0; i < runs; i++) {
    const t = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${a.port}/mcp/threadline`), {
      requestInit: { headers: { Authorization: `Bearer ${a.secret}`, 'X-Instar-Session': `measure-http-${i}`, 'X-Instar-AgentId': a.name } },
    });
    const c = new Client({ name: 'measure', version: '1' });
    const start = performance.now();
    await c.connect(t);
    const connectMs = +(performance.now() - start).toFixed(1);
    http.push({ connectMs, ...(await timeCalls(c)), privateMB: 0 });
    held.push(c);
  }
  const serverWith = serverPid ? privateKb(serverPid) : null;
  for (const c of held) await c.close();
  const summary = (rows) => ({
    runs: rows.length,
    medianConnectMs: median(rows.map((r) => r.connectMs)),
    medianFirstCallMs: median(rows.map((r) => r.connectMs + r.listToolsMs + r.firstCallMs)),
    medianPrivateMB: rows.some((r) => r.privateMB === null) ? null : median(rows.map((r) => r.privateMB)),
  });
  const server = serverBefore && serverWith ? {
    pid: serverPid, measure: serverBefore.kind,
    beforeMB: +(serverBefore.kb / 1024).toFixed(1), withClientsMB: +(serverWith.kb / 1024).toFixed(1),
    perSessionMB: +((serverWith.kb - serverBefore.kb) / 1024 / runs).toFixed(2),
  } : null;
  console.log(JSON.stringify({ at: new Date().toISOString(), host: os.hostname(), stdio: { ...summary(stdio), medianRssMB: median(stdio.map((r) => r.rssMB ?? 0)) }, http: summary(http), httpServerGrowth: server, raw: { stdio, http } }, null, 2));
}

async function health() {
  const a = readAgent(opt('agent-home', process.cwd()));
  const res = await fetch(`http://127.0.0.1:${a.port}/health`, { headers: { Authorization: `Bearer ${a.token}` } });
  const body = await res.json();
  console.log(JSON.stringify(body?.threadline?.mcpHttp ?? { error: 'no threadline.mcpHttp block', status: res.status }, null, 2));
}

const run = { census: async () => census(), latency, health }[mode];
if (!run) {
  console.error(`unknown mode "${mode}" (census | latency | health)`);
  process.exit(2);
}
run().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
