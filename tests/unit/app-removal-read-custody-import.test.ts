import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AppRemovalReadCustody } from '../../src/core/AppRemovalReadCustody.js';
import { retainPeerRemovalReadCustody } from '../../src/core/AppRemovalReadCustodyImport.js';
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
