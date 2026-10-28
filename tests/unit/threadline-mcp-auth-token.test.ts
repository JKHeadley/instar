/**
 * resolveMcpAuthToken — the Threadline MCP stdio helper's bearer source.
 *
 * Every own-surface /threadline/* route is bearer-gated (fb-829a7161-942), so
 * the out-of-process helper must present the real token. Order: env →
 * plaintext config → encrypted vault. The `{ secret: true }` placeholder is
 * never used as a token; an unreadable vault yields '' (honest 401 later,
 * never a forged header).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveMcpAuthToken } from '../../src/threadline/mcpAuthToken.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
function stateDir(config?: unknown): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-auth-'));
  dirs.push(d);
  if (config !== undefined) fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify(config));
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'threadline-mcp-auth-token-test.cleanup' });
});

const vaultWith = (v: unknown) => ({ get: (k: string) => (k === 'authToken' ? v : undefined) });
const lockedVault = { get: () => { throw new Error('wrong key'); } };

describe('resolveMcpAuthToken', () => {
  it('env INSTAR_AUTH_TOKEN wins over everything (the session-injected value)', () => {
    const d = stateDir({ port: 4111, authToken: 'from-config' });
    const r = resolveMcpAuthToken(d, { INSTAR_AUTH_TOKEN: 'from-env' }, { secretStore: vaultWith('from-vault') });
    expect(r).toEqual({ token: 'from-env', source: 'env', port: 4111 });
  });

  it('a plaintext config token is used when the env is empty, without opening the vault', () => {
    let opened = false;
    const d = stateDir({ port: 4112, authToken: 'from-config' });
    const r = resolveMcpAuthToken(d, {}, { secretStore: { get: () => { opened = true; return 'x'; } } });
    expect(r).toEqual({ token: 'from-config', source: 'config', port: 4112 });
    expect(opened).toBe(false);
  });

  it('the { secret: true } placeholder is never a token: the vault answers', () => {
    const d = stateDir({ port: 4113, authToken: { secret: true } });
    const r = resolveMcpAuthToken(d, {}, { secretStore: vaultWith('from-vault') });
    expect(r).toEqual({ token: 'from-vault', source: 'vault', port: 4113 });
  });

  it('a config with no token at all also falls through to the vault', () => {
    const d = stateDir({ port: 4114 });
    expect(resolveMcpAuthToken(d, {}, { secretStore: vaultWith('from-vault') }).source).toBe('vault');
  });

  it('a locked / unreadable vault yields no token (never throws, never forges)', () => {
    const d = stateDir({ authToken: { secret: true } });
    const r = resolveMcpAuthToken(d, {}, { secretStore: lockedVault });
    expect(r.token).toBe('');
    expect(r.source).toBe('none');
    expect(r.port).toBe(4040);
  });

  it('a vault whose authToken is not a string yields no token', () => {
    const d = stateDir({ authToken: { secret: true } });
    expect(resolveMcpAuthToken(d, {}, { secretStore: vaultWith({ secret: true }) }).token).toBe('');
    expect(resolveMcpAuthToken(d, {}, { secretStore: vaultWith('') }).token).toBe('');
  });

  it('a missing or corrupt config.json falls back to the default port and the vault', () => {
    const none = stateDir();
    expect(resolveMcpAuthToken(none, {}, { secretStore: vaultWith('v') })).toEqual({ token: 'v', source: 'vault', port: 4040 });
    const corrupt = stateDir();
    fs.writeFileSync(path.join(corrupt, 'config.json'), '{not json');
    expect(resolveMcpAuthToken(corrupt, {}, { secretStore: lockedVault, defaultPort: 4999 })).toEqual({ token: '', source: 'none', port: 4999 });
  });

  it('reads a REAL file-keyed vault when no store is injected (the secret-get path)', async () => {
    const { SecretStore } = await import('../../src/core/SecretStore.js');
    const d = stateDir({ port: 4115, authToken: { secret: true } });
    new SecretStore({ stateDir: d, forceFileKey: true }).set('authToken', 'vault-real');
    const r = resolveMcpAuthToken(d, {}, { secretStore: new SecretStore({ stateDir: d, forceFileKey: true }) });
    expect(r).toEqual({ token: 'vault-real', source: 'vault', port: 4115 });
  });
});
