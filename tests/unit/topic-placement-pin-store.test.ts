/**
 * TopicPlacementPinStore — the durable "move this to <nickname>" pin behind the
 * §L4 transfer-by-nickname feature. PlacementExecutor honors a per-topic pin
 * (preferredMachine + pinned), but nothing persisted it; this store does, keyed
 * by topic, so a relocation command makes the topic's next placement land on the
 * named machine and stay there.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TopicPlacementPinStore } from '../../src/core/TopicPlacementPinStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('TopicPlacementPinStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-store-'));
    filePath = path.join(dir, 'session-pool', 'topic-pins.json');
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/topic-placement-pin-store.test.ts' }); } catch { /* cleanup */ }
  });

  it('set → get returns the pin; asTopicMetadata shapes it for PlacementExecutor', () => {
    const fixed = new Date('2026-05-29T12:00:00.000Z');
    const store = new TopicPlacementPinStore({ filePath, now: () => fixed });
    store.set('13481', 'm_mini', true);
    expect(store.get('13481')).toEqual({ preferredMachine: 'm_mini', pinned: true, updatedAt: fixed.toISOString() });
    expect(store.asTopicMetadata('13481')).toEqual({ preferredMachine: 'm_mini', pinned: true });
  });

  it('an unpinned topic → get null + asTopicMetadata undefined (so route() passes topicMetadata: undefined)', () => {
    const store = new TopicPlacementPinStore({ filePath });
    expect(store.get('99')).toBeNull();
    expect(store.asTopicMetadata('99')).toBeUndefined();
  });

  it('persists across instances (durable JSON) and creates the dir', () => {
    const a = new TopicPlacementPinStore({ filePath });
    a.set('100', 'm_a', true);
    expect(fs.existsSync(filePath)).toBe(true);
    const b = new TopicPlacementPinStore({ filePath }); // fresh instance reads from disk
    expect(b.get('100')?.preferredMachine).toBe('m_a');
  });

  it('lastUpdatedAtMs feeds the transfer rate-limit guard (ms epoch of the pin)', () => {
    const fixed = new Date('2026-05-29T12:00:00.000Z');
    const store = new TopicPlacementPinStore({ filePath, now: () => fixed });
    expect(store.lastUpdatedAtMs('7')).toBeNull(); // unpinned
    store.set('7', 'm_x');
    expect(store.lastUpdatedAtMs('7')).toBe(fixed.getTime());
  });

  it('clear removes a pin (unpin)', () => {
    const store = new TopicPlacementPinStore({ filePath });
    store.set('5', 'm_y');
    store.clear('5');
    expect(store.get('5')).toBeNull();
    expect(store.asTopicMetadata('5')).toBeUndefined();
  });

  it('survives a corrupt pins file (advisory, not authoritative → starts clean)', () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{ this is not json');
    const store = new TopicPlacementPinStore({ filePath });
    expect(store.get('1')).toBeNull(); // no throw; clean slate
    store.set('1', 'm_z'); // and still writable afterwards
    expect(store.get('1')?.preferredMachine).toBe('m_z');
  });
});
