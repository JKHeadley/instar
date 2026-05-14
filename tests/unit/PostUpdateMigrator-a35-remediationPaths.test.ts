/**
 * Unit tests for the F-7 / A35 hook-shape changes:
 *
 *   - `GitStateManager.DEFAULT_GITIGNORE` const literal carries the
 *     five remediation runtime path globs (per §A35 + §A50). Fresh
 *     `instar git init` writes them out.
 *
 *   - `BackupManager`'s inline exclusion list (the
 *     `REMEDIATION_EXCLUDED_PATH_PREFIXES`) is feature-flag gated by
 *     `isRemediationEnabled` — same pattern as `shared-state.jsonl*` /
 *     `isIntegratedBeingEnabled`. When the gate is on, user-added
 *     includeFiles entries whose paths begin with a remediation prefix
 *     are dropped from the resolved include list.
 *
 * Spec: docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md §A14 §A35 §A50.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  DEFAULT_GITIGNORE,
  REMEDIATION_GITIGNORE_ENTRIES,
} from '../../src/core/GitStateManager.js';
import {
  BackupManager,
  REMEDIATION_EXCLUDED_PATH_PREFIXES,
} from '../../src/core/BackupManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('A35 — DEFAULT_GITIGNORE remediation entries', () => {
  it('contains every required remediation glob', () => {
    expect(REMEDIATION_GITIGNORE_ENTRIES).toEqual([
      'remediation/system-reviewer-state-*.json',
      'remediation/inbox-*.jsonl',
      'remediation/audit-projection-*.jsonl',
      'remediation/cross-process-attempts-*.jsonl',
      'remediation/llm-raw-*.jsonl',
    ]);
    for (const entry of REMEDIATION_GITIGNORE_ENTRIES) {
      expect(DEFAULT_GITIGNORE).toContain(entry);
    }
  });
});

describe('A35 — BackupManager remediation exclusion (feature-flag gated)', () => {
  let stateDir: string;

  function makeStateDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-f7-bm-excl-'));
  }

  function cleanup(dir: string): void {
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-a35-remediationPaths.test.ts:cleanup',
    });
  }

  it('exports the five remediation path prefixes', () => {
    expect(REMEDIATION_EXCLUDED_PATH_PREFIXES).toEqual([
      '.instar/remediation/system-reviewer-state-',
      '.instar/remediation/inbox-',
      '.instar/remediation/audit-projection-',
      '.instar/remediation/cross-process-attempts-',
      '.instar/remediation/llm-raw-',
    ]);
  });

  it('drops remediation-prefixed includeFiles entries when the gate is ON', () => {
    stateDir = makeStateDir();
    try {
      const bm = new BackupManager(
        stateDir,
        {
          enabled: true,
          maxSnapshots: 1,
          includeFiles: [
            '.instar/remediation/system-reviewer-state-abc.json',
            '.instar/remediation/inbox-default.jsonl',
            'AGENT.md', // should survive
          ],
        },
        undefined,
        undefined,
        () => true, // isRemediationEnabled
      );
      const resolved = (bm as unknown as {
        resolveIncludedFiles: () => string[];
      }).resolveIncludedFiles.call(bm);

      expect(resolved).toContain('AGENT.md');
      expect(resolved).not.toContain('.instar/remediation/system-reviewer-state-abc.json');
      expect(resolved).not.toContain('.instar/remediation/inbox-default.jsonl');
    } finally {
      cleanup(stateDir);
    }
  });

  it('keeps remediation-prefixed includeFiles entries when the gate is OFF', () => {
    stateDir = makeStateDir();
    try {
      const bm = new BackupManager(
        stateDir,
        {
          enabled: true,
          maxSnapshots: 1,
          includeFiles: ['.instar/remediation/system-reviewer-state-abc.json', 'AGENT.md'],
        },
        undefined,
        undefined,
        () => false, // isRemediationEnabled
      );
      const resolved = (bm as unknown as {
        resolveIncludedFiles: () => string[];
      }).resolveIncludedFiles.call(bm);

      expect(resolved).toContain('.instar/remediation/system-reviewer-state-abc.json');
      expect(resolved).toContain('AGENT.md');
    } finally {
      cleanup(stateDir);
    }
  });

  it('treats absent isRemediationEnabled callback as gate=OFF (back-compat)', () => {
    stateDir = makeStateDir();
    try {
      const bm = new BackupManager(stateDir, {
        enabled: true,
        maxSnapshots: 1,
        includeFiles: ['.instar/remediation/inbox-default.jsonl', 'AGENT.md'],
      });
      const resolved = (bm as unknown as {
        resolveIncludedFiles: () => string[];
      }).resolveIncludedFiles.call(bm);

      // No callback supplied — exclusion is inactive, entry survives.
      // This is what every existing caller in the codebase expects;
      // F-7 is strictly additive.
      expect(resolved).toContain('.instar/remediation/inbox-default.jsonl');
      expect(resolved).toContain('AGENT.md');
    } finally {
      cleanup(stateDir);
    }
  });
});
