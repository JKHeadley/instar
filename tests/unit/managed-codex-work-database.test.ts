import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { openManagedCodexWorkDatabase } from '../../src/core/ManagedCodexWorkDatabase.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

it('opens existing shared work without provisioning a database on an unused installation', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-work-db-'));
  try {
    expect(openManagedCodexWorkDatabase(stateDir)).toBeUndefined();
    expect(fs.existsSync(path.join(stateDir, 'local'))).toBe(false);

    const created = openManagedCodexWorkDatabase(stateDir, true)!;
    try {
      expect(created.store.reserve('work', { sessionId: 'launch', machineId: 'local', ownerEpoch: 1, remaining: 1 })).toBe(true);
    } finally {
      created.close();
    }

    const existing = openManagedCodexWorkDatabase(stateDir)!;
    try {
      expect(existing.store.hasWorkClaim('work')).toBe(true);
    } finally {
      existing.close();
    }
  } finally {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'managed-work-db-fixture' });
  }
});

it('refuses a linked database directory instead of treating it as absent', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-work-db-link-'));
  try {
    fs.symlinkSync(os.tmpdir(), path.join(stateDir, 'local'), 'dir');
    expect(() => openManagedCodexWorkDatabase(stateDir)).toThrow(/symlink-refused/);
    expect(() => openManagedCodexWorkDatabase(stateDir, true)).toThrow(/symlink-refused/);
  } finally {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'managed-work-db-link-fixture' });
  }
});

it('refuses to open or provision when a sidecar exists without its database', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-work-db-orphan-'));
  try {
    const directory = path.join(stateDir, 'local', 'managed-codex-continuation');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'work.sqlite-wal'), 'orphaned');
    expect(() => openManagedCodexWorkDatabase(stateDir)).toThrow(/sidecar remains/);
    expect(() => openManagedCodexWorkDatabase(stateDir, true)).toThrow(/sidecar remains/);
  } finally {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'managed-work-db-orphan-fixture' });
  }
});

it('preserves the distinction between a missing or empty provisioned store and an unused installation', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-work-db-provisioned-'));
  try {
    const directory = path.join(stateDir, 'local', 'managed-codex-continuation');
    fs.mkdirSync(directory, { recursive: true });
    expect(() => openManagedCodexWorkDatabase(stateDir)).toThrow(/provisioned.*missing/);
    expect(() => openManagedCodexWorkDatabase(stateDir, true)).toThrow(/provisioned.*missing/);

    fs.writeFileSync(path.join(directory, 'work.sqlite'), '');
    expect(() => openManagedCodexWorkDatabase(stateDir)).toThrow(/no established authority schema/);
    expect(() => openManagedCodexWorkDatabase(stateDir, true)).toThrow(/no established authority schema/);
  } finally {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'managed-work-db-provisioned-fixture' });
  }
});
