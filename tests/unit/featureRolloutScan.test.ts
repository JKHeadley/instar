/**
 * featureRolloutScan — the fs/git adapter for the reconciler. Covers id
 * normalization, frontmatter parse, artifact scan (approved/ships-staged +
 * trace join + recency), the flag observer (read-only), and the wiring-integrity
 * guard that the reconciler is actually constructed + run at boot.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  normalizeSpecId,
  parseSpecFrontmatter,
  scanSpecArtifacts,
  makeFlagObserver,
} from '../../src/core/featureRolloutScan.js';

describe('normalizeSpecId', () => {
  it('lowercases + kebabs', () => {
    expect(normalizeSpecId('SESSION-REAPER-SPEC.md')).toBe('session-reaper-spec');
    expect(normalizeSpecId('Foo_Bar.Baz.md')).toBe('foo-bar-baz');
  });
  it('truncates long ids with a hash suffix (≤63 chars, collision-safe)', () => {
    const long = 'a'.repeat(80) + '.md';
    const id = normalizeSpecId(long);
    expect(id.length).toBeLessThanOrEqual(63);
    expect(id).toMatch(/-[a-z0-9]+$/);
  });
});

describe('parseSpecFrontmatter', () => {
  it('reads simple key:value frontmatter', () => {
    const fm = parseSpecFrontmatter('---\napproved: true\nreview-convergence: "x"\nships-staged: true\n---\n# Title');
    expect(fm.approved).toBe('true');
    expect(fm['review-convergence']).toBe('x');
    expect(fm['ships-staged']).toBe('true');
  });
  it('returns {} when no frontmatter', () => {
    expect(parseSpecFrontmatter('# No frontmatter')).toEqual({});
  });
});

describe('scanSpecArtifacts', () => {
  let repo: string;
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-scan-'));
    fs.mkdirSync(path.join(repo, 'docs', 'specs'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.instar', 'instar-dev-traces'), { recursive: true });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(repo, { recursive: true, force: true, operation: 'tests/unit/featureRolloutScan.test.ts' }));

  it('joins an approved spec to its trace and marks it merged + recent', () => {
    fs.writeFileSync(path.join(repo, 'docs', 'specs', 'FEAT-X.md'),
      '---\napproved: true\nships-staged: true\nrollout-flag-path: monitoring.featX\nrollout-criteria: 2wk clean\n---\n# Feat X');
    fs.writeFileSync(path.join(repo, '.instar', 'instar-dev-traces', 't.json'),
      JSON.stringify({ phase: 'complete', specPath: 'docs/specs/FEAT-X.md', prNumber: 7, createdAt: new Date().toISOString() }));
    const arts = scanSpecArtifacts(repo);
    const a = arts.find(x => x.id === 'feat-x')!;
    expect(a.approved).toBe(true);
    expect(a.shipsStaged).toBe(true);
    expect(a.flagPath).toBe('monitoring.featX');
    expect(a.prNumber).toBe(7);
    expect(a.merged).toBe(true);
    expect(a.mergedRecently).toBe(true);
  });

  it('an approved spec with an OLD trace is merged but not recent (→ terminal backfill)', () => {
    fs.writeFileSync(path.join(repo, 'docs', 'specs', 'OLD.md'), '---\napproved: true\n---\n# Old');
    fs.writeFileSync(path.join(repo, '.instar', 'instar-dev-traces', 'o.json'),
      JSON.stringify({ specPath: 'docs/specs/OLD.md', createdAt: '2024-01-01T00:00:00Z' }));
    const a = scanSpecArtifacts(repo).find(x => x.id === 'old')!;
    expect(a.merged).toBe(true);
    expect(a.mergedRecently).toBe(false);
  });

  it('skips .eli16.md companions', () => {
    fs.writeFileSync(path.join(repo, 'docs', 'specs', 'X.eli16.md'), '# eli16');
    expect(scanSpecArtifacts(repo).find(x => x.specPath.endsWith('.eli16.md'))).toBeUndefined();
  });

  it('an un-traced spec is not merged (dev in progress)', () => {
    fs.writeFileSync(path.join(repo, 'docs', 'specs', 'WIP.md'), '---\napproved: true\n---\n# WIP');
    const a = scanSpecArtifacts(repo).find(x => x.id === 'wip')!;
    expect(a.merged).toBe(false);
  });
});

describe('makeFlagObserver (read-only)', () => {
  it('derives observation from live config + shipped default', () => {
    const obs = makeFlagObserver(
      { monitoring: { featX: { enabled: true, dryRun: true } } },
      { monitoring: { featX: { enabled: false } } },
    )('monitoring.featX');
    expect(obs).toEqual({ flagEnabled: true, flagDryRun: true, defaultEnabled: false });
  });
  it('defaultEnabled true when the shipped default is on', () => {
    const obs = makeFlagObserver({}, { monitoring: { featX: { enabled: true } } })('monitoring.featX');
    expect(obs.defaultEnabled).toBe(true);
  });
});

describe('wiring integrity — reconciler is constructed + run at boot', () => {
  it('server.ts constructs FeatureRolloutReconciler and calls reconcile()', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const src = fs.readFileSync(path.join(root, 'src/commands/server.ts'), 'utf8');
    expect(src).toContain('new FeatureRolloutReconciler(');
    expect(src).toContain('featureRolloutReconciler.reconcile()');
    expect(src).toContain('scanSpecArtifacts(config.projectDir)');
  });
  it('handles a bare-boolean flag (not just {enabled,dryRun} objects)', () => {
    const obs = makeFlagObserver({ monitoring: { flat: true } }, { monitoring: { flat: false } })('monitoring.flat');
    expect(obs.flagEnabled).toBe(true);
    expect(obs.defaultEnabled).toBe(false);
  });
});
