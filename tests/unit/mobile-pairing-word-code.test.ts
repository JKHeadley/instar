/** docs/specs/mobile-pairing-word-code.md — word list rules, issue/check by format, display, leak scan. */
import { describe, it, expect } from 'vitest';
import { PAIRING_WORDS } from '../../src/core/pairingWords.js';
import { ConfirmationCodes, parseWordCode, displayCode } from '../../src/core/MobileDeviceKeys.js';
import { prettyCode } from '../../dashboard/phones.js';

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]!; d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j]!;
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return d[b.length]!;
}

const FUTURE = () => Date.now() + 60_000;

describe('pairing word list', () => {
  it('has exactly 256 unique uppercase words of 4–6 letters, no two within edit distance 1, none denylisted', () => {
    expect(PAIRING_WORDS).toHaveLength(256);
    const DENY = ['ECHO', 'AGENT', 'CLAUDE', 'CODE', 'PAIR', 'PIN', 'DAMN', 'HELL', 'SHIT', 'FUCK', 'CRAP', 'PISS', 'SLUT', 'WHORE', 'BITCH', 'NAZI', 'KILL', 'DEATH', 'DEAD', 'BOMB', 'GUN'];
    for (const w of DENY) expect(PAIRING_WORDS).not.toContain(w);
    expect(new Set(PAIRING_WORDS).size).toBe(256);
    for (const w of PAIRING_WORDS) expect(w).toMatch(/^[A-Z]{4,6}$/);
    for (let i = 0; i < PAIRING_WORDS.length; i++) {
      for (let j = i + 1; j < PAIRING_WORDS.length; j++) expect(editDistance(PAIRING_WORDS[i]!, PAIRING_WORDS[j]!)).toBeGreaterThan(1);
    }
  });
});

describe('word confirmation codes', () => {
  it('issues WORD+4 digits for a word device and 6 digits otherwise', () => {
    const c = new ConfirmationCodes();
    expect(c.issue('w', FUTURE(), 'word')).toMatch(/^[A-Z]{4,6}\d{4}$/);
    expect(c.issue('d', FUTURE())).toMatch(/^\d{6}$/);
    expect(c.formatOf('w')).toBe('word');
    expect(c.formatOf('d')).toBe('digits');
  });

  it('accepts every word-code form; a wrong well-formed code is wrong; anything else is wrong-format (no HMAC)', () => {
    const c = new ConfirmationCodes();
    const code = c.issue('w', FUTURE(), 'word');
    const word = code.slice(0, -4); const num = code.slice(-4);
    const forms = [`${word}-${num}`, `${word.toLowerCase()} ${num}`, `${word}${num}`, ` ${word}–${num} `, `${word}—${num}`, `${word}_${num}`, `${word}: ${num}`, `${word}.${num}`, `${word} - ${num}`];
    for (const typed of forms) expect(c.check('w', typed).result).toBe('ok');
    const otherNum = String((Number(num) + 1) % 10_000).padStart(4, '0');
    expect(c.check('w', `${word}-${otherNum}`).result).toBe('wrong');
    for (const bad of ['123456', '1234', `${word.split('').join(' ')} ${num}`, '', `${word}----${num}`, 'KITE', 42, null, 'KITE-4172'])
      expect(c.check('w', bad).result).toBe('wrong-format');
    const digits = c.issue('d', FUTURE());
    expect(c.check('d', `${digits.slice(0, 3)} ${digits.slice(3)}`).result).toBe('ok');
    expect(c.check('d', `${word}-${num}`).result).toBe('wrong'); // digits device: today's rule, a strike
  });

  it('parses and displays both forms', () => {
    expect(parseWordCode(' kite-4172 ')).toBe('KITE4172');
    expect(parseWordCode('K I T E 4172')).toBeNull();
    expect(displayCode('KITE4172')).toBe('KITE-4172');
    expect(displayCode('123456')).toBe('123 456');
    expect(prettyCode('KITE-4172')).toBe('KITE-4172');
    expect(prettyCode('123 456')).toBe('123 456');
  });

  it('the leak scan catches every accepted form, in running text and after many decoys; ignores unlisted words', () => {
    const c = new ConfirmationCodes();
    const code = c.issue('w', FUTURE(), 'word');
    const word = code.slice(0, -4); const num = code.slice(-4);
    for (const form of [`${word}-${num}`, `${word.toLowerCase()} ${num}`, `${word}–${num}`, `${word}_${num}`, `${word}: ${num}`, `${word}.${num}`, `${word} - ${num}`])
      expect(c.leakedIn(`see ${form}.`)).toEqual(['w']);
    expect(c.leakedIn(`x9${word}${num}`)).toEqual(['w']); // a digit on the left still matches
    const decoys = Array.from({ length: 200 }, (_, i) => `${PAIRING_WORDS[i % 256]}-${String(i).padStart(4, '0')}`).filter((d) => d !== `${word}-${num}`).join(' ');
    expect(c.leakedIn(`${decoys} ${word}-${num}`)).toEqual(['w']);
    expect(c.leakedIn('room ZZZZ-1234 and QWERTY 9999')).toEqual([]);
  });
});

