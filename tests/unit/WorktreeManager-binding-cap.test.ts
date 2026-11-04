/**
 * The 30-binding cap must not become a permanent dead end. Nothing marks a
 * binding merged or abandoned, so at the cap every record is 'active'. The
 * manager now evicts the oldest binding that no session holds a live lock on;
 * it refuses only when every binding is in live use.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { createTwoSessionHarness, type HarnessHandle } from '../fixtures/two-session-harness.js';
import type { WorktreeBinding } from '../../src/core/WorktreeManager.js';

let h: HarnessHandle;
beforeEach(async () => { h = await createTwoSessionHarness(); });
afterEach(() => { h.cleanup(); });

type Internals = { bindings: Map<string, WorktreeBinding> };
const internals = () => h.manager as unknown as Internals;

/** Fill the map to the cap with copies of a real binding, oldest first. */
function fillToCap(template: WorktreeBinding, samePath: boolean): void {
  const m = internals().bindings;
  m.clear();
  for (let i = 0; i < 30; i++) {
    const topicId = 9000 + i;
    m.set(`${topicId}:dev`, {
      ...template,
      topicId,
      worktreePath: samePath ? template.worktreePath : `${template.worktreePath}-fake-${i}`,
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
    });
  }
}

describe('binding cap', () => {
  it('evicts the oldest idle binding instead of refusing; the evicted topic can come back', async () => {
    const first = await h.spawn({ topicId: 100, slug: 'seed' });
    h.release(first); // no live lock on its worktree any more
    const seed = internals().bindings.get('100:dev')!;
    fillToCap(seed, false);
    const oldestKey = '9000:dev';
    expect(internals().bindings.has(oldestKey)).toBe(true);

    const next = await h.spawn({ topicId: 200, slug: 'new-topic' });
    expect(next.cwd).toBeDefined();
    expect(internals().bindings.has(oldestKey)).toBe(false); // the oldest idle record went
    expect(internals().bindings.has('200:dev')).toBe(true);
    expect(internals().bindings.size).toBe(30);

    const historyFile = (h.manager as unknown as { bindingHistoryLog: string }).bindingHistoryLog;
    const history = fs.readFileSync(historyFile, 'utf-8');
    expect(history).toContain('binding-evicted-idle');
  });

  it('a topic whose record was evicted gets its existing worktree back', async () => {
    const s = await h.spawn({ topicId: 100, slug: 'seed' });
    const cwd = s.cwd!;
    h.release(s);
    internals().bindings.delete('100:dev'); // as if evicted
    const again = await h.spawn({ topicId: 100, slug: 'seed' });
    expect(again.cwd).toBe(cwd); // adopted, not recreated elsewhere
  });

  it('still refuses when every binding is held by a live session', async () => {
    await h.spawn({ topicId: 100, slug: 'seed' }); // live lock (this process) on the seed worktree
    const seed = internals().bindings.get('100:dev')!;
    fillToCap(seed, true); // all 30 point at the live-locked worktree
    await expect(h.spawn({ topicId: 200, slug: 'new-topic' })).rejects.toThrow(/all held by live sessions/);
  });
});
