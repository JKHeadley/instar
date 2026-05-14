/**
 * Unit tests for RemediatorBootstrap — Tier-2 live-mode wire-up.
 *
 * Covers SELF-HEALING-REMEDIATOR-V2-SPEC §A57 (Tier-2 unlocks live mode)
 * and the structural opt-in via `remediator.enabled` config flag.
 *
 * Strategy: drive the bootstrap with the `INSTAR_REMEDIATION_KEY_PASSPHRASE`
 * env-passphrase backend so we exercise the real RemediationKeyVault path
 * without touching the OS keychain. Each test creates a fresh tmpdir for
 * full isolation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  bootstrapRemediator,
  __testing,
  type BootstrapResult,
} from '../../src/remediation/RemediatorBootstrap.js';
import { Remediator } from '../../src/remediation/Remediator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { nodeAbiMismatchRunbook } from '../../src/remediation/runbooks/node-abi-mismatch.js';

// ── Fixture helpers ──────────────────────────────────────────────────────

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'remediator-bootstrap-'));
}

function cleanupDir(dir: string): void {
  SafeFsExecutor.safeRmSync(dir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/RemediatorBootstrap.test.ts:cleanup',
  });
}

/**
 * Force the env-passphrase backend so we never touch the host keychain.
 * Sets the passphrase env var and the force flag the vault honours.
 */
function withEnvPassphrase<T>(fn: () => T | Promise<T>): T | Promise<T> {
  const PREV_PHRASE = process.env.INSTAR_REMEDIATION_KEY_PASSPHRASE;
  process.env.INSTAR_REMEDIATION_KEY_PASSPHRASE = 'unit-test-passphrase-xyz';
  const restore = () => {
    if (PREV_PHRASE === undefined) {
      delete process.env.INSTAR_REMEDIATION_KEY_PASSPHRASE;
    } else {
      process.env.INSTAR_REMEDIATION_KEY_PASSPHRASE = PREV_PHRASE;
    }
  };
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(restore) as Promise<T>;
    }
    restore();
    return result;
  } catch (err) {
    restore();
    throw err;
  }
}

/**
 * Forcibly bypass keychain detection so the env-passphrase fallback engages
 * even on developer macOS hosts running the test suite locally. The Vault's
 * `selectBackend` honours `forceBackend` and `backendDetectorOverride`.
 *
 * We achieve this by stubbing `RemediationKeyVault.forStateDir` indirectly:
 * we set the env-passphrase passphrase AND we override the global vault
 * resolver via a module-level spy.
 */
