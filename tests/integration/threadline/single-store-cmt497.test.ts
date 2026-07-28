/**
 * Integration tests — Threadline single-store collapse (Phase 2a / CMT-497).
 *
 * The ThreadResumeMap is now a view over the cross-process file-CAS
 * ConversationStore. Validates spec acceptance criteria:
 *  #1/#5 — cross-process: a gate mutate racing a ThreadResumeMap remove (the
 *          MCP-child delete path) does not corrupt the store.
 *  #2/#3 — field-bridge round-trip; save MERGES (no clobber of gate turn state).
 *  #4   — resume works: a saved uuid is recoverable via get (jsonlExists guard).
 *  #7   — dual-read: a thread written by a pre-2a version (legacy file) is found
 *          on a miss and written through.
 *  #8   — no second file-backed writer: ThreadResumeMap never writes
 *          thread-resume-map.json (source-level + behavioral).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ThreadResumeMap, type ThreadResumeEntry } from '../../../src/threadline/ThreadResumeMap.js';
import { ConversationStore } from '../../../src/threadline/ConversationStore.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

function tmp(): { stateDir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmt497-'));
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'threadline'), { recursive: true });
  return { stateDir, cleanup: () => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/threadline/single-store-cmt497.test.ts:cleanup' }) };
}

/** Create a fake session JSONL so ThreadResumeMap.get's jsonlExists guard passes. */
function fakeJsonl(uuid: string): string {
  const dir = path.join(os.homedir(), '.claude', 'projects', 'cmt497-test-project');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${uuid}.jsonl`), '{"t":1}\n');
  return dir;
}
function cleanupJsonl(): void {
  try { SafeFsExecutor.safeRmSync(path.join(os.homedir(), '.claude', 'projects', 'cmt497-test-project'), { recursive: true, force: true, operation: 'cmt497:jsonl-cleanup' }); } catch { /* ignore */ }
}

function entry(o: Partial<ThreadResumeEntry> = {}): ThreadResumeEntry {
  const now = new Date().toISOString();
  return {
    uuid: 'uuid-cmt497-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', sessionName: 'sess', createdAt: now, savedAt: now,
    lastAccessedAt: now, remoteAgent: 'codey', subject: 'S', state: 'active', pinned: false, messageCount: 1, ...o,
  };
}

describe('Threadline single-store collapse (CMT-497, integration)', () => {
  let stateDir: string; let cleanup: () => void;
  beforeEach(() => { ({ stateDir, cleanup } = tmp()); });
  afterEach(() => { cleanup(); cleanupJsonl(); });

  it('#8 ThreadResumeMap writes conversations.json and NEVER thread-resume-map.json', () => {
    const trm = new ThreadResumeMap(stateDir, '/proj');
    trm.save('t1', entry());
    expect(fs.existsSync(path.join(stateDir, 'threadline', 'conversations.json'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'threadline', 'thread-resume-map.json'))).toBe(false);
    // Source-level guard: the class only READS the legacy file (dual-read), never writes it.
    const src = fs.readFileSync(path.resolve(__dirname, '../../../src/threadline/ThreadResumeMap.ts'), 'utf-8');
    expect(/writeFileSync\([^)]*thread-resume-map/.test(src)).toBe(false);
  });

  it('#3 save MERGES — does not clobber the gate turn state', async () => {
    const store = new ConversationStore(stateDir);
    // Gate sets turn state on the conversation.
    await store.mutate('t1', d => { d.turnCount = 7; d.lastInboundHash = 'abc'; d.messageCount = 7; return d; });
    // Router saves resume info via the view.
    const trm = new ThreadResumeMap(stateDir, '/proj', undefined, store);
    trm.save('t1', entry({ uuid: 'u', sessionName: 's', messageCount: 2 }));
    const c = new ConversationStore(stateDir).get('t1')!;
    expect(c.turnCount).toBe(7);          // preserved
    expect(c.lastInboundHash).toBe('abc'); // preserved
    expect(c.sessionUuid).toBe('u');       // applied
    expect(c.messageCount).toBe(7);        // max(7,2) — never goes backwards
  });

  it('#2/#4 field-bridge round-trip + resume recovers the uuid', () => {
    fakeJsonl('uuid-roundtrip-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    const trm = new ThreadResumeMap(stateDir, '/proj');
    trm.save('t1', entry({ uuid: 'uuid-roundtrip-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', sessionName: 'tmux-x', originTopicId: 4242, originSessionName: 'topic-sess' }));
    const got = trm.get('t1')!;
    expect(got).not.toBeNull();
    expect(got.uuid).toBe('uuid-roundtrip-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(got.sessionName).toBe('tmux-x');
    expect(got.originTopicId).toBe(4242);
    expect(got.originSessionName).toBe('topic-sess');
  });

  it('#7 dual-read: a pre-2a legacy-file thread is found on a miss + written through', () => {
    fakeJsonl('uuid-legacy-cccccccccccccccccccccccccccccc');
    // Simulate a thread written by a pre-2a version (legacy file only).
    fs.writeFileSync(path.join(stateDir, 'threadline', 'thread-resume-map.json'), JSON.stringify({
      legacyThread: entry({ uuid: 'uuid-legacy-cccccccccccccccccccccccccccccc', remoteAgent: 'dawn' }),
    }));
    const trm = new ThreadResumeMap(stateDir, '/proj');
    const got = trm.get('legacyThread');
    expect(got?.remoteAgent).toBe('dawn');
    // Written through to the new store.
    expect(new ConversationStore(stateDir).get('legacyThread')?.remoteAgent).toBe('dawn');
  });

  it('#1/#5 a gate mutate racing a remove (MCP-child delete) does not corrupt the store', async () => {
    const store = new ConversationStore(stateDir);
    await store.mutate('keep', d => { d.state = 'active'; return d; });
    await store.mutate('victim', d => { d.state = 'active'; return d; });
    const trm = new ThreadResumeMap(stateDir, '/proj'); // its own instance (separate process sim)

    await Promise.all([
      store.mutate('keep', d => { d.turnCount += 1; return d; }),
      (async () => trm.remove('victim'))(),
      store.mutate('keep', d => { d.turnCount += 1; return d; }),
    ]);

    const fresh = new ConversationStore(stateDir);
    expect(fresh.get('victim')).toBeNull();        // delete applied
    expect(fresh.get('keep')?.turnCount).toBe(2);  // concurrent writes not lost
  });
});
