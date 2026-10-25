import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { OriginSourcePoller } from '../../../src/messaging/telegram-origin/OriginSourcePoller.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const roots: string[] = [];
// One source write can show the poller more than one metadata state: writeFile
// truncates before it writes, and on APFS a rename updates ctime a moment after
// the new file appears. Invalidation is an idempotent refresh, so the contract
// is at least one callback per change and none after close, not exactly one
// (Rule 37 repair, PR #2087 round 3).
async function settled(changed: ReturnType<typeof vi.fn>): Promise<number> {
  for (let count = -1; count !== changed.mock.calls.length;) {
    count = changed.mock.calls.length; await new Promise(resolve => setTimeout(resolve, 100));
  }
  return changed.mock.calls.length;
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map(root => SafeFsExecutor.safeRm(root, {
    recursive: true, force: true, operation: 'test:origin-source-poller:cleanup',
  })));
});

describe('OriginSourcePoller', () => {
  it('invalidates changed and deleted authority sources and closes by cancelling its timer', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'origin-source-poller-')); roots.push(root);
    const filename = path.join(root, 'config.json'); await writeFile(filename, '{"v":1}');
    const changed = vi.fn();
    const poller = new OriginSourcePoller([filename], changed, 10);
    await poller.start();
    await writeFile(filename, '{"v":22}');
    await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 1000 });
    const beforeDelete = await settled(changed);
    await SafeFsExecutor.safeRm(filename, {
      force: true, operation: 'test:origin-source-poller:delete-source',
    });
    await vi.waitFor(() => expect(changed.mock.calls.length).toBeGreaterThan(beforeDelete), { timeout: 1000 });
    const started = performance.now(); poller.close();
    expect(performance.now() - started).toBeLessThan(50);
    const atClose = changed.mock.calls.length;
    await writeFile(filename, '{"v":333}');
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(changed).toHaveBeenCalledTimes(atClose);
  });

  it('observes a source created after startup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'origin-source-poller-')); roots.push(root);
    const filename = path.join(root, 'late.json');
    const changed = vi.fn();
    const poller = new OriginSourcePoller([filename], changed, 10);
    await poller.start();
    await writeFile(filename, '{}');
    await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 1000 });
    poller.close();
  });
});
