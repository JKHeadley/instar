/**
 * ACT-091 — wiring integrity for the reaped-topic-session respawn.
 *
 * The respawn primitive (`respawnSessionForTopic` + the per-topic
 * `spawningTopics` guard) lives inside `wireTelegramRouting`, and the
 * TopicLinkageHandler is constructed in the Threadline boot, so the production
 * path is a late-bound module hook. This pins, on the production source, that
 * the dependency is real (not null, not a no-op) and delegates to the same
 * respawn path an inbound Telegram message uses — awaited through the initial
 * injection, behind the spawn guard and the ownership re-check.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.resolve(__dirname, '../../../src/commands/server.ts'), 'utf-8');

describe('server.ts wires the ACT-091 topic respawn', () => {
  it('the TopicLinkageHandler receives a respawnTopicSession that delegates to the late-bound hook', () => {
    const ctor = src.slice(src.indexOf('topicLinkageHandler = new TopicLinkageHandler({'));
    const deps = ctor.slice(0, ctor.indexOf('threadlineRouter.setTopicLinkageHandler(topicLinkageHandler)'));
    expect(deps).toContain('respawnTopicSession: (args) => _threadlineTopicRespawn');
    expect(deps).toContain('? _threadlineTopicRespawn(args)');
  });

  it('the hook is built inside wireTelegramRouting from the Telegram respawn primitives', () => {
    const wire = src.slice(src.indexOf('export function wireTelegramRouting('));
    const start = wire.indexOf('_threadlineTopicRespawn = createThreadlineTopicRespawn({');
    expect(start).toBeGreaterThan(-1);
    const fn = wire.slice(start, wire.indexOf('\n  }\n', start));
    expect(fn).toContain('spawning: spawningTopics');
    expect(fn).toContain("ownRec.ownerMachineId !== _meshSelfId");
    expect(fn).toContain('registeredSession: (topicId) => telegram.getSessionForTopic(topicId)');
    // ACT-091: the OBSERVED paste (submitted / stuck / queued-busy), mapped so a
    // paste into a mid-turn session is provisional, never the bare boolean.
    expect(fn).toContain('liveInjectOutcomeFromObservation(await sessionManager.injectPasteNotificationObserved(name, text))');
    expect(fn).not.toContain('sessionManager.injectPasteNotificationConfirmed(name, text)');
    expect(fn).toContain('g3ShouldSpawnLocally(topicId)');
    expect(fn).toContain('classifySessionDeath(output');
    expect(fn).toContain("callsite: 'threadline-topic-respawn'");
    expect(fn).toContain('await respawnSessionForTopic(');
    expect(fn).toContain('awaitInitialInjection: true');
    expect(fn).toContain('if (fresh) _topicResumeMap?.remove(topicId)');
    expect(fn).toContain('telegram.registerTopicSession(topicId, newSessionName, topicName)');
    // the handler's "spawn in flight?" read is the same registry
    expect(wire).toContain('_threadlineTopicSpawning = (topicId: number) => spawningTopics.has(topicId)');
    const ctor = src.slice(src.indexOf('topicLinkageHandler = new TopicLinkageHandler({'));
    expect(ctor.slice(0, ctor.indexOf('threadlineRouter.setTopicLinkageHandler'))).toContain('isTopicSpawning: (topicId: number) => _threadlineTopicSpawning?.(topicId) === true');
  });

  it('the relay log claims "Resumed" only from result.resumed, and reports undelivered messages', () => {
    expect(src).toContain('if (result.resumed) console.log(`[relay] Resumed session for');
    expect(src).toContain('accepted but not delivered to a live session');
  });
});
