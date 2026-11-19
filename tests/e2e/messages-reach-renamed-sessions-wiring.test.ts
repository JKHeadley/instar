/**
 * messages-reach-renamed-sessions (PR-A) — production wiring is alive.
 *
 * The production server (src/commands/server.ts) must pass REAL dependencies, not
 * no-ops: the resolver over this agent's own session records and the topic registry,
 * the sender notifier on both failure paths, the retry manager's local-only scope and
 * session-id pin, the undelivered counter, and boot recovery of pending notices.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.join(__dirname, '../../src/commands/server.ts'), 'utf8');
const routerBlock = src.slice(src.indexOf('const messageRouter = new MessageRouter('), src.indexOf('}, crossMachineDeps);'));
const retryBlock = src.slice(src.indexOf('const retryManager = new DeliveryRetryManager('), src.indexOf('retryManager.start();'));

describe('messages-reach-renamed-sessions wiring', () => {
  it('the router resolves over real session records and the topic registry', () => {
    expect(routerBlock).toMatch(/resolveSession: \(target: string, asOf: number\) => resolveSessionTarget\(target, \{/);
    expect(routerBlock).toMatch(/sessions: state\.listSessions\(\)/);
    expect(routerBlock).toMatch(/sessionNameForTopic: \(topicId\) => sessionManager\.sessionNameForTopic\(topicId\)/);
    expect(routerBlock).toMatch(/reg\.isEnforcing\(reg\.getByTopic\(topicId\)\)/);
    expect(routerBlock).toMatch(/prefix: path\.basename\(config\.projectDir\)/);
  });

  it('both failure paths reach the sender notifier, and stats read its counter', () => {
    expect(routerBlock).toMatch(/onDeliveryFailure: \(envelope, reason\) => \{ void senderNotifier\.onFailure\(envelope, reason\); \}/);
    expect(routerBlock).toMatch(/undeliveredCounts: \(\) => Object\.fromEntries\(senderNotifier\.undelivered\)/);
    // Dead letters go through the router, which reports a remote-origin failure back to its
    // machine and hands a local one to onDeliveryFailure (the sender notifier, asserted above).
    expect(retryBlock).toMatch(/onDeadLetter: \(envelope, reason\) => \{ messageRouter\.reportTerminalFailure\(envelope, reason\); \}/);
  });

  it('the retry manager is scoped to local envelopes and checks the pinned session id', () => {
    expect(retryBlock).toMatch(/isLocalEnvelope: \(envelope\) =>/);
    expect(retryBlock).toMatch(/return !m \|\| m === 'local' \|\| m === machineId;/);
    expect(retryBlock).toMatch(/isPinnedSessionLive: \(tmuxSession, sessionId\) =>\s*sessionManager\.listRunningSessions\(\)\.some\(\(s\) => s\.tmuxSession === tmuxSession && s\.id === sessionId\)/);
  });

  it('the notifier types through the real delivery path and flushes pending notices at boot', () => {
    expect(src).toMatch(/const senderNotifier = new SenderNotifier\(\{/);
    expect(src).toMatch(/const r = await messageDelivery\.deliverToSession\(session, notice\);/);
    expect(src).toMatch(/senderNotifier\.recover\(envs\.filter\(\(e\) => e\.delivery\.noticePending && !e\.delivery\.noticeSentAt\)\)/);
  });

  it('the send route refuses caller-made notices and forces the sender fields', () => {
    const routes = fs.readFileSync(path.join(__dirname, '../../src/server/routes.ts'), 'utf8');
    expect(routes).toMatch(/if \(type === 'delivery-notice'\) \{/);
    expect(routes).toMatch(/ctx\.messageRouter\.forceLocalSender\(from\)/);
  });
});
