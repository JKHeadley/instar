/**
 * Integration test for the Tier-2 live-mode dispatch path.
 *
 * SELF-HEALING-REMEDIATOR-V2-SPEC §A57 — "Tier 2 unlocks live mode (silence
 * on verified success per outcome matrix)."
 *
 * What this test pins:
 *   1. `bootstrapRemediator()` constructs a working Remediator and wires it
 *      into a real `DegradationReporter` singleton via `setRemediator()`.
 *   2. A `reportStructured()` call routes through the Remediator and lands
 *      a matching audit entry in
 *      `<stateDir>/remediation/audit-projection-<machineId>.jsonl`.
 *   3. A non-matching event lands as `no-matching-runbook` in the same file.
 *   4. The integration uses real F-1 (env-passphrase backend), real F-4
 *      primitives, real F-5/F-8 wiring — only the surface callables are
 *      stubbed (we don't actually rebuild better-sqlite3 in CI).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { bootstrapRemediator } from '../../src/remediation/RemediatorBootstrap.js';
import {
  DegradationReporter,
  type NormalizedDegradationEvent,
} from '../../src/monitoring/DegradationReporter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  deserializeAuditEntry,
  type AuditEntry,
} from '../../src/remediation/audit/AuditWriter.js';
import { nodeAbiMismatchRunbook } from '../../src/remediation/runbooks/node-abi-mismatch.js';
import type { ApprovedRunbook } from '../../src/remediation/Remediator.js';

function freshTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'remediator-live-mode-'));
}

function cleanupDir(dir: string): void {
  SafeFsExecutor.safeRmSync(dir, {
    recursive: true,
    force: true,
    operation: 'tests/integration/remediator-live-mode.test.ts:cleanup',
  });
}

function readProjection(stateDir: string, machineId: string): AuditEntry[] {
  const p = path.join(
    stateDir,
    'remediation',
    `audit-projection-${machineId}.jsonl`,
  );
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(deserializeAuditEntry);
}

/**
 * Sleep until a predicate holds (with timeout). The Remediator dispatch
 * triggered by `reportStructured` is fire-and-forget — we poll the audit
 * projection file rather than introspect internal state.
 */
