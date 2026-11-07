import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import path from 'node:path';
const require = createRequire(import.meta.url);
const guardPath = path.resolve('src/templates/scripts/browser/lockout-guard.cjs');
const { warning, breakGlass, readOnly, action, mainWorldEnvelope, unwrapMainWorld } = require(guardPath);
function wrapped(code: string) {
  const r = spawnSync(process.execPath, [guardPath, 'wrap', '/unused', 'chrome-js.sh', 'acct', code, 'https://npmjs.com'], { encoding: 'utf8', env: { ...process.env, INSTAR_OPERATOR_APPROVAL: '' } });
  expect(r.status).toBe(0); return r.stdout;
}
describe('lockout safety', () => {
  it.each(['Your account will be suspended', 'Warning: account suspension', 'Account locking warning', 'Publishing is on hold for 72 hours', 'Your account may be locked', 'Enter a recovery code', 'Use a backup code', 'Disable two-factor authentication'])('detects %s', text => expect(warning(text)).toBe(true));
  it.each(['Welcome. Sign in with your password', 'Sign in with a passkey', 'Backup codes are available in Settings', 'Learn about recovery codes', 'Your OAuth token is ready'])('allows ordinary prose: %s', text => expect(warning(text)).toBe(false));
  it.each(['npm_recovery_codes', 'backupCodes', 'npm.backup-code', 'recovery_code_npm', 'break-glass codes', 'npm_break_glass'])('recognizes field %s', name => expect(breakGlass(name)).toBe(true));
  it.each(['password', 'bitwarden_master_password', 'oauth_token', 'passkey', 'backup_email', 'recovery_email'])('allows normal field %s', name => expect(breakGlass(name)).toBe(false));
  it('reads beyond the old 300 character cut before executing a submit', () => {
    let submitted = 0;
    const document = { body: { innerText: 'Welcome '.repeat(100) + 'Your account will be suspended' }, querySelector: () => ({ submit: () => submitted++ }) };
    expect(() => vm.runInNewContext(wrapped('document.querySelector("form").submit()'), { document })).toThrow(/ERR lockout-guard/);
    expect(submitted).toBe(0);
    document.body.innerText = 'Welcome. Sign in.';
    vm.runInNewContext(wrapped('document.querySelector("form").submit()'), { document });
    expect(submitted).toBe(1);
  });
  it('blocks click, location assignment, alias calls, and unknown code; reads are unaffected', () => {
    for (const code of ['button.click()', 'location.href="https://npmjs.com"', 'const f=button.click; f()', 'doSomething()', 'document.body.innerText="changed"', '[1].map(location.assign)', 'document.querySelector("form")["submit"]()']) expect(readOnly(code)).toBe(false);
    for (const code of ['document.body.innerText', 'document.body.innerText.slice(0,300)', 'document.title', 'location.origin', `JSON.stringify([...document.querySelectorAll('button')].map(b=>b.innerText))`, `document.querySelector('input').getAttribute('type')`]) {
      expect(readOnly(code)).toBe(true);
      if (code.includes('querySelector')) continue;
      expect(() => vm.runInNewContext(wrapped(code), { document: { title: 'Title', body: { innerText: 'Your account will be suspended' } }, location: { origin: 'https://npmjs.com' } })).not.toThrow();
    }
  });
  it('fails closed if page text cannot be read', () => {
    expect(() => vm.runInNewContext(wrapped('form.submit()'), { document: {} })).toThrow(/text unavailable/);
  });
  it('recognizes only a byte-exact main-world envelope, never caller environment claims', () => {
    const envelope = mainWorldEnvelope('R=document.title', 'mw123456789abc', 'mw123456789abcdef0');
    expect(unwrapMainWorld(envelope)).toBe('R=document.title');
    expect(unwrapMainWorld(envelope + ';form.submit()')).toBeNull();
    expect(unwrapMainWorld(envelope.replace('s.remove()', 'form.submit()'))).toBeNull();
  });
  it('binds approval to tool, target, code, and origin', () => {
    const a = action('chrome-js.sh', 'a', 'button.click()', 'https://npmjs.com');
    for (const args of [['chrome-mainworld.sh','a','button.click()','https://npmjs.com'], ['chrome-js.sh','b','button.click()','https://npmjs.com'], ['chrome-js.sh','a','form.submit()','https://npmjs.com'], ['chrome-js.sh','a','button.click()','https://other.test']]) expect(action(...args)).not.toBe(a);
  });
});
