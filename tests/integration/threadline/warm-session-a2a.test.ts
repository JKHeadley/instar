/**
 * Integration tests for the Warm-Session A2A integration (Arch Y).
 *
 * Wires REAL instances together (ThreadlineRouter + WarmSessionPool +
 * SpawnRequestManager + ThreadResumeMap) with a controlled spawnSession
 * callback that records the `interactive` flag — no mocks of the units under
 * test. Mirrors the relay-inbound decision flow the server performs.
 *
 * Covered (both sides of every boundary):
 *  - flag ON + verified non-topic peer → interactive spawn (interactive:true) +
 *    pool.admit (NOT the headless -p shape);
 *  - 2nd message on the same thread with a live session → inject (no 2nd spawn,
 *    no cooldown denial);
 *  - flag OFF → byte-for-byte the cold-spawn behavior;
 *  - topic-bound → warm path skipped (still cold-spawn / handleInboundMessage);
 *  - peer-conflict → cold-spawn fallback.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { ThreadlineRouter, trustMeetsFloor } from '../../../src/threadline/ThreadlineRouter.js';
import type { RelayMessageContext } from '../../../src/threadline/ThreadlineRouter.js';
import { WarmSessionPool } from '../../../src/threadline/WarmSessionPool.js';
import { SpawnRequestManager } from '../../../src/messaging/SpawnRequestManager.js';
import { ThreadResumeMap } from '../../../src/threadline/ThreadResumeMap.js';
import type { MessageEnvelope } from '../../../src/messaging/types.js';
import type { Session } from '../../../src/core/types.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

// ── Test seam: a ThreadResumeMap that reports sessions alive ─────
// The warm worker's --session-id JSONL doesn't exist on disk in a test, so
// ThreadResumeMap.get() would null the entry; overriding sessionAlive() lets
// the inject path be exercised (matches the production "live-inject" branch).
class LiveResumeMap extends ThreadResumeMap {
  liveNames = new Set<string>();
  protected sessionAlive(sessionName: string): boolean {
    return this.liveNames.has(sessionName);
  }
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'warm-a2a-integration-'));
}
function rmDir(dir: string): void {
  try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/threadline/warm-session-a2a.test.ts' }); } catch { /* ignore */ }
}

interface SpawnCall { prompt: string; interactive?: boolean; sessionId?: string }

function makeEnvelope(threadId: string, fp: string, body = 'hi'): MessageEnvelope {
  return {
    schemaVersion: 1 as const,
    message: {
      id: crypto.randomUUID(),
      from: { agent: fp, session: 'relay', machine: 'relay' },
      to: { agent: 'LocalAgent', session: 'best', machine: 'local' },
      subject: 'Relay message',
      body,
      type: 'query' as const,
      priority: 'medium' as const,
      threadId,
      createdAt: new Date().toISOString(),
    },
    transport: { protocol: 'relay', origin: { agent: fp, machine: 'relay' }, nonce: `${crypto.randomUUID()}:${new Date().toISOString()}`, timestamp: new Date().toISOString() },
    delivery: { status: 'delivered', attempts: 1, lastAttempt: new Date().toISOString() },
  } as unknown as MessageEnvelope;
}

function relayCtx(fp: string, preferWarm: boolean, trustLevel: 'verified' | 'trusted' | 'untrusted' = 'verified'): RelayMessageContext {
  return {
    trust: { kind: 'verified', senderFingerprint: fp },
    senderFingerprint: fp,
    senderName: fp.slice(0, 8),
    trustLevel,
    preferWarmSession: preferWarm,
  };
}

