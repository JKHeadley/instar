#!/usr/bin/env node
/**
 * token-baseline — Phase 0 per-turn token baseline for
 * docs/specs/context-budget-layered-summaries.md (§11 metric, Maturation plan
 * graduation criterion; check 9 of docs/specs/reports/context-budget-phase0-results.md).
 *
 * READ-ONLY. Streams Claude Code transcripts under every ~/.claude*'/projects
 * directory on THIS machine. The server's TokenLedger is not used because on a
 * follow-me machine it only scans ~/.claude/projects (src/server/AgentServer.ts
 * hard-codes that root), so it misses every session run under another
 * CLAUDE_CONFIG_DIR.
 *
 * A turn = one API request: an assistant entry with message.usage, deduped by
 * requestId (else message.id); Claude Code writes one entry per content block
 * with the same input usage, so de-duplication is required (output keeps the max seen).
 *
 * Cost weights (relative to one uncached input token; Anthropic's published
 * ratios, overridable): cache read 0.1, cache write 5-minute 1.25, cache write
 * 1-hour 2.0, output 5.0. "Input-side weighted" = uncached + writes + reads;
 * "all-in weighted" adds output.
 *
 * Usage: node scripts/context-budget/token-baseline.mjs [--project-substr STR]
 *          [--min-turns 100] [--since ISO] [--json]
 *   --project-substr  only transcripts whose project dir name contains STR
 *                     (default "-home-echo--instar-agents-echo", the agent home; worktrees excluded)
 *   --since           only turns at or after this time (default: all)
 * Subagent transcripts (…/subagents/…) are excluded: they are not topic sessions.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const projectSubstr = opt('--project-substr', '-home-echo--instar-agents-echo');
const minTurns = Number(opt('--min-turns', '100'));
const since = args.includes('--since') ? Date.parse(opt('--since')) : 0;
const W = { read: Number(opt('--w-read', '0.1')), write5m: Number(opt('--w-write5m', '1.25')), write1h: Number(opt('--w-write1h', '2')), output: Number(opt('--w-output', '5')) };

const home = os.homedir();
const roots = fs.readdirSync(home).filter((d) => d.startsWith('.claude') && !d.endsWith('.lock'))
  .map((d) => path.join(home, d, 'projects')).filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });

const files = []; const seen = new Set();
for (const r of roots) for (const proj of fs.readdirSync(r)) {
  // The agent home exactly (not its worktrees, whose dir names extend it).
  if (proj !== projectSubstr && !(projectSubstr !== '-home-echo--instar-agents-echo' && proj.includes(projectSubstr))) continue;
  const dir = path.join(r, proj);
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const p = path.join(dir, f); const st = fs.statSync(p); const k = `${st.dev}:${st.ino}`;
    if (seen.has(k)) continue; seen.add(k); files.push(p);
  }
}

// The same Claude session id can exist under several config homes: a follow-me
// login switch copies the transcript, so each copy holds an overlapping prefix.
// Requests are merged per session id and de-duplicated by request key, and user
// turns by entry uuid, so a copied prefix is counted once.
const bySession = new Map();
async function scan(file) {
  const sid = path.basename(file, '.jsonl');
  if (!bySession.has(sid)) bySession.set(sid, { files: [], reqs: new Map(), users: new Set(), model: null, first: null, last: null });
  const S = bySession.get(sid); S.files.push(file.replace(home, '~'));
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf-8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const isAsst = line.includes('"usage"');
    const isUser = line.startsWith('{') && line.includes('"type":"user"');
    if (!isAsst && !isUser) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(e.timestamp ?? '') || 0;
    if (since && ts && ts < since) continue;
    if (e.type === 'user' && !e.isMeta && !e.isCompactSummary) {
      const c = e.message?.content;
      if (typeof c === 'string' || (Array.isArray(c) && !c.some((b) => b?.type === 'tool_result'))) S.users.add(e.uuid ?? `${file}:${ts}`);
      continue;
    }
    const u = e.type === 'assistant' ? e.message?.usage : null;
    if (!u) continue;
    if (e.message?.model === '<synthetic>') continue;
    const key = e.requestId ?? e.message?.id ?? e.uuid;
    // Same request written once per content block: keep one row, with the largest output count seen.
    if (S.reqs.has(key)) { const r = S.reqs.get(key); r.out = Math.max(r.out, u.output_tokens ?? 0); continue; }
    const cc = u.cache_creation ?? {};
    const w1h = cc.ephemeral_1h_input_tokens ?? 0;
    const w5m = cc.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - w1h);
    S.reqs.set(key, { in: u.input_tokens ?? 0, out: u.output_tokens ?? 0, read: u.cache_read_input_tokens ?? 0, w5m, w1h });
    S.model = e.message?.model ?? S.model;
    if (ts) { S.first = S.first === null ? ts : Math.min(S.first, ts); S.last = S.last === null ? ts : Math.max(S.last, ts); }
  }
}
function total(sid, S) {
  const t = { turns: S.reqs.size, userTurns: S.users.size, in: 0, out: 0, read: 0, w5m: 0, w1h: 0 };
  for (const r of S.reqs.values()) { t.in += r.in; t.out += r.out; t.read += r.read; t.w5m += r.w5m; t.w1h += r.w1h; }
  t.inputWeighted = t.in + W.write5m * t.w5m + W.write1h * t.w1h + W.read * t.read;
  t.allInWeighted = t.inputWeighted + W.output * t.out;
  return { sessionId: sid, file: S.files.join(' + '), copies: S.files.length, model: S.model, first: S.first, last: S.last, ...t };
}

for (const f of files) await scan(f);
const sessions = [...bySession.entries()].map(([sid, S]) => total(sid, S));
const long = sessions.filter((s) => s.turns > minTurns);
const per = (s, k) => s[k] / s.turns;
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null; };
const agg = (ss) => {
  const T = ss.reduce((a, s) => { for (const k of ['turns', 'userTurns', 'in', 'out', 'read', 'w5m', 'w1h', 'inputWeighted', 'allInWeighted']) a[k] = (a[k] ?? 0) + s[k]; return a; }, {});
  const n = T.turns || 1;
  return {
    sessions: ss.length, turns: T.turns ?? 0, userTurns: T.userTurns ?? 0,
    perTurn: {
      uncachedInput: Math.round(T.in / n), cacheRead: Math.round(T.read / n), cacheWrite5m: Math.round(T.w5m / n), cacheWrite1h: Math.round(T.w1h / n),
      output: Math.round(T.out / n), inputWeighted: Math.round(T.inputWeighted / n), allInWeighted: Math.round(T.allInWeighted / n),
    },
    medianSessionPerTurn: {
      cacheRead: Math.round(median(ss.map((s) => per(s, 'read'))) ?? 0),
      inputWeighted: Math.round(median(ss.map((s) => per(s, 'inputWeighted'))) ?? 0),
      allInWeighted: Math.round(median(ss.map((s) => per(s, 'allInWeighted'))) ?? 0),
    },
    shareOfInputWeighted: T.inputWeighted ? {
      cacheRead: +(W.read * T.read / T.inputWeighted).toFixed(3),
      cacheWrite: +((W.write5m * T.w5m + W.write1h * T.w1h) / T.inputWeighted).toFixed(3),
      uncachedInput: +(T.in / T.inputWeighted).toFixed(3),
    } : null,
  };
};
const out = {
  machine: os.hostname(), at: new Date().toISOString(), weights: W, projectFilter: projectSubstr, minTurns,
  since: since ? new Date(since).toISOString() : null,
  transcripts: files.length, distinctSessions: sessions.length, longSessions: agg(long), allSessions: agg(sessions.filter((s) => s.turns > 0)),
  long: long.sort((a, b) => b.turns - a.turns).map((s) => ({ sessionId: s.sessionId, copies: s.copies, file: s.file, model: s.model, first: s.first && new Date(s.first).toISOString(), last: s.last && new Date(s.last).toISOString(), turns: s.turns, userTurns: s.userTurns, readPerTurn: Math.round(per(s, 'read')), inputWeightedPerTurn: Math.round(per(s, 'inputWeighted')), allInWeightedPerTurn: Math.round(per(s, 'allInWeighted')) })),
};
if (args.includes('--json')) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
else {
  const { long: rows, ...head } = out;
  console.log(JSON.stringify(head, null, 2));
  for (const r of rows) console.log(`${r.turns}\t${r.userTurns}\tread/t=${r.readPerTurn}\tinW/t=${r.inputWeightedPerTurn}\tallW/t=${r.allInWeightedPerTurn}\t${r.model}\t${r.first}..${r.last}\tcopies=${r.copies}\t${r.file}`);
}
