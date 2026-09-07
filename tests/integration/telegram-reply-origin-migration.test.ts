import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { telegramOriginCertificationAwareness, telegramOriginLeaseAwareness } from '../../src/messaging/telegram-origin/OriginAwareness.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const prior = fs.readFileSync('tests/fixtures/relay-history/telegram-reply-pre-origin.sh', 'utf8');
const expected = fs.readFileSync('src/templates/scripts/telegram-reply.sh', 'utf8');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, {
    recursive: true, force: true, operation: 'telegram-reply-origin-migration:test-cleanup',
  });
});

function installed(content: string) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-relay-migration-'));
  dirs.push(projectDir);
  const stateDir = path.join(projectDir, '.instar');
  const scripts = ['.claude/scripts/telegram-reply.sh', '.instar/scripts/telegram-reply.sh']
    .map(relative => path.join(projectDir, relative));
  for (const script of scripts) {
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, content, { mode: 0o755 });
  }
  const migrator = new PostUpdateMigrator({ projectDir, stateDir, port: 4042, hasTelegram: true, projectName: 'fixture' });
  const migrate = () => {
    const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
    (migrator as unknown as { migrateScripts(output: typeof result): void }).migrateScripts(result);
    return result;
  };
  return { scripts, stateDir, migrate };
}

describe('origin relay installed-upgrade parity', () => {
  it('adds rollout certification guidance to an existing origin section once, preserving operator notes', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-awareness-migration-'));
    dirs.push(projectDir);
    const file = path.join(projectDir, 'CLAUDE.md');
    fs.writeFileSync(file, '# Existing agent\n\n### Telegram message origin\n\nOperator note: preserve this workflow.\n');
    const shadows = ['AGENTS.md', 'GEMINI.md'].map(name => path.join(projectDir, name));
    for (const shadow of shadows) fs.writeFileSync(shadow, '# Existing shadow\n\n### Telegram message origin\n\nOperator shadow note.\n');
    const migrator = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'),
      port: 4042, hasTelegram: true, projectName: 'fixture' });
    const migrate = () => {
      const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
      (migrator as unknown as { migrateClaudeMd(output: typeof result): void }).migrateClaudeMd(result);
      (migrator as unknown as { migrateFrameworkShadowCapabilities(output: typeof result): void }).migrateFrameworkShadowCapabilities(result);
      expect(result.errors).toEqual([]);
      return fs.readFileSync(file, 'utf8');
    };
    const first = migrate();
    expect(first).toContain(telegramOriginCertificationAwareness());
    expect(first).toContain(telegramOriginLeaseAwareness());
    expect(first).toContain('messageOrigin.outageNotice.enabled');
    expect(first).toContain('Operator note: preserve this workflow.');
    const second = migrate();
    expect(second.split('Origin rollout certification:')).toHaveLength(2);
    expect(second.split('Origin lease renewal dependency:')).toHaveLength(2);
    expect(second.split('Message origins on your phone:')).toHaveLength(2);
    expect(second).toBe(first);
    for (const shadow of shadows) {
      const content = fs.readFileSync(shadow, 'utf8');
      expect(content).toContain('Operator shadow note.');
      expect(content).toContain('messageOrigin.outageNotice.enabled');
      expect(content.split('Origin rollout certification:')).toHaveLength(2);
      expect(content.split('Origin lease renewal dependency:')).toHaveLength(2);
      expect(content.split('Message origins on your phone:')).toHaveLength(2);
    }
  });

  it('upgrades both exact shipped v1.3.1225 relays, retains the old bytes, and is idempotent', () => {
    // Historical fixture from 77df8be42, not reconstructed from today's template.
    expect(createHash('sha256').update(prior).digest('hex'))
      .toBe('609f0fe432fe0c35043e05721658a24bcd21ae5b84fcbf99b37a75298e9499e6');
    expect(prior).not.toContain('X-Instar-Origin-Session');
    const fixture = installed(prior);
    expect(fixture.migrate().errors).toEqual([]);
    for (const script of fixture.scripts) {
      expect(fs.readFileSync(script, 'utf8')).toBe(expected);
      expect(fs.statSync(script).mode & 0o111).not.toBe(0);
      expect(fs.existsSync(`${script}.new`)).toBe(false);
    }
    const backupDir = path.join(fixture.stateDir, 'backups');
    const backups = fs.readdirSync(backupDir).filter(name => name.startsWith('telegram-reply.sh.'));
    expect(backups.length).toBeGreaterThan(0);
    expect(backups.every(name => fs.readFileSync(path.join(backupDir, name), 'utf8') === prior)).toBe(true);
    const second = fixture.migrate();
    expect(second.errors).toEqual([]);
    expect(second.upgraded.some(name => name.includes('telegram-reply.sh'))).toBe(false);
    expect(fs.readdirSync(backupDir).filter(name => name.startsWith('telegram-reply.sh.'))).toEqual(backups);
  });

  it('preserves a customized prior relay and offers the origin-aware candidate in both locations', () => {
    const customized = prior + '\n# Operator customization: preserve me.\n';
    const fixture = installed(customized);
    fixture.migrate();
    for (const script of fixture.scripts) {
      expect(fs.readFileSync(script, 'utf8')).toBe(customized);
      expect(fs.readFileSync(`${script}.new`, 'utf8')).toBe(expected);
    }
  });
});
