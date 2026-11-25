import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createManagedCodexWorkerHome, readManagedCodexWorkerHome } from '../../src/core/ManagedCodexWorkerHome.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const first = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

it.skipIf(!process.getuid)('allocates a fresh private home and refuses re-use or unverified paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-homes-'));
  try {
    const workspace = path.join(root, 'workspace');
    const state = path.join(root, 'state');
    fs.mkdirSync(workspace);
    fs.mkdirSync(state);
    const { home, homeIdentity } = createManagedCodexWorkerHome(state, workspace, first);
    expect(readManagedCodexWorkerHome(state, workspace, first, homeIdentity)).toBe(home);
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
    expect(readManagedCodexWorkerHome(state, workspace, other, homeIdentity)).toBeUndefined();
    expect(() => createManagedCodexWorkerHome(state, workspace, first)).toThrow();
    expect(() => createManagedCodexWorkerHome(state, root, other)).toThrow(/overlaps/);
    const nestedWorkspace = path.join(home, 'workspace');
    fs.mkdirSync(nestedWorkspace);
    expect(readManagedCodexWorkerHome(state, nestedWorkspace, first, homeIdentity)).toBeUndefined();
    expect(readManagedCodexWorkerHome(state, workspace, '../workspace', homeIdentity)).toBeUndefined();

    fs.symlinkSync(home, path.join(path.dirname(home), other), 'dir');
    expect(readManagedCodexWorkerHome(state, workspace, other, homeIdentity)).toBeUndefined();
    fs.chmodSync(home, 0o755);
    expect(readManagedCodexWorkerHome(state, workspace, first, homeIdentity)).toBeUndefined();
    fs.renameSync(home, home + '.old');
    fs.mkdirSync(home, { mode: 0o700 });
    expect(readManagedCodexWorkerHome(state, workspace, first, homeIdentity)).toBeUndefined();
  } finally {
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'managed-worker-home-fixture' });
  }
});