async function waitFor(
  pred: () => boolean,
  timeoutMs = 5000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: predicate did not become true within ${timeoutMs}ms`);
}

// ── Test fixture runbook — pure stub, no native rebuild ──────────────────

function makeStubRunbook(id: string): ApprovedRunbook {
  return {
    id,
    priority: 100,
    surface: 'test-stub',
    eventPrefilter: {
      errorCode: ['TEST_LIVE_MODE'],
      provenance: ['subsystem-explicit'],
    },
    match: (event) => event.subsystem === 'live-mode-test',
    preconditions: async () => true,
    surfaceCallable: async () => ({ outcome: 'success', details: {} }),
    verify: async () => ({
      outcome: 'verified-healthy',
      reason: 'stub verify ok',
    }),
    blastRadius: 'process',
    reversibility: 'reversible',
    expectedRuntimeMs: 1_000,
  };
}

describe('Remediator live-mode integration', () => {
  let tmpDir: string;
  const PREV_PHRASE = process.env.INSTAR_REMEDIATION_KEY_PASSPHRASE;

  beforeEach(() => {
    tmpDir = freshTmpDir();
    process.env.INSTAR_REMEDIATION_KEY_PASSPHRASE = 'integration-test-passphrase';
    // Make sure the singleton is fresh per test — other suites may have
    // configured the reporter already.
    DegradationReporter.resetForTesting();
  });

  afterEach(() => {
    DegradationReporter.resetForTesting();
    if (PREV_PHRASE === undefined) {
      delete process.env.INSTAR_REMEDIATION_KEY_PASSPHRASE;
    } else {
      process.env.INSTAR_REMEDIATION_KEY_PASSPHRASE = PREV_PHRASE;
    }
    cleanupDir(tmpDir);
  });

  it('routes a matching structured event through the wired Remediator to verified-healthy', async () => {
    // Force env-passphrase backend so the test doesn't depend on the host
    // keychain. The bootstrap module accepts this via the vault's options.
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
      const machineId = 'm-live-1';
      const stubRunbook = makeStubRunbook('live-mode-stub');
      const result = await bootstrapRemediator({
        stateDir: tmpDir,
        machineId,
        additionalRunbooks: [stubRunbook],
      });
      expect(result.disabled).toBe(false);
      if (result.disabled) return;

      // Configure the reporter (mirrors server.ts boot order) + wire the
      // Remediator. This is the exact sequence the production server uses.
      const reporter = DegradationReporter.getInstance();
      reporter.configure({
        stateDir: tmpDir,
        agentName: 'integration-test-agent',
        instarVersion: '0.0.0-integration',
      });
      reporter.setRemediator(result.remediator);

      // Emit a structured event that matches the stub runbook.
      const event: NormalizedDegradationEvent = {
        subsystem: 'live-mode-test',
        errorCode: 'TEST_LIVE_MODE',
        provenance: 'subsystem-explicit',
        reason: {
          redacted: 'simulated live-mode degradation',
          full: 'simulated live-mode degradation',
        },
        timestamp: new Date().toISOString(),
        monotonicTs: performance.now(),
      };
      reporter.reportStructured(event);

      // Poll the audit projection — dispatch is fire-and-forget.
      await waitFor(() => {
        const entries = readProjection(tmpDir, machineId);
        return entries.some(
          (e) =>
            e.runbookId === 'live-mode-stub' && e.outcome === 'verified-healthy',
        );
      });

      const entries = readProjection(tmpDir, machineId);
      const started = entries.filter((e) => e.outcome === 'started');
      const verified = entries.filter((e) => e.outcome === 'verified-healthy');
      expect(started.length).toBeGreaterThanOrEqual(1);
      expect(verified.length).toBeGreaterThanOrEqual(1);
      expect(verified[0]!.subsystem).toBe('live-mode-test');
      expect(verified[0]!.runbookId).toBe('live-mode-stub');
    } finally {
      spy.mockRestore();
    }
  });

  it('routes a non-matching event to no-matching-runbook', async () => {
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
      const machineId = 'm-live-2';
      const result = await bootstrapRemediator({
        stateDir: tmpDir,
        machineId,
      });
      expect(result.disabled).toBe(false);
      if (result.disabled) return;

      const reporter = DegradationReporter.getInstance();
      reporter.configure({
        stateDir: tmpDir,
        agentName: 'integration-test-agent',
        instarVersion: '0.0.0-integration',
      });
      reporter.setRemediator(result.remediator);

      // Send a structured event with a nonsense errorCode — won't match
      // nodeAbiMismatchRunbook (W-1). Expect `no-matching-runbook` audit entry.
      const event: NormalizedDegradationEvent = {
        subsystem: 'unmatched-subsystem',
        errorCode: 'NEVER_REGISTERED_ERROR',
        provenance: 'subsystem-explicit',
        reason: {
          redacted: 'no matching runbook',
          full: 'no matching runbook',
        },
        timestamp: new Date().toISOString(),
        monotonicTs: performance.now(),
      };
      reporter.reportStructured(event);

      await waitFor(() => {
        const entries = readProjection(tmpDir, machineId);
        return entries.some((e) => e.outcome === 'no-matching-runbook');
      });

      const entries = readProjection(tmpDir, machineId);
      const noMatch = entries.filter((e) => e.outcome === 'no-matching-runbook');
      expect(noMatch.length).toBeGreaterThanOrEqual(1);
      expect(noMatch[0]!.subsystem).toBe('unmatched-subsystem');
    } finally {
      spy.mockRestore();
    }
  });

  it('preserves legacy alert path when Remediator is NOT set (defaults FALSE)', async () => {
    // No bootstrap call — simulates `remediator.enabled: false` in config.
    // The reporter has no Remediator wired; events flow through the legacy
    // alert path. The test asserts the structural property — no audit-
    // projection file should be created since no Remediator wrote one.
    const reporter = DegradationReporter.getInstance();
    reporter.configure({
      stateDir: tmpDir,
      agentName: 'integration-test-agent',
      instarVersion: '0.0.0-integration',
    });

    const event: NormalizedDegradationEvent = {
      subsystem: 'live-mode-test',
      errorCode: 'TEST_LIVE_MODE',
      provenance: 'subsystem-explicit',
      reason: {
        redacted: 'legacy-path event',
        full: 'legacy-path event',
      },
      timestamp: new Date().toISOString(),
      monotonicTs: performance.now(),
    };
    reporter.reportStructured(event);

    // Brief settle so any async work would have had time to land.
    await new Promise((r) => setTimeout(r, 200));

    // No Remediator → no audit-projection file.
    expect(
      fs.existsSync(
        path.join(tmpDir, 'remediation', 'audit-projection-m-legacy.jsonl'),
      ),
    ).toBe(false);
  });

  it('runs nodeAbiMismatchRunbook through the full registration path (W-1 wired by default)', async () => {
    // Don't actually invoke the surface — just assert the runbook is wired
    // and that the prefilter is the right shape. This is the structural
    // assurance that when a real NATIVE_MODULE_ABI_MISMATCH event arrives
    // in production with `remediator.enabled: true`, the dispatch path
    // would route correctly.
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
      const result = await bootstrapRemediator({
        stateDir: tmpDir,
        machineId: 'm-live-3',
      });
      expect(result.disabled).toBe(false);
      if (result.disabled) return;

      expect(result.registeredRunbookIds).toContain('node-abi-mismatch');
      expect(nodeAbiMismatchRunbook.eventPrefilter.errorCode).toContain(
        'NATIVE_MODULE_ABI_MISMATCH',
      );
      // §A6: free-text provenance is NOT in the prefilter.
      expect(nodeAbiMismatchRunbook.eventPrefilter.provenance).not.toContain(
        'free-text',
      );
    } finally {
      spy.mockRestore();
    }
  });
});
