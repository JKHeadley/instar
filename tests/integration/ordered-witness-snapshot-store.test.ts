import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { OrderedWitnessSnapshotStore } from '../../src/core/OrderedWitnessSnapshotStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

it('persists the exact accepted Git and floor pair and refuses stale predecessors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ordered-witness-snapshot-'));
  const filename = join(dir, 'witness.sqlite');
  const scope = { agentId: 'echo', namespace: 'needs-you' } as const;
  const genesis = { commit: 'a'.repeat(40), floor: {
    ...scope, epoch: 1, holder: 'studio', head: '0'.repeat(64), position: 0, witnessGeneration: 1, witness: 'mini',
  } };
  const next = { commit: 'b'.repeat(40), floor: { ...genesis.floor, head: '1'.repeat(64), position: 1 } };
  const alternative = { commit: 'c'.repeat(40), floor: { ...next.floor, head: '2'.repeat(64) } };
  let store = OrderedWitnessSnapshotStore.open(filename);
  try {
    expect(store.read(scope)).toBeNull();
    expect(store.provision(genesis)).toBe(true);
    expect(store.provision(genesis)).toBe(false);
    expect(store.recordAccepted(genesis, next)).toBe('recorded');
    store.close();
    store = OrderedWitnessSnapshotStore.open(filename);
    expect(store.read(scope)).toEqual(next);
    expect(store.recordAccepted(genesis, next)).toBe('existing');
    expect(store.recordAccepted(genesis, alternative)).toBe('mismatch');
    expect(store.recordAccepted(next, genesis)).toBe('mismatch');
    expect(store.read({ ...scope, namespace: 'mobile-ingress' })).toBeNull();
    expect(store.read(scope)).toEqual(next);
  } finally {
    store.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'ordered-witness-snapshot-test:cleanup' });
  }
});
