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

  it('names the pairing code page, the PIN unlock, the approval label and the reply push', () => {
    const s = PAIRING_WITHOUT_TELEGRAM_CLAUDEMD_SECTION();
    expect(s).toContain('/dashboard/pair');
    expect(s).toContain('codePageUrl');
    expect(s).toContain('Copy');
    // The rewrite of older copies is keyed on "Phones"; the fresh section must never say it.
    expect(s).not.toContain('Phones');
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

  describe('older copies that sent the operator to the Phones tab (dashboard-console-default-and-pair-page §3.6)', () => {
    const PHONES_OPENING = 'An agent with no Telegram owner can still add a phone. The pairing link works the same; after the phone opens it, the confirmation code (like `KITE-4172`, or six digits) is not sent anywhere: it is shown on the dashboard\'s **Phones** tab, and only after the operator unlocks the dashboard with the PIN. The operator reads it there and types it into the app (or taps "Not my phone"). Where a Telegram owner exists, the code still goes to the owner\'s private Telegram chat.';
    const PHONES_OPENING_6DIGIT = 'An agent with no Telegram owner can still add a phone. The pairing link works the same; after the phone opens it, the 6-digit confirmation code is not sent anywhere: it is shown on the dashboard\'s **Phones** tab, and only after the operator unlocks the dashboard with the PIN. The operator reads it there and types it into the app (or taps "Not my phone"). Where a Telegram owner exists, the code still goes to the owner\'s private Telegram chat.';
    const phonesSend = (codeLine: string) => `- Send the operator the pairing link and the dashboard link, and tell them: open the link on the phone, then open the dashboard's Phones tab, unlock with the PIN, and type the code shown there into the app. ${codeLine}`;
    const PHONES_WHEN = '- **When to use** (PROACTIVE): "add you to my phone" on an agent without Telegram → mint the link and point the operator at the dashboard Phones tab.';
    const older = (opening: string, codeLine: string) => {
      const fresh = PAIRING_WITHOUT_TELEGRAM_CLAUDEMD_SECTION().split('\n');
      return fresh.map((l) => l.startsWith('An agent with no Telegram owner') ? opening
        : l.startsWith('- Send the operator the pairing link') ? phonesSend(codeLine)
        : l.startsWith('- **When to use**') ? PHONES_WHEN : l).join('\n');
    };
    const cases: Array<[string, string]> = [
      ['the word-code wording', older(PHONES_OPENING, PAIRING_WITHOUT_TELEGRAM_CURRENT_CODE_LINE)],
      ['the first code line', older(PHONES_OPENING, PAIRING_WITHOUT_TELEGRAM_STALE_CODE_LINE)],
      ['the pre-word-code 6-digit wording', older(PHONES_OPENING_6DIGIT, PAIRING_WITHOUT_TELEGRAM_CURRENT_CODE_LINE)],
      ['the 6-digit wording and the first code line', older(PHONES_OPENING_6DIGIT, PAIRING_WITHOUT_TELEGRAM_STALE_CODE_LINE)],
    ];
    for (const [name, section] of cases) {
      it(`${name}: rewritten to the fresh section, and a second run changes nothing`, () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-notg-md-'));
        try {
          fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
          const file = path.join(dir, 'CLAUDE.md');
          expect(section).toContain('Phones');
          fs.writeFileSync(file, '# CLAUDE.md\nUnrelated note: unlock with the 6-digit PIN, then open the Phones tab of another agent.\n' + section);
          const m = new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
          const run = () => { const r: R = { upgraded: [], skipped: [], errors: [] }; (m as unknown as { migrateClaudeMd(r: R): void }).migrateClaudeMd(r); return r; };
          expect(run().upgraded).toContain('CLAUDE.md: Pairing a phone without Telegram names the pairing code page');
          const once = fs.readFileSync(file, 'utf8');
          // Our three lines are fresh; an unrelated line that merely mentions Phones and the 6-digit PIN is untouched.
          expect(once).toContain(PAIRING_WITHOUT_TELEGRAM_CLAUDEMD_SECTION());
          expect(once).toContain('Unrelated note: unlock with the 6-digit PIN, then open the Phones tab of another agent.');
          expect(count(once)).toBe(1);
          expect(run().upgraded.filter((u) => u.includes('Pairing a phone without Telegram'))).toEqual([]);
          expect(fs.readFileSync(file, 'utf8')).toBe(once);
        } finally {
          SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/pairing-without-telegram-claude-md-awareness.test.ts' });
        }
      });
    }
  });
});
