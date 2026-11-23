import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CreationPlacementSnapshot, creationPlacementSourceVersion } from '../../src/core/CreationPlacementSnapshot.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

describe('complete creation placement snapshot', () => {
  it('never invokes a complete loader on the HTTP read, caches unchanged sources and invalidates pending writes', async () => {
    let version = 'v1'; const load = vi.fn(() => []);
    const cache = new CreationPlacementSnapshot({ enabled: () => true, version: () => version, load });
    expect(cache.get().complete).toBe(false); expect(load).not.toHaveBeenCalled();
    await turn(); expect(cache.get().complete).toBe(true); expect(load).toHaveBeenCalledTimes(1);
    cache.get(); expect(load).toHaveBeenCalledTimes(1);
    version = 'pending-v2'; expect(cache.get().complete).toBe(false);
    await turn(); expect(cache.get().version).toBe('pending-v2'); expect(load).toHaveBeenCalledTimes(2);
  });
  it('does not publish a view when the source changed during complete read, and existing cadence can retry failure', async () => {
    let version = 'v1'; let fail = true;
    const cache = new CreationPlacementSnapshot({ enabled: () => true, version: () => version, load: () => { if (fail) { version = 'v2'; return null; } return []; } });
    cache.get(); await turn(); expect(cache.get().complete).toBe(false); await turn();
    fail = false; cache.refresh(); await turn(); expect(cache.get().complete).toBe(true);
  });
  it('configuration-off is unavailable, even after a complete cached empty tree', async () => {
    let enabled = true;
    const cache = new CreationPlacementSnapshot({ enabled: () => enabled, version: () => 'v1', load: () => [] });
    cache.refresh(); await turn(); expect(cache.get().complete).toBe(true);
    enabled = false; expect(cache.get().complete).toBe(false);
  });
  it('a stable unflushed placement queue cannot publish a complete durable snapshot', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creation-pending-'));
    try {
      let highWaterSeq = 1;
      const version = () => creationPlacementSourceVersion(dir, [{ kind: 'chief-of-staff-record', lastSeq: 2, highWaterSeq }]);
      const load = vi.fn(() => []);
      const cache = new CreationPlacementSnapshot({ enabled: () => true, version, load });
      cache.get(); await turn();
      expect(cache.get().complete).toBe(false); expect(load).not.toHaveBeenCalled();
      highWaterSeq = 2; cache.get(); await turn(); expect(cache.get().complete).toBe(true);
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test-creation-pending' }); }
  });
  it('strict source identity notices new peers and archived Chief files but ignores unrelated streams', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creation-source-version-'));
    try {
      const root = path.join(dir, 'state', 'coherence-journal'); fs.mkdirSync(root, { recursive: true });
      const initial = creationPlacementSourceVersion(dir, []);
      fs.writeFileSync(path.join(root, 'local.app-conversation-event.jsonl'), '{}');
      expect(creationPlacementSourceVersion(dir, [])).toBe(initial);
      fs.mkdirSync(path.join(root, 'peers'));
      fs.writeFileSync(path.join(root, 'peers', 'peer.chief-of-staff-record.1.jsonl'), '{}');
      expect(creationPlacementSourceVersion(dir, [])).not.toBe(initial);
      expect(creationPlacementSourceVersion(dir, [{ kind: 'chief-of-staff-record', lastSeq: 1 }])).not.toBe(creationPlacementSourceVersion(dir, []));
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test-creation-placement-source' }); }
  });
});
