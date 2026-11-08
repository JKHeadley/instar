/**
 * BackupManager — skill-learning-sentinel decision 21: snapshots include the
 * canonical skills, the skill-learning shards, the use telemetry, and the
 * derived cache with its WAL/SHM companions (a directory-prefixed glob).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackupManager } from '../../src/core/BackupManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('BackupManager — skill-learning paths (decision 21)', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-skill-learning-'));
    fs.writeFileSync(path.join(stateDir, 'AGENT.md'), '# agent');
    const put = (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(stateDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(stateDir, rel), content);
    };
    put('skills/ci-health-report/SKILL.md', '---\nname: ci-health-report\ndescription: "x"\nmetadata:\n  instar-learned-origin: "skill-learning-sentinel"\n---\nbody');
    put('skills/ci-health-report/references/notes.md', 'ref');
    put('skill-learning/ledger/m_a.0.jsonl', '{"eventId":"1"}\n');
    put('skill-learning/journal/m_a.jsonl', '{"op":"render-commit"}\n');
    put('skill-learning/rendered-baselines/m_a.json', '{"version":1}');
    put('skill-telemetry/m_a.jsonl', '{"skill":"ci-health-report"}\n');
    put('state/skill-learning.db', 'sqlite');
    put('state/skill-learning.db-wal', 'wal');
    put('state/skill-learning.db-shm', 'shm');
    put('state/unrelated.db', 'not ours');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/BackupManager-skillLearning.test.ts' });
  });

  it('includes skills/, skill-learning/, skill-telemetry/ and state/skill-learning.db* in a snapshot', () => {
    const snapshot = new BackupManager(stateDir).createSnapshot('manual');
    const files = snapshot.files.map((f) => f.split(path.sep).join('/'));
    expect(files).toContain('skills/ci-health-report/SKILL.md');
    expect(files).toContain('skills/ci-health-report/references/notes.md');
    expect(files).toContain('skill-learning/ledger/m_a.0.jsonl');
    expect(files).toContain('skill-learning/journal/m_a.jsonl');
    expect(files).toContain('skill-learning/rendered-baselines/m_a.json');
    expect(files).toContain('skill-telemetry/m_a.jsonl');
    expect(files).toContain('state/skill-learning.db');
    expect(files).toContain('state/skill-learning.db-wal');
    expect(files).toContain('state/skill-learning.db-shm');
    expect(files).not.toContain('state/unrelated.db');
    const copied = path.join(stateDir, 'backups', snapshot.id, 'state', 'skill-learning.db-wal');
    expect(fs.readFileSync(copied, 'utf-8')).toBe('wal');
  });

  it('a user-added includeFiles entry is unioned with the new defaults (defaults are not replaced)', () => {
    fs.writeFileSync(path.join(stateDir, 'extra.json'), '{}');
    const snapshot = new BackupManager(stateDir, { includeFiles: ['extra.json'] }).createSnapshot('manual');
    const files = snapshot.files.map((f) => f.split(path.sep).join('/'));
    expect(files).toContain('extra.json');
    expect(files).toContain('skill-telemetry/m_a.jsonl');
    expect(files).toContain('state/skill-learning.db');
  });

  it('the root-level glob precedent still expands (shared-state.jsonl*)', () => {
    fs.writeFileSync(path.join(stateDir, 'shared-state.jsonl'), '{}\n');
    fs.writeFileSync(path.join(stateDir, 'shared-state.jsonl.1700000000'), '{}\n');
    const snapshot = new BackupManager(stateDir, undefined, undefined, () => true).createSnapshot('manual');
    const files = snapshot.files.map((f) => f.split(path.sep).join('/'));
    expect(files).toContain('shared-state.jsonl');
    expect(files).toContain('shared-state.jsonl.1700000000');
  });
});
