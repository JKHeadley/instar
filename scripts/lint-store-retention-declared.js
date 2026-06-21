#!/usr/bin/env node
/**
 * lint-store-retention-declared.js — Bounded Accumulation §3b (Lint 1).
 *
 * Every persistent store (a category in state-coherence-registry.json) MUST declare a
 * retention policy. This lint is the RATCHET: it FAILS on a NEW category that has no
 * `retention`, while grandfathering the frozen legacy backlog (the §4 retrofit counts
 * that backlog down). It also enforces D6 set-monotonicity — the frozen baseline may
 * only SHRINK: growing it (gaming the ratchet by adding a new store to the allowlist
 * instead of giving it retention) fails.
 *
 * Pairs with lint-state-registry.js (which forces a write-site to be REGISTERED at all);
 * this lint forces a registered store to also be BOUNDED.
 *
 * Exit codes: 0 pass · 1 violation · 2 cannot-read (fail-loud, never silently skip).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// --registry / --baseline override the defaults (for tests + alternate checkouts).
function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const REGISTRY = path.resolve(argVal('--registry') || path.join(ROOT, 'src', 'data', 'state-coherence-registry.json'));
const BASELINE = path.resolve(argVal('--baseline') || path.join(ROOT, 'scripts', 'bounded-accumulation-retention-baseline.json'));

// The category count of the frozen baseline at Increment 1. The baseline may only
// shrink; a larger set means the allowlist was grown to dodge the ratchet (D6).
const FROZEN_BASELINE_COUNT = 75;

function hasRetention(e) {
  return !!(e && e.retention && typeof e.retention === 'object' && Object.keys(e.retention).length > 0);
}

let registry, baseline;
try {
  registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
} catch (e) {
  console.error('lint-store-retention-declared: cannot read registry: ' + e.message);
  process.exit(2);
}
try {
  baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
} catch (e) {
  console.error('lint-store-retention-declared: cannot read frozen baseline: ' + e.message);
  process.exit(2);
}

const baselineSet = new Set(baseline.categories || []);
const errors = [];

// D6: the frozen baseline may only shrink.
if ((baseline.categories || []).length > FROZEN_BASELINE_COUNT) {
  errors.push(
    `Retention baseline GREW (${baseline.categories.length} > frozen ${FROZEN_BASELINE_COUNT}). ` +
      `The baseline may only shrink (D6 set-monotonicity) — declare a retention policy on the new ` +
      `store instead of adding it to the grandfathered allowlist.`,
  );
}

// Every no-retention category must be in the frozen baseline (grandfathered legacy).
for (const e of registry.entries || []) {
  if (hasRetention(e)) continue;
  if (!baselineSet.has(e.category)) {
    errors.push(
      `Store category "${e.category}" has NO retention policy and is not in the frozen baseline. ` +
        `Every persistent store must declare a retention policy (Bounded Accumulation §2). Add a ` +
        `"retention" field to its state-coherence-registry.json entry — one of: ` +
        `{class:'A',access:'streamed',maxBytes,keepSegments} (rotating log), ` +
        `{class:'C',access:'streamed',complianceHold:true} (audit/forensic — archive, never drop), ` +
        `{class:'sqlite',access:'sqlite',maxAgeMs} (indexed store), ` +
        `{class:'R',access:'protocol-reader',boundedBy:'replication-protocol'} (replication substrate), or ` +
        `{class:'resolution',boundedByResolution:true,maxOpenItems} (actionable queue).`,
    );
  }
}

if (errors.length) {
  console.error('lint-store-retention-declared: FAIL');
  for (const e of errors) console.error('  • ' + e);
  process.exit(1);
}

const retentioned = (registry.entries || []).filter(hasRetention).length;
console.log(
  `lint-store-retention-declared: OK — ${retentioned} stores retentioned, ` +
    `${baselineSet.size} grandfathered (retrofit backlog, may only shrink).`,
);
process.exit(0);
