import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { cloudflaredSupportsTokenFile, writeTunnelTokenFile } from '../../src/tunnel/CloudflareNamedProvider.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/cloudflare-named-token-file.test.ts' }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-token-')); dirs.push(d); return d; };

/** A fake cloudflared that prints the given help text. */
function fakeBinary(help: string): string {
  const f = path.join(tmp(), 'cloudflared');
  fs.writeFileSync(f, `#!/bin/sh\ncat <<'X'\n${help}\nX\n`, { mode: 0o755 });
  return f;
}

describe('named tunnel token stays off the command line', () => {
  it('writes the token to a file only the owner can read, under the git-ignored secrets folder', () => {
    const stateDir = tmp();
    const file = writeTunnelTokenFile(stateDir, 'tok-value-123');
    expect(file).toBe(path.join(stateDir, 'secrets', 'cloudflared-token'));
    expect(fs.readFileSync(file!, 'utf-8')).toBe('tok-value-123');
    expect(fs.statSync(file!).mode & 0o777).toBe(0o600);
  });

  it('tightens an existing file that was readable by others', () => {
    const stateDir = tmp();
    fs.mkdirSync(path.join(stateDir, 'secrets'));
    fs.writeFileSync(path.join(stateDir, 'secrets', 'cloudflared-token'), 'old', { mode: 0o644 });
    const file = writeTunnelTokenFile(stateDir, 'new');
    expect(fs.statSync(file!).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file!, 'utf-8')).toBe('new');
  });

  it('returns null rather than throw when the folder cannot be written', () => {
    const blocker = path.join(tmp(), 'file-not-dir');
    fs.writeFileSync(blocker, '');
    expect(writeTunnelTokenFile(blocker, 'x')).toBeNull();
  });

  it('uses --token-file only on a binary that supports it', () => {
    expect(cloudflaredSupportsTokenFile(fakeBinary('   --token value\n   --token-file value  Filepath'))).toBe(true);
    expect(cloudflaredSupportsTokenFile(fakeBinary('   --token value'))).toBe(false);
    expect(cloudflaredSupportsTokenFile(path.join(tmp(), 'missing'))).toBe(false);
  });
});
