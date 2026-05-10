/**
 * Tests for TaskFlow Phase 5 — audit ledger emission for state transitions.
 * Spec: docs/specs/OPENCLAW-IMPORT-TASKFLOW-SPEC.md § Phase 5 line 653;
 *       § Threat Model lines 681-682 (redacted shape — no stateJson, only
 *       waitJson.kind).
 *
 * Real SQLite + real SharedStateLedger (no mocking). Verifies:
 *  - Terminal transitions (succeeded, failed, cancelled, lost) emit notes
 *  - Non-terminal transitions (createFlow, startStep, setFlowWaiting, resumeFlow)
 *    also emit per spec audit-trail requirement
 *  - Notes are emitted with subsystem='taskflow-transition', kind='note'
 *  - Audit payload contains ONLY redacted fields:
 *      flowId, revision, currentStep, from_status, to_status, waitJson.kind,
 *      controllerId, op
 *  - Audit payload does NOT contain stateJson or waitJson.payload
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TaskFlowStore } from '../../src/tasks/task-flow-registry.store.sqlite.js';
import { TaskFlowRegistry } from '../../src/tasks/TaskFlowRegistry.js';
import { SharedStateLedger } from '../../src/core/SharedStateLedger.js';
import {
  CreateFlowInput,
  TaskFlowPrincipal,
  WaitJson,
} from '../../src/tasks/task-flow-types.js';

interface TestRig {
  dir: string;
  store: TaskFlowStore;
  registry: TaskFlowRegistry;
  ledger: SharedStateLedger;
  clock: { now: number };
  emitted: Array<Record<string, unknown>>;
  cleanup: () => Promise<void>;
}

async function rig(): Promise<TestRig> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-audit-'));
  const store = new TaskFlowStore({ dbPath: path.join(dir, 'task-flows.db') });
  await store.open();
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const ledger = new SharedStateLedger({
    stateDir,
    config: {} as any,
    salt: 'test-salt',
  });
  const clock = { now: 1_700_000_000_000 };
  const emitted: Array<Record<string, unknown>> = [];
  const registry = new TaskFlowRegistry({
    store,
    ledger,
    now: () => clock.now,
    rateLimits: {
      createPerSecPerController: 1_000_000,
      maxActivePerController: 1_000_000,
      pingPerMinPerFlow: 1_000_000,
    },
  });
  registry.on('taskflow:audit-emitted', (p: Record<string, unknown>) => emitted.push(p));
  return {
    dir,
    store,
    registry,
    ledger,
    clock,
    emitted,
    cleanup: async () => {
      store.close();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/task-flow-audit-ledger.test.ts' });
    },
  };
}

const base: CreateFlowInput = {
  ownerKey: 'k-audit',
  controllerId: 'AuditCtrl',
  controllerInstanceId: 'inst-1',
  idempotencyKey: 'idem-audit-aaaaaaaaaa',
  goal: 'audit test',
};

const ctrl: TaskFlowPrincipal = {
  scope: 'controller',
  controllerId: 'AuditCtrl',
  controllerInstanceId: 'inst-1',
};

// drain microtasks + lock retries to let best-effort ledger appends land
async function flushAsync(): Promise<void> {
  // Loop a few cycles with both setImmediate + small real timeouts; the ledger
  // uses proper-lockfile with exponential backoff so a pure microtask drain is
  // insufficient on first run.
  for (let i = 0; i < 30; i++) {
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}

function readLedger(dir: string): any[] {
  const file = path.join(dir, 'state', 'shared-state.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe('TaskFlowRegistry — Phase 5 audit ledger emission', () => {
  let r: TestRig;
  beforeEach(async () => { r = await rig(); });
  afterEach(async () => { await r.cleanup(); });

  it('emits a taskflow-transition note on createFlow', async () => {
    await r.registry.createFlow(base);
    await flushAsync();
    const entries = readLedger(r.dir);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const tx = entries.find((e: any) => e.emittedBy?.subsystem === 'taskflow-transition');
    expect(tx).toBeDefined();
    expect(tx.kind).toBe('note');
    expect(tx.subject).toBe('taskflow-transition');
    expect(tx.provenance).toBe('subsystem-asserted');
  });

  it('emits notes on each non-terminal mutation (startStep, setFlowWaiting, resumeFlow)', async () => {
    const { flow } = await r.registry.createFlow(base);
    const started = await r.registry.startStep({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      principal: ctrl,
      currentStep: 'phase-a',
    });
    const waitJson: WaitJson = { kind: 'reply', channel: 'tg', threadId: 't1', peer: 'p1' };
    const waited = await r.registry.setFlowWaiting({
      flowId: flow.flowId,
      expectedRevision: started.flow.revision,
      principal: ctrl,
      waitJson,
    });
    await r.registry.resumeFlow({
      flowId: flow.flowId,
      expectedRevision: waited.flow.revision,
      principal: ctrl,
      waitInstanceId: waited.flow.waitInstanceId!,
    });
    await flushAsync();
    const ops = r.emitted.map((e) => e.op);
    expect(ops).toContain('createFlow');
    expect(ops).toContain('startStep');
    expect(ops).toContain('setFlowWaiting');
    expect(ops).toContain('resumeFlow');
  });

  it('emits notes on terminal transitions (succeeded)', async () => {
    const { flow } = await r.registry.createFlow(base);
    const started = await r.registry.startStep({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      principal: ctrl,
      currentStep: 'work',
    });
    await r.registry.finishFlow({
      flowId: flow.flowId,
      expectedRevision: started.flow.revision,
      principal: ctrl,
    });
    await flushAsync();
    const terminal = r.emitted.find((e) => e.to_status === 'succeeded');
    expect(terminal).toBeDefined();
    expect(terminal!.from_status).toBe('running');
    expect(terminal!.op).toBe('finishFlow');
  });

  it('emits notes on terminal transitions (failed)', async () => {
    const { flow } = await r.registry.createFlow(base);
    const started = await r.registry.startStep({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      principal: ctrl,
      currentStep: 'work',
    });
    await r.registry.failFlow({
      flowId: flow.flowId,
      expectedRevision: started.flow.revision,
      principal: ctrl,
      failureReason: 'test',
    });
    await flushAsync();
    expect(r.emitted.find((e) => e.to_status === 'failed')).toBeDefined();
  });

  it('emits notes on terminal transitions (cancelled)', async () => {
    const { flow } = await r.registry.createFlow(base);
    const started = await r.registry.startStep({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      principal: ctrl,
      currentStep: 'work',
    });
    const reqd = await r.registry.requestFlowCancel({
      flowId: flow.flowId,
      expectedRevision: started.flow.revision,
      requesterOrigin: { kind: 'user', id: 'u' },
    });
    await r.registry.cancelFlow({
      flowId: flow.flowId,
      expectedRevision: reqd.flow.revision,
      principal: ctrl,
    });
    await flushAsync();
    expect(r.emitted.find((e) => e.to_status === 'cancelled')).toBeDefined();
  });

  it('emits notes on terminal transitions (lost)', async () => {
    const { flow } = await r.registry.createFlow(base);
    const started = await r.registry.startStep({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      principal: ctrl,
      currentStep: 'work',
    });
    await r.registry.markLost({
      flowId: flow.flowId,
      expectedRevision: started.flow.revision,
      ledgerEntryId: 'note-deadbeef',
      reason: 'lost',
    });
    await flushAsync();
    expect(r.emitted.find((e) => e.to_status === 'lost')).toBeDefined();
  });

  it('audit payload includes ONLY redacted fields (no stateJson, no waitJson.payload)', async () => {
    const stateJson = { secret: 'do-not-leak', userInputs: ['a', 'b'] };
    const { flow } = await r.registry.createFlow({ ...base, stateJson });
    const started = await r.registry.startStep({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      principal: ctrl,
      currentStep: 'work',
    });
    const waitJson: WaitJson = {
      kind: 'external-call',
      serviceId: 'svc-private',
      correlationId: 'corr-aaaaaaaaaaaaaaaaaaaaaa-private',
    };
    await r.registry.setFlowWaiting({
      flowId: flow.flowId,
      expectedRevision: started.flow.revision,
      principal: ctrl,
      waitJson,
    });
    await flushAsync();
    const allowedKeys = new Set([
      'flowId', 'revision', 'currentStep', 'from_status',
      'to_status', 'waitKind', 'controllerId', 'op',
    ]);
    for (const e of r.emitted) {
      for (const k of Object.keys(e)) {
        expect(allowedKeys.has(k), `unexpected key in audit payload: ${k}`).toBe(true);
      }
      // Strong assertions: stateJson and waitJson.payload MUST NOT appear.
      expect((e as any).stateJson).toBeUndefined();
      expect((e as any).waitJson).toBeUndefined();
      expect(JSON.stringify(e)).not.toContain('do-not-leak');
      expect(JSON.stringify(e)).not.toContain('svc-private');
      expect(JSON.stringify(e)).not.toContain('corr-aaaaaaaaaaaaaaaaaaaaaa-private');
    }
    // waitKind is the only waitJson surface allowed.
    const setWaiting = r.emitted.find((e) => e.op === 'setFlowWaiting');
    expect(setWaiting?.waitKind).toBe('external-call');
  });

  it('ledger entry summary line also does not contain stateJson or waitJson identifying fields', async () => {
    const stateJson = { secret: 'do-not-leak-summary' };
    const { flow } = await r.registry.createFlow({ ...base, stateJson });
    await r.registry.startStep({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      principal: ctrl,
      currentStep: 'work',
    });
    await flushAsync();
    const entries = readLedger(r.dir);
    for (const e of entries) {
      expect(JSON.stringify(e)).not.toContain('do-not-leak-summary');
    }
  });

  it('dedupKey is stable per (flowId, revision, op)', async () => {
    const { flow } = await r.registry.createFlow(base);
    await r.registry.startStep({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      principal: ctrl,
      currentStep: 'work',
    });
    await flushAsync();
    const entries = readLedger(r.dir);
    const txEntries = entries.filter((e: any) => e.emittedBy?.subsystem === 'taskflow-transition');
    const keys = new Set(txEntries.map((e: any) => e.dedupKey));
    // unique keys per (flowId, revision, op)
    expect(keys.size).toBe(txEntries.length);
    for (const k of keys) {
      expect(k).toMatch(/^taskflow-transition:[0-9a-f-]+:\d+:(createFlow|startStep|setFlowWaiting|resumeFlow|finishFlow|failFlow|cancelFlow|markLost)$/);
    }
  });

  it('audit emission is async/best-effort — does NOT block state correctness', async () => {
    // Even if ledger.append rejects (unrealistic but valid contract), state advances.
    const original = (r.ledger as any).append.bind(r.ledger);
    (r.ledger as any).append = async () => { throw new Error('simulated audit failure'); };
    const { flow } = await r.registry.createFlow(base);
    const started = await r.registry.startStep({
      flowId: flow.flowId,
      expectedRevision: flow.revision,
      principal: ctrl,
      currentStep: 'work',
    });
    expect(started.applied).toBe(true);
    expect(started.flow.status).toBe('running');
    (r.ledger as any).append = original;
  });
});
