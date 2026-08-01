import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AttentionConditionStore, type AttentionConditionIdentity } from '../../src/core/AttentionConditionStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'AttentionConditionStore.test cleanup' });
  }
});

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attention-condition-'));
  dirs.push(dir);
  const filePath = path.join(dir, 'conditions.json');
  const clock = { now: Date.parse('2026-08-01T20:00:00Z') };
  const create = () => new AttentionConditionStore({ filePath, now: () => clock.now });
  return { filePath, clock, create };
}

const identity: AttentionConditionIdentity = {
  producer: 'stale-owner-release',
  conditionType: 'ambiguity',
  subject: 'peer-a',
  scope: 'owner',
};

describe('AttentionConditionStore', () => {
  it('reuses one active episode across process reconstruction', () => {
    const h = harness();
    const first = h.create().observe(identity);
    expect(first.shouldRaise).toBe(true);

    h.clock.now += 60_000;
    const afterRestart = h.create().observe(identity);
    expect(afterRestart).toEqual({ itemId: first.itemId, episode: 1, shouldRaise: false });
  });

  it('mints a new episode only after an explicit clear', () => {
    const h = harness();
    const store = h.create();
    const first = store.observe(identity);
    expect(store.clear(identity)).toBe(true);

    h.clock.now += 60_000;
    const recurrence = h.create().observe(identity);
    expect(recurrence.shouldRaise).toBe(true);
    expect(recurrence.episode).toBe(2);
    expect(recurrence.itemId).not.toBe(first.itemId);
  });

  it('clears every active condition for one producer and subject without touching siblings', () => {
    const h = harness();
    const store = h.create();
    store.observe(identity);
    store.observe({ ...identity, conditionType: 'giveup', scope: '700' });
    const sibling = store.observe({ ...identity, subject: 'peer-b' });

    expect(store.clearSubject(identity.producer, identity.subject)).toBe(2);
    expect(store.observe(identity).episode).toBe(2);
    expect(store.observe({ ...identity, subject: 'peer-b' })).toEqual({ ...sibling, shouldRaise: false });
  });
});
