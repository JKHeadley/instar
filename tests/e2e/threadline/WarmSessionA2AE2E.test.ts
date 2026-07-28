/**
 * E2E test — Warm-Session A2A full lifecycle (Arch Y).
 *
 * Builds the full warm-session stack with real components (ThreadlineRouter +
 * WarmSessionPool + SpawnRequestManager + a real ThreadResumeMap subclass) and
 * a test double only for the external boundaries (the spawnSession callback and
 * the tmux liveness/kill primitives). Exercises the lifecycle the spec §4 names:
 *
 *  1. Two messages on one thread are handled by the SAME persistent session
 *     (continuity — msg2 injects, no respawn), grounding preamble applied.
 *  2. Force-evict (reapExpired → kill) leaves the resume entry intact.
 *  3. The next message after eviction falls back to the Path-1 resume (#746)
 *     — NO warm spawn, the prior conversation uuid is reused via --resume.
 *
 * The live A6 round-trip against the real Dawn peer (running server + relay) is
 * left to the orchestrator per the brief — it needs a live server + real peer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { ThreadlineRouter } from '../../../src/threadline/ThreadlineRouter.js';
import type { RelayMessageContext } from '../../../src/threadline/ThreadlineRouter.js';
import { WarmSessionPool } from '../../../src/threadline/WarmSessionPool.js';
import { SpawnRequestManager } from '../../../src/messaging/SpawnRequestManager.js';
import { ThreadResumeMap } from '../../../src/threadline/ThreadResumeMap.js';
import type { MessageEnvelope } from '../../../src/messaging/types.js';
import type { Session } from '../../../src/core/types.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

// A resume map whose session liveness + transcript existence are driven by
// test-controlled sets — mirrors tmux liveness + Claude JSONL on disk without a
// real pane/transcript. Killing a session removes it from the live set (so get()
// can no longer inject and must fall back to resume); the warm worker's
// transcript uuid is registered so the post-eviction resume path resolves it.
class LiveResumeMap extends ThreadResumeMap {
  live = new Set<string>();
  transcripts = new Set<string>();
  protected sessionAlive(sessionName: string): boolean {
    return this.live.has(sessionName);
  }
  protected jsonlExists(uuid: string): boolean {
    return this.transcripts.has(uuid);
  }
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'warm-a2a-e2e-'));
}
function rmDir(dir: string): void {
  try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/threadline/WarmSessionA2AE2E.test.ts' }); } catch { /* ignore */ }
}

interface SpawnCall { interactive?: boolean; sessionId?: string; resumeSessionId?: string }

