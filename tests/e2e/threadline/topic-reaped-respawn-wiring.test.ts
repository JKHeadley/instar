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

  it('the hook is assigned inside wireTelegramRouting, using the Telegram respawn path', () => {
    const wire = src.slice(src.indexOf('export function wireTelegramRouting('));
    const body = wire.slice(wire.indexOf('_threadlineTopicRespawn = async ('));
    expect(wire.indexOf('_threadlineTopicRespawn = async (')).toBeGreaterThan(-1);
    const fn = body.slice(0, body.indexOf('\n  };\n'));
    expect(fn).toContain('respawnSessionForTopic(');
    expect(fn).toContain('awaitInitialInjection: true');
    expect(fn).toContain('spawningTopics.has(topicId)');
    expect(fn).toContain('spawningTopics.clear(topicId, tok)');
    // never spawn a topic another machine owns (double-session guard)
    expect(fn).toContain("ownRec.ownerMachineId !== _meshSelfId");
    // the same spawn checks the Telegram dead-session path runs
    expect(fn).toContain('g3ShouldSpawnLocally(topicId)');
    expect(fn).toContain("callsite: 'threadline-topic-respawn'");
    expect(fn).toContain('classifySessionDeath(output');
    expect(fn).toContain("death.cause === 'quota_exhaustion'");
    // never kill-by-name from the thread record: only the registry's session
    expect(fn).toContain('const registered = telegram.getSessionForTopic(topicId)');
    expect(fn).not.toContain('?? sessionName');
  });

  it('the relay log claims "Resumed" only from result.resumed, and reports undelivered messages', () => {
    expect(src).toContain('if (result.resumed) console.log(`[relay] Resumed session for');
    expect(src).toContain('accepted but not delivered to a live session');
  });
});
