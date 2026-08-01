// safe-fs-allow: test file — tmpdir fixtures only, cleaned via SafeFsExecutor.

/**
 * Unit tests for GuardPostureTripwire.
 *
 * Triggering incident: the 2026-06-05 meltdown load-shed batch-flipped five
 * guards off in config.json; only the scheduler was noticed. The tripwire
 * makes any enabled→disabled guard transition loud at the next boot.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildCompleteGuardPosture,
  extractGuardPosture,
  diffGuardPosture,
  runGuardPostureTripwire,
  type AttentionItemInput,
} from '../../../src/monitoring/GuardPostureTripwire.js';
import { resolveGuardConfigSnapshot } from '../../../src/monitoring/guardPosture.js';
import { buildGuardInventory } from '../../../src/monitoring/guardPostureView.js';
import { GuardRegistry } from '../../../src/monitoring/GuardRegistry.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

// The shape of the real incident config (2026-06-05): mixed dict-with-enabled
// entries, plain booleans, and non-guard values that must be ignored.
const CONFIG_BEFORE = {
  monitoring: {
    contextWedgeSentinel: { enabled: true, autoRecovery: { enabled: true, dryRun: false } },
    failureLearning: { enabled: true, minSupport: 4 },
    resourceLedger: { enabled: true, sampleIntervalMs: 60000 },
    burnDetection: { enabled: true },
    memoryMonitoring: true,
    sentinelTelegramEscalation: false,
    watchdog: { enabled: true },
    // non-guard shapes that must be ignored:
    burnThresholds: { absoluteShareThreshold: 0.25 },
    someList: [1, 2, 3],
  },
  scheduler: { enabled: true, maxParallelJobs: 1 },
  port: 4042,
};

const CONFIG_AFTER_LOADSHED = JSON.parse(JSON.stringify(CONFIG_BEFORE));
CONFIG_AFTER_LOADSHED.monitoring.contextWedgeSentinel.enabled = false;
CONFIG_AFTER_LOADSHED.monitoring.failureLearning.enabled = false;
CONFIG_AFTER_LOADSHED.monitoring.resourceLedger.enabled = false;
CONFIG_AFTER_LOADSHED.monitoring.burnDetection.enabled = false;
CONFIG_AFTER_LOADSHED.scheduler.enabled = false;

describe('extractGuardPosture', () => {
  it('extracts monitoring.*.enabled, plain monitoring booleans, and scheduler.enabled', () => {
    const p = extractGuardPosture(CONFIG_BEFORE);
    expect(p['monitoring.contextWedgeSentinel.enabled']).toBe(true);
    expect(p['monitoring.failureLearning.enabled']).toBe(true);
    expect(p['monitoring.memoryMonitoring']).toBe(true);
    expect(p['monitoring.sentinelTelegramEscalation']).toBe(false);
    expect(p['scheduler.enabled']).toBe(true);
  });

  it('ignores non-boolean shapes (nested non-enabled dicts, arrays, numbers)', () => {
    const p = extractGuardPosture(CONFIG_BEFORE);
    expect(Object.keys(p).some(k => k.includes('burnThresholds'))).toBe(false);
    expect(Object.keys(p).some(k => k.includes('someList'))).toBe(false);
    expect(Object.keys(p).some(k => k.includes('port'))).toBe(false);
  });

  it('empty/garbage configs produce an empty posture (no throw)', () => {
    expect(extractGuardPosture(undefined)).toEqual({});
    expect(extractGuardPosture(null)).toEqual({});
    expect(extractGuardPosture('nope')).toEqual({});
    expect(extractGuardPosture({})).toEqual({});
  });
});

describe('buildCompleteGuardPosture', () => {
  it('unions manifest guards outside monitoring into the watched posture', () => {
    const complete = buildCompleteGuardPosture({
      monitoring: {},
      multiMachine: {
        peerExecution: { enabled: false },
        meshTransport: { recoveryProbeEnabled: false },
      },
    });

    expect(complete.posture['multiMachine.peerExecution.enabled']).toBe(false);
    expect(complete.posture['multiMachine.meshTransport.recoveryProbeEnabled']).toBe(false);
    expect(complete.coverage.watched).toBe(Object.keys(complete.posture).length);
    expect(
      complete.coverage.configDerived + complete.coverage.manifestDeclared - complete.coverage.overlap,
    ).toBe(complete.coverage.watched);
  });
});

describe('diffGuardPosture', () => {
  it('reports enabled→disabled and disabled→enabled transitions', () => {
    const d = diffGuardPosture(
      extractGuardPosture(CONFIG_BEFORE),
      extractGuardPosture(CONFIG_AFTER_LOADSHED),
    );
    expect(d.disabled).toEqual([
      'monitoring.burnDetection.enabled',
      'monitoring.contextWedgeSentinel.enabled',
      'monitoring.failureLearning.enabled',
      'monitoring.resourceLedger.enabled',
      'scheduler.enabled',
    ]);
    expect(d.enabled).toEqual([]);
  });

  it('a key appearing or vanishing is a shape change, not a flip', () => {
    const d = diffGuardPosture({ 'monitoring.a.enabled': true }, { 'monitoring.b.enabled': false });
    expect(d.disabled).toEqual([]);
    expect(d.enabled).toEqual([]);
  });
});

describe('runGuardPostureTripwire', () => {
  let dir: string;
  let stateDir: string;
  let logsDir: string;
  let emitted: AttentionItemInput[];
  const emit = async (item: AttentionItemInput) => { emitted.push(item); };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-guardposture-'));
    stateDir = path.join(dir, '.instar');
    logsDir = path.join(dir, 'logs');
    emitted = [];
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/monitoring/GuardPostureTripwire.test.ts:cleanup',
    });
  });

  function snapshot(): { ts: string; posture: Record<string, boolean> } {
    return JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'guard-posture.json'), 'utf-8'));
  }

  function breadcrumbs(): Array<Record<string, unknown>> {
    const p = path.join(logsDir, 'guard-posture.jsonl');
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  }

  it('first boot: records the baseline, raises nothing', async () => {
    const r = await runGuardPostureTripwire({
      config: CONFIG_BEFORE, stateDir, logsDir, emitAttention: emit, log: () => {},
    });
    expect(r.firstBoot).toBe(true);
    expect(r.disabled).toEqual([]);
    expect(emitted).toHaveLength(0);
    expect(breadcrumbs()).toHaveLength(0);
    expect(snapshot().posture['scheduler.enabled']).toBe(true);
  });

  it('persists exactly the same key set that GET /guards inventories', async () => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
      developmentAgent: true,
      monitoring: { watchdog: { enabled: true } },
      multiMachine: {
        peerExecution: { enabled: false },
        meshTransport: { recoveryProbeEnabled: false },
      },
    }));
    const resolved = resolveGuardConfigSnapshot(dir);
    const r = await runGuardPostureTripwire({
      config: resolved.resolved,
      defaultConfig: resolved.defaults,
      stateDir,
      logsDir,
      log: () => {},
    });
    const inventory = buildGuardInventory({
      snapshot: resolved,
      bootSnapshot: null,
      registry: new GuardRegistry(),
    });

    expect(Object.keys(snapshot().posture).sort()).toEqual(inventory.guards.map(g => g.key));
    expect(r.coverage.watched).toBe(inventory.guards.length);
  });

  it('the incident shape: batch flip → ONE aggregated attention item + one breadcrumb row', async () => {
    await runGuardPostureTripwire({ config: CONFIG_BEFORE, stateDir, logsDir, emitAttention: emit, log: () => {} });
    const r = await runGuardPostureTripwire({
      config: CONFIG_AFTER_LOADSHED, stateDir, logsDir, emitAttention: emit, log: () => {},
    });
    expect(r.firstBoot).toBe(false);
    expect(r.disabled).toHaveLength(5);
    expect(r.attentionEmitted).toBe(true);
    // ONE aggregated item, never one per guard (Bounded Notification Surface).
    expect(emitted).toHaveLength(1);
    expect(emitted[0].priority).toBe('HIGH');
    expect(emitted[0].title).toContain('5');
    expect(emitted[0].summary).toContain('scheduler.enabled');
    const rows = breadcrumbs();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('guard-posture-change');
    expect(rows[0].disabled).toContain('monitoring.contextWedgeSentinel.enabled');
    expect(rows[0].coverage.watched).toBe(r.coverage.watched);
    expect(emitted[0].title).toContain(`of ${r.coverage.watched}`);
  });

  it('inventory expansion compares newly watched guards with resolved defaults', async () => {
    // Simulate a pre-fix 36-key snapshot: neither non-monitoring manifest key
    // existed, even though both were explicitly OFF in config.
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'state', 'guard-posture.json'),
      JSON.stringify({ ts: '2026-07-31T00:00:00.000Z', posture: { 'scheduler.enabled': true } }),
    );

    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({
      developmentAgent: true,
      multiMachine: {
        peerExecution: { enabled: false },
        meshTransport: { recoveryProbeEnabled: false },
      },
    }));
    const resolved = resolveGuardConfigSnapshot(dir);
    const currentPosture = buildCompleteGuardPosture(resolved.resolved).posture;
    const defaultPosture = buildCompleteGuardPosture(resolved.defaults).posture;
    expect(currentPosture['multiMachine.peerExecution.enabled']).toBe(false);
    expect(defaultPosture['multiMachine.peerExecution.enabled']).toBe(true);
    expect(currentPosture['multiMachine.meshTransport.recoveryProbeEnabled']).toBe(false);
    expect(defaultPosture['multiMachine.meshTransport.recoveryProbeEnabled']).toBe(true);

    const logLines: string[] = [];
    const r = await runGuardPostureTripwire({
      config: resolved.resolved,
      defaultConfig: resolved.defaults,
      stateDir,
      logsDir,
      emitAttention: emit,
      log: (line) => { logLines.push(line); },
    });

    expect(r.disabled).toEqual([
      'multiMachine.meshTransport.recoveryProbeEnabled',
      'multiMachine.peerExecution.enabled',
    ]);
    expect(r.newlyTrackedDisabled).toEqual(r.disabled);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].title).toBe(`2 of ${r.coverage.watched} watched guard(s) disabled`);
    expect(emitted[0].summary).toContain('newly watched');
    expect(logLines.some(line => line.includes('newly watched default-ON guard found OFF'))).toBe(true);
    expect(logLines.filter(line => line.includes('multiMachine.peerExecution.enabled')).join('\n'))
      .not.toContain('since last boot');
    expect(breadcrumbs()[0].previousWatched).toBe(1);
    expect(snapshot().posture['multiMachine.peerExecution.enabled']).toBe(false);
  });

  it('no repeat alarm: the same disabled posture on the NEXT boot raises nothing (transition-based)', async () => {
    await runGuardPostureTripwire({ config: CONFIG_BEFORE, stateDir, logsDir, emitAttention: emit, log: () => {} });
    await runGuardPostureTripwire({ config: CONFIG_AFTER_LOADSHED, stateDir, logsDir, emitAttention: emit, log: () => {} });
    const r = await runGuardPostureTripwire({
      config: CONFIG_AFTER_LOADSHED, stateDir, logsDir, emitAttention: emit, log: () => {},
    });
    expect(r.disabled).toEqual([]);
    expect(emitted).toHaveLength(1); // still just the original
    expect(breadcrumbs()).toHaveLength(1);
  });

  it('re-enable: breadcrumb only, no attention item (good news is not a to-do)', async () => {
    await runGuardPostureTripwire({ config: CONFIG_AFTER_LOADSHED, stateDir, logsDir, emitAttention: emit, log: () => {} });
    const r = await runGuardPostureTripwire({
      config: CONFIG_BEFORE, stateDir, logsDir, emitAttention: emit, log: () => {},
    });
    expect(r.enabled).toHaveLength(5);
    expect(r.disabled).toEqual([]);
    expect(emitted).toHaveLength(0);
    expect(breadcrumbs()).toHaveLength(1);
    expect(breadcrumbs()[0].enabled).toContain('scheduler.enabled');
  });

  it('no emitAttention (no Telegram): breadcrumb still lands, attentionEmitted false', async () => {
    await runGuardPostureTripwire({ config: CONFIG_BEFORE, stateDir, logsDir, log: () => {} });
    const r = await runGuardPostureTripwire({
      config: CONFIG_AFTER_LOADSHED, stateDir, logsDir, log: () => {},
    });
    expect(r.disabled).toHaveLength(5);
    expect(r.attentionEmitted).toBe(false);
    expect(breadcrumbs()).toHaveLength(1);
  });

  it('corrupt snapshot degrades to first-boot semantics and repairs itself', async () => {
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'state', 'guard-posture.json'), '{not json');
    const r = await runGuardPostureTripwire({
      config: CONFIG_BEFORE, stateDir, logsDir, emitAttention: emit, log: () => {},
    });
    expect(r.firstBoot).toBe(true);
    expect(emitted).toHaveLength(0);
    expect(snapshot().posture['scheduler.enabled']).toBe(true); // repaired
  });

  it('emit failure: error captured, snapshot still advanced (no repeat next boot), never throws', async () => {
    await runGuardPostureTripwire({ config: CONFIG_BEFORE, stateDir, logsDir, log: () => {} });
    const r = await runGuardPostureTripwire({
      config: CONFIG_AFTER_LOADSHED, stateDir, logsDir, log: () => {},
      emitAttention: async () => { throw new Error('telegram down'); },
    });
    expect(r.attentionEmitted).toBe(false);
    expect(r.error).toContain('telegram down');
    // Baseline advanced → the next boot with the same posture stays quiet.
    const r2 = await runGuardPostureTripwire({
      config: CONFIG_AFTER_LOADSHED, stateDir, logsDir, emitAttention: emit, log: () => {},
    });
    expect(r2.disabled).toEqual([]);
  });
});
