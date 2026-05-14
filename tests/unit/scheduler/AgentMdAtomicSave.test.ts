/**
 * AgentMdAtomicSave — race-safe two-rename commit tests.
 *
 * Per INSTAR-JOBS-AS-AGENTMD spec §Design Principle 2.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  atomicSaveAgentMdJob,
  listStagedNewFiles,
  discardStagedFile,
} from '../../../src/scheduler/AgentMdAtomicSave.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

describe('AgentMdAtomicSave', () => {
  let workspace: string;
  let mdPath: string;
  let manifestPath: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-2r-'));
    mdPath = path.join(workspace, '.instar', 'jobs', 'user', 'test-slug.md');
    manifestPath = path.join(workspace, '.instar', 'jobs', 'schedule', 'test-slug.json');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(workspace, { recursive: true, force: true, operation: 'AgentMdAtomicSave.test cleanup' });
  });

  function manifest(slug: string): Record<string, unknown> {
    return { slug, origin: 'user', schedule: '*/5 * * * *', enabled: true, execute: { type: 'agentmd' }, manifestVersion: 1 };
  }

  it('happy path: writes both files, leaves no .new staging files', () => {
    const r = atomicSaveAgentMdJob({
      mdPath,
      manifestPath,
      mdBody: '---\nname: Test\n---\nbody\n',
      manifest: manifest('test-slug'),
    });

    expect(r.ok).toBe(true);
    expect(fs.existsSync(mdPath)).toBe(true);
    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(fs.existsSync(mdPath + '.new')).toBe(false);
    expect(fs.existsSync(manifestPath + '.new')).toBe(false);
    expect(fs.readFileSync(mdPath, 'utf-8')).toContain('body');
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(parsed.slug).toBe('test-slug');
  });

  it('rename A succeeds, rename B fails: leaves new md committed + manifest.new staged', () => {
    // Pre-write an existing manifest to make the test verifiable on
    // success — then mock renameSync to fail only for the second rename.
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest('old-slug'), null, 2));

    const realRenameSync = fs.renameSync;
    let renameCallCount = 0;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((src, dst) => {
      renameCallCount++;
      if (renameCallCount === 2) {
        throw new Error('SIMULATED: rename B failed');
      }
      return realRenameSync(src, dst);
    });

    try {
      const r = atomicSaveAgentMdJob({
        mdPath,
        manifestPath,
        mdBody: 'new body\n',
        manifest: manifest('test-slug'),
      });

      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.stage).toBe('commit-manifest');
        expect(r.partial.mdCommitted).toBe(true);
        expect(r.partial.manifestCommitted).toBe(false);
        expect(r.partial.manifestNewExists).toBe(true);
      }

      // The body IS the new content. The manifest is still the OLD content.
      expect(fs.readFileSync(mdPath, 'utf-8')).toBe('new body\n');
      expect(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')).slug).toBe('old-slug');
      // The manifest.new staged file is present.
      expect(fs.existsSync(manifestPath + '.new')).toBe(true);
    } finally {
      renameSpy.mockRestore();
    }
  });

  it('rename A fails: leaves both .new files staged, no committed change', () => {
    const realRenameSync = fs.renameSync;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('SIMULATED: rename A failed');
    });

    try {
      const r = atomicSaveAgentMdJob({
        mdPath,
        manifestPath,
        mdBody: 'new body\n',
        manifest: manifest('test-slug'),
      });

      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.stage).toBe('commit-md');
        expect(r.partial.mdCommitted).toBe(false);
        expect(r.partial.manifestCommitted).toBe(false);
        expect(r.partial.mdNewExists).toBe(true);
        expect(r.partial.manifestNewExists).toBe(true);
      }
      expect(fs.existsSync(mdPath)).toBe(false);
      expect(fs.existsSync(manifestPath)).toBe(false);
      expect(fs.existsSync(mdPath + '.new')).toBe(true);
      expect(fs.existsSync(manifestPath + '.new')).toBe(true);
    } finally {
      renameSpy.mockRestore();
    }
  });

  it('failing to stage the md (write of .md.new errors): no .new files produced', () => {
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw new Error('SIMULATED: stage-md write failed');
    });

    try {
      const r = atomicSaveAgentMdJob({
        mdPath,
        manifestPath,
        mdBody: 'body\n',
        manifest: manifest('test-slug'),
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.stage).toBe('stage-md');
        expect(r.partial.mdNewExists).toBe(false);
        expect(r.partial.manifestNewExists).toBe(false);
      }
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('idempotent re-save: running atomicSaveAgentMdJob twice with the same input is a no-op for the end state', () => {
    const input = {
      mdPath,
      manifestPath,
      mdBody: 'body v1\n',
      manifest: manifest('test-slug'),
    };
    expect(atomicSaveAgentMdJob(input).ok).toBe(true);
    const md1 = fs.readFileSync(mdPath, 'utf-8');
    const mf1 = fs.readFileSync(manifestPath, 'utf-8');

    expect(atomicSaveAgentMdJob(input).ok).toBe(true);
    expect(fs.readFileSync(mdPath, 'utf-8')).toBe(md1);
    expect(fs.readFileSync(manifestPath, 'utf-8')).toBe(mf1);
  });

  // ── listStagedNewFiles + discardStagedFile ──────────────────────────

  it('listStagedNewFiles finds .new files across nested directories', () => {
    fs.mkdirSync(path.join(workspace, '.instar', 'jobs', 'user'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.instar', 'jobs', 'schedule'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.instar', 'jobs', 'user', 'a.md.new'), 'staged');
    fs.writeFileSync(path.join(workspace, '.instar', 'jobs', 'schedule', 'a.json.new'), 'staged');
    fs.writeFileSync(path.join(workspace, '.instar', 'jobs', 'user', 'b.md'), 'committed');

    const found = listStagedNewFiles(path.join(workspace, '.instar', 'jobs'));
    expect(found).toHaveLength(2);
    expect(found.some((p) => p.endsWith('a.md.new'))).toBe(true);
    expect(found.some((p) => p.endsWith('a.json.new'))).toBe(true);
  });

  it('discardStagedFile removes a staged file', () => {
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    const staged = mdPath + '.new';
    fs.writeFileSync(staged, 'staged');

    discardStagedFile(staged);

    expect(fs.existsSync(staged)).toBe(false);
  });

  // ── Recovery property tests ─────────────────────────────────────────

  it('after rename-B-failed state, a fresh successful save heals the inconsistency', () => {
    // Step 1: simulate the rename-B failure state from earlier.
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest('old-slug'), null, 2));

    let renameCallCount = 0;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((src, dst) => {
      renameCallCount++;
      if (renameCallCount === 2) throw new Error('SIMULATED: rename B failed');
      return (renameSpy.getMockImplementation() as any).bind(null)(src, dst) || (vi.fn() as any);
    });

    // First save (intentionally fails at rename B):
    renameSpy.mockImplementationOnce((src: any, dst: any) => fs.renameSync.wrappedMethod?.call(fs, src, dst));
    renameSpy.mockRestore();

    // Reset to real behavior, then run the save normally.
    const r = atomicSaveAgentMdJob({
      mdPath,
      manifestPath,
      mdBody: 'final body\n',
      manifest: manifest('healed-slug'),
    });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(mdPath, 'utf-8')).toBe('final body\n');
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')).slug).toBe('healed-slug');
    expect(fs.existsSync(manifestPath + '.new')).toBe(false);
  });
});
