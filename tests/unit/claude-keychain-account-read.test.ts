/**
 * A keychain service can hold more than one Claude credential item, one per account
 * attribute. Live 2026-11-10 (gearfinity3d): an item filed under acct="unknown" on
 * 2026-11-08 sat beside the CLI's own item (acct=<user>). A bare `-s <service>` read
 * returned the stale one, so after a successful re-login the poller, the completion
 * sweep and the identity probe all kept reading a dead token: the login never
 * completed by itself and the account was never read again.
 *
 * Every instar read now asks for the CLI's account first. No real `security` runs:
 * child_process is mocked to model the two items.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const items = vi.hoisted(() => ({ byAccount: new Map<string, string>(), anyFirst: null as string | null, calls: [] as string[][] }));

function lookup(argv: string[]): string | null {
  items.calls.push(argv);
  const a = argv.indexOf('-a');
  if (a >= 0) return items.byAccount.get(argv[a + 1]) ?? null;
  return items.anyFirst;
}

vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  const execFile = ((cmd: string, argv: string[], opts: unknown, cb?: (e: Error | null, out?: string) => void) => {
    const callback = (typeof opts === 'function' ? opts : cb) as (e: Error | null, out?: unknown) => void;
    const hit = cmd === 'security' ? lookup(argv) : null;
    if (hit === null) callback(Object.assign(new Error('item not found'), { code: 44 }));
    else callback(null, { stdout: hit, stderr: '' });
  }) as unknown as typeof real.execFile;
  // promisify(execFile) resolves with the second callback arg; give it {stdout}.
  (execFile as unknown as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] =
    (cmd: string, argv: string[]) => new Promise((resolve, reject) => {
      const hit = cmd === 'security' ? lookup(argv) : null;
      if (hit === null) reject(Object.assign(new Error('item not found'), { code: 44 }));
      else resolve({ stdout: hit, stderr: '' });
    });
  const execFileSync = ((cmd: string, argv: string[]) => {
    const hit = cmd === 'security' ? lookup(argv) : null;
    if (hit === null) throw Object.assign(new Error('item not found'), { status: 44 });
    return hit;
  }) as unknown as typeof real.execFileSync;
  return { ...real, execFile, execFileSync, default: { ...real, execFile, execFileSync } };
});

const SERVICE = 'Claude Code-credentials-8aa0bca8';
const NEW = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-NEW"}}';
const STALE = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-STALE"}}';

describe('Claude credential keychain reads match the CLI item', () => {
  const priorUser = process.env.USER;
  beforeEach(() => {
    process.env.USER = 'dabombstudio';
    items.byAccount = new Map([['dabombstudio', NEW], ['unknown', STALE]]);
    items.anyFirst = STALE; // the keychain happens to list the stale item first
    items.calls = [];
  });
  afterEach(() => { process.env.USER = priorUser; vi.resetModules(); });

  it('the account attribute is the one the CLI uses: $USER, then the OS user name', async () => {
    const { claudeKeychainAccount } = await import('../../src/core/OAuthRefresher.js');
    expect(claudeKeychainAccount()).toBe('dabombstudio');
    delete process.env.USER;
    expect(claudeKeychainAccount()).toBe((await import('node:os')).userInfo().username);
  });

  it('async read returns the CLI item even when a stale item is listed first', async () => {
    const { readClaudeKeychainItem } = await import('../../src/core/OAuthRefresher.js');
    expect(await readClaudeKeychainItem(SERVICE)).toBe(NEW);
    expect(items.calls[0]).toEqual(['find-generic-password', '-a', 'dabombstudio', '-s', SERVICE, '-w']);
  });

  it('sync read does the same', async () => {
    const { readClaudeKeychainItemSync } = await import('../../src/core/OAuthRefresher.js');
    expect(readClaudeKeychainItemSync(SERVICE)).toBe(NEW);
  });

  it('an item written only under another account is still found (older tools)', async () => {
    items.byAccount = new Map([['someone-else', STALE]]);
    const { readClaudeKeychainItem } = await import('../../src/core/OAuthRefresher.js');
    expect(await readClaudeKeychainItem(SERVICE)).toBe(STALE);
    expect(items.calls.map((c) => c.includes('-a'))).toEqual([true, false]);
  });

  it('no item at all → null, never throws', async () => {
    items.byAccount = new Map();
    items.anyFirst = null;
    const { readClaudeKeychainItem, readClaudeKeychainItemSync } = await import('../../src/core/OAuthRefresher.js');
    expect(await readClaudeKeychainItem(SERVICE)).toBeNull();
    expect(readClaudeKeychainItemSync(SERVICE)).toBeNull();
  });

  it('the swap executor revision read (completion sweep baseline) sees the CLI item', async () => {
    const { defaultKeychainExec } = await import('../../src/core/CredentialSwapExecutor.js');
    expect(await defaultKeychainExec.readService(SERVICE)).toBe(NEW);
  });

  it('the credential store read used by the quota poller and identity probe sees the CLI item', async () => {
    if (process.platform !== 'darwin') return; // the keychain branch is darwin-only
    const { defaultCredentialStore } = await import('../../src/core/OAuthRefresher.js');
    expect(await defaultCredentialStore.readAsync!('/Users/dabombstudio/.claude-followme-gearfinity3d')).toBe(NEW);
    expect(defaultCredentialStore.read('/Users/dabombstudio/.claude-followme-gearfinity3d')).toBe(NEW);
  });
});
