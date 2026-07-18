// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Fleet-regression tests for the stall-class registry codemod
 * (docs/specs/framework-stall-coverage-matrix.md §5 additive-growth test):
 * adding a class WITHOUT the codemod fails every stale matrix; running the
 * codemod seeds `declared-gap (new-class, unreviewed)` rows with `seededAt`
 * stamps + `pending-mint` closePaths and validation passes green with the
 * debt visible; the codemod is idempotent; --dry-run writes nothing.
 *
 * Runs the REAL scripts/stall-class-codemod.mjs via child_process against a
 * synthetic fixture tree (offline-first contract: no server, any checkout).
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  validateAllStallMatrices,
  type StallCoverageValidatorDeps,
} from '../../src/core/stallCoverageValidator.js';

const realRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MATRIX_REL = 'docs/frameworks/foo-cli-stall-coverage.md';
const createdTrees: string[] = [];

function registrySource(ids: string[]): string {
  const rows = ids
    .map((id) => `  { id: '${id}', name: '${id}', description: 'synthetic', sinceVersion: '1.0' },`)
    .join('\n');
  return `export const STALL_CLASSES = [\n${rows}\n] as const;\n`;
}

const BASE_MATRIX =
  '---\n' +
  'framework: foo-cli\n' +
  'stall-coverage:\n' +
  '  - class: alpha-class\n' +
  '    status: declared-gap\n' +
  '    reason: no detector exists yet\n' +
  '    issueRef: stallclass::alpha-class::foo-cli::gap\n' +
  '    closePath: CMT-1\n' +
  "    liveness-surface: 'DEFECT: session reads as running while stalled'\n" +
  '---\n\n# foo-cli matrix body\n';

/** A synthetic tree with the REAL codemod, a two-class registry, and a matrix
 *  that only carries the first class (the stale-matrix scenario). */
function freshTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-codemod-'));
  createdTrees.push(root);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs/frameworks'), { recursive: true });
  fs.copyFileSync(
    path.join(realRepoRoot, 'scripts/stall-class-codemod.mjs'),
    path.join(root, 'scripts/stall-class-codemod.mjs'),
  );
  // The codemod imports js-yaml — resolve it from the real repo's node_modules.
  fs.symlinkSync(path.join(realRepoRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  fs.writeFileSync(
    path.join(root, 'src/data/stall-classes.ts'),
    registrySource(['alpha-class', 'beta-class']),
  );
  fs.writeFileSync(path.join(root, MATRIX_REL), BASE_MATRIX);
  return root;
}

function runCodemod(root: string, ...args: string[]): string {
  return execFileSync(
    process.execPath,
    [path.join(root, 'scripts/stall-class-codemod.mjs'), ...args],
    { encoding: 'utf8' },
  );
}

function depsFor(): StallCoverageValidatorDeps {
  return {
    stallClassIds: ['alpha-class', 'beta-class'],
    requiredFrameworks: ['foo-cli'],
    guardManifestKeys: new Set<string>(),
    notAGuardComponents: new Map<string, string>(),
  };
}

afterAll(() => {
  for (const root of createdTrees) fs.rmSync(root, { recursive: true, force: true });
});

describe('stall-class codemod — fleet regression', () => {
  it('a registry class addition WITHOUT the codemod fails the stale matrix (class-row-missing)', () => {
    const root = freshTree();
    const set = validateAllStallMatrices({ repoRoot: root, deps: depsFor() });
    expect(set.valid).toBe(false);
    const missing = set.results[0].issues.filter((i) => i.rule === 'class-row-missing');
    expect(missing.map((i) => i.classId)).toEqual(['beta-class']);
  });

  it('running the codemod seeds a declared-gap row and validation passes green with visible debt', () => {
    const root = freshTree();
    const out = runCodemod(root);
    expect(out).toContain('seed foo-cli: beta-class');
    expect(out).toContain('seeded 1 row(s)');

    const raw = fs.readFileSync(path.join(root, MATRIX_REL), 'utf8');
    const fm = /^---\n([\s\S]*?)\n---/.exec(raw);
    expect(fm).not.toBeNull();
    const doc = yaml.load(fm![1], { schema: yaml.JSON_SCHEMA }) as {
      'stall-coverage': Array<Record<string, unknown>>;
    };
    const seeded = doc['stall-coverage'].find((r) => r.class === 'beta-class');
    expect(seeded).toBeDefined();
    expect(seeded!.status).toBe('declared-gap');
    expect(seeded!.reason).toBe('new-class, unreviewed');
    expect(seeded!.closePath).toBe('pending-mint');
    expect(seeded!.issueRef).toBe('stallclass::beta-class::foo-cli::unreviewed');
    expect(String(seeded!.seededAt)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The stamp is today (UTC) — the aging clock starts at seed time.
    expect(String(seeded!.seededAt)).toBe(new Date().toISOString().slice(0, 10));

    const set = validateAllStallMatrices({ repoRoot: root, deps: depsFor() });
    expect(
      set.results.flatMap((r) => r.issues.map((i) => `${r.framework}: [${i.rule}] ${i.message}`)),
    ).toEqual([]);
    expect(set.valid).toBe(true);
  });

  it('the codemod is idempotent — a second run seeds 0 rows and rewrites nothing', () => {
    const root = freshTree();
    runCodemod(root);
    const afterFirst = fs.readFileSync(path.join(root, MATRIX_REL), 'utf8');
    const out = runCodemod(root);
    expect(out).toContain('seeded 0 row(s)');
    const afterSecond = fs.readFileSync(path.join(root, MATRIX_REL), 'utf8');
    expect(afterSecond).toBe(afterFirst);
  });

  it('--dry-run reports what it would seed but writes nothing', () => {
    const root = freshTree();
    const before = fs.readFileSync(path.join(root, MATRIX_REL), 'utf8');
    const out = runCodemod(root, '--dry-run');
    expect(out).toContain('seed foo-cli: beta-class');
    expect(out).toContain('[dry-run] would seed 1 row(s)');
    const after = fs.readFileSync(path.join(root, MATRIX_REL), 'utf8');
    expect(after).toBe(before);
  });
});
