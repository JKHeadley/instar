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
    expect(source).toContain("hookSchemaVersion: 1, messageAttemptId: uuidv7(), message, turnEvidence: evidence, topicHint: topicId");
    expect(source).not.toContain('High-recall, drop-only prefilter');
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

  it('upgrades the shipped awareness paragraph in place and remains idempotent', () => {
    const old = '- **Verify Before Done (observe-only v1).** Before claiming a same-turn action is complete, rely on real structural evidence from the tool that performed it. A Claude Stop hook reads only a bounded local transcript tail, emits scrubbed structural `TurnEvidence` (tool/action/safe target/success — never commands, results, secrets, or the transcript path), and records advisory completion-claim observations. It never blocks or rewrites a response. Prior-turn and background outcomes are explicitly not accused. The feature is dev-gated, dry-run first, and dark on the fleet; non-Claude frameworks no-op until they have an equivalent verified trace.';
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), `# Existing\n\n${old}\n`);
    const first: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (migrator as any).migrateClaudeMd(first);
    const once = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8');
    expect(once).not.toContain('Verify Before Done (observe-only v1)');
    expect(once.match(/Claim Verification awareness v2/g)).toHaveLength(1);
    const second: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (migrator as any).migrateClaudeMd(second);
    expect(fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8').match(/Claim Verification awareness v2/g)).toHaveLength(1);
  });
});