describe('Warm-Session A2A — E2E lifecycle', () => {
  let dir: string;
  let resumeMap: LiveResumeMap;
  let router: ThreadlineRouter;
  let spawnCalls: SpawnCall[];
  let injectCount: number;
  let injectedBodies: string[];
  let killed: string[];
  let liveSessions: Session[];
  let pool: WarmSessionPool;
  let clock: { t: number };
  let counter: number;

  const PEER = 'fp-dawn-peer';
  const TTL = 10_000;

  function relayCtx(prefer: boolean): RelayMessageContext {
    return {
      trust: { kind: 'verified', senderFingerprint: PEER },
      senderFingerprint: PEER,
      senderName: 'Dawn',
      trustLevel: 'verified',
      preferWarmSession: prefer,
    };
  }

  function envelope(threadId: string, body: string): MessageEnvelope {
    return {
      schemaVersion: 1 as const,
      message: {
        id: crypto.randomUUID(),
        from: { agent: PEER, session: 'relay', machine: 'relay' },
        to: { agent: 'LocalAgent', session: 'best', machine: 'local' },
        subject: 'Relay message',
        body,
        type: 'query' as const,
        priority: 'medium' as const,
        threadId,
        createdAt: new Date().toISOString(),
      },
      transport: { protocol: 'relay', origin: { agent: PEER, machine: 'relay' }, nonce: `${crypto.randomUUID()}:x`, timestamp: new Date().toISOString() },
      delivery: { status: 'delivered', attempts: 1, lastAttempt: new Date().toISOString() },
    } as unknown as MessageEnvelope;
  }

  function killByName(name: string): void {
    killed.push(name);
    liveSessions = liveSessions.filter(s => s.tmuxSession !== name);
    resumeMap.live.delete(name);
  }

  beforeEach(() => {
    dir = tmpDir();
    resumeMap = new LiveResumeMap(path.join(dir, '.instar'), path.join(dir, 'project'));
    spawnCalls = [];
    injectCount = 0;
    injectedBodies = [];
    killed = [];
    liveSessions = [];
    counter = 0;
    // Start the clock well past 0 so a never-spawned agent isn't seen as
    // just-spawned (cooldownRemaining = max(cooldownMs - (now - lastSpawn≈0), 0)).
    clock = { t: 1_000_000 };
    pool = new WarmSessionPool({ globalCap: 3, perPeerCap: 1, ttlMs: TTL }, () => clock.t);

    const spawnManager = new SpawnRequestManager({
      maxSessions: 10,
      getActiveSessions: () => liveSessions,
      nowFn: () => clock.t,
      spawnSession: async (_prompt, opts) => {
        spawnCalls.push({ interactive: opts?.interactive, sessionId: opts?.sessionId, resumeSessionId: opts?.resumeSessionId });
        const tmuxSession = `echo-${opts?.interactive ? 'warm' : 'spawn'}-${++counter}`;
        const sess: Session = { id: `id-${counter}`, name: tmuxSession, status: 'running', tmuxSession, startedAt: new Date().toISOString() };
        liveSessions.push(sess);
        resumeMap.live.add(tmuxSession);
        // The warm worker creates its transcript at the deterministic --session-id,
        // so an eviction can later --resume it losslessly (#746).
        if (opts?.sessionId) resumeMap.transcripts.add(opts.sessionId);
        return { sessionId: sess.id, tmuxSession };
      },
    });

    const messageDelivery = {
      // Mirror the real MessageDelivery: step 1 refuses if the session is not
      // alive (so a killed warm session can't be injected into → falls back to
      // resume). The router's tryInjectIntoLiveSession treats !success as a
      // signal to fall through to resume/spawn.
      deliverToSession: async (name: string, env: MessageEnvelope) => {
        if (!resumeMap.live.has(name)) {
          return { success: false, phase: 'queued', failureReason: 'Session not alive', shouldRetry: true };
        }
        injectCount += 1;
        injectedBodies.push(env.message.body);
        return { success: true, phase: 'delivered', shouldRetry: false };
      },
      checkInjectionSafety: async () => ({ foregroundProcess: 'claude.exe', isSafeProcess: true, hasHumanInput: false, contextBudgetExceeded: false }),
      formatInline: (m: any) => m.body,
      formatPointer: (m: any) => m.body,
    };

    router = new ThreadlineRouter(
      { getThread: async () => null } as any,
      spawnManager as any,
      resumeMap,
      {} as any,
      { localAgent: 'LocalAgent', localMachine: 'local' },
      null,
      messageDelivery as any,
      undefined,
      () => clock.t,
      pool,
      true,        // warmEnabled
      'verified',
      killByName,
    );
  });

  afterEach(() => rmDir(dir));

  it('two messages on one thread → SAME warm session (continuity); evict → next resumes via #746', async () => {
    const threadId = crypto.randomUUID();

    // ── Message 1: warm (interactive) spawn + pool admit ──
    const r1 = await router.handleInboundMessage(envelope(threadId, 'msg-1'), relayCtx(true));
    expect(r1.spawned).toBe(true);
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].interactive).toBe(true);
    const warmSessionName = pool.get(threadId)!.sessionName;
    const warmUuid = spawnCalls[0].sessionId!; // the deterministic --session-id

    // ── Message 2: SAME session, inject (no respawn) — continuity ──
    clock.t += 1_000;
    const msg2At = clock.t;
    const r2 = await router.handleInboundMessage(envelope(threadId, 'msg-2'), relayCtx(true));
    expect(r2.injected).toBe(true);
    expect(r2.sessionName).toBe(warmSessionName);
    expect(spawnCalls.length).toBe(1);            // NO second spawn — same session
    expect(injectCount).toBe(1);
    // Grounding preamble applied to the injected follow-up.
    expect(injectedBodies[0]).toContain('[EXTERNAL MESSAGE — Trust:');
    expect(injectedBodies[0]).toContain('msg-2');

    // The resume entry points at the warm session + its deterministic uuid.
    const entryBeforeEvict = resumeMap.get(threadId);
    expect(entryBeforeEvict?.sessionName).toBe(warmSessionName);
    expect(entryBeforeEvict?.uuid).toBe(warmUuid);

    // ── Force-evict: reapExpired (idle past TTL) → kill ──
    clock.t = msg2At + TTL; // idle past TTL since last touch (msg-2)
    const expired = pool.reapExpired();
    for (const rec of expired) killByName(rec.sessionName);
    expect(expired.map(r => r.sessionName)).toEqual([warmSessionName]);
    expect(killed).toContain(warmSessionName);
    expect(pool.peek(threadId)).toBeUndefined(); // removed from pool

    // The resume entry is INTACT (eviction is lossless — the uuid survives).
    // The warm worker's transcript was registered at spawn (transcripts set), so
    // get() resolves the entry for the resume path even though the session died.

    // ── Message 3: no live session → resume via #746 (--resume warmUuid) ──
    // Advance past the 30s per-peer spawn cooldown so the resume spawn isn't
    // denied (the warm spawn consumed the cooldown at msg-1).
    clock.t += 31_000;
    const r3 = await router.handleInboundMessage(envelope(threadId, 'msg-3'), relayCtx(true));
    // Either injected (if session re-marked live — it isn't here) or resumed.
    expect(r3.injected).not.toBe(true);
    expect(r3.resumed).toBe(true);
    // A spawn happened for the resume, carrying --resume of the warm uuid.
    const resumeCall = spawnCalls[spawnCalls.length - 1];
    expect(resumeCall.resumeSessionId).toBe(warmUuid); // Path-1 lossless fallback
    expect(resumeCall.interactive).toBeUndefined();    // resume goes via cold path
  });
});
