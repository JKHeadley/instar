import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FencedPublicationStore } from '../../src/core/FencedPublicationStore.js';
import { claimMobileIngress } from '../../src/core/MobileIngressPublication.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const scope = { agentId: 'echo', namespace: 'mobile-ingress' } as const;
const original = { epoch: 4, holder: 'mini' };
const successor = { epoch: 5, holder: 'studio' };
const digest = '1'.repeat(64);
const other = '2'.repeat(64);
const handover = '3'.repeat(64);
const directories: string[] = [];
const stores: FencedPublicationStore[] = [];

function open(file: string): FencedPublicationStore {
  const store = FencedPublicationStore.open(file);
  stores.push(store);
  return store;
}

function temporaryDatabase(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fenced-publication-'));
  directories.push(dir);
  return path.join(dir, 'authority.sqlite');
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    SafeFsExecutor.safeRmSync(directory, {
      recursive: true, force: true, operation: 'tests/unit/FencedPublicationStore.test.ts:cleanup',
    });
  }
});

describe('shared fenced publication storage', () => {
  it('preserves an exact claim and rejects conflicting reuse on another connection', () => {
    const file = temporaryDatabase();
    const first = open(file);
    const second = open(file);
    expect(first.provision(scope, original)).toBe(true);
    expect(first.claim(scope, original, 'phone:request', digest)).toMatchObject({ kind: 'claimed' });
    expect(second.claim(scope, original, 'phone:request', digest)).toMatchObject({ kind: 'existing' });
    expect(second.claim(scope, original, 'phone:request', other)).toEqual({ kind: 'conflict' });
  });

  it('blocks both generations during pending, fences a stale claim and preserves history after handover', () => {
    const file = temporaryDatabase();
    const before = open(file);
    const after = open(file);
    expect(before.provision(scope, original)).toBe(true);
    expect(before.claim(scope, original, 'already-claimed', digest).kind).toBe('claimed');
    expect(after.prepareHandover(scope, original, successor, handover)).toBe(true);
    expect(before.claim(scope, original, 'new', digest)).toEqual({ kind: 'pending' });
    expect(after.claim(scope, successor, 'new', digest)).toEqual({ kind: 'pending' });
    expect(after.activateHandover(scope, original, successor, other)).toBe(false);
    expect(after.activateHandover(scope, original, successor, handover)).toBe(true);
    expect(before.claim(scope, original, 'new', digest)).toEqual({ kind: 'fenced' });
    expect(after.claim(scope, successor, 'new', digest).kind).toBe('claimed');
    expect(after.claim(scope, successor, 'already-claimed', digest)).toMatchObject({
      kind: 'existing', claim: { generation: original },
    });
  });

  it('recovers pending handover and the exact claim after closing and reopening the store', () => {
    const file = temporaryDatabase();
    const before = FencedPublicationStore.open(file);
    try {
      expect(before.provision(scope, original)).toBe(true);
      expect(before.claim(scope, original, 'existing', digest).kind).toBe('claimed');
      expect(before.prepareHandover(scope, original, successor, handover)).toBe(true);
    } finally {
      before.close();
    }
    const recovered = open(file);
    expect(recovered.claim(scope, successor, 'new', digest)).toEqual({ kind: 'pending' });
    expect(recovered.getClaim(scope, 'existing')).toEqual({ operationKey: 'existing', digest, generation: original });
    expect(recovered.activateHandover(scope, original, successor, handover)).toBe(true);
    expect(recovered.claim(scope, successor, 'existing', digest).kind).toBe('existing');
  });

  it('keys mobile claims on device and request, and rejects a changed digest', () => {
    const store = open(temporaryDatabase());
    expect(store.provision(scope, original)).toBe(true);
    const intent = { agentId: 'echo', deviceId: 'phone-a', requestId: 'request-1', admittedDigest: digest };
    expect(claimMobileIngress(store, original, intent).kind).toBe('claimed');
    expect(claimMobileIngress(store, original, intent).kind).toBe('existing');
    expect(claimMobileIngress(store, original, { ...intent, admittedDigest: other }).kind).toBe('conflict');
    expect(claimMobileIngress(store, original, { ...intent, deviceId: 'phone-b' }).kind).toBe('claimed');
  });

  it('isolates each namespace and agent even when operation keys match', () => {
    const store = open(temporaryDatabase());
    const names = ['needs-you', 'machine-key-history', 'delete', 'mobile-ingress'] as const;
    for (const namespace of names) {
      const client = { agentId: 'echo', namespace };
      expect(store.claim(client, original, 'same-key', digest)).toEqual({ kind: 'unavailable' });
      expect(store.provision(client, original)).toBe(true);
      expect(store.claim(client, original, 'same-key', digest).kind).toBe('claimed');
    }
    const another = { ...scope, agentId: 'another-agent' };
    expect(store.getClaim(another, 'same-key')).toBeNull();
  });
});
