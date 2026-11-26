#!/usr/bin/env node
/** Emergency rollback for portable jobs. Stop the agent before running. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const index = args.indexOf('--state-dir');
if (index < 0 || typeof args[index + 1] !== 'string' || args.length !== 2) {
  console.error('usage: node scripts/job-portable-sync-rollback.mjs --state-dir <absolute .instar path>');
  process.exit(2);
}
const stateDir = path.resolve(args[index + 1]);
const markerFile = path.join(stateDir, 'lifeline-started-at.json');
try {
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  if (!Number.isSafeInteger(marker.pid) || marker.pid < 1) throw new Error('invalid-startup-marker');
  try { process.kill(marker.pid, 0); throw new Error('agent-still-running'); }
  catch (error) {
    if (error.code === 'ESRCH') { /* dead process; safe to continue */ }
    else throw error; // alive, permission denied, or unverifiable
  }
} catch (error) {
  if (error.code !== 'ENOENT') {
    console.error(`portable rollback refused: ${error.message}`);
    process.exit(1);
  }
}
const journalFile = path.join(stateDir, 'state', 'job-portable-import-journal.json');
let journal;
try {
  const raw = fs.readFileSync(journalFile, 'utf8');
  if (raw.length > 8 * 1024 * 1024) throw new Error('journal-oversized');
  journal = JSON.parse(raw);
  if (journal?.version !== 1 || !journal.jobs || typeof journal.jobs !== 'object') throw new Error('journal-corrupt');
} catch (error) {
  console.error(`portable rollback refused: ${error.message}`);
  process.exit(1);
}
const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'job-portable-fs.py');
let moved = 0;
let refused = 0;
for (const [slug, record] of Object.entries(journal.jobs)) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(slug)
    || !record || typeof record !== 'object'
    || !/^[a-f0-9]{64}$/.test(record.root)
    || !/^[a-f0-9]{64}$/.test(record.manifestHash)) { refused++; continue; }
  const result = spawnSync('python3', [helper, 'quarantine', stateDir,
    `jobs/schedule/${slug}.json`, `state/job-portable-quarantine/${slug}-${record.root}.json`, record.manifestHash],
  { timeout: 3000, maxBuffer: 1024 });
  let final = result;
  if ((result.error || result.status !== 0) && record.state === 'pending'
    && record.previous && /^[a-f0-9]{64}$/.test(record.previous.root)
    && /^[a-f0-9]{64}$/.test(record.previous.manifestHash)) {
    final = spawnSync('python3', [helper, 'quarantine', stateDir,
      `jobs/schedule/${slug}.json`, `state/job-portable-quarantine/${slug}-${record.previous.root}.json`,
      record.previous.manifestHash], { timeout: 3000, maxBuffer: 1024 });
  }
  if (final.error || final.status !== 0) {
    console.error(`portable rollback refused ${slug}: ${final.stderr?.toString().trim() || final.error?.message || 'helper-failed'}`);
    refused++;
  } else if (final.stdout.toString().trim() === 'moved') moved++;
}
console.log(`portable rollback: quarantined ${moved} manifest(s), refused ${refused}`);
if (refused) process.exit(1);
