import { afterEach, describe, expect, it } from 'vitest';
import { WindowRunCadenceExecutor, WindowRunCadenceStore } from '../../src/core/WindowRunCadenceExecutor.js';
import { WindowRunLivenessAuthority, WindowRunLivenessStore, type WindowRunLivenessDocument, type WindowRunWorkReceipt } from '../../src/core/WindowRunLivenessAuthority.js';
import { createTempProject, type TempProject } from '../helpers/setup.js';

const BASE = Date.parse('2026-09-05T20:00:00.000Z');

function work(sequence: number, at: number): WindowRunWorkReceipt {
  return { receiptId: `receipt-${sequence}`, sequence, digest: String(sequence).padStart(64, 'a'), observedAt: new Date(at).toISOString(), artifact: 'artifact.txt', taskRef: `autonomous:run-w32:${sequence}` };
}

function liveness(receipts: WindowRunWorkReceipt[] = []): WindowRunLivenessDocument {
  return {
    version: 1, windowId: 'w32', topicId: 36966, autonomousRunId: 'run-w32', lifecycleRunId: 'lifecycle-w32', executorId: 'executor-1',
    status: 'active', registeredAt: new Date(BASE).toISOString(), activatedAt: new Date(BASE).toISOString(), predicates: {
      'executor-bound-running': { ok: true, observed: 'running' }, 'heartbeat-fresh': { ok: true, observed: 'fresh' },
      'delivery-reachable': { ok: true, observed: 'reachable' }, 'durable-work-advanced': { ok: true, observed: 'advanced' },
      'lifecycle-admitted-unexpired': { ok: true, observed: 'admitted' },
    }, transitions: [], executorBindingReceipts: [], audit: {
      entries: receipts.map((receipt, index) => ({ sequence: index + 1, kind: 'work-receipt' as const, at: receipt.observedAt, status: 'active' as const, workReceipt: receipt, previousDigest: index ? `audit-${index}` : null, entryDigest: `audit-${index + 1}` })),
      headDigest: receipts.length ? `audit-${receipts.length}` : null,
    }, lastWorkReceipt: receipts.at(-1),
  };
}

