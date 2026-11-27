// safe-fs-allow: isolated migration fixture cleanup uses SafeFsExecutor.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type Result = { upgraded: string[]; skipped: string[]; errors: string[] };
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => SafeFsExecutor.safeRmSync(dir, {
  recursive: true, force: true, operation: 'PostUpdateMigrator-feedbackTriageAccountQuota.test.ts',
})));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-account-migrate-'));
  dirs.push(root);
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  const migrator = new PostUpdateMigrator({ projectDir: root, stateDir, port: 4042,
    hasTelegram: false, projectName: 'test' });
  const result = (): Result => ({ upgraded: [], skipped: [], errors: [] });
  return { root, stateDir, migrator, result };
}

describe('feedback triage account quota migration and awareness', () => {
  it('adds the dark mode to missing config without changing an existing operator mode', () => {
    const { stateDir, migrator, result } = fixture();
    const file = path.join(stateDir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ feedbackFactory: { triage: {} } }));
    const first = result();
    (migrator as unknown as { migrateConfig(r: Result): void }).migrateConfig(first);
    expect(first.errors).toEqual([]);
    const read = () => JSON.parse(fs.readFileSync(file, 'utf8')) as { feedbackFactory: { triage: { accountSelectionMode: string } } };
    expect(read().feedbackFactory.triage.accountSelectionMode).toBe('off');
    const second = result();
    (migrator as unknown as { migrateConfig(r: Result): void }).migrateConfig(second);
    expect(second.upgraded.some((item) => item.includes('feedback triage account selection mode'))).toBe(false);
    const config = read();
    config.feedbackFactory.triage.accountSelectionMode = 'on';
    fs.writeFileSync(file, JSON.stringify(config));
    (migrator as unknown as { migrateConfig(r: Result): void }).migrateConfig(result());
    expect(read().feedbackFactory.triage.accountSelectionMode).toBe('on');
  });

  it('teaches both fresh and existing agents the same quota admission contract once', () => {
    const { root, migrator, result } = fixture();
    const fresh = generateClaudeMd('test', 'Echo', 4042, false);
    expect(fresh).toContain('feedbackFactory.triage.accountSelectionMode');
    expect(fresh).toContain('cached quota reading cannot admit a call');
    const file = path.join(root, 'CLAUDE.md');
    fs.writeFileSync(file, '**Feedback triage and execution (operated feedback factory)**\n');
    (migrator as unknown as { migrateClaudeMd(r: Result): void }).migrateClaudeMd(result());
    (migrator as unknown as { migrateClaudeMd(r: Result): void }).migrateClaudeMd(result());
    const migrated = fs.readFileSync(file, 'utf8');
    expect(migrated.match(/feedbackFactory\.triage\.accountSelectionMode/g)).toHaveLength(1);
    expect(migrated).toContain('cached usage cannot admit a call');
  });
});
