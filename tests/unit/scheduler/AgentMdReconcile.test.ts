/**
 * AgentMdReconcile — boot-time consistency check tests.
 *
 * Per INSTAR-JOBS-AS-AGENTMD spec §Runtime "Load lifecycle (boot)".
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { reconcileAgentMdTree } from '../../../src/scheduler/AgentMdReconcile.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

describe('AgentMdReconcile', () => {
  let workspace: string;
  let stateDir: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-rec-'));
    stateDir = path.join(workspace, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(workspace, { recursive: true, force: true, operation: 'AgentMdReconcile.test cleanup' });
  });

  function writeManifest(slug: string, origin: 'instar' | 'user' = 'user'): void {
    const dir = path.join(stateDir, 'jobs', 'schedule');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify({ slug, origin, schedule: '*/5 * * * *', enabled: true, execute: { type: 'agentmd' } }));
  }

  function writeMd(slug: string, namespace: 'instar' | 'user'): void {
    const dir = path.join(stateDir, 'jobs', namespace);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${slug}.md`), `---\nname: ${slug}\n---\nbody\n`);
  }

  function writeJobsJson(entries: any[]): void {
    fs.writeFileSync(path.join(stateDir, 'jobs.json'), JSON.stringify(entries, null, 2));
  }

  it('clean tree produces zero findings', () => {
    writeManifest('alpha', 'user');
    writeMd('alpha', 'user');

    const report = reconcileAgentMdTree({ stateDir });
    expect(report.findings).toEqual([]);
    expect(report.summary.total).toBe(0);
  });

  it('orphan-manifest surfaces when manifest exists with no matching .md', () => {
    writeManifest('orphan-slug', 'user');
    // No corresponding .md.

    const report = reconcileAgentMdTree({ stateDir });

    const orphans = report.findings.filter((f) => f.kind === 'orphan-manifest');
    expect(orphans).toHaveLength(1);
    expect(orphans[0].slug).toBe('orphan-slug');
    expect(orphans[0].severity).toBe('error');
    expect(report.summary.byKind['orphan-manifest']).toBe(1);
  });

  it('shadow-md surfaces when .md exists with no matching manifest', () => {
    writeMd('shadow-slug', 'user');
    // No corresponding manifest.

    const report = reconcileAgentMdTree({ stateDir });

    const shadows = report.findings.filter((f) => f.kind === 'shadow-md');
    expect(shadows).toHaveLength(1);
    expect(shadows[0].slug).toBe('shadow-slug');
    expect(shadows[0].severity).toBe('warning');
    expect(report.summary.byKind['shadow-md']).toBe(1);
  });

  it('missing-from-jobs-json surfaces when a legacy prompt entry has neither manifest nor .md', () => {
    writeJobsJson([
      { slug: 'legacy-prompt', execute: { type: 'prompt', value: 'do thing' }, schedule: '*/5 * * * *' },
      { slug: 'migrated-already', execute: { type: 'prompt', value: 'old' }, schedule: '*/5 * * * *' },
    ]);
    writeManifest('migrated-already', 'user');
    writeMd('migrated-already', 'user');

    const report = reconcileAgentMdTree({ stateDir });

    const missing = report.findings.filter((f) => f.kind === 'missing-from-jobs-json');
    expect(missing).toHaveLength(1);
    expect(missing[0].slug).toBe('legacy-prompt');
  });

  it('staged-new surfaces .new files from interrupted atomic save', () => {
    fs.mkdirSync(path.join(stateDir, 'jobs', 'user'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'jobs', 'user', 'crashy.md.new'), 'staged body');
    fs.mkdirSync(path.join(stateDir, 'jobs', 'schedule'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'jobs', 'schedule', 'crashy.json.new'), '{}');

    const report = reconcileAgentMdTree({ stateDir });

    const staged = report.findings.filter((f) => f.kind === 'staged-new');
    expect(staged).toHaveLength(2);
    expect(staged.every((s) => s.severity === 'info')).toBe(true);
  });

  it('case-collision surfaces two .md files differing only in case (case-sensitive FS only)', () => {
    // macOS APFS and Windows NTFS are case-insensitive by default; this
    // test only exercises the detection on case-sensitive filesystems
    // (Linux ext4, etc.). On case-insensitive filesystems, the second
    // write replaces the first via inode-equivalence, so there's no
    // actual collision to detect.
    const dir = path.join(stateDir, 'jobs', 'user');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Health-Check.md'), 'a');
    fs.writeFileSync(path.join(dir, 'health-check.md'), 'b');

    const listing = fs.readdirSync(dir);
    if (listing.length < 2) {
      // Case-insensitive FS: both writes landed on the same path.
      // Skip this test variant — the detection logic is correct, the
      // OS just can't reproduce the collision here.
      return;
    }

    const report = reconcileAgentMdTree({ stateDir });

    const collisions = report.findings.filter((f) => f.kind === 'case-collision');
    expect(collisions).toHaveLength(1);
    expect(collisions[0].severity).toBe('error');
    expect(collisions[0].conflictingPaths).toHaveLength(2);
  });

  it('non-prompt legacy entries (script/skill) do NOT surface as missing-from-jobs-json', () => {
    writeJobsJson([
      { slug: 'script-job', execute: { type: 'script', value: 'echo' }, schedule: '*/5 * * * *' },
      { slug: 'skill-job', execute: { type: 'skill', value: 'my-skill' }, schedule: '*/5 * * * *' },
    ]);

    const report = reconcileAgentMdTree({ stateDir });

    expect(report.findings.filter((f) => f.kind === 'missing-from-jobs-json')).toHaveLength(0);
  });

  it('reports multiple findings simultaneously with correct counts', () => {
    writeManifest('orphan-1', 'user');
    writeManifest('orphan-2', 'user');
    writeMd('shadow-1', 'instar');
    fs.mkdirSync(path.join(stateDir, 'jobs', 'user'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'jobs', 'user', 'staged.md.new'), 's');

    const report = reconcileAgentMdTree({ stateDir });

    expect(report.summary.byKind['orphan-manifest']).toBe(2);
    expect(report.summary.byKind['shadow-md']).toBe(1);
    expect(report.summary.byKind['staged-new']).toBe(1);
    expect(report.summary.total).toBe(4);
  });

  it('empty state directory produces zero findings (fresh install)', () => {
    const report = reconcileAgentMdTree({ stateDir });
    expect(report.summary.total).toBe(0);
  });

  it('reconcileAgentMdTree is pure — calling it twice produces identical output', () => {
    writeManifest('a', 'user');
    writeMd('a', 'user');
    writeManifest('orphan', 'user');

    const r1 = reconcileAgentMdTree({ stateDir });
    const r2 = reconcileAgentMdTree({ stateDir });
    expect(JSON.stringify(r2)).toBe(JSON.stringify(r1));
  });
});