describe('agent awareness: the never-ask line names the word-code form', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { PostUpdateMigrator, MOBILE_PAIRING_CLAUDEMD_SECTION, PAIRING_WITHOUT_TELEGRAM_CLAUDEMD_SECTION, PAIRING_WITHOUT_TELEGRAM_STALE_CODE_LINE, PAIRING_WITHOUT_TELEGRAM_CURRENT_CODE_LINE } = await import('../../src/core/PostUpdateMigrator.js');
  const { SafeFsExecutor } = await import('../../src/core/SafeFsExecutor.js');
  const migrate = (dir: string) => {
    const m = new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4321, hasTelegram: false, projectName: 'x' } as never);
    const r = { upgraded: [] as string[], errors: [] as string[], skipped: [] as string[] };
    (m as unknown as { migrateClaudeMd(r: unknown): void }).migrateClaudeMd(r);
    return r;
  };

  it('the template names KITE-4172 and an existing agent\'s old line is rewritten exactly once', () => {
    const fresh = MOBILE_PAIRING_CLAUDEMD_SECTION(4321);
    expect(fresh).toContain('like `KITE-4172`, or six digits');
    expect(fresh).not.toContain('6-digit');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-word-'));
    try {
      fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
      const old = fresh
        .replace(/- \*\*Never ask the operator for the confirmation code\*\*[^\n]*/, '- **Never ask the operator for the 6-digit confirmation code**, and never repeat it. If they paste it to me, that pairing is cancelled automatically; tell them to ask for a new link.')
        .replace('then type the confirmation code I send privately', 'then type the 6-digit code I send privately')
        .replace('send the owner a confirmation code (like `KITE-4172`, or six digits) **privately**', 'send the owner a 6-digit code **privately**') + '\n- Authentication: Uses a 6-digit PIN (auto-generated).\n'
        + PAIRING_WITHOUT_TELEGRAM_CLAUDEMD_SECTION()
          .replace('the confirmation code (like `KITE-4172`, or six digits) is not sent anywhere', 'the 6-digit code is not sent anywhere')
          .replace(PAIRING_WITHOUT_TELEGRAM_CURRENT_CODE_LINE, PAIRING_WITHOUT_TELEGRAM_STALE_CODE_LINE);
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `# Agent\n\nMine.\n${old}`);
      expect(old.match(/6-digit/g)!.length).toBe(5); // four pairing sentences + the unrelated PIN line
      expect(migrate(dir).upgraded).toContain('CLAUDE.md: Mobile pairing sentences name the confirmation code without fixing its shape');
      const after = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
      expect(after).toContain('Mine.');
      expect(after.match(/6-digit/g)).toEqual(['6-digit']); // only the unrelated PIN line remains
      expect(after).toContain('Uses a 6-digit PIN');
      expect(after).toContain(PAIRING_WITHOUT_TELEGRAM_CURRENT_CODE_LINE); // the older rewrite composed with this one
      expect(after).not.toContain(PAIRING_WITHOUT_TELEGRAM_STALE_CODE_LINE);
      expect(migrate(dir).upgraded.filter((u) => u.includes('confirmation code'))).toHaveLength(0);
      expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe(after);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/mobile-pairing-word-code.test.ts' });
    }
  });
});
