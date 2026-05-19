/**
 * Unit tests for FrameworkParitySentinel.
 *
 * Spec: specs/instar-foundations/framework-parity-sentinel.md
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FrameworkParitySentinel } from '../../../src/monitoring/FrameworkParitySentinel.js';
import {
  _replaceParityRuleForTest,
} from '../../../src/providers/parity/registry.js';
import type {
  ParityRule,
  VerifyResult,
  ParityMismatch,
  FunctionalPrimitive,
} from '../../../src/providers/parity/types.js';

async function tmpProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'parity-sentinel-test-'));
}

const NOOP_RULE: Pick<ParityRule, 'frameworks' | 'remediationPolicy' | 'verify' | 'listInstances' | 'remediate' | 'listOrphans' | 'removeOrphans'> = {
  frameworks: ['claude-code', 'codex-cli'],
  remediationPolicy: 'mirror-trust',
  async verify() {
    return { ok: true, mismatches: [] };
  },
  async listInstances() {
    return [];
  },
  async remediate() {
    /* noop */
  },
  async listOrphans() {
    return [];
  },
  async removeOrphans() {
    return [];
  },
};

function makeStubRule(opts: {
  instances?: string[];
  verifyResults?: Record<string, VerifyResult>;
  remediationPolicy?: 'mirror-trust' | 'flag-only';
  alwaysOverwrite?: boolean;
  orphans?: ParityMismatch[];
  remediateImpl?: (instance: string, framework: string) => Promise<void>;
}): ParityRule {
  const instances = opts.instances ?? [];
  return {
    ...NOOP_RULE,
    primitive: 'skill',
    remediationPolicy: opts.remediationPolicy ?? 'mirror-trust',
    alwaysOverwrite: opts.alwaysOverwrite,
    async verify(_root, instance) {
      return opts.verifyResults?.[instance] ?? { ok: true, mismatches: [] };
    },
    async listInstances() {
      return instances;
    },
    async remediate(_root, instance, framework) {
      if (opts.remediateImpl) return opts.remediateImpl(instance, framework);
    },
    async listOrphans() {
      return opts.orphans ?? [];
    },
  };
}

/**
 * Replace all currently-registered rules with no-op stubs (except `keep`),
 * then replace `keep` with the supplied rule. Returns a single cleanup
 * function that restores all of them.
 */
function isolateToOneRule(rule: ParityRule): () => void {
  const others: Array<FunctionalPrimitive> = ['skill', 'hook', 'memory'].filter(
    (p) => p !== rule.primitive,
  ) as Array<FunctionalPrimitive>;
  const restores: Array<() => void> = [];
  for (const p of others) {
    restores.push(
      _replaceParityRuleForTest(p, { ...NOOP_RULE, primitive: p } as ParityRule),
    );
  }
  restores.push(_replaceParityRuleForTest(rule.primitive, rule));
  return () => {
    for (const r of restores.reverse()) r();
  };
}

