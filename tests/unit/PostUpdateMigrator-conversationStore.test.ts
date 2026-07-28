/**
 * Verifies PostUpdateMigrator.migrateThreadlineConversationStore folds the
 * legacy thread-resume-map.json + context-thread-map.json into the unified
 * conversations.json (Threadline Phase 1 keystone, acceptance criterion #9).
 *
 * Covers: field preservation (sessionUuid, agentIdentity, pinned, failed/
 * archived lifecycle, cross-machine, boundTopicId), idempotency (never clobbers
 * a runtime-written row), context-only thread preservation, and that the
 * migrated file loads cleanly through ConversationStore.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { ConversationStore } from '../../src/threadline/ConversationStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

function run(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateThreadlineConversationStore(r: MigrationResult): void }).migrateThreadlineConversationStore(result);
  return result;
}

describe('PostUpdateMigrator — threadline conversation store fold', () => {
  let projectDir: string;
  let tlDir: string;
  let convPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-conv-fold-'));
    tlDir = path.join(projectDir, '.instar', 'threadline');
    fs.mkdirSync(tlDir, { recursive: true });
    convPath = path.join(tlDir, 'conversations.json');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-conversationStore.test.ts:cleanup' });
  });

  it('skips when no legacy stores exist', () => {
    const result = run(newMigrator(projectDir));
    expect(result.errors).toEqual([]);
    expect(result.skipped.some(s => s.includes('no legacy stores'))).toBe(true);
    expect(fs.existsSync(convPath)).toBe(false);
  });

  it('folds ThreadResumeMap entries preserving every field', () => {
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(tlDir, 'thread-resume-map.json'), JSON.stringify({
      't-active': {
        uuid: 'sess-uuid-1', sessionName: 'tmux-1', createdAt: now, savedAt: now,
        lastAccessedAt: now, remoteAgent: 'codey', subject: 'build chat', state: 'active',
        pinned: true, messageCount: 7, originTopicId: 12304, originSessionName: 'topic-sess',
        spawnMode: 'interactive', machineOrigin: 'macA',
      },
      't-archived': {
        uuid: 'sess-uuid-2', sessionName: 'tmux-2', createdAt: now, savedAt: now,
        lastAccessedAt: now, remoteAgent: 'dawn', subject: 'old', state: 'archived',
        pinned: false, messageCount: 2, migratedTo: 'macB',
      },
    }, null, 2));

    const result = run(newMigrator(projectDir));
    expect(result.errors).toEqual([]);
    expect(result.upgraded.some(u => u.includes('folded 2'))).toBe(true);

    const store = JSON.parse(fs.readFileSync(convPath, 'utf-8'));
    const active = store.conversations['t-active'];
    expect(active.sessionUuid).toBe('sess-uuid-1');
    expect(active.boundSessionName).toBe('tmux-1');
    expect(active.boundTopicId).toBe(12304);
    expect(active.originSessionName).toBe('topic-sess');
    expect(active.pinned).toBe(true);
    expect(active.messageCount).toBe(7);
    expect(active.machineOrigin).toBe('macA');
    expect(active.state).toBe('active');
    expect(active.participants.peers).toEqual(['codey']);

    // failed/archived lifecycle + cross-machine fields preserved.
    expect(store.conversations['t-archived'].state).toBe('archived');
    expect(store.conversations['t-archived'].migratedTo).toBe('macB');
  });

  it('attaches ContextThreadMap identity bindings (hijack guard preserved)', () => {
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(tlDir, 'thread-resume-map.json'), JSON.stringify({
      't-1': { uuid: 'u', sessionName: 's', createdAt: now, savedAt: now, lastAccessedAt: now, remoteAgent: 'codey', subject: 'x', state: 'idle', pinned: false, messageCount: 1 },
    }, null, 2));
    fs.writeFileSync(path.join(tlDir, 'context-thread-map.json'), JSON.stringify({
      mappings: [
        { contextId: 'ctx-1', threadId: 't-1', agentIdentity: 'codey-fp', createdAt: now, lastAccessedAt: now },
        { contextId: 'ctx-2', threadId: 't-ctx-only', agentIdentity: 'other-fp', createdAt: now, lastAccessedAt: now },
      ],
    }, null, 2));

    const result = run(newMigrator(projectDir));
    expect(result.errors).toEqual([]);
    const store = JSON.parse(fs.readFileSync(convPath, 'utf-8'));
    expect(store.conversations['t-1'].contextId).toBe('ctx-1');
    expect(store.conversations['t-1'].agentIdentity).toBe('codey-fp');
    // Context-only thread preserved as a minimal row (binding not lost).
    expect(store.conversations['t-ctx-only'].agentIdentity).toBe('other-fp');
  });

  it('is idempotent and never clobbers a runtime-written row', () => {
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(tlDir, 'thread-resume-map.json'), JSON.stringify({
      't-live': { uuid: 'old-uuid', sessionName: 's', createdAt: now, savedAt: now, lastAccessedAt: now, remoteAgent: 'codey', subject: 'x', state: 'idle', pinned: false, messageCount: 1 },
    }, null, 2));
    // A runtime row already exists (version > 0) with newer turn state.
    fs.writeFileSync(convPath, JSON.stringify({
      version: 1,
      conversations: {
        't-live': { threadId: 't-live', version: 5, participants: { peers: ['codey'] }, state: 'active', pinned: false, messageCount: 9, turnCount: 3, sessionUuid: 'live-uuid', createdAt: now, savedAt: now, lastActivityAt: now },
      },
      lastModified: now,
    }, null, 2));

    const result = run(newMigrator(projectDir));
    expect(result.errors).toEqual([]);
    // Nothing new to fold — the live row is left untouched.
    expect(result.skipped.some(s => s.includes('already migrated'))).toBe(true);
    const store = JSON.parse(fs.readFileSync(convPath, 'utf-8'));
    expect(store.conversations['t-live'].version).toBe(5);
    expect(store.conversations['t-live'].sessionUuid).toBe('live-uuid');
    expect(store.conversations['t-live'].turnCount).toBe(3);

    // Second run is also a no-op.
    const second = run(newMigrator(projectDir));
    expect(second.upgraded).toEqual([]);
  });

  it('produces a conversations.json that ConversationStore loads cleanly', () => {
    const recent = new Date().toISOString();
    fs.writeFileSync(path.join(tlDir, 'thread-resume-map.json'), JSON.stringify({
      't-load': { uuid: 'u', sessionName: 's', createdAt: recent, savedAt: recent, lastAccessedAt: recent, remoteAgent: 'codey', subject: 'x', state: 'active', pinned: false, messageCount: 1 },
    }, null, 2));

    run(newMigrator(projectDir));

    const store = new ConversationStore(path.join(projectDir, '.instar'));
    const c = store.get('t-load');
    expect(c?.remoteAgent).toBe('codey');
    expect(c?.state).toBe('active');
  });
});
