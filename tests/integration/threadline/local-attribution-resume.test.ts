/**
 * Integration: the local-delivery ingress chain — resolve a peer NAME from a REAL
 * on-disk known-agents.json (publicKey-only shape) → hand the resolved fingerprint
 * to the REAL ThreadlineRouter.handleInboundMessage → the anti-hijack guard resumes
 * the owned thread instead of isolating it.
 *
 * This composes the two pieces the `/messages/relay-agent` route now composes
 * (resolvePeerFingerprintByName + the hint), against the EXACT data shape that
 * caused the blocking convergence bug: sagemind has NO `fingerprint` field, only a
 * `publicKey`, so the owner was recorded as `publicKey[:32]`.
 *
 * Spec: docs/specs/threadline-local-delivery-fingerprint-attribution.md
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ThreadlineRouter } from '../../../src/threadline/ThreadlineRouter.js';
import type { ThreadlineRouterConfig } from '../../../src/threadline/ThreadlineRouter.js';
import { resolvePeerFingerprint, resolvePeerFingerprintByName } from '../../../src/threadline/peerFingerprint.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import type { MessageEnvelope, AgentMessage } from '../../../src/messaging/types.js';

function ownedEntry(remoteAgent: string) {
  const now = new Date().toISOString();
  return {
    uuid: 'owner-uuid', sessionName: 'owner-tmux', createdAt: now, savedAt: now,
    lastAccessedAt: now, remoteAgent, subject: 'Owned', state: 'idle',
    pinned: false, messageCount: 2,
  };
}
function envelopeFrom(agent: string, threadId: string): MessageEnvelope {
  return {
    message: {
      id: 'msg-' + Math.random().toString(36).slice(2, 8),
      from: { agent, machine: 'local' }, to: { agent: 'echo', machine: 'local' },
      threadId, subject: 'reply', body: 'hi back', createdAt: new Date().toISOString(), priority: 'normal',
    } as AgentMessage,
  } as MessageEnvelope;
}

const config: ThreadlineRouterConfig = { localAgent: 'echo', localMachine: 'local', maxHistoryMessages: 20 };

describe('local-attribution ingress chain — resolver(real file) → guard resume', () => {
  let stateDir: string;
  let router: ThreadlineRouter;
  let spawnManager: { evaluate: ReturnType<typeof vi.fn>; handleDenial: ReturnType<typeof vi.fn> };
  let entries: Map<string, unknown>;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-attr-'));
    fs.mkdirSync(path.join(stateDir, 'threadline'), { recursive: true });
    spawnManager = {
      evaluate: vi.fn().mockResolvedValue({ approved: true, sessionId: 'uuid', tmuxSession: 'tmux', reason: 'ok' }),
      handleDenial: vi.fn(),
    };
    entries = new Map();
    const threadResumeMap = {
      get: (id: string) => entries.get(id) ?? null,
      save: (id: string, e: unknown) => entries.set(id, e),
      remove: (id: string) => entries.delete(id),
      resolve: vi.fn(),
      getByRemoteAgent: vi.fn().mockReturnValue([]),
    };
    router = new ThreadlineRouter(
      { getThread: vi.fn().mockResolvedValue({ messages: [] }) } as never,
      spawnManager as never,
      threadResumeMap as never,
      {} as never,
      config,
    );
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'local-attribution-resume.test:afterEach' }); });

  const writeKnownAgents = (agents: unknown[]) =>
    fs.writeFileSync(path.join(stateDir, 'threadline', 'known-agents.json'), JSON.stringify({ agents }));

  it('resumes the owned thread for a publicKey-only peer (the incident shape, end-to-end)', async () => {
    // sagemind: publicKey-only — the live shape that no-op'd the v1 resolver.
    const pub = '1db85f0011223344556677889900aabbccddeeff00112233445566778899aabb';
    writeKnownAgents([{ name: 'sagemind', publicKey: pub }]);

    // Owner recorded via the SAME shared derivation the outbound path now uses.
    const ownerFp = resolvePeerFingerprint({ publicKey: pub })!;
    expect(ownerFp).toBe(pub.substring(0, 32));
    const threadId = '199c20fe-thread';
    entries.set(threadId, ownedEntry(ownerFp));

    // Ingress: resolve the inbound NAME → fingerprint from the real file, pass as hint.
    const hint = resolvePeerFingerprintByName(stateDir, 'sagemind') ?? undefined;
    expect(hint).toBe(ownerFp);

    const result = await router.handleInboundMessage(
      envelopeFrom('sagemind', threadId), undefined, { inboundSenderFingerprint: hint },
    );

    expect(result.threadId).toBe(threadId); // resumed
    expect((spawnManager.evaluate.mock.calls[0][0] as { reason: string }).reason).toMatch(/^Resume thread/);
  });

  it('isolates an UNKNOWN sender name (not in known-agents.json) — fail-safe preserved', async () => {
    writeKnownAgents([{ name: 'sagemind', publicKey: 'aa'.repeat(32) }]);
    const threadId = 'owned-2';
    entries.set(threadId, ownedEntry('aa'.repeat(16)));

    const hint = resolvePeerFingerprintByName(stateDir, 'stranger') ?? undefined; // unknown → null
    expect(hint).toBeUndefined();

    const result = await router.handleInboundMessage(
      envelopeFrom('stranger', threadId), undefined, { inboundSenderFingerprint: hint },
    );

    expect(result.threadId).not.toBe(threadId); // isolated
    expect((spawnManager.evaluate.mock.calls[0][0] as { reason: string }).reason).toMatch(/^New thread/);
  });
});
