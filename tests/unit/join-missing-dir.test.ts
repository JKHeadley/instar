import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { joinMesh } from '../../src/commands/machine.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/**
 * `instar join <pairing-url> --dir <path>` with a --dir that does not exist yet
 * crashed with ENOENT writing <dir>/.instar/config.json (found on the real
 * Studio + M5 proof rig, 2026-11-07). The scaffold step must create the state
 * folder first.
 */
describe('joinMesh with a --dir that does not exist yet', () => {
  const roots: string[] = [];
  afterEach(() => { vi.restoreAllMocks(); for (const r of roots) SafeFsExecutor.safeRmSync(r, { recursive: true, force: true, operation: 'join-missing-dir-test-cleanup' }); });

  it('creates the state folder and writes the machine-local config instead of crashing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'join-missing-dir-'));
    roots.push(root);
    const dir = path.join(root, 'not-yet', 'home');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);
    // An unreachable pairing URL: every step after the scaffold may fail, but not with ENOENT.
    const outcome = await joinMesh('http://127.0.0.1:9', { code: 'AB-CD-1234', dir, port: 4999 } as never)
      .then(() => 'ok', (err: unknown) => String(err instanceof Error ? err.message : err));
    expect(outcome).not.toMatch(/ENOENT/);
    const config = JSON.parse(fs.readFileSync(path.join(dir, '.instar', 'config.json'), 'utf-8'));
    expect(config.port).toBe(4999);
    expect(typeof config.authToken).toBe('string');
  }, 30_000);
});
