#!/usr/bin/env node
/**
 * lint-journal-actuation-ban — COHERENCE-JOURNAL-SPEC §3.9 structural guard.
 *
 * The journal is SIGNAL, never AUTHORITY: replicated journal data is stale by
 * construction (heartbeat-cadenced), and an actuator that trusted a replica's
 * "session closed" could kill or double-place against reality — the journal
 * would CAUSE the duplicate-session incidents it exists to diagnose.
 *
 * Enforcement: no ACTUATOR module (kill / spawn / place / transfer / reap
 * surfaces) may import the journal READER. The reader is deliberately a
 * separate module from the writer so this ban has a precise import target —
 * actuators MAY hold the writer (they emit), they may never read.
 *
 * Guardrail, not proof (a consumer could re-read the JSONL by hand); the
 * declared §3.9 duty is the authority, this catches the direct pattern.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.argv.includes('--root')
  ? process.argv[process.argv.indexOf('--root') + 1]
  : path.resolve(__dirname, '..');

/**
 * Actuator modules: anything holding kill/spawn/place/transfer/reap authority.
 * Grow this list when a new actuator class lands — adding here is cheap;
 * debugging a journal-driven double-kill is not.
 */
const ACTUATOR_FILES = [
  'src/core/SessionManager.ts',
  'src/core/SessionRouter.ts',
  'src/core/SessionOwnershipRegistry.ts',
  'src/monitoring/SessionWatchdog.ts',
  'src/monitoring/SessionMonitor.ts',
  'src/core/SessionMaintenanceRunner.ts',
  'src/core/AutonomousSessions.ts',
  'src/lifeline/ServerSupervisor.ts',
];

const READER_IMPORT = /from\s+['"][^'"]*CoherenceJournalReader(\.js)?['"]/;

const violations = [];
for (const rel of ACTUATOR_FILES) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) continue;
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (READER_IMPORT.test(lines[i])) {
      violations.push(`${rel}:${i + 1}: actuator imports the journal READER (forbidden by §3.9 — the journal answers questions, live systems decide)`);
    }
  }
}

if (violations.length > 0) {
  console.error('lint-journal-actuation-ban: VIOLATIONS\n');
  for (const v of violations) console.error('  ' + v);
  console.error('\nReplicated journal data is stale by construction. Read the live store instead.');
  process.exit(1);
}
console.log(`lint-journal-actuation-ban: clean (${ACTUATOR_FILES.length} actuator modules, none import the reader)`);