describe('WindowRunCadenceExecutor', () => {
  let project: TempProject | undefined;
  afterEach(() => project?.cleanup());

  it('persists one cross-turn checkpoint request and preserves cadence across executor rebind', async () => {
    project = createTempProject();
    let nowMs = BASE + 25 * 60_000;
    const state = liveness();
    const requested: string[] = [];
    const store = new WindowRunCadenceStore(project.stateDir);
    const make = () => new WindowRunCadenceExecutor(store, {
      now: () => new Date(nowMs).toISOString(), getLiveness: () => state,
      resolveFirstUnreceiptedTask: () => 'autonomous:run-w32:1',
      requestCheckpoint: async ({ taskRef }) => { requested.push(taskRef); return { delivered: true, receipt: 'tmux-delivery-1' }; },
    }, { enabled: true, dryRun: false });

    await make().tick();
    await make().tick();
    expect(requested).toEqual(['autonomous:run-w32:1']);
    expect(store.load()?.checkpoints).toHaveLength(1);

    state.executorId = 'executor-2';
    state.executorBindingReceipts.push({ receiptId: 'rebind-1', at: new Date(nowMs).toISOString(), fromExecutorId: 'executor-1', toExecutorId: 'executor-2', recoveryAttemptId: 'attempt-1', projectionReceipt: 'projection-1' });
    nowMs = BASE + 30 * 60_000;
    state.audit.entries.push({ sequence: 1, kind: 'work-receipt', at: new Date(BASE + 29 * 60_000).toISOString(), status: 'active', workReceipt: work(1, BASE + 29 * 60_000), previousDigest: null, entryDigest: 'audit-1' });
    state.audit.headDigest = 'audit-1'; state.lastWorkReceipt = state.audit.entries[0].workReceipt;
    const after = await make().tick();
    expect(after).toMatchObject({ executorId: 'executor-2', startedAt: new Date(BASE).toISOString(), lastReceiptedSequence: 1 });
    expect(after?.intervals).toMatchObject([{ number: 1, outcome: 'passed', workSequence: 1 }]);
  });

  it('does not start clocks or actions during an arbitrarily long preparation', async () => {
    project = createTempProject();
    const state = liveness();
    state.status = 'preparing'; delete state.activatedAt;
    let actions = 0;
    const store = new WindowRunCadenceStore(project.stateDir);
    const executor = new WindowRunCadenceExecutor(store, {
      now: () => new Date(BASE + 12 * 60 * 60_000).toISOString(), getLiveness: () => state,
      resolveFirstUnreceiptedTask: () => 'task-1',
      requestCheckpoint: async () => { actions++; return { delivered: true, receipt: 'unexpected' }; },
      deliverSynthesis: async () => { actions++; return { messageId: 1 }; },
    }, { enabled: true, dryRun: false });
    expect(await executor.tick()).toBeNull();
    expect(store.load()).toBeNull();
    expect(actions).toBe(0);
    state.status = 'active'; state.activatedAt = new Date(BASE + 12 * 60 * 60_000).toISOString();
    const activated = await executor.tick();
    expect(activated).toMatchObject({
      startedAt: state.activatedAt,
      nextReceiptDueAt: new Date(BASE + 12.5 * 60 * 60_000).toISOString(),
      nextReportDueAt: new Date(BASE + 15 * 60 * 60_000).toISOString(),
      intervals: [], reports: [],
    });
    expect(actions).toBe(0);
  });

  it('materializes distinct advancing 30-minute intervals and fails a missed interval loudly', async () => {
    project = createTempProject();
    let nowMs = BASE + 60 * 60_000;
    const state = liveness([work(1, BASE + 29 * 60_000), work(2, BASE + 59 * 60_000)]);
    const failures: string[] = [];
    const executor = new WindowRunCadenceExecutor(new WindowRunCadenceStore(project.stateDir), {
      now: () => new Date(nowMs).toISOString(), getLiveness: () => state, resolveFirstUnreceiptedTask: () => 'task-3',
      notifyFailure: async (_state, message) => { failures.push(message); return true; },
    }, { enabled: true, dryRun: false });
    const passing = await executor.tick();
    expect(passing?.intervals.map(item => [item.outcome, item.workSequence])).toEqual([['passed', 1], ['passed', 2]]);

    nowMs = BASE + 96 * 60_000;
    const failed = await executor.tick();
    expect(failed?.status).toBe('failed');
    expect(failed?.intervals.at(-1)?.outcome).toBe('missed');
    expect(failures).toHaveLength(1);
    await executor.tick();
    expect(failures).toHaveLength(1);
  });

  it('revokes liveness at the 30-minute stale-work boundary before cadence grace can fail', async () => {
    project = createTempProject();
    let nowMs = BASE;
    const liveStore = new WindowRunLivenessStore(project.stateDir);
    const authority = new WindowRunLivenessAuthority(liveStore, {
      now: () => new Date(nowMs).toISOString(),
      sample: state => ({ sampledAt: new Date(nowMs).toISOString(), executor: { id: state.executorId, running: true, heartbeatAt: new Date(nowMs).toISOString() }, deliveryReachable: true, work: state.lastWorkReceipt ?? null, lifecycle: { lifecycleRunId: state.lifecycleRunId, state: 'active_start', admitted: true, expiresAt: new Date(BASE + 24 * 60 * 60_000).toISOString() } }),
      verifyWorkArtifact: () => ({ artifact: 'artifact.txt', digest: 'b'.repeat(64), taskRef: 'task-1' }),
    }, { enabled: true, dryRun: true, workEvidenceMaxAgeMs: 30 * 60_000 });
    const binding = { windowId: 'w32', topicId: 36966, autonomousRunId: 'run-w32', lifecycleRunId: 'lifecycle-w32', executorId: 'executor-1' };
    authority.register(binding);
    await authority.recordWorkAdvance({ ...binding, artifactRef: 'artifact.txt' });
    expect((await authority.tick())?.status).toBe('active');
    const cadence = new WindowRunCadenceExecutor(new WindowRunCadenceStore(project.stateDir), {
      now: () => new Date(nowMs).toISOString(), getLiveness: () => authority.status().state, resolveFirstUnreceiptedTask: () => 'task-2',
    }, { enabled: true, dryRun: true });
    await cadence.tick();

    nowMs = BASE + 30 * 60_000 + 1;
    const atRisk = await authority.tick();
    expect(atRisk?.status).toBe('at-risk');
    expect(atRisk?.predicates['durable-work-advanced'].ok).toBe(false);
    expect((await cadence.tick())?.status).toBe('running');

    nowMs = BASE + 35 * 60_000 + 1;
    expect((await cadence.tick())?.status).toBe('failed');
  });

  it('delivers the due 3-hour synthesis once and recovers an ambiguous attempt from durable history', async () => {
    project = createTempProject();
    const receipts = Array.from({ length: 6 }, (_, index) => work(index + 1, BASE + (index + 1) * 30 * 60_000 - 1_000));
    const state = liveness(receipts);
    let nowMs = BASE + 3 * 60 * 60_000;
    const delivered: Array<{ reportId: string; text: string }> = [];
    const history = new Map<string, number>();
    const store = new WindowRunCadenceStore(project.stateDir);
    const make = () => new WindowRunCadenceExecutor(store, {
      now: () => new Date(nowMs).toISOString(), getLiveness: () => state, resolveFirstUnreceiptedTask: () => null,
      findDeliveredSynthesis: (_topic, reportId) => history.get(reportId) ?? null,
      deliverSynthesis: async ({ reportId, text }) => { delivered.push({ reportId, text }); history.set(reportId, 42); return { messageId: 42 }; },
    }, { enabled: true, dryRun: false });
    const first = await make().tick();
    expect(first?.intervals).toHaveLength(6);
    expect(first?.reports).toMatchObject([{ status: 'delivered', messageId: 42 }]);
    expect(delivered[0].text).toMatch(/Progress:.*Recovery:.*Blockers:.*Next:.*W32 synthesis receipt:/);
    await make().tick();
    expect(delivered).toHaveLength(1);

    const onDisk = store.load()!;
    onDisk.reports[0].status = 'attempting'; onDisk.reports[0].messageId = undefined; onDisk.nextReportDueAt = onDisk.reports[0].dueAt;
    store.save(onDisk);
    const recovered = await make().tick();
    expect(recovered?.reports[0]).toMatchObject({ status: 'delivered', messageId: 42 });
    expect(delivered).toHaveLength(1);
  });

  it('bounds failed synthesis redrive to three durable attempts and fails loudly once across restart', async () => {
    project = createTempProject();
    const receipts = Array.from({ length: 6 }, (_, index) => work(index + 1, BASE + (index + 1) * 30 * 60_000 - 1_000));
    const state = liveness(receipts);
    let nowMs = BASE + 3 * 60 * 60_000;
    let attempts = 0;
    const failures: string[] = [];
    const store = new WindowRunCadenceStore(project.stateDir);
    const make = () => new WindowRunCadenceExecutor(store, {
      now: () => new Date(nowMs).toISOString(), getLiveness: () => state, resolveFirstUnreceiptedTask: () => null,
      findDeliveredSynthesis: () => null,
      deliverSynthesis: async () => { attempts += 1; throw new Error('telegram-down'); },
      notifyFailure: async (_state, message) => { failures.push(message); return true; },
    }, { enabled: true, dryRun: false, reportRetryMaxAttempts: 3, reportRetryBackoffMs: 60_000 });

    expect((await make().tick())?.reports[0]).toMatchObject({ status: 'failed', attemptCount: 1 });
    await make().tick();
    expect(attempts).toBe(1);
    nowMs += 60_000;
    expect((await make().tick())?.reports[0]).toMatchObject({ status: 'failed', attemptCount: 2 });
    nowMs += 2 * 60_000;
    const exhausted = await make().tick();
    expect(exhausted).toMatchObject({ status: 'failed', failure: { notified: true } });
    expect(exhausted?.reports[0]).toMatchObject({ status: 'failed', attemptCount: 3 });
    expect(attempts).toBe(3);
    expect(failures).toHaveLength(1);
    nowMs += 24 * 60 * 60_000;
    await make().tick();
    expect(attempts).toBe(3);
    expect(failures).toHaveLength(1);
  });

  it('closes without future sends when liveness terminalizes', async () => {
    project = createTempProject();
    const state = liveness();
    let nowMs = BASE;
    let sends = 0;
    const executor = new WindowRunCadenceExecutor(new WindowRunCadenceStore(project.stateDir), {
      now: () => new Date(nowMs).toISOString(), getLiveness: () => state, resolveFirstUnreceiptedTask: () => null,
      deliverSynthesis: async () => { sends++; return { messageId: 1 }; },
    }, { enabled: true, dryRun: false });
    await executor.tick();
    state.status = 'closed';
    nowMs = BASE + 4 * 60 * 60_000;
    expect((await executor.tick())?.status).toBe('closed');
    expect(sends).toBe(0);
  });
});
