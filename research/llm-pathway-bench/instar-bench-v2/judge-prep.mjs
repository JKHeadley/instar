#!/usr/bin/env node
// judge-prep.mjs — prepare a blind judge packet WITH planted duplicate pairs
// (spec: self-consistency probes — grade the same output twice, flag
// disagreement). Reads <run>/judge-blind.json, plants ceil(N/5) duplicates
// (capped 8) under fresh anonIds at deterministic offsets, writes:
//   judge-blind-probed.json — what the in-session judge actually reads
//   judge-probe-key.json    — duplicate map (read ONLY after judging)
// Deterministic (no RNG — offsets derived from entry count) so re-runs match.
// Usage: node judge-prep.mjs --run <stamp>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const RUN = arg('run', null);
if (!RUN) { console.error('--run required'); process.exit(4); }
const RUNDIR = join(HERE, '..', 'results', 'instar-bench-v2', RUN);
const src = join(RUNDIR, 'judge-blind.json');
if (!existsSync(src)) { console.error('no judge-blind.json for run ' + RUN); process.exit(4); }
const entries = JSON.parse(readFileSync(src, 'utf8'));
if (!entries.length) { console.log(JSON.stringify({ run: RUN, entries: 0, planted: 0, note: 'empty packet' })); process.exit(0); }

const nDup = Math.min(8, Math.ceil(entries.length / 5));
const probes = [];
for (let i = 0; i < nDup; i++) {
  // Deterministic spread across the packet.
  const srcIdx = Math.floor((i + 0.5) * entries.length / nDup);
  const dup = { ...entries[srcIdx] };
  const dupId = `P${String(i).padStart(3, '0')}`;
  probes.push({ probeId: dupId, duplicates: entries[srcIdx].anonId });
  dup.anonId = dupId;
  // Insert at a deterministic offset away from the original.
  const insertAt = (srcIdx + Math.floor(entries.length / 2) + i * 3) % (entries.length + 1);
  entries.splice(insertAt, 0, dup);
}
writeFileSync(join(RUNDIR, 'judge-blind-probed.json'), JSON.stringify(entries, null, 1));
writeFileSync(join(RUNDIR, 'judge-probe-key.json'), JSON.stringify({ run: RUN, probes }, null, 1));
console.log(JSON.stringify({ run: RUN, entries: entries.length - nDup, planted: nDup, out: 'judge-blind-probed.json' }));
