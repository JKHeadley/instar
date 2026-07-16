import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ListenerSessionManager } from '../../src/threadline/ListenerSessionManager.js';
import { classifyEligibility } from '../../src/monitoring/ResumeQueue.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'threadline reap unit cleanup' });
});

describe('Threadline reap recovery primitives', () => {
  it('admits an unbound Threadline recovery only with the exact durable message identity', () => {
    const base = {
      sessionName: 'warm', tmuxSession: 'warm', cwd: '/tmp', reason: 'quota-shed',
      disposition: 'terminal' as const, origin: 'autonomous' as const,
      workEvidence: ['build-or-autonomous-active'],
    };
    expect(classifyEligibility({ ...base, threadId: 't1', threadlineMessageId: 'm1' }, { includeOperatorKills: false })).toEqual({ eligible: true });
    expect(classifyEligibility({ ...base, threadId: 't1' }, { includeOperatorKills: false })).toEqual({ eligible: false, why: 'no-resume-path' });
  });

  it('finds the exact pending inbound and suppresses recovery after a later outbound', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadline-reap-unit-'));
    dirs.push(dir);
    const manager = new ListenerSessionManager(dir, 'token');
    const inbound = manager.appendCanonicalInboxEntry({
      from: 'peer', senderName: 'Peer', trustLevel: 'trusted', threadId: 't1', text: 'answer this', messageId: 'm1',
    });
    expect(manager.readLatestCanonicalInboxForThread('t1')?.id).toBe('m1');
    expect(manager.readCanonicalInboxEntry('m1')?.text).toBe('answer this');
    expect(manager.hasCanonicalReplyFor('t1', inbound.id)).toBe(false);
    manager.appendCanonicalOutboxEntry({
      from: 'self', senderName: 'Self', to: 'peer', recipientName: 'Peer', threadId: 't1', text: 'done', messageId: 'o1',
      inReplyTo: inbound.id,
    });
    expect(manager.hasCanonicalReplyFor('t1', inbound.id)).toBe(true);
  });

  it('does not let an interleaved reply settle the newer inbound', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadline-reap-interleave-'));
    dirs.push(dir);
    const manager = new ListenerSessionManager(dir, 'token');
    const first = manager.appendCanonicalInboxEntry({
      from: 'peer', senderName: 'Peer', trustLevel: 'trusted', threadId: 't1', text: 'first', messageId: 'm1',
    });
    const second = manager.appendCanonicalInboxEntry({
      from: 'peer', senderName: 'Peer', trustLevel: 'trusted', threadId: 't1', text: 'second', messageId: 'm2',
    });
    manager.appendCanonicalOutboxEntry({
      from: 'self', senderName: 'Self', to: 'peer', recipientName: 'Peer', threadId: 't1', text: 'first reply',
      messageId: 'o1', inReplyTo: first.id,
    });
    expect(manager.hasCanonicalReplyFor('t1', first.id)).toBe(true);
    expect(manager.hasCanonicalReplyFor('t1', second.id)).toBe(false);
  });

  it('atomically gives one owner the reply boundary', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadline-reap-claim-'));
    dirs.push(dir);
    const manager = new ListenerSessionManager(dir, 'token');
    expect(manager.tryClaimReply('m1', 'original-worker')).toBe(true);
    expect(manager.tryClaimReply('m1', 'recovery-worker')).toBe(false);
    expect(manager.transferReplyClaim('m1', 'original-worker', 'replacement-session')).toBe(true);
    expect(manager.tryClaimReply('m1', 'replacement-session')).toBe(true);
    manager.releaseReplyClaim('m1', 'replacement-session');
    expect(manager.tryClaimReply('m1', 'recovery-worker')).toBe(true);
  });

  it('persists an append-failure claim across manager restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadline-reap-durable-claim-'));
    dirs.push(dir);
    const first = new ListenerSessionManager(dir, 'token');
    expect(first.tryClaimReply('m1', 'sender')).toBe(true);
    first.retainReplyClaimFailure('m1', 'sender');
    const restarted = new ListenerSessionManager(dir, 'token');
    expect(restarted.hasReplyClaim('m1')).toBe(true);
    expect(restarted.tryClaimReply('m1', 'recovery')).toBe(false);
  });

  it('refuses tampered canonical evidence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadline-reap-tamper-'));
    dirs.push(dir);
    const manager = new ListenerSessionManager(dir, 'token');
    const inbound = manager.appendCanonicalInboxEntry({
      from: 'peer', senderName: 'Peer', trustLevel: 'trusted', threadId: 't1', text: 'original', messageId: 'm1',
    });
    const inboxPath = path.join(dir, 'threadline', 'inbox.jsonl.active');
    const tampered = { ...inbound, text: 'forged' };
    fs.writeFileSync(inboxPath, `${JSON.stringify(tampered)}\n`);

    expect(manager.readLatestCanonicalInboxForThread('t1')).toBeNull();
    expect(manager.readCanonicalInboxEntry('m1')).toBeNull();
  });
});
