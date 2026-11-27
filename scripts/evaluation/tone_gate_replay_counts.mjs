#!/usr/bin/env node
// Benchmark Milestone 1, step 1: count the tone-gate decisions in this machine's
// local judgment provenance log that are captured, replayable and exact.
// Read-only. Prints counts and refusal codes only, never message text.
// `captured` is a lower bound: a row the 64 KB clamp cut is counted only when the
// capture version survives in its 8 KB head, and a skeleton row never is.
//
// Usage: node scripts/evaluation/tone_gate_replay_counts.mjs [--dir <state/judgment-provenance>] [--days N]
// Needs a built dist (it imports assessToneGateReplayEligibility from dist/).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = path.resolve(arg('--dir', path.join(process.cwd(), '.instar', 'state', 'judgment-provenance')));
const days = Number(arg('--days', '14'));
if (!Number.isFinite(days) || days <= 0) {
  console.error('tone_gate_replay_counts: --days must be a positive number');
  process.exit(2);
}

const { assessToneGateReplayEligibility } = await import(
  pathToFileURL(path.join(ROOT, 'dist', 'core', 'MessagingToneGate.js')).href
);

/** The gate's verdict as the model gave it, read from the row's served response head. */
function verdictFromRow(row) {
  let ctx;
  try {
    ctx = typeof row.contextRedacted === 'string' ? JSON.parse(row.contextRedacted) : row.contextRedacted;
  } catch {
    return { verdict: 'unreadable' };
  }
  const head = ctx && typeof ctx.rawResponseHead === 'string' ? ctx.rawResponseHead : '';
  const m = head.match(/"pass"\s*:\s*(true|false)/);
  if (!m) return { verdict: 'unreadable' };
  const rule = head.match(/"rule"\s*:\s*"([A-Z0-9_]*)"/)?.[1] ?? '';
  return { verdict: m[1] === 'true' ? 'PASS' : 'BLOCK', rule };
}

const counts = { rows: 0, captured: 0, replayable: 0, exact: 0, refused: {}, verdicts: {} };
const since = Date.now() - days * 86_400_000;
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) : [];
for (const f of files) {
  for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.kind !== 'decision' || row.decisionPoint !== 'messaging-tone-gate') continue;
    if (Date.parse(row.ts) < since) continue;
    counts.rows++;
    const v = verdictFromRow(row);
    counts.verdicts[v.verdict] = (counts.verdicts[v.verdict] ?? 0) + 1;
    const full = row.contextFull;
    // Captured = the row carries a replay capture, including one the 64 KB clamp cut
    // (its head still names the capture version).
    if (full && typeof full === 'object'
      && (full.captureVersion !== undefined
        || (full.truncated === true && String(full.head ?? '').includes('tone-replay-input-v1')))) counts.captured++;
    const e = assessToneGateReplayEligibility(full);
    if (e.eligible) {
      counts.replayable++;
      if (e.exact) counts.exact++;
    } else {
      counts.refused[e.reason] = (counts.refused[e.reason] ?? 0) + 1;
    }
  }
}
console.log(JSON.stringify({ dir, days, files: files.length, ...counts }, null, 2));
