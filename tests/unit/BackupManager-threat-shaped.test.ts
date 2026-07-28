/**
 * Threat-shaped backup-exclusion tests (llm-decision-quality-meter spec §5.3 /
 * ACT-1201) — proven against the NAMED THREAT, not by list membership.
 *
 * Every deny list (BLOCKED_FILES, BLOCKED_PATH_PREFIXES,
 * NEVER_BACKUP_PATH_SEGMENTS) is consulted against the includeFiles ENTRY
 * string only; createSnapshot's directory-copy branch copies a directory
 * entry's direct file children. Pre-fix, an operator-added `state/` glob (or
 * the `./` root glob, whose entry basename '.' passes every entry-level check)
 * shipped excluded per-machine state — hog decisions, PR leases,
 * self-action-governor windows, pending-inbound custody, config.json — into a
 * snapshot that git-sync replicates to paired machines. And restoreSnapshot
 * applied path-containment only, so a PRE-fix snapshot could re-import the
 * excluded state on restore. These tests seed the REAL layout and assert the
 * per-file re-check holds on BOTH paths (a membership-only unit test would
 * have gone green on the mis-pinned flag-gated list — the misrooted-
 * NEVER_SERVED test lesson, applied to the backup arm; spec §Testing r6).
 *
 * Mirrors tests/unit/BackupManager-never-backup.test.ts conventions (public
 * createSnapshot/restoreSnapshot paths against a real tmp stateDir).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { BackupManager } from '../../src/core/BackupManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('BackupManager — threat-shaped exclusions (per-file re-check)', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-threat-'));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/BackupManager-threat-shaped.test.ts' });
  });

  it("includeFiles ['state/'] with remediation OFF: the snapshot OMITS every excluded per-machine store, keeps a legit sibling", () => {
    // REAL layout — all four excluded stores EXIST as direct children of
    // state/, exactly where production writes them. Exclusion must be the
    // reason they stay out, not absence.
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'state', 'external-hog-decisions.json'),
      '{"decisions":{"hog-1":{"targetTuple":{"pid":123,"startTime":456}}}}\n',
    );
    fs.writeFileSync(path.join(stateDir, 'state', 'pr-hand-leases.json'), '{"leases":{"echo/foo":{"holder":"stale"}}}\n');
    fs.writeFileSync(path.join(stateDir, 'state', 'self-action-governor.json'), '{"windows":{"reaper":{"count":9}}}\n');
    fs.writeFileSync(path.join(stateDir, 'state', 'pending-inbound.test.sqlite'), 'sqlite-bytes\n');
    // A legitimate file under the SAME directory must still be backed up
    // (no over-blocking).
    fs.writeFileSync(path.join(stateDir, 'state', 'legit-runtime-note.json'), '{"keep":"me"}\n');

    const bm = new BackupManager(
      stateDir,
      { includeFiles: ['state/'] },
      undefined,
      undefined,
      () => false, // remediation OFF — the exclusion must not depend on it
    );
    const snap = bm.createSnapshot('manual');

    expect(snap.files).toContain(path.join('state', 'legit-runtime-note.json'));
    for (const excluded of [
      'external-hog-decisions.json',
      'pr-hand-leases.json',
      'self-action-governor.json',
      'pending-inbound.test.sqlite',
    ]) {
      expect(snap.files.some((f) => f.includes(excluded)), excluded).toBe(false);
      // Belt and suspenders: nothing landed in the snapshot dir either.
      const snapDir = bm.getSnapshotPath(snap.id);
      expect(fs.existsSync(path.join(snapDir, 'state', excluded)), excluded).toBe(false);
    }
    const snapDir = bm.getSnapshotPath(snap.id);
    expect(fs.existsSync(path.join(snapDir, 'state', 'legit-runtime-note.json'))).toBe(true);
  });

  it("includeFiles ['./'] (root glob): the snapshot omits config.json via the BLOCKED_FILES per-file arm", () => {
    // The './' entry's basename is '.' — it passes every entry-level check, so
    // only the per-file re-check inside the directory-copy branch protects
    // config.json (which holds the authToken/dashboardPin).
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{"authToken":"super-secret","dashboardPin":"123456"}\n');
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# Agent identity\n');

    const bm = new BackupManager(stateDir, { includeFiles: ['./'] });
    const snap = bm.createSnapshot('manual');

    expect(snap.files.some((f) => path.basename(f) === 'config.json')).toBe(false);
    expect(snap.files).toContain('AGENT.md'); // legit root sibling still backed up
    const snapDir = bm.getSnapshotPath(snap.id);
    expect(fs.existsSync(path.join(snapDir, 'config.json'))).toBe(false);
    const dumped = fs.readdirSync(snapDir, { recursive: true }) as string[];
    expect(dumped.some((f) => path.basename(String(f)) === 'config.json')).toBe(false);
  });

  it('restoreSnapshot refuses to re-import excluded state from a crafted (pre-fix) snapshot', () => {
    // Craft a snapshot the way a PRE-fix BackupManager (or another machine)
    // could have produced it: excluded stores present in the files list with a
    // VALID integrity hash — only the per-file deny on the restore path can
    // keep them out of the state dir.
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# original identity\n');
    const id = '2026-01-01T000000Z';
    const snapDir = path.join(stateDir, 'backups', id);
    fs.mkdirSync(path.join(snapDir, 'state'), { recursive: true });
    const payload: Record<string, string> = {
      'AGENT.md': '# restored identity\n',
      [path.join('state', 'pr-hand-leases.json')]: '{"leases":{"echo/foo":{"holder":"resurrected-stale-lease"}}}\n',
      [path.join('state', 'external-hog-decisions.json')]: '{"decisions":{"hog-1":{"targetTuple":{"pid":999}}}}\n',
    };
    let totalBytes = 0;
    for (const [rel, content] of Object.entries(payload)) {
      fs.writeFileSync(path.join(snapDir, rel), content);
      totalBytes += Buffer.byteLength(content);
    }
    const files = Object.keys(payload);
    const integrityHash = crypto
      .createHash('sha256')
      .update(JSON.stringify({ files: [...files].sort(), totalBytes }))
      .digest('hex');
    fs.writeFileSync(
      path.join(snapDir, 'manifest.json'),
      JSON.stringify({ id, createdAt: '2026-01-01T00:00:00.000Z', trigger: 'manual', files, totalBytes, integrityHash }, null, 2),
    );

    const bm = new BackupManager(stateDir);
    bm.restoreSnapshot(id);

    // The legit file WAS restored — the restore genuinely ran.
    expect(fs.readFileSync(path.join(stateDir, 'AGENT.md'), 'utf-8')).toContain('restored identity');
    // The excluded stores were NOT re-imported.
    expect(fs.existsSync(path.join(stateDir, 'state', 'pr-hand-leases.json'))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, 'state', 'external-hog-decisions.json'))).toBe(false);
  });

  it('a legitimate file under a denied-siblings directory still restores (no over-blocking on the restore path)', () => {
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# original\n');
    const id = '2026-01-02T000000Z';
    const snapDir = path.join(stateDir, 'backups', id);
    fs.mkdirSync(path.join(snapDir, 'state'), { recursive: true });
    const rel = path.join('state', 'legit-runtime-note.json');
    const content = '{"keep":"me"}\n';
    fs.writeFileSync(path.join(snapDir, rel), content);
    const files = [rel];
    const totalBytes = Buffer.byteLength(content);
    const integrityHash = crypto
      .createHash('sha256')
      .update(JSON.stringify({ files: [...files].sort(), totalBytes }))
      .digest('hex');
    fs.writeFileSync(
      path.join(snapDir, 'manifest.json'),
      JSON.stringify({ id, createdAt: '2026-01-02T00:00:00.000Z', trigger: 'manual', files, totalBytes, integrityHash }, null, 2),
    );

    const bm = new BackupManager(stateDir);
    bm.restoreSnapshot(id);
    expect(fs.readFileSync(path.join(stateDir, rel), 'utf-8')).toContain('keep');
  });
});
