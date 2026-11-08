import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import os from 'node:os';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { ACCOUNT_ACTION_SAFETY } from '../../src/data/accountActionSafety.js';
import { NORMAL_CHROME_BROWSER_SKILL_CONTENT } from '../../src/data/builtinSkillContent.js';
import { NORMAL_CHROME_BROWSER_CLAUDEMD_SECTION } from '../../src/core/PostUpdateMigrator.js';

import { ACCOUNT_PAGE_SAFETY_SCRIPT } from '../../src/data/accountPageSafetyScript.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
const source = ACCOUNT_PAGE_SAFETY_SCRIPT;
function browser(text: string, pathname = '/login', labels: string[] = []) {
  const document = { body: { innerText: text }, querySelectorAll: () => labels.map(textContent => ({ textContent, getAttribute: () => null })) };
  return vm.runInNewContext(source, { document, location: { href: `https://www.npmjs.com${pathname}` }, URL });
}
describe('account-action safety review', () => {
  it('catches the npm warning after a long prefix the original 300-char read missed', () => {
    const preflight = browser('A'.repeat(12000) + '\nYour account will be temporarily suspended for 72 hours.');
    expect(preflight(false, 0).kind).toBe('account-action-review');
  });
  it.each(['/login/recovery', '/account/recovery', '/2fa/backup'])('signals before arbitrary code on %s without inspecting caller code', pathname => {
    expect(browser('Sign in', pathname)(false, 0).kind).toBe('account-action-review');
  });
  it('recognizes recovery-code headings and fields without a suspension notice', () => {
    expect(browser('Enter your code', '/login', ['Recovery code'])(false, 0).kind).toBe('account-action-review');
  });
  it('keeps ordinary password, passkey, OAuth and TOTP flows autonomous', () => {
    for (const label of ['Password', 'Use a passkey', 'Authorize this app', 'Authenticator code']) {
      expect(browser('Sign in. You can also use a recovery code.', '/login', [label])(false, 0)).toBeNull();
    }
  });
  it('delivers every character of a dangerous page in explicit chunks without executing caller JS', () => {
    const text = 'Start\n' + 'x'.repeat(18000) + '\nYour account will be temporarily suspended.';
    const preflight = browser(text, '/login/recovery');
    let offset = 0; let combined = '';
    do {
      const chunk = JSON.parse(preflight(true, offset));
      expect(chunk.text.length).toBeLessThanOrEqual(6000);
      combined += chunk.text;
      expect(chunk.complete).toBe(chunk.nextOffset === null);
      offset = chunk.nextOffset;
    } while (offset !== null);
    expect(combined).toBe(text);
  });
  it.each([-1, NaN, 1.5, 100])('rejects invalid read offset %s', offset => {
    expect(() => browser('short')(true, offset)).toThrow('invalid-page-offset');
  });
  it('surfaces a not-yet-loaded document instead of treating it as a safe empty page', () => {
    const preflight = vm.runInNewContext(source, { document: { body: null }, location: { href: 'https://www.npmjs.com/login' }, URL });
    expect(preflight(false, 0).signals.unreadable).toBe(true);
    expect(() => preflight(true, 0)).toThrow('account-page-not-ready');
  });
  it('ignores hidden recovery fields while ordinary sign-in is visible', () => {
    const field = { textContent: 'Recovery code', hidden: true, getAttribute: () => null };
    const preflight = vm.runInNewContext(source, { document: { body: { innerText: 'Password' }, querySelectorAll: () => [field] }, location: { href: 'https://www.npmjs.com/login' }, URL });
    expect(preflight(false, 0)).toBeNull();
    field.hidden = false;
    expect(preflight(false, 0).kind).toBe('account-action-review');
  });
  it('identifies page changes across chunks so the reader can restart', () => {
    const document = { body: { innerText: 'x'.repeat(12000) }, querySelectorAll: () => [] };
    const preflight = vm.runInNewContext(source, { document, location: { href: 'https://www.npmjs.com/login' }, URL });
    const first = JSON.parse(preflight(true, 0));
    expect(JSON.parse(preflight(true, 6000)).pageFingerprint).toBe(first.pageFingerprint);
    document.body.innerText += ' Changed';
    expect(JSON.parse(preflight(true, 6000)).pageFingerprint).not.toBe(first.pageFingerprint);
  });
  it('lets the context-rich agent acknowledge a legitimate action on the exact current flagged page', () => {
    const preflight = browser('Your account will be suspended', '/login/recovery');
    const signal = preflight(false, 0);
    expect(preflight(false, 0, signal.pageFingerprint, 'I read the entire page and am inspecting a support example, not spending a code.')).toBeNull();
    expect(preflight(false, 0, signal.pageFingerprint, '')?.kind).toBe('account-action-review');
    expect(preflight(false, 0, signal.pageFingerprint, '   ')?.kind).toBe('account-action-review');
    expect(preflight(false, 0, 'stale-fingerprint', 'Reviewed the old page')?.kind).toBe('account-action-review');
  });
  it('returns a fresh advisory when the page changed after the acknowledged read', () => {
    const document = { body: { innerText: 'Your account will be suspended' }, querySelectorAll: () => [] };
    const preflight = vm.runInNewContext(source, { document, location: { href: 'https://www.npmjs.com/login' }, URL });
    const first = preflight(false, 0);
    document.body.innerText += ' for 72 hours';
    expect(preflight(false, 0, first.pageFingerprint, 'I read the old page').kind).toBe('account-action-review');
  });
  it('does not emit secret query/fragment parameters in page or advisory metadata', () => {
    const preflight = browser('Your account will be suspended', '/login?code=SECRET#token=SECRET');
    expect(JSON.stringify(preflight(false, 0))).not.toContain('SECRET');
    expect(preflight(true, 0)).not.toContain('SECRET');
  });
  it('ships the same policy to the installed skill and cross-framework CLAUDE awareness', () => {
    expect(NORMAL_CHROME_BROWSER_SKILL_CONTENT).toContain(ACCOUNT_ACTION_SAFETY);
    expect(NORMAL_CHROME_BROWSER_CLAUDEMD_SECTION()).toContain(ACCOUNT_ACTION_SAFETY);
  });
});

describe('account-action safety migration', () => {
  it('upgrades existing edited built-in skills idempotently and leaves a custom skill alone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-safety-migrate-'));
    try {
      const file = path.join(dir, '.claude/skills/normal-chrome-browser/SKILL.md');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '---\nname: normal-chrome-browser\n---\nMy custom browser notes.');
      const migrator = new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4040, hasTelegram: false, projectName: 'test' });
      const call = () => {
        const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
        (migrator as any).migrateAccountActionSafetySkill(result);
        return result;
      };
      expect(call().errors).toEqual([]);
      expect(fs.readFileSync(file, 'utf8')).toContain('My custom browser notes.');
      expect(fs.readFileSync(file, 'utf8')).toContain(ACCOUNT_ACTION_SAFETY);
      expect(call().upgraded).toEqual([]);
      fs.writeFileSync(file, 'Custom skill without built-in identity');
      call();
      expect(fs.readFileSync(file, 'utf8')).toBe('Custom skill without built-in identity');
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/account-page-safety.test.ts' });
    }
  });
});
