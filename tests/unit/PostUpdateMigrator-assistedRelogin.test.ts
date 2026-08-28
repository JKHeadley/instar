import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'PostUpdateMigrator-assistedRelogin cleanup' });
  }
});

describe('PostUpdateMigrator assisted re-login awareness', () => {
  it('adds the authority-bounded repair guidance idempotently beside passive history', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-awareness-')); roots.push(root);
    fs.mkdirSync(path.join(root, '.instar'), { recursive: true });
    const target = path.join(root, 'CLAUDE.md');
    fs.writeFileSync(target, '# CLAUDE.md\n\n**Subscription Pool (multi-account quota + auto-swap + enrollment)**\n- **Sign-in reliability history (passive, never repair authority)** — Use this when asked “how often do subscriptions need sign-in again?” or “was this a real auth failure or a credential-store visibility gap?”.\n');
    const migrator = new PostUpdateMigrator({ projectDir: root, stateDir: path.join(root, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
    const run = () => {
      const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
      (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
      return result;
    };
    expect(run().upgraded).toContain('CLAUDE.md: added assisted subscription sign-in repair awareness');
    const once = fs.readFileSync(target, 'utf8');
    expect(once).toContain('Assisted sign-in repair (one approval, then autonomous)');
    expect(once).toContain('Never ask for or paste credentials into chat');
    run();
    expect(fs.readFileSync(target, 'utf8')).toBe(once);
  });
});
