/**
 * Boot sweep tests — spec §5.2/§5.3 + the §3.4 crash table: gate-expiry per
 * named reason, crash recovery rows 1-3, PIS veto (stop-scoped only),
 * quarantine + expired-quarantine deletion, pause-aware recovery.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  PendingInboundStore,
  resolvePendingInboundPath,
} from '../../src/core/PendingInboundStore.js';
import {
  runInboundQueueBootSweep,
  quarantineDirFor,
  type BootSweepDeps,
} from '../../src/core/inboundQueueBootSweep.js';
import type { LossItem } from '../../src/core/QueueDrainLoop.js';

let dir: string;
let nowMs: number;

function makeDeps(over: Partial<BootSweepDeps> = {}): BootSweepDeps & {
  losses: Array<{ items: LossItem[]; reason: string }>;
  pni: LossItem[][];
  attention: string[];
  pisRecords: Set<string>;
  pisCleared: string[];
} {
  const d = {
    stateDir: dir,
    agentId: 'echo',
    queueWillRun: { run: true } as BootSweepDeps['queueWillRun'],
    losses: [] as Array<{ items: LossItem[]; reason: string }>,
    pni: [] as LossItem[][],
    attention: [] as string[],
    pisRecords: new Set<string>(),
    pisCleared: [] as string[],
    hasPisRecord: (sk: string) => d.pisRecords.has(sk),
    clearPisRecord: (sk: string) => { d.pisCleared.push(sk); },
    reportLoss: (items: LossItem[], reason: string) => { d.losses.push({ items, reason }); },
    reportPossiblyNotInjected: (items: LossItem[]) => { d.pni.push(items); },
    raiseAttention: (title: string) => { d.attention.push(title); },
    log: () => {},
    nowMs: () => nowMs,
    ...over,
  };
  return d as ReturnType<typeof makeDeps>;
}

function seedStore(): PendingInboundStore {
  return PendingInboundStore.open('echo', dir);
}

function seedRow(store: PendingInboundStore, sessionKey: string, messageId: string): number {
  const out = store.enqueue(
    { sessionKey, messageId, payload: 'p', senderEnvelope: { firstName: 'J' }, topicMetadata: undefined, reason: 'r', tenure: 'mac-a#1', nowIso: new Date(nowMs).toISOString(), monoMs: 1, bootSessionId: 'old-boot' },
    { maxPerSession: 50, maxTotal: 500, hardMaxTotal: 1000, maxPayloadBytes: 65536 },
  );
  if (out.result !== 'queued') throw new Error('seed failed');
  return out.seq;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iqbs-test-'));
  nowMs = Date.parse('2026-06-12T20:00:00Z');
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'inbound-queue-boot-sweep.test.ts' });
});

describe('no store file', () => {
  it('is a no-op (file-existence keyed)', () => {
    const res = runInboundQueueBootSweep(makeDeps());
    expect(res.storePresent).toBe(false);
    expect(res.store).toBeNull();
  });
});

describe('gate-expiry (§5.3 — queue will not run this boot)', () => {
  for (const gate of ['feature-disabled', 'pool-dark', 'no-mesh-identity', 'dry-run'] as const) {
    it(`expires all non-terminal rows naming gate:${gate}`, () => {
      const store = seedStore();
      seedRow(store, 's1', 'm1');
      const claimed = seedRow(store, 's2', 'm2');
      store.claim(claimed, new Date(nowMs).toISOString());
      store.close();

      const deps = makeDeps({ queueWillRun: { run: false, gateReason: gate } });
      const res = runInboundQueueBootSweep(deps);
      expect(res.gateExpired).toBe(2);
      expect(res.store).toBeNull(); // closed — the drain never constructs
      expect(deps.losses[0].reason).toBe(`queue-dispatch-will-not-run:${gate}`);
      const reopened = seedStore();
      expect(reopened.listNonTerminal()).toHaveLength(0);
      expect(reopened.getRow(claimed)?.terminal_reason).toBe(`gate:${gate}`);
      reopened.close();
    });
  }
});

describe('crash recovery (§3.4 crash table)', () => {
  it('row 1: claimed, no receipt → released to queued (redispatch)', () => {
    const store = seedStore();
    const seq = seedRow(store, 's', 'm');
    store.claim(seq, new Date(nowMs).toISOString());
    store.close();

    const deps = makeDeps();
    const res = runInboundQueueBootSweep(deps);
    expect(res.recoveredToQueued).toBe(1);
    expect(res.store!.getRow(seq)?.state).toBe('queued');
    res.store!.close();
  });

  it('row 2: claimed + receipt, no PIS → delivered_unconfirmed + "possibly not injected"', () => {
    const store = seedStore();
    const seq = seedRow(store, 's', 'm');
    store.claim(seq, new Date(nowMs).toISOString());
    store.writeReceiptIfClaimed(seq, 's', 'm', new Date(nowMs).toISOString());
    store.close();

    const deps = makeDeps();
    const res = runInboundQueueBootSweep(deps);
    expect(res.settledDelivered).toBe(1);
    expect(res.possiblyNotInjected).toBe(1);
    expect(deps.pni[0][0]).toMatchObject({ sessionKey: 's', reason: 'receipt-without-downstream-record' });
    const row = res.store!.getRow(seq)!;
    expect(row.state).toBe('delivered');
    expect(row.delivered_unconfirmed).toBe(1);
    res.store!.close();
  });

  it('row 3: claimed + receipt + PIS → delivered clean (PIS replays the inject)', () => {
    const store = seedStore();
    const seq = seedRow(store, 's', 'm');
    store.claim(seq, new Date(nowMs).toISOString());
    store.writeReceiptIfClaimed(seq, 's', 'm', new Date(nowMs).toISOString());
    store.close();

    const deps = makeDeps();
    deps.pisRecords.add('s');
    const res = runInboundQueueBootSweep(deps);
    expect(res.settledDelivered).toBe(1);
    expect(res.possiblyNotInjected).toBe(0);
    expect(res.store!.getRow(seq)?.delivered_unconfirmed).toBe(0);
    res.store!.close();
  });

  it('pause durably in effect: recovered claimed→queued rows are frozen; PIS records NOT vetoed', () => {
    const store = seedStore();
    const seq = seedRow(store, 's', 'm');
    store.claim(seq, new Date(nowMs).toISOString());
    store.setPaused(true, new Date(nowMs).toISOString());
    store.close();

    const deps = makeDeps();
    deps.pisRecords.add('some-other-session');
    const res = runInboundQueueBootSweep(deps);
    const row = res.store!.getRow(seq)!;
    expect(row.state).toBe('queued');
    expect(row.frozen_since).not.toBeNull();
    expect(deps.pisCleared).toHaveLength(0); // round-9: veto is stop-scoped ONLY
    res.store!.close();
  });

  it('PIS veto fires for operator-stop sessions only (round-9 pin)', () => {
    const store = seedStore();
    const stoppedSeq = seedRow(store, 's-stopped', 'm1');
    store.transition(stoppedSeq, 'queued', 'expired', { nowIso: new Date(nowMs).toISOString(), terminalReason: 'operator-stop' });
    seedRow(store, 's-live', 'm2');
    store.close();

    const deps = makeDeps();
    const res = runInboundQueueBootSweep(deps);
    expect(deps.pisCleared).toEqual(['s-stopped']);
    expect(res.pisVetoed).toBe(1);
    res.store!.close();
  });

  it('unflipped unreported receipts are reported once (window 6 boot detection)', () => {
    const store = seedStore();
    store.recordRemoteReceipt('s', 'm-remote', new Date(nowMs).toISOString());
    store.close();

    const deps = makeDeps();
    const res = runInboundQueueBootSweep(deps);
    expect(res.possiblyNotInjected).toBe(1);
    // Reported once: a second sweep reports nothing.
    res.store!.close();
    const deps2 = makeDeps();
    const res2 = runInboundQueueBootSweep(deps2);
    expect(res2.possiblyNotInjected).toBe(0);
    res2.store!.close();
  });
});

describe('quarantine (§5.3 fail-open)', () => {
  it('an unopenable store is quarantined with sidecars; boot proceeds; one attention item', () => {
    const storePath = resolvePendingInboundPath(dir, 'echo');
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, 'NOT A SQLITE FILE — corrupt');
    fs.writeFileSync(`${storePath}-wal`, 'wal');
    fs.writeFileSync(`${storePath}-shm`, 'shm');

    const deps = makeDeps();
    const res = runInboundQueueBootSweep(deps);
    expect(res.quarantined).toBe(true);
    expect(res.store).toBeNull();
    expect(deps.attention).toHaveLength(1);
    expect(fs.existsSync(storePath)).toBe(false);
    const qFiles = fs.readdirSync(quarantineDirFor(dir));
    expect(qFiles.length).toBe(3); // main + wal + shm moved
    for (const f of qFiles) {
      const mode = fs.statSync(path.join(quarantineDirFor(dir), f)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('expired quarantines (>7d) are deleted on every boot — even gated-off', () => {
    const qDir = quarantineDirFor(dir);
    fs.mkdirSync(qDir, { recursive: true });
    const old = path.join(qDir, 'pending-inbound.echo.sqlite.old');
    fs.writeFileSync(old, 'x');
    const past = new Date(nowMs - 8 * 24 * 3600_000);
    fs.utimesSync(old, past, past);

    const deps = makeDeps({ queueWillRun: { run: false, gateReason: 'feature-disabled' } });
    const res = runInboundQueueBootSweep(deps);
    expect(res.expiredQuarantinesDeleted).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
  });
});
