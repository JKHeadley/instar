import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PREFERENCES_KIND_REGISTRATION } from '../../src/core/ConversationPreferences.js';
import { wirePreferenceStore } from '../../src/core/ConversationPreferencesWiring.js';
import { ReplicatedRecordEmitter } from '../../src/core/ReplicatedRecordEmitter.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ReplicatedStoreReconciler } from '../../src/core/ReplicatedStoreReconciler.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/conversation-preferences-reconcile-retry.test.ts' }); });

function setup() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preference-retry-')); dirs.push(stateDir);
  const registry = new ReplicatedKindRegistry(); registry.register(PREFERENCES_KIND_REGISTRATION);
  let admitted = false;
  let writerEnabled = true;
  let seq = 0;
  const append = vi.fn(() => admitted ? 'accepted' as const : 'rate-limited' as const);
  const emitter = new ReplicatedRecordEmitter({
    journal: {
      emitReplicatedRecord: append,
      emitReplicatedRecordWithSeq: () => ({ outcome: append(), seq: ++seq }),
    },
    clock: { tick: () => ({ physical: ++seq, logical: 0, node: 'self' }) },
    registry, origin: 'self', stores: () => ({ conversationPreferences: { enabled: writerEnabled } }),
    loadWitness: () => undefined,
  });
  const store = wirePreferenceStore({ stateDir, emitter, ownMachineId: 'self', peerStreams: null, report: vi.fn(), awaitDurable: async () => {} });
  const scan = vi.fn(() => ({ rows: [], skipped: 0, present: true }));
  const log = vi.fn();
  let cliEnabled = false;
  let callbackFault = false;
  const rec = new ReplicatedStoreReconciler({
    emitter, registry, origin: 'self', stores: () => ({ conversationPreferences: { enabled: true } }),
    reader: { loadOwnOriginRecordsAsync: async () => new Map() },
    seams: [{ store: 'conversationPreferences', paths: [], snapshot: scan }],
    gitCarried: async () => 'local', config: () => ({ enabled: cliEnabled }), log,
    drainDurableOutboxes: () => { if (callbackFault) throw new Error('outbox unavailable'); store.flushEmits(); },
  });
  return { store, rec, scan, log, append, admit: () => { admitted = true; }, disableWriter: () => { writerEnabled = false; }, enableCli: () => { cliEnabled = true; }, fault: (value: boolean) => { callbackFault = value; } };
}

describe('preference outbox on the existing reconciler cadence', () => {
  it('recovers a refused write while CLI scanning is disabled, without another mutation', async () => {
    const h = setup();
    const rows = h.store.prepareOperation('owner', 'app:12345678-1234-4234-8234-123456789abc', { muted: true });
    h.store.applyReserved(rows);
    expect(h.store.emissionStatus(rows[0]!)).toBe('pending');
    h.admit(); await h.rec.tick();
    await expect.poll(() => h.store.emissionStatus(rows[0]!)).toBe('emitted');
    expect(h.scan).not.toHaveBeenCalled();
    expect(h.store.get('owner', rows[0]!.ref)?.muted).toBe(true);
  });

  it('retains writer admission even though outbox draining bypasses the CLI switch', async () => {
    const h = setup();
    const rows = h.store.prepareOperation('owner', 'app:12345678-1234-4234-8234-123456789abc', { archived: true });
    h.store.applyReserved(rows);
    h.admit(); h.disableWriter(); h.append.mockClear(); await h.rec.tick();
    expect(h.append).not.toHaveBeenCalled();
    expect(h.store.emissionStatus(rows[0]!)).toBe('pending');
  });

  it('isolates callback faults from CLI scanning and releases the next tick', async () => {
    const h = setup(); h.enableCli(); h.fault(true);
    await h.rec.tick();
    expect(h.log).toHaveBeenCalledWith('outbox-retry-fault', { error: 'outbox unavailable' });
    expect(h.scan).toHaveBeenCalledTimes(1);
    h.fault(false); await h.rec.tick();
    expect(h.scan).toHaveBeenCalledTimes(2);
  });
});
