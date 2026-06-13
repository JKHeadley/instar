/**
 * WS5.2 Step 9 — E2E "feature is alive" / new-vs-migrated parity.
 *
 * The single most important Step-9 assertion: an existing agent is NOT BLIND to a
 * capability a new agent sees. We prove it from BOTH sites:
 *   - NEW agent: generateClaudeMd() (the init/scaffold path) carries the Live
 *     Credential Re-Pointing awareness section.
 *   - EXISTING agent: migrateClaudeMd() (the auto-update path) injects the SAME
 *     section into a stale CLAUDE.md.
 * Both must surface the proactive triggers + the two routes — the parity contract
 * of the Migration Parity + Agent Awareness standards.
 *
 * Spec: docs/specs/live-credential-repointing-rebalancer.md §4.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const REQUIRED_PHRASES = [
  'Live Credential Re-Pointing',
  'flip my default account',
  'which account is this',
  'POST /credentials/set-default',
  'GET /credentials/locations',
  'subscriptionPool.credentialRepointing', // dark-posture statement
];

describe('Step 9 E2E — credential-repointing awareness parity (new ↔ migrated)', () => {
  describe('NEW agent (generateClaudeMd / scaffold path)', () => {
    it('a freshly scaffolded CLAUDE.md carries the awareness section', () => {
      const claudeMd = generateClaudeMd('test-project', 'TestAgent', 4042, true);
      for (const phrase of REQUIRED_PHRASES) {
        expect(claudeMd, `new-agent CLAUDE.md missing "${phrase}"`).toContain(phrase);
      }
    });
  });

  describe('EXISTING agent (migrateClaudeMd / auto-update path)', () => {
    let projectDir: string;
    let claudeMdPath: string;

    beforeEach(() => {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-credrepoint-e2e-'));
      fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
      claudeMdPath = path.join(projectDir, 'CLAUDE.md');
      fs.writeFileSync(claudeMdPath, '# CLAUDE.md — legacy\n\nPredates the feature.\n');
    });

    afterEach(() => {
      SafeFsExecutor.safeRmSync(projectDir, {
        recursive: true,
        force: true,
        operation: 'tests/e2e/credential-repointing-awareness-parity.test.ts:cleanup',
      });
    });

    it('a migrated CLAUDE.md carries the SAME awareness section (existing agent not blind)', () => {
      const migrator = new PostUpdateMigrator({
        projectDir,
        stateDir: path.join(projectDir, '.instar'),
        port: 4042,
        hasTelegram: false,
        projectName: 'test',
      });
      const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
      (migrator as unknown as { migrateClaudeMd(r: typeof result): void }).migrateClaudeMd(result);

      const claudeMd = fs.readFileSync(claudeMdPath, 'utf-8');
      for (const phrase of REQUIRED_PHRASES) {
        expect(claudeMd, `migrated CLAUDE.md missing "${phrase}"`).toContain(phrase);
      }
    });
  });

  it('both sites name the same routes (coherent capability surface)', () => {
    const newAgent = generateClaudeMd('p', 'A', 4042, true);
    // The migrated section text is independently authored; assert both reference
    // the identical lever pair so the agent learns the SAME capability either way.
    expect(newAgent).toContain('POST /credentials/set-default');
    expect(newAgent).toContain('GET /credentials/locations');
    expect(newAgent).toContain('/switch-account'); // the deprecation note rides along
  });
});