describe('FrameworkParitySentinel', () => {
  let projectRoot: string;
  let restoreRule: (() => void) | null = null;

  beforeEach(async () => {
    projectRoot = await tmpProject();
  });

  afterEach(async () => {
    if (restoreRule) {
      restoreRule();
      restoreRule = null;
    }
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  describe('scan() — happy path', () => {
    it('returns ok report when all rules verify clean', async () => {
      restoreRule = isolateToOneRule(makeStubRule({ instances: ['a', 'b'] }));
      const sentinel = new FrameworkParitySentinel({
        projectRoot,
        stateDir: projectRoot,
        enabledFrameworks: ['claude-code'],
      });
      const report = await sentinel.scan();
      expect(report.gapsFound).toBe(0);
      expect(report.remediated).toBe(0);
      // The full registry includes more than just skill; check that at least
      // our stub's instances were checked.
      expect(report.instancesChecked).toBeGreaterThanOrEqual(2);
    });

    it('emits scan-complete event with the report', async () => {
      restoreRule = isolateToOneRule(makeStubRule({ instances: [] }));
      const sentinel = new FrameworkParitySentinel({
        projectRoot,
        stateDir: projectRoot,
        enabledFrameworks: ['claude-code'],
      });
      let received: unknown = null;
      sentinel.on('parity:scan-complete', (r) => {
        received = r;
      });
      await sentinel.scan();
      expect(received).toBeTruthy();
    });
  });

  describe('scan() — drift detection', () => {
    it('emits parity:gap-found for each mismatch', async () => {
      const mismatch: ParityMismatch = {
        primitive: 'skill',
        instanceName: 'foo',
        framework: 'claude-code',
        reasonCode: 'frontmatter-name-mismatch',
        detail: 'name drift',
      };
      restoreRule = isolateToOneRule(makeStubRule({
          instances: ['foo'],
          verifyResults: { foo: { ok: false, mismatches: [mismatch] } },
        }),
      );
      const sentinel = new FrameworkParitySentinel({
        projectRoot,
        stateDir: projectRoot,
        enabledFrameworks: ['claude-code'],
      });
      const gaps: ParityMismatch[] = [];
      sentinel.on('parity:gap-found', (m: ParityMismatch) => {
        gaps.push(m);
      });
      const report = await sentinel.scan();
      expect(report.gapsFound).toBeGreaterThanOrEqual(1);
      expect(gaps.some((g) => g.instanceName === 'foo' && g.detail === 'name drift')).toBe(true);
    });
  });

  describe('scan() — remediation policy', () => {
    it('calls remediate() for mirror-trust rules with drift', async () => {
      const calls: Array<{ instance: string; framework: string }> = [];
      restoreRule = isolateToOneRule(makeStubRule({
          instances: ['foo'],
          remediationPolicy: 'mirror-trust',
          verifyResults: {
            foo: {
              ok: false,
              mismatches: [
                {
                  primitive: 'skill',
                  instanceName: 'foo',
                  framework: 'claude-code',
                  reasonCode: 'missing-rendered-file',
                  detail: 'missing',
                },
              ],
            },
          },
          remediateImpl: async (instance, framework) => {
            calls.push({ instance, framework });
          },
        }),
      );
      const sentinel = new FrameworkParitySentinel({
        projectRoot,
        stateDir: projectRoot,
        enabledFrameworks: ['claude-code'],
      });
      const report = await sentinel.scan();
      expect(report.remediated).toBe(1);
      expect(calls).toEqual([{ instance: 'foo', framework: 'claude-code' }]);
    });

    it('does NOT call remediate() for flag-only rules', async () => {
      const calls: string[] = [];
      restoreRule = isolateToOneRule(makeStubRule({
          instances: ['foo'],
          remediationPolicy: 'flag-only',
          verifyResults: {
            foo: {
              ok: false,
              mismatches: [
                {
                  primitive: 'skill',
                  instanceName: 'foo',
                  framework: 'claude-code',
                  reasonCode: 'missing-rendered-file',
                  detail: 'missing',
                },
              ],
            },
          },
          remediateImpl: async (instance) => {
            calls.push(instance);
          },
        }),
      );
      const sentinel = new FrameworkParitySentinel({
        projectRoot,
        stateDir: projectRoot,
        enabledFrameworks: ['claude-code'],
      });
      const report = await sentinel.scan();
      expect(calls).toEqual([]);
      expect(report.remediated).toBe(0);
    });

    it('alwaysOverwrite=true rule REMEDIATES through user-edit-conflict and emits parity:user-edit-overwritten', async () => {
      const remediateCalls: string[] = [];
      restoreRule = isolateToOneRule(makeStubRule({
          instances: ['foo'],
          remediationPolicy: 'mirror-trust',
          alwaysOverwrite: true,
          verifyResults: {
            foo: {
              ok: false,
              mismatches: [
                {
                  primitive: 'hook',
                  instanceName: 'foo',
                  framework: 'claude-code',
                  reasonCode: 'user-edit-conflict',
                  detail: 'user edited',
                },
              ],
            },
          },
          remediateImpl: async (instance) => {
            remediateCalls.push(instance);
          },
        }),
      );
      const sentinel = new FrameworkParitySentinel({
        projectRoot,
        stateDir: projectRoot,
        enabledFrameworks: ['claude-code'],
      });
      const overwritten: unknown[] = [];
      const refused: unknown[] = [];
      sentinel.on('parity:user-edit-overwritten', (m) => overwritten.push(m));
      sentinel.on('parity:remediation-refused', (m) => refused.push(m));
      const report = await sentinel.scan();
      // Per Migration Parity §4: alwaysOverwrite=true rules remediate through
      // the conflict and emit the audit signal.
      expect(remediateCalls).toEqual(['foo']);
      expect(overwritten.length).toBeGreaterThanOrEqual(1);
      expect(refused.length).toBe(0);
      expect(report.remediated).toBe(1);
      expect(report.remediationRefused).toBe(0);
    });

    it('refuses remediation on user-edit-conflict and emits the event', async () => {
      restoreRule = isolateToOneRule(makeStubRule({
          instances: ['foo'],
          remediationPolicy: 'mirror-trust',
          verifyResults: {
            foo: {
              ok: false,
              mismatches: [
                {
                  primitive: 'skill',
                  instanceName: 'foo',
                  framework: 'claude-code',
                  reasonCode: 'user-edit-conflict',
                  detail: 'user edited',
                },
              ],
            },
          },
        }),
      );
      const sentinel = new FrameworkParitySentinel({
        projectRoot,
        stateDir: projectRoot,
        enabledFrameworks: ['claude-code'],
      });
      const refused: unknown[] = [];
      sentinel.on('parity:remediation-refused', (m) => refused.push(m));
      const report = await sentinel.scan();
      expect(report.remediationRefused).toBeGreaterThanOrEqual(1);
      expect(refused.length).toBeGreaterThanOrEqual(1);
    });

    it('respects remediationEnabled=false config override (downgrades mirror-trust to flag-only)', async () => {
      const calls: string[] = [];
      restoreRule = isolateToOneRule(makeStubRule({
          instances: ['foo'],
          remediationPolicy: 'mirror-trust',
          verifyResults: {
            foo: {
              ok: false,
              mismatches: [
                {
                  primitive: 'skill',
                  instanceName: 'foo',
                  framework: 'claude-code',
                  reasonCode: 'missing-rendered-file',
                  detail: 'missing',
                },
              ],
            },
          },
          remediateImpl: async (instance) => {
            calls.push(instance);
          },
        }),
      );
      const sentinel = new FrameworkParitySentinel({
        projectRoot,
        stateDir: projectRoot,
        enabledFrameworks: ['claude-code'],
        remediationEnabled: false,
      });
      await sentinel.scan();
      expect(calls).toEqual([]);
    });
  });

  describe('scan() — orphan detection', () => {
    it('emits parity:orphan-found for each orphan', async () => {
      const orphan: ParityMismatch = {
        primitive: 'skill',
        instanceName: 'orphan-foo',
        framework: 'claude-code',
        reasonCode: 'orphan-rendering-found',
        detail: 'orphan dir',
      };
      restoreRule = isolateToOneRule(makeStubRule({ instances: [], orphans: [orphan] }),
      );
      const sentinel = new FrameworkParitySentinel({
        projectRoot,
        stateDir: projectRoot,
        enabledFrameworks: ['claude-code'],
      });
      const orphans: ParityMismatch[] = [];
      sentinel.on('parity:orphan-found', (m: ParityMismatch) => orphans.push(m));
      const report = await sentinel.scan();
      expect(report.orphansFound).toBeGreaterThanOrEqual(1);
      expect(orphans.some((o) => o.instanceName === 'orphan-foo')).toBe(true);
    });
  });

  describe('state persistence', () => {
    it('writes and reloads cursors across instances', async () => {
      restoreRule = isolateToOneRule(makeStubRule({ instances: ['foo', 'bar'] }));
      const sentinel1 = new FrameworkParitySentinel({
        projectRoot,
        stateDir: projectRoot,
        enabledFrameworks: ['claude-code'],
      });
      await sentinel1.scan();
      const status1 = sentinel1.getStatus();
      expect(status1.lastScanAt).toBeTruthy();

      const sentinel2 = new FrameworkParitySentinel({
        projectRoot,
        stateDir: projectRoot,
        enabledFrameworks: ['claude-code'],
      });
      const status2 = sentinel2.getStatus();
      expect(status2.lastScanAt).toBe(status1.lastScanAt);
    });

    it('survives missing state file (cold start)', async () => {
      restoreRule = isolateToOneRule(makeStubRule({ instances: [] }));
      const sentinel = new FrameworkParitySentinel({
        projectRoot,
        stateDir: projectRoot,
        enabledFrameworks: ['claude-code'],
      });
      expect(sentinel.getStatus().lastScanAt).toBeNull();
    });
  });

  describe('concurrent scan short-circuit', () => {
    it('returns empty report when scan() is called while a scan is in flight', async () => {
      // Use a rule whose verify is slow to give us a window to call scan() again.
      let resolveVerify: (v: VerifyResult) => void;
      const verifyPromise = new Promise<VerifyResult>((res) => {
        resolveVerify = res;
      });
      restoreRule = isolateToOneRule({
        primitive: 'skill',
        frameworks: ['claude-code'],
        remediationPolicy: 'mirror-trust',
        async listInstances() {
          return ['foo'];
        },
        async verify() {
          return verifyPromise;
        },
        async remediate() {
          /* noop */
        },
        async listOrphans() {
          return [];
        },
        async removeOrphans() {
          return [];
        },
      });
      const sentinel = new FrameworkParitySentinel({
        projectRoot,
        stateDir: projectRoot,
        enabledFrameworks: ['claude-code'],
      });
      const first = sentinel.scan();
      const second = await sentinel.scan();
      expect(second.rulesWalked).toBe(0); // short-circuited
      resolveVerify!({ ok: true, mismatches: [] });
      await first;
    });
  });

  describe('start/stop lifecycle', () => {
    it('start/stop are idempotent', async () => {
      const sentinel = new FrameworkParitySentinel({
        projectRoot,
        stateDir: projectRoot,
        enabledFrameworks: ['claude-code'],
        scanIntervalMs: 60_000,
        initialScanDelayMs: 60_000,
      });
      sentinel.start();
      sentinel.start();
      sentinel.stop();
      sentinel.stop();
    });
  });
});