describe('Warm-Session A2A — integration (router + pool + spawn manager)', () => {
  let dir: string;
  let resumeMap: LiveResumeMap;
  let spawnCalls: SpawnCall[];
  let spawnManager: SpawnRequestManager;
  let messageDelivery: { deliverToSession: (n: string, e: MessageEnvelope) => Promise<any>; checkInjectionSafety: any; formatInline: any; formatPointer: any };
  let injectCalls: Array<{ name: string; body: string }>;
  let killedNames: string[];
  let liveSessions: Session[];
  let spawnCounter: number;

  beforeEach(() => {
    dir = tmpDir();
    resumeMap = new LiveResumeMap(path.join(dir, '.instar'), path.join(dir, 'project'));
    spawnCalls = [];
    injectCalls = [];
    killedNames = [];
    liveSessions = [];
    spawnCounter = 0;

    spawnManager = new SpawnRequestManager({
      maxSessions: 10,
      getActiveSessions: () => liveSessions,
      spawnSession: async (prompt, opts) => {
        spawnCalls.push({ prompt, interactive: opts?.interactive, sessionId: opts?.sessionId });
        const tmuxSession = `echo-msg-${opts?.interactive ? 'warm' : 'spawn'}-${++spawnCounter}`;
        const sess: Session = {
          id: `id-${spawnCounter}`,
          name: tmuxSession,
          status: 'running',
          tmuxSession,
          startedAt: new Date().toISOString(),
        };
        liveSessions.push(sess);
        if (opts?.interactive) resumeMap.liveNames.add(tmuxSession);
        return { sessionId: sess.id, tmuxSession };
      },
    });

    messageDelivery = {
      deliverToSession: async (name: string, env: MessageEnvelope) => {
        injectCalls.push({ name, body: env.message.body });
        return { success: true, phase: 'delivered', shouldRetry: false };
      },
      checkInjectionSafety: async () => ({ foregroundProcess: 'claude.exe', isSafeProcess: true, hasHumanInput: false, contextBudgetExceeded: false }),
      formatInline: (m: any) => m.body,
      formatPointer: (m: any) => m.body,
    };
  });

  afterEach(() => rmDir(dir));

  function makeRouter(warmEnabled: boolean, pool: WarmSessionPool | null) {
    return new ThreadlineRouter(
      { getThread: async () => null } as any,
      spawnManager as any,
      resumeMap,
      {} as any,
      { localAgent: 'LocalAgent', localMachine: 'local' },
      null,
      messageDelivery as any,
      undefined,
      undefined,
      pool,
      warmEnabled,
      'verified',
      warmEnabled ? (n: string) => killedNames.push(n) : null,
    );
  }

  it('flag ON + verified non-topic peer → interactive spawn + pool.admit (NOT -p)', async () => {
    const pool = new WarmSessionPool({ globalCap: 3, perPeerCap: 1, ttlMs: 600_000 });
    const router = makeRouter(true, pool);
    const threadId = crypto.randomUUID();

    const r = await router.handleInboundMessage(makeEnvelope(threadId, 'fp-dawn'), relayCtx('fp-dawn', true));

    expect(r.spawned).toBe(true);
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].interactive).toBe(true);          // interactive, NOT -p
    expect(spawnCalls[0].sessionId).toBeTruthy();           // deterministic --session-id
    expect(spawnCalls[0].prompt).toContain('remain in this conversation and wait');
    expect(pool.size()).toBe(1);
    expect(pool.get(threadId)?.peerId).toBe('fp-dawn');
  });

  it('2nd message same thread with a live warm session → inject (no 2nd spawn, no cooldown)', async () => {
    const pool = new WarmSessionPool({ globalCap: 3, perPeerCap: 1, ttlMs: 600_000 });
    const router = makeRouter(true, pool);
    const threadId = crypto.randomUUID();

    await router.handleInboundMessage(makeEnvelope(threadId, 'fp-dawn', 'msg-1'), relayCtx('fp-dawn', true));
    expect(spawnCalls.length).toBe(1);

    // Follow-up immediately (well within the 30s cooldown) — must inject, not spawn.
    const r2 = await router.handleInboundMessage(makeEnvelope(threadId, 'fp-dawn', 'msg-2'), relayCtx('fp-dawn', true));
    expect(r2.injected).toBe(true);
    expect(spawnCalls.length).toBe(1);                      // NO second spawn
    expect(injectCalls.length).toBe(1);
    expect(injectCalls[0].name).toBe(pool.get(threadId)!.sessionName);
    // Grounding boundary present on the injected body (security).
    expect(injectCalls[0].body).toContain('[EXTERNAL MESSAGE — Trust:');
    expect(injectCalls[0].body).toContain('msg-2');
  });

  it('flag OFF → byte-for-byte cold-spawn (interactive NOT set), pool untouched', async () => {
    const pool = new WarmSessionPool({ globalCap: 3, perPeerCap: 1, ttlMs: 600_000 });
    const router = makeRouter(false, pool); // warm disabled
    const threadId = crypto.randomUUID();

    const r = await router.handleInboundMessage(makeEnvelope(threadId, 'fp-dawn'), relayCtx('fp-dawn', true));
    expect(r.spawned).toBe(true);
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].interactive).toBeUndefined();      // headless -p path
    expect(spawnCalls[0].prompt).not.toContain('remain in this conversation and wait');
    expect(pool.size()).toBe(0);
  });

  it('topic-bound reply → warm path skipped (relay sets preferWarmSession false)', async () => {
    const pool = new WarmSessionPool({ globalCap: 3, perPeerCap: 1, ttlMs: 600_000 });
    const router = makeRouter(true, pool);
    const threadId = crypto.randomUUID();

    // The relay computes preferWarmSession = warmEnabled && !isTopicBoundReply && trustMeetsFloor.
    // A topic-bound reply has isTopicBoundReply=true → preferWarmSession=false.
    const isTopicBoundReply = true;
    const prefer = true /*warmEnabled*/ && !isTopicBoundReply && trustMeetsFloor('verified', 'verified');
    expect(prefer).toBe(false);

    await router.handleInboundMessage(makeEnvelope(threadId, 'fp-dawn'), relayCtx('fp-dawn', prefer));
    expect(spawnCalls[0].interactive).toBeUndefined();
    expect(pool.size()).toBe(0);
  });

  it('peer-conflict → cold-spawn fallback (owner record untouched)', async () => {
    const pool = new WarmSessionPool({ globalCap: 3, perPeerCap: 2, ttlMs: 600_000 });
    pool.admit({ threadId: 'shared-thread', peerId: 'fp-owner', sessionName: 'echo-owner' });
    const router = makeRouter(true, pool);

    const r = await router.handleInboundMessage(
      makeEnvelope('shared-thread', 'fp-attacker'),
      relayCtx('fp-attacker', true),
    );
    expect(r.spawned).toBe(true);                           // still handled (cold fallback)
    expect(spawnCalls[spawnCalls.length - 1].interactive).toBeUndefined();
    expect(pool.get('shared-thread')?.peerId).toBe('fp-owner'); // untouched
    expect(pool.get('shared-thread')?.sessionName).toBe('echo-owner');
  });
});
