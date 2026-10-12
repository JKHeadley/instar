/**
 * topicRespawnHook — deliver a topic-bound Threadline reply to a topic whose
 * session is not live (ACT-091).
 *
 * The decision the Telegram dead-session path makes, with the same primitives,
 * handed in so the logic is testable outside server.ts:
 *
 *  1. ownership — never spawn a topic another of my machines owns;
 *  2. a spawn already in flight for the topic (a reply, or a user message, is
 *     respawning it) → WAIT for it (bounded), then type the reply into the
 *     now-live session — the second reply inside one respawn is neither lost
 *     nor duplicated;
 *  3. a live session → type the reply in (`live-inject`);
 *  4. the G3 lease gate; the death classification (no respawn after a quota
 *     death; a fresh start after a context-exhausted one); SpawnAdmission;
 *  5. respawn (resume) or cold-spawn with the reply as the first message,
 *     awaited through the initial injection (`respawn-inject`).
 *
 * `delivered: true` means a live session has the reply — nothing else. Every
 * refusal is a reason the caller surfaces (failure-visible), never silence.
 */

import type { SpawningTopicsRegistry } from '../core/SpawningTopicsRegistry.js';
import { normalizeLiveInject, type LiveInjectOutcome, type LiveInjectSettlement } from './TopicLinkageHandler.js';

export type TopicRespawnResult =
  | { delivered: true; mode: 'live-inject' | 'respawn-inject'; sessionName?: string; pending?: false }
  | { delivered: false; reason: string; pending?: false }
  /** A live paste into a MID-TURN session: queued input, provisional (ACT-091). */
  | { delivered: false; pending: true; reason: 'queued-busy'; mode: 'live-inject'; sessionName: string; settled: Promise<LiveInjectSettlement> };

export interface TopicRespawnDeps {
  spawning: SpawningTopicsRegistry;
  /** True when the ownership record names ANOTHER machine as the topic's active owner. */
  ownedElsewhere: (topicId: number) => boolean;
  /** The session the topic registry names (never a name read from a thread record). */
  registeredSession: (topicId: number) => string | null;
  isSessionAlive: (sessionName: string) => boolean;
  /**
   * Confirmed paste into a live session: `true`/`submitted` only when it was
   * consumed; `queued-busy` when the session was mid-turn (provisional).
   */
  injectConfirmed: (sessionName: string, text: string) => Promise<LiveInjectOutcome>;
  /** The G3 lease-gated spawn decision. */
  leaseGate: (topicId: number) => { spawnLocally: boolean; reason: string };
  /** Why the registered session died, from its dead pane. `null` = unknown. */
  classifyDeath: (sessionName: string) => 'quota' | 'context-exhausted' | 'other' | null;
  /** SpawnAdmission; absent = no seam constructed (always allow). */
  admit?: (topicId: number) => { allow: boolean; reason?: string };
  /** respawnSessionForTopic (--resume unless `fresh`), awaited through the initial injection. */
  respawn: (sessionName: string, topicId: number, text: string, fresh: boolean) => Promise<void>;
  /** spawnSessionForTopic + registerTopicSession, awaited through the initial injection. Returns the new name. */
  coldSpawn: (topicId: number, text: string) => Promise<string>;
  /** How long a second reply waits for an in-flight spawn. Default 150 s (ready 120 s + confirm). */
  spawnWaitBoundMs?: number;
  spawnWaitPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export const DEFAULT_SPAWN_WAIT_BOUND_MS = 150_000;

export function createThreadlineTopicRespawn(deps: TopicRespawnDeps) {
  const log = deps.log ?? ((line: string) => console.log(line));

  const injectLive = async (sessionName: string, text: string): Promise<TopicRespawnResult> => {
    try {
      const o = normalizeLiveInject(await deps.injectConfirmed(sessionName, text));
      if (o.state === 'submitted') return { delivered: true, mode: 'live-inject', sessionName };
      if (o.state === 'queued-busy') return { delivered: false, pending: true, reason: 'queued-busy', mode: 'live-inject', sessionName, settled: o.settled };
      return { delivered: false, reason: 'inject-unconfirmed' };
    } catch (err) {
      return { delivered: false, reason: err instanceof Error ? err.message : String(err) };
    }
  };

  return async function threadlineTopicRespawn(args: { topicId: number; text: string }): Promise<TopicRespawnResult> {
    const { topicId, text } = args;
    if (deps.ownedElsewhere(topicId)) return { delivered: false, reason: 'topic-owned-by-another-machine' };

    // A spawn is already running for this topic (the previous reply's, or a
    // user message's). Wait for it, then deliver into the live session.
    if (deps.spawning.has(topicId)) {
      log(`[threadline-topic-respawn] topic ${topicId}: spawn in flight — waiting for it before delivering`);
      const cleared = await deps.spawning.waitUntilClear(topicId, {
        boundMs: deps.spawnWaitBoundMs ?? DEFAULT_SPAWN_WAIT_BOUND_MS,
        pollMs: deps.spawnWaitPollMs,
        sleep: deps.sleep,
      });
      if (!cleared) return { delivered: false, reason: 'spawn-in-progress' };
      const after = deps.registeredSession(topicId);
      if (after && deps.isSessionAlive(after)) return injectLive(after, text);
      // The spawn ended without a live session — fall through to our own attempt.
    }

    const registered = deps.registeredSession(topicId);
    if (registered && deps.isSessionAlive(registered)) return injectLive(registered, text);

    const g3 = deps.leaseGate(topicId);
    if (!g3.spawnLocally) return { delivered: false, reason: `lease-gate: ${g3.reason}` };

    let fresh = false;
    if (registered) {
      const death = deps.classifyDeath(registered);
      if (death === 'quota') return { delivered: false, reason: 'quota-exhausted' };
      if (death === 'context-exhausted') fresh = true;
    }

    if (deps.admit) {
      const d = deps.admit(topicId);
      if (!d.allow) return { delivered: false, reason: `spawn-admission: ${d.reason ?? 'refused'}` };
    }

    // Re-check: a spawn may have started while we classified/admitted.
    if (deps.spawning.has(topicId)) return { delivered: false, reason: 'spawn-in-progress' };
    const tok = deps.spawning.add(topicId);
    try {
      let sessionName: string | undefined;
      if (registered) {
        await deps.respawn(registered, topicId, text, fresh);
        sessionName = deps.registeredSession(topicId) ?? registered;
      } else {
        sessionName = await deps.coldSpawn(topicId, text);
      }
      return { delivered: true, mode: 'respawn-inject', sessionName };
    } catch (err) {
      // The spawn may have recorded a pending inject before failing; the boot
      // sweep can then still deliver it, so the surfaced copy may be a duplicate.
      return { delivered: false, reason: err instanceof Error ? err.message : String(err) };
    } finally {
      deps.spawning.clear(topicId, tok);
    }
  };
}
