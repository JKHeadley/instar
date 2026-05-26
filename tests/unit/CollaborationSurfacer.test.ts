/**
 * Unit tests for CollaborationSurfacer (CMT-509 §2) — parentless Threadline
 * conversations surface to a single dedicated topic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CollaborationSurfacer, type SurfacerTelegram } from '../../src/threadline/CollaborationSurfacer.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function fakeTelegram(): SurfacerTelegram & { posts: Array<{ topicId: number; text: string }>; created: number } {
  const state = {
    posts: [] as Array<{ topicId: number; text: string }>,
    created: 0,
    async findOrCreateForumTopic(name: string) {
      state.created += 1;
      return { topicId: 7777, name, reused: state.created > 1 };
    },
    async sendToTopic(topicId: number, text: string) {
      state.posts.push({ topicId, text });
      return { ok: true };
    },
  };
  return state;
}

describe('CollaborationSurfacer', () => {
  let stateDir: string;
  let cleanup: () => void;
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surfacer-'));
    cleanup = () => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/CollaborationSurfacer.test.ts:cleanup' });
  });
  afterEach(() => cleanup());

  const base = { threadId: 't1', senderName: 'codey', text: 'Can you verify the build?', hasParentTopic: false, warrants: true };

  it('posts a parentless warranted first contact to the dedicated topic', async () => {
    const tg = fakeTelegram();
    const s = new CollaborationSurfacer({ telegram: tg, stateDir });
    const r = await s.surface(base);
    expect(r.surfaced).toBe(true);
    expect(r.topicId).toBe(7777);
    expect(tg.posts).toHaveLength(1);
    expect(tg.posts[0].text).toContain('codey');
    expect(tg.posts[0].text).toContain('Can you verify the build?');
  });

  it('does NOT surface a conversation that has a parent topic', async () => {
    const tg = fakeTelegram();
    const s = new CollaborationSurfacer({ telegram: tg, stateDir });
    const r = await s.surface({ ...base, hasParentTopic: true });
    expect(r.surfaced).toBe(false);
    expect(r.reason).toBe('has-parent-topic');
    expect(tg.posts).toHaveLength(0);
  });

  it('does NOT surface a non-warranted message', async () => {
    const tg = fakeTelegram();
    const s = new CollaborationSurfacer({ telegram: tg, stateDir });
    const r = await s.surface({ ...base, warrants: false });
    expect(r.surfaced).toBe(false);
    expect(r.reason).toBe('not-warranted');
    expect(tg.posts).toHaveLength(0);
  });

  it('dedupes: one post per conversation; follow-ups do not re-post', async () => {
    const tg = fakeTelegram();
    const s = new CollaborationSurfacer({ telegram: tg, stateDir });
    await s.surface(base);
    const r2 = await s.surface({ ...base, text: 'a follow-up on the same thread' });
    expect(r2.surfaced).toBe(false);
    expect(r2.reason).toBe('already-surfaced');
    expect(tg.posts).toHaveLength(1);
  });

  it('reuses ONE dedicated topic across different conversations (created once)', async () => {
    const tg = fakeTelegram();
    const s = new CollaborationSurfacer({ telegram: tg, stateDir });
    await s.surface({ ...base, threadId: 't-a' });
    await s.surface({ ...base, threadId: 't-b' });
    expect(tg.posts).toHaveLength(2);
    expect(tg.posts.every(p => p.topicId === 7777)).toBe(true);
    expect(tg.created).toBe(1); // topic created once, then reused from state
  });

  it('persists the dedicated topic id across instances (no re-create)', async () => {
    const tg = fakeTelegram();
    await new CollaborationSurfacer({ telegram: tg, stateDir }).surface({ ...base, threadId: 't-a' });
    await new CollaborationSurfacer({ telegram: tg, stateDir }).surface({ ...base, threadId: 't-b' });
    expect(tg.created).toBe(1);
  });

  it('never emits raw JSON — extracts a readable gist', async () => {
    const tg = fakeTelegram();
    const s = new CollaborationSurfacer({ telegram: tg, stateDir });
    await s.surface({ ...base, text: JSON.stringify({ type: 'query', text: 'the real question' }) });
    expect(tg.posts[0].text).toContain('the real question');
    expect(tg.posts[0].text).not.toContain('"type"');
    expect(tg.posts[0].text).not.toContain('{');
  });

  it('shortens a fingerprint-looking sender name', async () => {
    const tg = fakeTelegram();
    const s = new CollaborationSurfacer({ telegram: tg, stateDir });
    await s.surface({ ...base, senderName: 'a1b2c3d4e5f6a7b8c9d0' });
    expect(tg.posts[0].text).toContain('a1b2c3d4');
  });

  it('surface failure is non-fatal (returns error, does not throw)', async () => {
    const tg = fakeTelegram();
    tg.sendToTopic = vi.fn().mockRejectedValue(new Error('telegram down'));
    const s = new CollaborationSurfacer({ telegram: tg, stateDir, log: { warn: () => {} } });
    const r = await s.surface(base);
    expect(r.surfaced).toBe(false);
    expect(r.reason).toBe('error');
  });

  // ── CMT-519: notify() + bind helpers ──────────────────────────────

  it('notify() posts a STATUS notice to the SILENT hub, reusing the one topic', async () => {
    const opts: Array<{ silent?: boolean }> = [];
    const tg = fakeTelegram();
    const origSend = tg.sendToTopic;
    tg.sendToTopic = async (topicId: number, text: string, o?: { silent?: boolean }) => { opts.push(o ?? {}); return origSend(topicId, text); };
    const s = new CollaborationSurfacer({ telegram: tg, stateDir });
    const r = await s.notify({ threadId: 'tx', title: 'Conversation loop paused', body: 'stopped a loop', peerName: 'codey' });
    expect(r.surfaced).toBe(true);
    expect(r.topicId).toBe(7777);
    expect(tg.posts[0].text).toContain('Conversation loop paused');
    expect(opts[0].silent).toBe(true); // hub is silent (D2)
  });

  it('notify() does NOT dedupe per thread (a status can legitimately recur)', async () => {
    const tg = fakeTelegram();
    const s = new CollaborationSurfacer({ telegram: tg, stateDir });
    await s.notify({ threadId: 'tx', title: 'loop paused', body: 'one' });
    await s.notify({ threadId: 'tx', title: 'loop paused', body: 'two' });
    expect(tg.posts).toHaveLength(2);
    expect(tg.created).toBe(1); // same single hub topic
  });

  it('mostRecentUnbound returns the latest unbound; ambiguous when >1', async () => {
    const tg = fakeTelegram();
    const s = new CollaborationSurfacer({ telegram: tg, stateDir });
    await s.surface({ ...base, threadId: 't-a' });
    let mru = s.mostRecentUnbound();
    expect(mru.record?.threadId).toBe('t-a');
    expect(mru.ambiguous).toBe(false);
    await new Promise(r => setTimeout(r, 5));
    await s.surface({ ...base, threadId: 't-b' });
    mru = s.mostRecentUnbound();
    expect(mru.ambiguous).toBe(true); // two unbound now
  });

  it('markBound excludes a conversation from mostRecentUnbound', async () => {
    const tg = fakeTelegram();
    const s = new CollaborationSurfacer({ telegram: tg, stateDir });
    await s.surface({ ...base, threadId: 't-a' });
    s.markBound('t-a');
    expect(s.mostRecentUnbound().record).toBeNull();
  });

  it('migrates a legacy surfacedThreads string[] state file to records (dedupe still works)', async () => {
    const tg = fakeTelegram();
    // Plant a legacy-shaped state file.
    const dir = path.join(stateDir, 'threadline');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'collaboration-surface.json'), JSON.stringify({ dedicatedTopicId: 7777, surfacedThreads: ['t-legacy'] }));
    const s = new CollaborationSurfacer({ telegram: tg, stateDir });
    // The legacy thread is treated as already-surfaced (dedupe survives migration).
    const r = await s.surface({ ...base, threadId: 't-legacy' });
    expect(r.surfaced).toBe(false);
    expect(r.reason).toBe('already-surfaced');
    expect(tg.created).toBe(0); // reused the persisted hub topic id, no re-create
  });
});
