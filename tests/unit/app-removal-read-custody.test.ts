import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppRemovalReadCustody } from '../../src/core/AppRemovalReadCustody.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const key = '2f0c8a3e-1b2c-4d5e-8f90-1234567890ab';
const creation = { eventId: 'created-on-m1', machineId: 'm1' };
const roots: string[] = [];
const root = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-removal-custody-'));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of roots.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'app-removal-read-custody-test:cleanup' });
});

describe('App removal read custody', () => {
  it('does not initialize storage on an observation and keeps an exact record across restart', () => {
    const dir = root();
    const first = new AppRemovalReadCustody(dir);
    expect(first.observe(key)).toEqual({ kind: 'unrecorded' });
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(first.record(key, creation)).toBe(true);
    const restarted = new AppRemovalReadCustody(dir);
    expect(restarted.observe(key)).toEqual({ kind: 'recorded', record: {
      version: 1, conversationKey: key, creationEventId: creation.eventId, custodianMachineId: 'm1',
    } });
    expect(restarted.record(key, creation)).toBe(true);
    expect(restarted.record(key, { ...creation, machineId: 'm2' })).toBe(false);
    expect(first.record(key, { ...creation, eventId: 'different-creation' })).toBe(false);
    expect(fs.readdirSync(path.join(dir, 'state', 'app-removal-read-custody'))).toEqual([`${key}.json`]);
  });

  it('refuses malformed or linked evidence without replacing it', () => {
    const dir = root();
    const custody = new AppRemovalReadCustody(dir);
    const directory = path.join(dir, 'state', 'app-removal-read-custody');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${key}.json`);
    fs.writeFileSync(file, '{"version":1}');
    expect(custody.observe(key)).toEqual({ kind: 'unavailable' });
    expect(custody.record(key, creation)).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"version":1}');
    const linkedDir = root();
    fs.symlinkSync(path.join(dir, 'state'), path.join(linkedDir, 'state'));
    const linked = new AppRemovalReadCustody(linkedDir);
    expect(linked.observe(key)).toEqual({ kind: 'unavailable' });
    expect(linked.record(key, creation)).toBe(false);
  });

  it('returns failure if scratch cleanup cannot finish, and accepts an exact retry', () => {
    const dir = root();
    const custody = new AppRemovalReadCustody(dir);
    const cleanup = vi.spyOn(SafeFsExecutor, 'safeUnlinkSync').mockImplementation(() => {
      throw new Error('cleanup failed');
    });
    try {
      expect(custody.record(key, creation)).toBe(false);
    } finally { cleanup.mockRestore(); }
    expect(custody.record(key, creation)).toBe(true);
    expect(custody.observe(key)).toMatchObject({ kind: 'recorded', record: { custodianMachineId: 'm1' } });
  });

  it('does not persist placeholders or invalid conversation keys', () => {
    const dir = root();
    const custody = new AppRemovalReadCustody(dir);
    expect(custody.record(key, { ...creation, machineId: 'local' })).toBe(false);
    expect(custody.record('../invalid', creation)).toBe(false);
    expect(custody.observe('../invalid')).toEqual({ kind: 'unavailable' });
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
