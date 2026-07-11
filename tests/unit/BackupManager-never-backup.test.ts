/**
 * NEVER_BACKUP_PATH_SEGMENTS — the UNCONDITIONAL judgment-provenance backup
 * exclusion (ownership-gated-spawn-and-judgment-within-floors spec §3.5).
 *
 * Provenance rows are machine-local decision context (0700/0600, gitignored,
 * never HTTP-served); a backup snapshot that crosses machines must never carry
 * them. Unlike the shared-state and remediation gates, this exclusion has NO
 * feature flag — resolveIncludedFiles drops any includeFiles entry containing
 * the 'judgment-provenance' path SEGMENT (segment-matched, not prefix-matched,
 * so an alternate relative spelling cannot smuggle the dir in).
 *
 * Mirrors tests/unit/BackupManager-sharedState.test.ts conventions (public
 * createSnapshot path) plus a direct resolveIncludedFiles probe for entries
 * that could never land on disk.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BackupManager, NEVER_BACKUP_PATH_SEGMENTS } from '../../src/core/BackupManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function resolveIncluded(bm: BackupManager): string[] {
  return (bm as unknown as { resolveIncludedFiles: () => string[] }).resolveIncludedFiles();
}

describe('BackupManager — never-backup judgment-provenance segments', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-never-backup-'));
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# Agent');
    fs.writeFileSync(path.join(stateDir, 'custom-note.md'), 'keep me');
    // The provenance dir + a row file EXIST — exclusion must be the reason
    // they stay out of the snapshot, not absence.
    fs.mkdirSync(path.join(stateDir, 'state', 'judgment-provenance'), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'state', 'judgment-provenance', '2026-01-01.jsonl'),
      '{"contextFull":{"secret":"machine-local"}}\n',
    );
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/BackupManager-never-backup.test.ts' });
  });

  it('exports the segment list with judgment-provenance', () => {
    expect(NEVER_BACKUP_PATH_SEGMENTS).toContain('judgment-provenance');
  });

  it('drops provenance includeFiles entries UNCONDITIONALLY while keeping normal files', () => {
    const bm = new BackupManager(stateDir, {
      includeFiles: [
        'state/judgment-provenance/',
        '../state/judgment-provenance/x.jsonl',
        'custom-note.md',
      ],
    });
    const included = resolveIncluded(bm);
    expect(included).toContain('custom-note.md');
    expect(included).toContain('AGENT.md'); // defaults are unioned, untouched
    expect(included.some((e) => e.includes('judgment-provenance'))).toBe(false);
  });

  it('the public snapshot path never copies a provenance row', () => {
    const bm = new BackupManager(stateDir, {
      includeFiles: ['state/judgment-provenance/', 'custom-note.md'],
    });
    const snap = bm.createSnapshot('manual');
    expect(snap.files).toContain('custom-note.md');
    expect(snap.files.some((f) => f.includes('judgment-provenance'))).toBe(false);
    // Belt and suspenders: nothing landed in the snapshot dir either.
    const snapDir = bm.getSnapshotPath(snap.id);
    expect(fs.existsSync(path.join(snapDir, 'state', 'judgment-provenance'))).toBe(false);
  });

  it('is flag-immune: every combination of the OTHER gates still drops it', () => {
    for (const integratedBeing of [true, false]) {
      for (const remediation of [true, false]) {
        const bm = new BackupManager(
          stateDir,
          { includeFiles: ['state/judgment-provenance/', '../state/judgment-provenance/x.jsonl'] },
          undefined,
          () => integratedBeing,
          () => remediation,
        );
        const included = resolveIncluded(bm);
        expect(
          included.some((e) => e.includes('judgment-provenance')),
          `integratedBeing=${integratedBeing} remediation=${remediation}`,
        ).toBe(false);
      }
    }
  });

  it('segment-matches alternate spellings (traversal + nested), not just the canonical prefix', () => {
    const bm = new BackupManager(stateDir, {
      includeFiles: [
        'foo/judgment-provenance/bar.jsonl',
        'state/../state/judgment-provenance/x.jsonl',
      ],
    });
    const included = resolveIncluded(bm);
    expect(included.some((e) => e.includes('judgment-provenance'))).toBe(false);
  });

  it('does NOT over-drop a name merely containing the substring in one segment', () => {
    // 'judgment-provenance-notes.md' is a single segment that is not equal to
    // the banned segment — segment equality, not substring matching.
    fs.writeFileSync(path.join(stateDir, 'judgment-provenance-notes.md'), 'ok');
    const bm = new BackupManager(stateDir, { includeFiles: ['judgment-provenance-notes.md'] });
    const included = resolveIncluded(bm);
    expect(included).toContain('judgment-provenance-notes.md');
  });
});
