/** Agent Awareness + Migration Parity for pairing and push without Telegram (mobile-native-conversations §4.4, §4.7). */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator, PAIRING_WITHOUT_TELEGRAM_CLAUDEMD_SECTION, PAIRING_WITHOUT_TELEGRAM_CLAUDEMD_MARKER, PAIRING_WITHOUT_TELEGRAM_STALE_CODE_LINE, PAIRING_WITHOUT_TELEGRAM_CURRENT_CODE_LINE } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type R = { upgraded: string[]; skipped: string[]; errors: string[] };
const count = (s: string) => s.split(PAIRING_WITHOUT_TELEGRAM_CLAUDEMD_MARKER).length - 1;

describe('Pairing a phone without Telegram CLAUDE.md section', () => {
  it('new agents get it from the template, once', () => {
    expect(count(generateClaudeMd('test', 'Test', 4042, false))).toBe(1);
  });

  it('existing agents get it once through migrateClaudeMd; idempotent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-notg-md-'));
    try {
      fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
      const file = path.join(dir, 'CLAUDE.md');
      fs.writeFileSync(file, '# CLAUDE.md\n');
      const m = new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
      const run = () => { const r: R = { upgraded: [], skipped: [], errors: [] }; (m as unknown as { migrateClaudeMd(r: R): void }).migrateClaudeMd(r); return r; };
      expect(run().upgraded).toContain('CLAUDE.md: added Pairing a phone without Telegram section');
      run();
      expect(count(fs.readFileSync(file, 'utf8'))).toBe(1);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/pairing-without-telegram-claude-md-awareness.test.ts' });
    }
  });

  it('names the Phones tab, the PIN unlock, the approval label and the reply push', () => {
    const s = PAIRING_WITHOUT_TELEGRAM_CLAUDEMD_SECTION();
    expect(s).toContain('Phones');
    expect(s).toContain('PIN');
    expect(s).toContain('approvedVia: dashboard-pin');
    expect(s).toContain('New reply');
    expect(s).toContain('I never read or relay that code');
    // The honest boundary: the agent can read the PIN, so this is weaker than a private chat.
    expect(s).toContain('weaker than a private Telegram chat');
    expect(s).not.toContain('my token alone cannot see it');
  });

  it('an agent that got the first wording has that line refreshed in place, once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-notg-md-'));
    try {
      fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
      const file = path.join(dir, 'CLAUDE.md');
      const old = PAIRING_WITHOUT_TELEGRAM_CLAUDEMD_SECTION().replace(PAIRING_WITHOUT_TELEGRAM_CURRENT_CODE_LINE, PAIRING_WITHOUT_TELEGRAM_STALE_CODE_LINE);
      expect(old).toContain(PAIRING_WITHOUT_TELEGRAM_STALE_CODE_LINE);
      fs.writeFileSync(file, '# CLAUDE.md\n' + old);
      const m = new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
      const run = () => { const r: R = { upgraded: [], skipped: [], errors: [] }; (m as unknown as { migrateClaudeMd(r: R): void }).migrateClaudeMd(r); return r; };
      expect(run().upgraded).toContain('CLAUDE.md: updated the Pairing a phone without Telegram code line');
      expect(run().upgraded).not.toContain('CLAUDE.md: updated the Pairing a phone without Telegram code line');
      const after = fs.readFileSync(file, 'utf8');
      expect(after).not.toContain(PAIRING_WITHOUT_TELEGRAM_STALE_CODE_LINE);
      expect(after.split(PAIRING_WITHOUT_TELEGRAM_CURRENT_CODE_LINE).length - 1).toBe(1);
      expect(count(after)).toBe(1);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/pairing-without-telegram-claude-md-awareness.test.ts' });
    }
  });
});
