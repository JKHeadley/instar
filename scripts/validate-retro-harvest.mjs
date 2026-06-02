#!/usr/bin/env node
/**
 * validate-retro-harvest.mjs — thin CLI for the Apprenticeship Step 0
 * retro-harvest validator.
 *
 * The PURE validator logic now lives in TypeScript at
 * `src/core/retroHarvestValidator.ts` (the SOURCE OF TRUTH, Apprenticeship
 * Step 1 §3.2 relocation). This script re-exports the compiled module so
 * existing importers (tests via the TS source, callers via the build) keep
 * working, and keeps the `node scripts/...` CLI entry. Precedent:
 * `src/threadline/BackfillCore.ts` + its scripts consumer.
 *
 * CLI:  node scripts/validate-retro-harvest.mjs <artifact.md> [--prior] [--check-live]
 *   exit 0 = valid, exit 1 = invalid (errors to stderr).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export {
  validateRetroHarvest,
  parseArtifact,
  countSectionItems,
  findSecret,
  safeArtifactPath,
  checkLiveLedger,
  SCHEMA_ID,
  INSTANCE_TYPES,
  SCOPE_MODES,
  COMPLETENESS,
  FIDELITY_VERDICTS,
  HARVEST_DIR,
  APPROVED_SCRUBBERS,
  POINTER_PATTERNS,
} from '../dist/core/retroHarvestValidator.js';

import { validateRetroHarvest } from '../dist/core/retroHarvestValidator.js';

// --- CLI entry (guarded so importing for tests is side-effect-free)
const isMain = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const priorHarvestExists = args.includes('--prior');
  if (!file) {
    console.error('usage: validate-retro-harvest.mjs <artifact.md> [--prior] [--check-live]');
    process.exit(1);
  }
  const text = readFileSync(file, 'utf8');
  const { valid, errors } = validateRetroHarvest(text, { priorHarvestExists });
  if (!valid) {
    console.error(`INVALID: ${file}`);
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }
  console.log(`valid: ${file}`);
  process.exit(0);
}
