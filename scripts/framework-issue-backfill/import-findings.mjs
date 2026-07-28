#!/usr/bin/env node
// Bulk-import engineering-discovered framework issues into the FrameworkIssueLedger
// via POST /framework-issues/observe. Idempotent: the ledger dedups on dedupKey, so
// re-running updates rather than duplicates. Generic — point it at any findings JSON.
//
// Usage:
//   INSTAR_AUTH_TOKEN=... node import-findings.mjs <findings.json> [--port 4042] [--dry-run]
//
// findings.json shape: { "framework": "codex-cli", "findings": [ { dedupKey, bucket,
//   severity, title, evidence?, observedVersion?, fixedInVersion?, status?,
//   wontFixReason?, bucketPrimary?, signature?, relatedSpec? }, ... ] }

import fs from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
const portArg = args.indexOf('--port');
const port = portArg >= 0 ? args[portArg + 1] : process.env.INSTAR_PORT || '4042';
const token = process.env.INSTAR_AUTH_TOKEN || '';

if (!file) {
  console.error('usage: node import-findings.mjs <findings.json> [--port N] [--dry-run]');
  process.exit(2);
}
if (!token && !dryRun) {
  console.error('INSTAR_AUTH_TOKEN env is required (or pass --dry-run)');
  process.exit(2);
}

const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
const framework = doc.framework;
const findings = Array.isArray(doc.findings) ? doc.findings : [];
if (!framework || findings.length === 0) {
  console.error('findings JSON must have { framework, findings: [...] }');
  process.exit(2);
}

const url = `http://localhost:${port}/framework-issues/observe`;
let created = 0;
let updated = 0;
let failed = 0;

for (const f of findings) {
  const body = { framework, ...f };
  delete body._comment;
  if (dryRun) {
    console.log(`[dry-run] ${f.bucket}/${f.severity} ${f.dedupKey} :: ${f.title}`);
    continue;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) {
      failed++;
      console.error(`  FAIL ${f.dedupKey}: ${res.status} ${json.error || ''}`);
      continue;
    }
    if (json.created) created++;
    else updated++;
    console.log(
      `  ${json.created ? 'CREATE' : 'update'} ${f.dedupKey} → ${json.issueId} (${f.status || 'open'}, seen×${json.recurrenceCount})`,
    );
  } catch (err) {
    failed++;
    console.error(`  ERROR ${f.dedupKey}: ${err.message}`);
  }
}

console.log(`\nDone: ${created} created, ${updated} updated, ${failed} failed (of ${findings.length}).`);
process.exit(failed > 0 ? 1 : 0);
