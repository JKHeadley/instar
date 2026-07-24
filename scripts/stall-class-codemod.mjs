#!/usr/bin/env node
/**
 * Stall-class registry codemod — offline-first, idempotent.
 *
 * Spec: docs/specs/framework-stall-coverage-matrix.md (§2.1, §3.4)
 *
 * When a class is added to src/data/stall-classes.ts, this codemod seeds a
 * `declared-gap (new-class, unreviewed)` row into every existing matrix in
 * docs/frameworks/*-stall-coverage.md, in the SAME PR that adds the class —
 * otherwise the CI ratchet reds every stale matrix on the next push.
 *
 * Offline-first contract (§2.1): runs in any source checkout (contributor
 * clone, CI, the PR-race repair path) with NO instar server required. Seeded
 * rows carry:
 *   - `status: declared-gap`, `reason: "new-class, unreviewed"`
 *   - `seededAt: <today ISO date>` (the aging clock — warning at +45d,
 *     CI red at +60d)
 *   - `closePath: pending-mint` (legal ONLY alongside seededAt; the
 *     recurring stall-matrix-live-check job owns the mint + ref rewrite)
 *   - `issueRef: stallclass::<class>::<framework>::unreviewed`
 *
 * Idempotently re-runnable against a merged tree: rows that already exist
 * are never touched; running twice is a no-op. When two green PRs race (a
 * class addition and a new matrix in flight), the merge of the second reds
 * the ratchet and the fix is: run this codemod, commit the seeded rows.
 *
 * Usage: node scripts/stall-class-codemod.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');

/**
 * Parse canonical class ids from the registry TS source without executing
 * it (offline-first — no build step, no ts-node). The registry's shape is
 * pinned by the CI ratchet, which asserts spec-table/registry agreement, so
 * a tolerant literal scan of the STALL_CLASSES block is stable here.
 */
function parseClassIds(registrySource) {
  const block = registrySource.match(
    /STALL_CLASSES[\s\S]*?=\s*\[([\s\S]*?)\]\s*as const/,
  );
  if (!block) {
    throw new Error('could not locate STALL_CLASSES block in registry source');
  }
  const ids = [...block[1].matchAll(/id:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]);
  if (ids.length === 0) {
    throw new Error('STALL_CLASSES block contained no class ids');
  }
  return ids;
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function main() {
  const registryPath = join(repoRoot, 'src/data/stall-classes.ts');
  const classIds = parseClassIds(readFileSync(registryPath, 'utf8'));

  const frameworksDir = join(repoRoot, 'docs/frameworks');
  if (!existsSync(frameworksDir)) {
    console.log('no docs/frameworks directory — nothing to seed');
    return;
  }
  const matrixFiles = readdirSync(frameworksDir).filter((f) =>
    f.endsWith('-stall-coverage.md'),
  );

  let seededTotal = 0;
  for (const file of matrixFiles) {
    const framework = file.replace(/-stall-coverage\.md$/, '');
    const path = join(frameworksDir, file);
    const raw = readFileSync(path, 'utf8');
    const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!fm) {
      console.error(`SKIP ${file}: no front-matter block`);
      continue;
    }
    const doc = yaml.load(fm[1]);
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc['stall-coverage'])) {
      console.error(`SKIP ${file}: no stall-coverage list in front-matter`);
      continue;
    }
    const rows = doc['stall-coverage'];
    const present = new Set(rows.map((r) => r && r.class));
    const missing = classIds.filter((id) => !present.has(id));
    if (missing.length === 0) continue;

    for (const classId of missing) {
      rows.push({
        class: classId,
        status: 'declared-gap',
        reason: 'new-class, unreviewed',
        seededAt: todayIsoDate(),
        issueRef: `stallclass::${classId}::${framework}::unreviewed`,
        closePath: 'pending-mint',
        'liveness-surface':
          'unknown — seeded row; the class is new and this framework has not reviewed it',
      });
      seededTotal += 1;
      console.log(`seed ${framework}: ${classId}`);
    }

    if (!dryRun) {
      const newFm = yaml.dump(doc, { lineWidth: 100, noRefs: true });
      writeFileSync(path, `---\n${newFm}---\n${fm[2]}`);
    }
  }

  console.log(
    `${dryRun ? '[dry-run] would seed' : 'seeded'} ${seededTotal} row(s) across ${matrixFiles.length} matrix file(s)`,
  );
}

main();
