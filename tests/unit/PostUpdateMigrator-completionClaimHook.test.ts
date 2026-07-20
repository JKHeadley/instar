import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

describe('PostUpdateMigrator — Verify Before Done hook parity', () => {
  let projectDir: string;
  let migrator: PostUpdateMigrator;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'completion-hook-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    migrator = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'),
      port: 4042, hasTelegram: false, projectName: 'test' });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'completion-hook-test' }));

  it('always installs the executable bounded structural observer and never uploads a transcript path', () => {
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (migrator as any).migrateHooks(result);
    const file = path.join(projectDir, '.instar', 'hooks', 'instar', 'completion-claim-observe.js');
    const source = fs.readFileSync(file, 'utf8');
    expect(source).toBe(migrator.getHookContent('completion-claim-observe'));
    expect(fs.statSync(file).mode & 0o111).not.toBe(0);
    expect(source).toContain('512 * 1024');
    expect(source).toContain('toolResultOnly');
    expect(source).toContain("body: JSON.stringify({ message, evidence, topicId })");
    expect(source).toContain("setTimeout(() => { controller.abort(); process.exit(0); }, 25)");
    expect(source).toContain("void fetch('http://127.0.0.1:'");
    expect(source).not.toContain("await fetch('http://127.0.0.1:'");
    expect(source).toContain("feature.redactIdentifiers === true");
    expect(source).toContain("'X-Instar-Bind-Token'");
    expect(source).not.toMatch(/JSON\.stringify\(\{[^}]*transcript[_P]/);
    for (const redaction of ['gh***_REDACTED', 'xox*-REDACTED', 'TELEGRAM_BOT_TOKEN_REDACTED', 'AWS_ACCESS_KEY_REDACTED', 'JWT_REDACTED']) {
      expect(source).toContain(redaction);
    }
    expect(result.errors).toEqual([]);
  });

  it('reconciles exactly one Stop registration without removing existing hooks', () => {
    fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.claude', 'settings.json'), JSON.stringify({ hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'node existing-stop.js' }] }],
    } }));
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (migrator as any).migrateSettings(result);
    (migrator as any).migrateSettings(result);
    const settings = JSON.parse(fs.readFileSync(path.join(projectDir, '.claude', 'settings.json'), 'utf8'));
    const commands = settings.hooks.Stop.flatMap((entry: any) => entry.hooks).map((hook: any) => hook.command);
    expect(commands).toContain('node existing-stop.js');
    expect(commands.filter((command: string) => command.includes('completion-claim-observe.js'))).toHaveLength(1);
  });
});
