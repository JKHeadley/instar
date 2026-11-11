#!/usr/bin/env node
/**
 * scan-compaction-paths — Phase 0 measurement for
 * docs/specs/context-budget-layered-summaries.md (§16 item 1, checks 1 and 6 of
 * docs/specs/reports/context-budget-phase0-results.md).
 *
 * READ-ONLY. Streams every Claude Code transcript (`*.jsonl`) under every
 * `~/.claude*`/projects directory on THIS machine and counts, per transcript:
 *   - compact_boundary entries (type=system, subtype=compact_boundary);
 *   - SessionStart:compact hook_success attachments, and those whose output
 *     carries Instar's recovery marker line from session-start.sh (the same
 *     test as src/monitoring/compactionCanary.ts);
 *   - server-side recovery injections: user entries whose text (never a
 *     tool_result) carries the CompactionSentinel / recoverCompactedSession
 *     preamble from src/messaging/shared/compactionResumePayload.ts.
 * Entries are de-duplicated by uuid across files (follow-me copies).
 * Each boundary is then classified by what followed it before the next
 * boundary in the same file: hook block, server inject, both, or neither.
 *
 * Usage: node scripts/context-budget/scan-compaction-paths.mjs [--since ISO] [--json]
 *   --since  only boundaries at or after this time feed the "since" table
 *            (default 2026-11-10T05:57:38Z, when the 9.1 fix merged as #3014).
 * Writes nothing. Prints a summary (or JSON with --json).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const RECOVERY_MARKER = '=== IDENTITY RECOVERY (post-compaction) ===';
const SERVER_MARKER = 'Your session just went through context compaction';

const args = process.argv.slice(2);
const sinceArg = args.includes('--since') ? args[args.indexOf('--since') + 1] : '2026-11-10T05:57:38Z';
const since = Date.parse(sinceArg);
const asJson = args.includes('--json');

function roots() {
  const home = os.homedir();
  return fs.readdirSync(home)
    .filter((d) => d.startsWith('.claude') && !d.endsWith('.lock'))
    .map((d) => path.join(home, d, 'projects'))
    .filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
}

function* walk(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}

function userText(entry) {
  const c = entry?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    if (c.some((b) => b && b.type === 'tool_result')) return '';
    return c.filter((b) => b && b.type === 'text').map((b) => b.text ?? '').join('\n');
  }
  return '';
}

// A follow-me login switch copies a transcript into another config home, so the
// same entries (same uuid) can appear in several files: each entry counts once.
const seenEntries = new Set();
async function scanFile(file) {
  const r = { file, boundaries: [], ssCompact: 0, ssCompactRecovery: 0, serverInjects: 0 };
  let cur = null;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf-8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    // Cheap prefilter: skip lines that cannot match any class.
    if (!line.includes('compact_boundary') && !line.includes('SessionStart:compact') && !line.includes(SERVER_MARKER)) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (typeof e.uuid === 'string') {
      if (seenEntries.has(e.uuid)) { if (e.subtype === 'compact_boundary') cur = null; continue; }
      seenEntries.add(e.uuid);
    }
    if (e.type === 'system' && e.subtype === 'compact_boundary') {
      cur = { at: Date.parse(e.timestamp ?? '') || null, trigger: e.compactMetadata?.trigger ?? 'unknown', hook: false, server: false };
      r.boundaries.push(cur);
      continue;
    }
    const a = e.attachment;
    if (e.type === 'attachment' && a && a.type === 'hook_success' && a.hookName === 'SessionStart:compact') {
      r.ssCompact++;
      const out = typeof a.stdout === 'string' ? a.stdout : typeof a.content === 'string' ? a.content : '';
      if (typeof a.command === 'string' && a.command.includes('session-start.sh') && out.split(/\r?\n/).some((ln) => ln.trim() === RECOVERY_MARKER)) {
        r.ssCompactRecovery++;
        if (cur) cur.hook = true;
      }
      continue;
    }
    if (e.type === 'user' && userText(e).includes(SERVER_MARKER)) {
      r.serverInjects++;
      if (cur) cur.server = true;
    }
  }
  return r;
}

const seen = new Set();
const files = [];
for (const root of roots()) {
  for (const f of walk(root)) {
    const st = fs.statSync(f);
    const key = `${st.dev}:${st.ino}`;
    if (seen.has(key)) continue; // same file reached twice (links)
    seen.add(key);
    files.push(f);
  }
}

const results = [];
for (const f of files) {
  try { results.push(await scanFile(f)); } catch (err) { results.push({ file: f, error: String(err) }); }
}

function classify(bs) {
  const c = { boundaries: bs.length, hookOnly: 0, serverOnly: 0, both: 0, neither: 0, auto: 0, manual: 0 };
  for (const b of bs) {
    if (b.hook && b.server) c.both++; else if (b.hook) c.hookOnly++; else if (b.server) c.serverOnly++; else c.neither++;
    if (b.trigger === 'auto') c.auto++; else if (b.trigger === 'manual') c.manual++;
  }
  return c;
}

const all = results.filter((r) => !r.error);
const allB = all.flatMap((r) => r.boundaries);
const sinceB = allB.filter((b) => b.at !== null && b.at >= since);
const withB = all.filter((r) => r.boundaries.length > 0);
const summary = {
  machine: os.hostname(),
  scannedAt: new Date().toISOString(),
  roots: roots(),
  transcripts: files.length,
  unreadable: results.filter((r) => r.error).length,
  transcriptsWithBoundary: withB.length,
  totals: {
    compactBoundaries: allB.length,
    ssCompactAttachments: all.reduce((s, r) => s + r.ssCompact, 0),
    ssCompactWithRecoveryBlock: all.reduce((s, r) => s + r.ssCompactRecovery, 0),
    serverInjects: all.reduce((s, r) => s + r.serverInjects, 0),
  },
  allBoundaries: classify(allB),
  since: { since: new Date(since).toISOString(), ...classify(sinceB) },
  firstRecoveryBlockBoundaryAt: (() => { const t = allB.filter((b) => b.hook && b.at).map((b) => b.at).sort((x, y) => x - y)[0]; return t ? new Date(t).toISOString() : null; })(),
  perTranscript: withB.map((r) => ({
    file: r.file.replace(os.homedir(), '~'),
    subagent: r.file.includes(`${path.sep}subagents${path.sep}`),
    ssCompact: r.ssCompact, ssCompactRecovery: r.ssCompactRecovery, serverInjects: r.serverInjects,
    ...classify(r.boundaries),
    sinceBoundaries: r.boundaries.filter((b) => b.at !== null && b.at >= since).length,
    lastBoundaryAt: (() => { const t = r.boundaries.map((b) => b.at).filter(Boolean).sort((x, y) => y - x)[0]; return t ? new Date(t).toISOString() : null; })(),
  })),
};

if (asJson) { process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`); }
else {
  const { perTranscript, ...head } = summary;
  console.log(JSON.stringify(head, null, 2));
  for (const t of perTranscript) console.log(`${t.boundaries}\t${t.hookOnly}/${t.serverOnly}/${t.both}/${t.neither}\tsince=${t.sinceBoundaries}\tss=${t.ssCompact}/${t.ssCompactRecovery}\tsrv=${t.serverInjects}\t${t.lastBoundaryAt}\t${t.file}`);
}
