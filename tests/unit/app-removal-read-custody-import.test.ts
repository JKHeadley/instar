import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AppConversationStore } from '../../src/core/AppConversationStore.js';
import { AppRemovalReadCustody } from '../../src/core/AppRemovalReadCustody.js';
import { retainPeerRemovalReadCustody, verifyPeerRemovalCreation } from '../../src/core/AppRemovalReadCustodyImport.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const conversationKey = '2f0c8a3e-1b2c-4d5e-8f90-1234567890ab';
const payload = { version: 1, conversationKey, creationEventId: 'creation-a', custodianMachineId: 'm1' };
const creation = { kind: 'verified' as const, conversationKey, eventId: 'creation-a', authenticatedOrigin: 'm1' };
const roots: string[] = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-custody-import-'));
  roots.push(dir);
  const local = new AppRemovalReadCustody(dir);
  return { dir, local, input: { conversationKey, authenticatedOrigin: 'm1', payload, creation, local } };
}
afterEach(() => {
  for (const dir of roots.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'app-custody-import-test:cleanup' });
});

it('waits for verified creation and then durably retains an exact peer record', () => {
  const { dir, local, input } = fixture();
  expect(retainPeerRemovalReadCustody({ ...input, creation: { kind: 'pending' } })).toBe('pending');
  expect(local.observe(conversationKey)).toEqual({ kind: 'unrecorded' });
  expect(retainPeerRemovalReadCustody(input)).toBe('retained');
  expect(new AppRemovalReadCustody(dir).observe(conversationKey)).toEqual({ kind: 'recorded', record: payload });
  expect(retainPeerRemovalReadCustody(input)).toBe('retained');
});

it('refuses a mismatched sender, creation, extra field or conflicting retained tuple', () => {
  const { dir, local, input } = fixture();
  expect(retainPeerRemovalReadCustody({ ...input, authenticatedOrigin: 'peer' })).toBe('refused');
  expect(retainPeerRemovalReadCustody({ ...input, creation: { ...creation, authenticatedOrigin: 'peer' } })).toBe('refused');
  expect(retainPeerRemovalReadCustody({ ...input, creation: { ...creation, eventId: 'other' } })).toBe('refused');
  expect(retainPeerRemovalReadCustody({ ...input, creation: { kind: 'conflict' } })).toBe('refused');
  expect(retainPeerRemovalReadCustody({ ...input, payload: { ...payload, clear: true } })).toBe('refused');
  expect(fs.readdirSync(dir)).toEqual([]);
  expect(local.record(conversationKey, { eventId: 'different', machineId: 'm2' })).toBe(true);
  expect(retainPeerRemovalReadCustody(input)).toBe('refused');
  expect(local.observe(conversationKey)).toMatchObject({ kind: 'recorded', record: { custodianMachineId: 'm2' } });
});

it('requires the authenticated journal sender, event and local creation record to agree', () => {
  const event = {
    kind: 'created' as const, conversationKey, eventId: 'creation-a', machineId: 'm1',
    title: 'House plans', at: '2026-11-25T21:00:00.000Z',
  };
  const { kind, ...fields } = event;
  const entry = { machine: 'm1', data: { ...fields, origin: 'm1', eventKind: kind } };
  const store = { hasCreationConflict: () => false, getCreationRecord: () => event };
  expect(verifyPeerRemovalCreation(conversationKey, 'm1', entry, store)).toEqual(creation);
  expect(verifyPeerRemovalCreation(conversationKey, 'm2', entry, store)).toEqual({ kind: 'conflict' });
  expect(verifyPeerRemovalCreation(conversationKey, 'm1', { ...entry, data: { ...entry.data, origin: 'm2' } }, store)).toEqual({ kind: 'conflict' });
  expect(verifyPeerRemovalCreation(conversationKey, 'm1', entry, { ...store, getCreationRecord: () => null })).toEqual({ kind: 'pending' });
  expect(verifyPeerRemovalCreation(conversationKey, 'm1', entry, { ...store, hasCreationConflict: () => true })).toEqual({ kind: 'conflict' });
  expect(verifyPeerRemovalCreation(conversationKey, 'm1', entry, { ...store, getCreationRecord: () => ({ ...event, eventId: 'other' }) })).toEqual({ kind: 'conflict' });
  expect(verifyPeerRemovalCreation(conversationKey, 'm1', entry, { ...store, getCreationRecord: () => ({ ...event, title: 'Other plans' }) })).toEqual({ kind: 'conflict' });
});

it('rechecks authenticated creation against reopened storage and refuses later conflicts', () => {
  const { dir, input } = fixture();
  const options = { stateDir: dir, machineId: () => 'receiving-machine' };
  const event = {
    kind: 'created' as const, conversationKey, eventId: 'creation-a', machineId: 'm1',
    title: 'House plans', at: '2026-11-25T21:00:00.000Z',
  };
  const entry = { machine: 'm1', data: { ...event, origin: 'm1', eventKind: event.kind } };
  const initial = new AppConversationStore(options);
  try {
    expect(verifyPeerRemovalCreation(conversationKey, 'm1', entry, initial)).toEqual({ kind: 'pending' });
    expect(initial.ingestReplicated(event)?.appended).toBe(true);
  } finally {
    initial.close();
  }

  const reopened = new AppConversationStore(options);
  try {
    expect(retainPeerRemovalReadCustody({
      ...input, creation: verifyPeerRemovalCreation(conversationKey, 'm1', entry, reopened),
    })).toBe('retained');
    reopened.ingestReplicated({ ...event, title: 'Other plans' });
    expect(verifyPeerRemovalCreation(conversationKey, 'm1', entry, reopened)).toEqual({ kind: 'conflict' });
  } finally {
    reopened.close();
  }
});