async function callBootstrapWithEnvBackend(opts: {
  stateDir: string;
  machineId: string;
}): Promise<BootstrapResult> {
  // Use dynamic import for fresh module state in each test, and force the
  // env-passphrase backend via the constructor options.
  const { RemediationKeyVault } = await import(
    '../../src/remediation/RemediationKeyVault.js'
  );
  const originalForStateDir = RemediationKeyVault.forStateDir;
  const spy = vi
    .spyOn(RemediationKeyVault, 'forStateDir')
    .mockImplementation((stateDir, options = {}) =>
      originalForStateDir.call(RemediationKeyVault, stateDir, {
        ...options,
        forceBackend: 'env-passphrase',
      }),
    );
  try {
    return await bootstrapRemediator(opts);
  } finally {
    spy.mockRestore();
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('RemediatorBootstrap', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = freshTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it('throws on missing stateDir', async () => {
    await expect(
      bootstrapRemediator({ stateDir: '', machineId: 'm1' }),
    ).rejects.toThrow(/stateDir is required/);
  });

  it('throws on missing machineId', async () => {
    await expect(
      bootstrapRemediator({ stateDir: tmpDir, machineId: '' }),
    ).rejects.toThrow(/machineId is required/);
  });

  it('returns {disabled, reason: "no-secret-backend"} when no backend is available', async () => {
    const { RemediationKeyVault, RemediationKeyVaultError } = await import(
      '../../src/remediation/RemediationKeyVault.js'
    );
    const spy = vi
      .spyOn(RemediationKeyVault, 'forStateDir')
      .mockRejectedValueOnce(
        new RemediationKeyVaultError(
          'no backend available (test)',
          'no-backend-available',
        ),
      );
    try {
      const result = await bootstrapRemediator({
        stateDir: tmpDir,
        machineId: 'm1',
      });
      expect(result.disabled).toBe(true);
      if (result.disabled) {
        expect(result.reason).toBe('no-secret-backend');
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('propagates non-"no-backend-available" vault errors', async () => {
    const { RemediationKeyVault, RemediationKeyVaultError } = await import(
      '../../src/remediation/RemediationKeyVault.js'
    );
    const spy = vi
      .spyOn(RemediationKeyVault, 'forStateDir')
      .mockRejectedValueOnce(
        new RemediationKeyVaultError(
          'something else broke',
          'master-missing',
        ),
      );
    try {
      await expect(
        bootstrapRemediator({ stateDir: tmpDir, machineId: 'm1' }),
      ).rejects.toThrow(/something else broke/);
    } finally {
      spy.mockRestore();
    }
  });

  it('wires up a full Remediator and registers W-1 + W-3 runbooks', async () => {
    await withEnvPassphrase(async () => {
      const result = await callBootstrapWithEnvBackend({
        stateDir: tmpDir,
        machineId: 'm-bootstrap-1',
      });
      expect(result.disabled).toBe(false);
      if (result.disabled) return; // type guard
      expect(result.remediator).toBeInstanceOf(Remediator);
      expect(result.vault).toBeDefined();
      expect(result.registeredRunbookIds).toContain('node-abi-mismatch');
      expect(result.registeredRunbookIds).toContain('messaging-delivery-failed');
    });
  });

  it('skips W-2/W-4 runbooks that are not yet on main (logs and continues)', async () => {
    await withEnvPassphrase(async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const result = await callBootstrapWithEnvBackend({
          stateDir: tmpDir,
          machineId: 'm-bootstrap-2',
        });
        expect(result.disabled).toBe(false);
        if (result.disabled) return;
        // Runbooks on main today: W-1 + W-3. W-2 and W-4 still skipped.
        expect(result.registeredRunbookIds).toEqual([
          'node-abi-mismatch',
          'messaging-delivery-failed',
        ]);
        const skipped = logSpy.mock.calls
          .map((c) => String(c[0] ?? ''))
          .filter((line) => line.includes('not yet on main — skipping'));
        expect(skipped.length).toBeGreaterThanOrEqual(2);
        expect(skipped.some((l) => l.includes('supervisor-preflight'))).toBe(true);
        expect(skipped.some((l) => l.includes('db-corruption'))).toBe(true);
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  it('accepts additionalRunbooks (test-fixture extension hook)', async () => {
    await withEnvPassphrase(async () => {
      const fixtureRunbook = {
        ...nodeAbiMismatchRunbook,
        id: 'fixture-runbook',
      };
      const result = await callBootstrapWithEnvBackend({
        stateDir: tmpDir,
        machineId: 'm-bootstrap-3',
      });
      expect(result.disabled).toBe(false);
      if (result.disabled) return;

      // additionalRunbooks via a second pass
      const result2 = await callBootstrapWithEnvBackend({
        stateDir: tmpDir + '-additional',
        machineId: 'm-bootstrap-additional',
      });
      expect(result2.disabled).toBe(false);
      // Clean up the second tmp dir we just created
      cleanupDir(tmpDir + '-additional');

      // Now exercise additionalRunbooks parameter end-to-end
      const tmpDir3 = freshTmpDir();
      try {
        const { bootstrapRemediator: bootstrap } = await import(
          '../../src/remediation/RemediatorBootstrap.js'
        );
        const { RemediationKeyVault } = await import(
          '../../src/remediation/RemediationKeyVault.js'
        );
        const originalForStateDir = RemediationKeyVault.forStateDir;
        const spy = vi
          .spyOn(RemediationKeyVault, 'forStateDir')
          .mockImplementation((s, o = {}) =>
            originalForStateDir.call(RemediationKeyVault, s, {
              ...o,
              forceBackend: 'env-passphrase',
            }),
          );
        try {
          const r = await bootstrap({
            stateDir: tmpDir3,
            machineId: 'm-bootstrap-3-extra',
            additionalRunbooks: [fixtureRunbook],
          });
          expect(r.disabled).toBe(false);
          if (!r.disabled) {
            expect(r.registeredRunbookIds).toContain('fixture-runbook');
          }
        } finally {
          spy.mockRestore();
        }
      } finally {
        cleanupDir(tmpDir3);
      }

      void fixtureRunbook;
    });
  });

  it('throws on runbook registration validation failures (A6/A36)', async () => {
    await withEnvPassphrase(async () => {
      const tmpDir2 = freshTmpDir();
      try {
        // Forge an invalid runbook — essential=true + blastRadius='process'
        // violates §A36. Bootstrap must surface the failure, not swallow it.
        const invalidRunbook = {
          ...nodeAbiMismatchRunbook,
          id: 'invalid-essential',
          essential: true,
          blastRadius: 'process' as const,
        };
        const { RemediationKeyVault } = await import(
          '../../src/remediation/RemediationKeyVault.js'
        );
        const originalForStateDir = RemediationKeyVault.forStateDir;
        const spy = vi
          .spyOn(RemediationKeyVault, 'forStateDir')
          .mockImplementation((s, o = {}) =>
            originalForStateDir.call(RemediationKeyVault, s, {
              ...o,
              forceBackend: 'env-passphrase',
            }),
          );
        try {
          await expect(
            bootstrapRemediator({
              stateDir: tmpDir2,
              machineId: 'm-bootstrap-4',
              additionalRunbooks: [invalidRunbook],
            }),
          ).rejects.toThrow(/essential/);
        } finally {
          spy.mockRestore();
        }
      } finally {
        cleanupDir(tmpDir2);
      }
    });
  });
});

describe('RemediatorBootstrap.__testing helpers', () => {
  it('makeAuditTokenVerifier accepts the vault audit leaf and rejects others', async () => {
    await withEnvPassphrase(async () => {
      const tmpDir2 = freshTmpDir();
      try {
        const { RemediationKeyVault } = await import(
          '../../src/remediation/RemediationKeyVault.js'
        );
        const vault = await RemediationKeyVault.forStateDir(tmpDir2, {
          forceBackend: 'env-passphrase',
        });
        const verifier = __testing.makeAuditTokenVerifier(vault);
        const auditLeaf = vault.deriveLeafKey('audit', null);
        expect(verifier({ auditToken: auditLeaf })).toBe(true);
        expect(verifier({ auditToken: Buffer.alloc(0) })).toBe(false);
        expect(verifier({ auditToken: Buffer.alloc(32, 0xff) })).toBe(false);
      } finally {
        cleanupDir(tmpDir2);
      }
    });
  });

  it('buildApprovalChannels orders by primary kind, includes both kinds', () => {
    const telegramFirst = __testing.buildApprovalChannels('telegram');
    expect(telegramFirst.map((c) => c.kind)).toEqual(['telegram', 'cli']);
    const cliFirst = __testing.buildApprovalChannels('cli');
    expect(cliFirst.map((c) => c.kind)).toEqual(['cli', 'telegram']);
  });

  it('constantTimeEqual returns true on equal buffers, false otherwise', () => {
    const a = Buffer.from([1, 2, 3, 4]);
    const b = Buffer.from([1, 2, 3, 4]);
    const c = Buffer.from([1, 2, 3, 5]);
    const d = Buffer.from([1, 2, 3]);
    expect(__testing.constantTimeEqual(a, b)).toBe(true);
    expect(__testing.constantTimeEqual(a, c)).toBe(false);
    expect(__testing.constantTimeEqual(a, d)).toBe(false);
  });

  it('tryLoadOptionalRunbook returns null for not-yet-merged wrappers', () => {
    expect(__testing.tryLoadOptionalRunbook('supervisor-preflight')).toBeNull();
    expect(__testing.tryLoadOptionalRunbook('db-corruption')).toBeNull();
  });
});
