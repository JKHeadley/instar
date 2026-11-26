import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { DeviceRegistry, keyHashOf } from '../../src/core/MobileDeviceKeys.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { FirstApproverWriteReservationStore, firstApproverReplacementReservation } from '../../src/core/trustJourney/FirstApproverWriteReservationStore.js';

const deviceKey = makeDevice().publicKey;
const newKey = makeDevice().publicKey;
const write = {
  slotKey: 'tj:device-acceptance:first:0', operationId: 'local-replacement-1',
  holderMachineId: 'machine-1', holderEpoch: 'epoch-1',
  deviceKeyHash: keyHashOf(deviceKey), priorPresenceKeyHash: null, newPresenceKeyHash: keyHashOf(newKey),
};
const replacement = firstApproverReplacementReservation('local-owner-device', write);
const enrollment = {
  ...replacement, operationId: 'phone-enrollment-1',
  kind: 'phone-enrollment' as const, intentHash: 'b'.repeat(64),
};

it.each([replacement, enrollment])('recovers the durable $kind winner and refuses the other write', winner => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-approver-reservation-'));
  const file = path.join(dir, 'slot.db');
  const loser = winner.kind === 'phone-enrollment' ? replacement : enrollment;
  const registry = new DeviceRegistry(dir);
  expect(registry.createActiveLocalOwner({
    id: 'local-owner-device', publicKey: deviceKey, host: 'fixture', label: null,
    machineId: write.holderMachineId, approvedAt: new Date().toISOString(),
  }).ok).toBe(true);
  const apply = vi.spyOn(registry, 'replaceFirstApproverPresenceKey');
  let holder = 'epoch-1';
  const current = (intent: typeof winner) => intent.holderEpoch === holder;
  try {
    const first = new Database(file);
    try {
      const store = new FirstApproverWriteReservationStore(first, current);
      expect(store.reserve({ ...winner, slotKey: 'tj:device-acceptance:first:00' })).toBe(false);
      expect(store.reserve(winner)).toBe(true);
      expect(store.reserve(loser)).toBe(false);
      expect(store.applyLocalKeyReplacement(registry, 'other-device', newKey, write)).toBeNull();
      expect(apply).not.toHaveBeenCalled();
    } finally {
      first.close();
    }
    const resumed = new Database(file);
    try {
      const store = new FirstApproverWriteReservationStore(resumed, current);
      expect(store.reserve(winner)).toBe(true);
      expect(store.reserve(loser)).toBe(false);
      expect(store.applyLocalKeyReplacement(registry, 'local-owner-device', newKey, write)).toBe(winner.kind === 'local-key-replacement' ? 'replaced' : null);
      holder = 'epoch-2';
      expect(store.applyLocalKeyReplacement(registry, 'local-owner-device', newKey, write)).toBeNull();
      expect(store.reserve({ ...loser, holderEpoch: holder })).toBe(false);
      expect(apply).toHaveBeenCalledTimes(winner.kind === 'local-key-replacement' ? 1 : 0);
      expect(new DeviceRegistry(dir).get('local-owner-device')?.presenceKey)
        .toBe(winner.kind === 'local-key-replacement' ? newKey : undefined);
    } finally {
      resumed.close();
    }
  } finally {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'first-approver reservation fixture' });
  }
});
