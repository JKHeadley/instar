#!/usr/bin/env node
/**
 * sender-asymmetry — Phase 0 "asymmetry measurement by sender" for
 * docs/specs/context-budget-layered-summaries.md (§2, §16 item 1; check 8 of
 * docs/specs/reports/context-budget-phase0-results.md).
 *
 * READ-ONLY. For the N largest Claude Code transcripts on THIS machine (or the
 * files given with --file), streams every entry and attributes the characters
 * of its content to one class:
 *   operator   — user prompt text that is not injected by a hook or the server
 *                (Telegram/Slack relays arrive this way, so this class is the
 *                human's words plus the relay's one-line header);
 *   injected   — user-side content the harness or Instar added: hook
 *                attachments (hook_success / hook_additional_context /
 *                hook_*), isMeta user entries, compaction summaries,
 *                <local-command-*> and <system-reminder> blocks, and Instar
 *                server injections (bootstrap-file pointers, compaction
 *                resume, "[AGENT MESSAGE]" style system lines);
 *   assistantProse — assistant text blocks;
 *   thinking   — assistant thinking blocks;
 *   toolCalls  — assistant tool_use inputs (JSON-serialised);
 *   toolResults — user tool_result content.
 * Other attachments (skill listings, deferred tool deltas, environment) are
 * counted as `harnessOther`. Characters only; tokens are not estimated.
 *
 * Usage: node scripts/context-budget/sender-asymmetry.mjs [--top 3] [--file PATH ...] [--json]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const args = process.argv.slice(2);
const top = Number(args.includes('--top') ? args[args.indexOf('--top') + 1] : '3');
const given = args.flatMap((a, i) => (a === '--file' ? [args[i + 1]] : []));
const home = os.homedir();

function* walk(dir) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) { const p = path.join(dir, e.name); if (e.isDirectory()) yield* walk(p); else if (e.isFile() && e.name.endsWith('.jsonl')) yield p; }
}
let files = given;
if (!files.length) {
  const all = [];
  for (const d of fs.readdirSync(home).filter((x) => x.startsWith('.claude') && !x.endsWith('.lock'))) {
    for (const f of walk(path.join(home, d, 'projects'))) all.push({ f, size: fs.statSync(f).size });
  }
  // One per session id (follow-me copies share an id; keep the largest copy).
  const best = new Map();
  for (const x of all) { const id = path.basename(x.f); if (!best.has(id) || best.get(id).size < x.size) best.set(id, x); }
  files = [...best.values()].sort((a, b) => b.size - a.size).slice(0, top).map((x) => x.f);
}

const INJECT_PATTERNS = [
  /^\s*<local-command-/, /^\s*<command-name>/, /^\s*<system-reminder>/,
  /Your session just went through context compaction/,
  /^\s*\[IMPORTANT: Read .*bootstrap-/, /^\s*\[AGENT MESSAGE/i, /^\s*\[SYSTEM/i, /^\s*\[instar/i,
];
const len = (v) => (typeof v === 'string' ? v.length : v == null ? 0 : JSON.stringify(v).length);

async function scan(file) {
  const c = { operator: 0, injected: 0, assistantProse: 0, thinking: 0, toolCalls: 0, toolResults: 0, harnessOther: 0 };
  const seenReq = new Set();
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf-8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'attachment') {
      const a = e.attachment ?? {};
      const n = len(a.content ?? a.stdout ?? a);
      if (typeof a.type === 'string' && a.type.startsWith('hook')) c.injected += n; else c.harnessOther += n;
      continue;
    }
    if (e.type === 'user') {
      const content = e.message?.content;
      const meta = e.isMeta || e.isCompactSummary;
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
      for (const b of blocks) {
        if (b?.type === 'tool_result') { c.toolResults += len(b.content); continue; }
        const t = b?.type === 'text' ? b.text ?? '' : '';
        if (!t) { c.harnessOther += len(b); continue; }
        if (meta || INJECT_PATTERNS.some((re) => re.test(t))) c.injected += t.length; else c.operator += t.length;
      }
      continue;
    }
    if (e.type === 'assistant') {
      for (const b of e.message?.content ?? []) {
        if (b?.type === 'text') c.assistantProse += (b.text ?? '').length;
        else if (b?.type === 'thinking') c.thinking += (b.thinking ?? '').length;
        else if (b?.type === 'tool_use') c.toolCalls += len(b.input);
      }
      if (e.requestId) seenReq.add(e.requestId);
    }
  }
  const total = Object.values(c).reduce((s, v) => s + v, 0) || 1;
  const share = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, +(100 * v / total).toFixed(1)]));
  return { file: file.replace(home, '~'), bytes: fs.statSync(file).size, requests: seenReq.size, chars: c, sharePct: share };
}

const out = { machine: os.hostname(), at: new Date().toISOString(), results: [] };
for (const f of files) out.results.push(await scan(f));
console.log(JSON.stringify(out, null, args.includes('--json') ? 2 : 1));
