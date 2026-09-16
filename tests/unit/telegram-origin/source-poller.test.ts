import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { OriginSourcePoller } from '../../../src/messaging/telegram-origin/OriginSourcePoller.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const roots: string[] = [];
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
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce(), { timeout: 1000 });
    await SafeFsExecutor.safeRm(filename, {
      force: true, operation: 'test:origin-source-poller:delete-source',
    });
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2), { timeout: 1000 });
    const started = performance.now(); poller.close();
    expect(performance.now() - started).toBeLessThan(50);
    await writeFile(filename, '{"v":333}');
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('observes a source created after startup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'origin-source-poller-')); roots.push(root);
    const filename = path.join(root, 'late.json');
    const changed = vi.fn();
    const poller = new OriginSourcePoller([filename], changed, 10);
    await poller.start();
    await writeFile(filename, '{}');
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce(), { timeout: 1000 });
    poller.close();
  });
});
