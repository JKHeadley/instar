/**
 * ThreadlineRouter `path` discriminator + resent-copy notice placement
 * (docs/specs/a2a-inbound-id-ledger.md §1). The ledger maps a router return
 * through its allowlist; only the success shapes carry `path`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { ThreadlineRouter } from '../../../src/threadline/ThreadlineRouter.js';
import { ThreadResumeMap } from '../../../src/threadline/ThreadResumeMap.js';
import type { MessageEnvelope } from '../../../src/messaging/types.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { RESENT_COPY_NOTICE, outcomeFromRouterResult } from '../../../src/threadline/InboundIdLedger.js';

function makeEnvelope(threadId?: string): MessageEnvelope {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    message: {
      id: crypto.randomUUID(),
      from: { agent: 'remote-agent', session: 's', machine: 'm' },
      to: { agent: 'local-agent', session: 'best', machine: 'local' },
      type: 'query', priority: 'medium', subject: 'S', body: 'peer body text', createdAt: now, ttlMinutes: 30, threadId,
    },
    transport: { relayChain: [], originServer: 'http://localhost:1', nonce: `${crypto.randomUUID()}:${now}`, timestamp: now },
    delivery: { phase: 'received', transitions: [], attempts: 1 },
  } as MessageEnvelope;
}

const relayCtx = { trust: { kind: 'plaintext-tofu' as const, senderFingerprint: 'fp' }, senderFingerprint: 'fp', senderName: 'peer', trustLevel: 'verified' as const };

describe('ThreadlineRouter — ledger path discriminator', () => {
  let dir: string;
  let resumeMap: ThreadResumeMap;
  let spawn: { evaluate: ReturnType<typeof vi.fn>; handleDenial: ReturnType<typeof vi.fn>; getStatus: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn> };
  const store = { getThread: vi.fn().mockResolvedValue(null), exists: vi.fn(), save: vi.fn() };
  const msgRouter = { getThread: vi.fn().mockResolvedValue(null) };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-ledger-path-'));
    resumeMap = new ThreadResumeMap(path.join(dir, '.instar'), '/test/project');
    spawn = {
      evaluate: vi.fn().mockResolvedValue({ approved: true, sessionId: 'sid', tmuxSession: 'tmux-1', reason: 'ok' }),
      handleDenial: vi.fn(), getStatus: vi.fn().mockReturnValue({ cooldowns: [], pendingRetries: 0 }), reset: vi.fn(),
    };
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/threadline/ThreadlineRouter-ledger-path.test.ts' }));

  function make(extra: { gate?: unknown; delivery?: unknown } = {}) {
    return new ThreadlineRouter(msgRouter as never, spawn as never, resumeMap, store as never,
      { localAgent: 'local-agent', localMachine: 'local-machine' }, (extra.gate ?? null) as never, (extra.delivery ?? null) as never);
  }

  it('a headless spawn for a new thread is path cold, and the notice precedes the grounding framing', async () => {
    const r = await make().handleInboundMessage(makeEnvelope(crypto.randomUUID()), relayCtx, { resentNotice: RESENT_COPY_NOTICE });
    expect(r.path).toBe('cold');
    expect(outcomeFromRouterResult(r)).toEqual({ kind: 'handed-off', path: 'cold' });
    const prompt = spawn.evaluate.mock.calls[0][0].context as string;
    expect(prompt.startsWith(`[server notice: ${RESENT_COPY_NOTICE}]`)).toBe(true);
    expect(prompt.indexOf('peer body text')).toBeGreaterThan(prompt.indexOf(RESENT_COPY_NOTICE));
  });

  it('without a notice the prompt is unchanged', async () => {
    await make().handleInboundMessage(makeEnvelope(crypto.randomUUID()), relayCtx);
    const prompt = spawn.evaluate.mock.calls[0][0].context as string;
    expect(prompt.includes('[server notice:')).toBe(false);
  });

  it('a SpawnRequestManager denial carries no path (handoff-failed)', async () => {
    spawn.evaluate.mockResolvedValue({ approved: false, queued: true, reason: 'limit' });
    const r = await make().handleInboundMessage(makeEnvelope(crypto.randomUUID()), relayCtx);
    expect(r.path).toBeUndefined();
    expect(outcomeFromRouterResult(r)).toEqual({ kind: 'handoff-failed' });
  });

  it('autonomy queue-for-approval is path approval; block is refused', async () => {
    const q = await make({ gate: { evaluate: vi.fn().mockResolvedValue({ decision: 'queue-for-approval', approvalId: 'a1' }) } })
      .handleInboundMessage(makeEnvelope(crypto.randomUUID()), relayCtx);
    expect(q.path).toBe('approval');
    const b = await make({ gate: { evaluate: vi.fn().mockResolvedValue({ decision: 'block', reason: 'no' }) } })
      .handleInboundMessage(makeEnvelope(crypto.randomUUID()), relayCtx);
    expect(outcomeFromRouterResult(b)).toEqual({ kind: 'refused', code: 'autonomy-block' });
  });

  it('a live inject is path live with the notice outside the framing', async () => {
    const threadId = crypto.randomUUID();
    const uuid = crypto.randomUUID();
    const pdir = path.join(os.homedir(), '.claude', 'projects', 'tl-ledger-path');
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, `${uuid}.jsonl`), '{}\n');
    try {
      const now = new Date().toISOString();
      resumeMap.save(threadId, { uuid, sessionName: 'live-sess', createdAt: now, savedAt: now, lastAccessedAt: now, remoteAgent: 'remote-agent', subject: 'S', state: 'idle', pinned: false, messageCount: 1 });
      const delivery = { deliverToSession: vi.fn().mockResolvedValue({ success: true }), checkInjectionSafety: vi.fn(), formatInline: vi.fn(), formatPointer: vi.fn() };
      const ownerCtx = { ...relayCtx, senderFingerprint: 'remote-agent', trust: { kind: 'plaintext-tofu' as const, senderFingerprint: 'remote-agent' } };
      const r = await make({ delivery }).handleInboundMessage(makeEnvelope(threadId), ownerCtx, { resentNotice: RESENT_COPY_NOTICE });
      expect(r.path).toBe('live');
      const body = delivery.deliverToSession.mock.calls[0][1].message.body as string;
      expect(body.startsWith(`[server notice: ${RESENT_COPY_NOTICE}]`)).toBe(true);
    } finally {
      SafeFsExecutor.safeRmSync(pdir, { recursive: true, force: true, operation: 'tests/unit/threadline/ThreadlineRouter-ledger-path.test.ts' });
    }
  });
});
