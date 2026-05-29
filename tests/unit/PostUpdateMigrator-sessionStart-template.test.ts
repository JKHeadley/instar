/**
 * Migration-parity regression test: getSessionStartHook now reads the bundled
 * template (src/templates/hooks/session-start.sh) so edits to it — notably the
 * macOS 26 escalation-spool drain — propagate to existing agents on update.
 * Previously it returned a hardcoded string literal that wouldn't pick up
 * template changes (Migration Parity Standard violation).
 *
 * Spec: docs/specs/macos26-launchd-tcc-runtime-relocation.md.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

describe('PostUpdateMigrator — session-start hook migration parity', () => {
  function newMigrator(projectDir: string): PostUpdateMigrator {
    return new PostUpdateMigrator({
      projectDir,
      stateDir: path.join(projectDir, '.instar'),
      port: 4042,
      hasTelegram: false,
      projectName: 'test',
    });
  }

  it('returns the bundled template content (including the escalation-spool drain)', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-sshook-'));
    try {
      const migrator = newMigrator(projectDir);
      // Access the private method via cast — same pattern other tests use.
      const body = (migrator as unknown as { getSessionStartHook(): string }).getSessionStartHook();
      // The bundled template carries the macOS 26 drain block; the old
      // hardcoded literal does NOT. This assertion proves the template-first
      // path is in use and the drain will propagate to existing agents.
      expect(body).toContain('macOS 26 TCC escalation-spool drain');
      expect(body).toContain('watchdog-escalations.jsonl');
      // And the spool-fast-path check (so we know the actual template, not a fragment).
      expect(body).toContain('if [ -s "$SPOOL" ]');
    } finally {
      try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* */ }
    }
  });
});
