/**
 * SEC-155: a keychain write never puts the secret on a command line. On macOS `ps` shows every user's
 * process arguments, so `security add-generic-password ... -w <secret>` exposed OAuth credentials and
 * vault master keys to other local accounts while the write ran. Writes now go to `security -i` on
 * standard input with the secret hex-encoded behind `-X`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { KEYCHAIN_STDIN_MAX_LINE, keychainAddInput, keychainWriteAsync, keychainWriteSync } from '../../src/core/keychainStdinWrite.js';

const SECRET = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-SECRET-VALUE"}}';

describe('keychainAddInput', () => {
  it('builds one add line with the secret hex-encoded, never in the clear', () => {
    const line = keychainAddInput({ account: 'mara', service: 'Claude Code-credentials', secret: SECRET, update: true });
    expect(line).toBe(`add-generic-password -U -a "mara" -s "Claude Code-credentials" -X "${Buffer.from(SECRET).toString('hex')}"\n`);
    expect(line).not.toContain('SECRET-VALUE');
    const hex = /-X "([0-9a-f]+)"/.exec(line)![1]!;
    expect(Buffer.from(hex, 'hex').toString('utf8')).toBe(SECRET); // the same bytes `-w` would have stored
  });

  it('adds -U only when updating', () => {
    expect(keychainAddInput({ account: 'a', service: 's', secret: 'x' })).toMatch(/^add-generic-password -a "a"/);
  });

  it('refuses a line longer than `security -i` reads whole (it would store a truncated item), and accepts one at the limit', () => {
    const overhead = keychainAddInput({ account: 'a', service: 's', secret: '' }).length;
    const fits = 'x'.repeat(Math.floor((KEYCHAIN_STDIN_MAX_LINE - overhead) / 2)); // each byte is two hex digits
    const atLimit = keychainAddInput({ account: 'a', service: 's', secret: fits }).length;
    expect(atLimit).toBeLessThanOrEqual(KEYCHAIN_STDIN_MAX_LINE);
    expect(atLimit).toBeGreaterThan(KEYCHAIN_STDIN_MAX_LINE - 2);
    expect(() => keychainAddInput({ account: 'a', service: 's', secret: fits + 'x' })).toThrow(/too long/);
    // A real Claude credential item (about 1,100 bytes) fits with room to spare.
    expect(() => keychainAddInput({ account: 'mara', service: 'Claude Code-credentials-01761045', secret: 'c'.repeat(1100), update: true })).not.toThrow();
  });

  it('refuses an account or service name that cannot be quoted safely', () => {
    for (const bad of ['a"b', 'a\\b', 'a\nb', 'a$b', 'a`b', '', 'x'.repeat(257)]) {
      expect(() => keychainAddInput({ account: bad, service: 's', secret: 'x' })).toThrow(/account name/);
      expect(() => keychainAddInput({ account: 'a', service: bad, secret: 'x' })).toThrow(/service name/);
    }
  });
});

describe('keychainWriteSync / keychainWriteAsync', () => {
  it('runs `security -i` with the command on standard input; the arguments never carry the secret', () => {
    const calls: Array<{ cmd: string; args: readonly string[]; opts: { input?: string; stdio?: unknown; timeout?: number } }> = [];
    const exec = ((cmd: string, args: readonly string[], opts: { input?: string }) => { calls.push({ cmd, args, opts }); return ''; }) as never;
    keychainWriteSync({ account: 'a', service: 's', secret: SECRET, update: true }, { stdio: ['ignore', 'ignore', 'ignore'], timeout: 3000, exec });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('security');
    expect(calls[0]!.args).toEqual(['-i']);
    expect(JSON.stringify(calls[0]!.args)).not.toContain('SECRET');
    expect(calls[0]!.opts.input).toContain(Buffer.from(SECRET).toString('hex'));
    expect(calls[0]!.opts.stdio).toEqual(['pipe', 'ignore', 'ignore']); // standard input must be a pipe
    expect(calls[0]!.opts.timeout).toBe(3000);
  });

  it('a failed write still throws, so callers keep their fallback', () => {
    const exec = (() => { throw new Error('exit 45'); }) as never;
    expect(() => keychainWriteSync({ account: 'a', service: 's', secret: 'x' }, { timeout: 1000, exec })).toThrow('exit 45');
  });

  it('the async write rejects an unsafe name before starting any process', async () => {
    await expect(keychainWriteAsync({ account: 'a"b', service: 's', secret: 'x' }, { timeout: 1000 })).rejects.toThrow(/account name/);
  });
});

describe('no keychain write in src passes the secret as an argument', () => {
  it('every add-generic-password goes through the stdin helper', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|js|mjs)$/.test(e.name)) {
          const src = fs.readFileSync(p, 'utf8');
          // An argument-array keychain add: the token quoted as its own argument.
          if (/['"]add-generic-password['"]/.test(src)) offenders.push(path.relative(process.cwd(), p));
        }
      }
    };
    walk(path.join(process.cwd(), 'src'));
    expect(offenders).toEqual([]);
  });
});
