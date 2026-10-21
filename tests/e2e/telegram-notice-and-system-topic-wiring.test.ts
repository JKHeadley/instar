/**
 * Tier 3 — production wiring in server.ts for the two Telegram fixes:
 *  1. The delayed-reply notice gate is wired into BOTH held paths (forward and
 *     direct), so background output never posts "I have your message".
 *  2. Both TelegramAdapter constructions carry the single-creator system-topic
 *     hooks, both boot paths start the standby adoption loop, and the boot
 *     ensure* functions never mint a topic on a read-only standby.
 * A dependency that is constructed but never passed is the failure this guards.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const server = fs.readFileSync(path.join(__dirname, '../../src/commands/server.ts'), 'utf8');
const fnBody = (name: string): string => {
  const start = server.indexOf(`async function ${name}(`);
  expect(start, `${name} exists`).toBeGreaterThan(-1);
  return server.slice(start, server.indexOf('\n}\n', start));
};

describe('delayed-reply notice gate wiring', () => {
  it('one HeldNoticeGate is built and passed to the forward path', () => {
    expect(server).toMatch(/const heldNoticeGate = new originForwardMod\.HeldNoticeGate\(/);
    expect(server).toMatch(/noticeGate: heldNoticeGate,/);
  });
  it('the direct-hold path consults the gate with the row\'s author before notifying', () => {
    const start = server.indexOf('runtime.options.onLeaseHoldObserved = async row =>');
    const body = server.slice(start, server.indexOf('runtime.options.onHeldForwardExpired', start));
    expect(body).toMatch(/heldNoticeGate\.decide\(\{ topicId, producerKind: row\.producerKind \}\)/);
    expect(body).toMatch(/if \(gate\.send && route\.kind === 'peer'/);
    expect(body).toMatch(/heldNoticeGate\.recordSent\(topicId\)/);
  });
});

describe('single-creator system topics wiring', () => {
  it('both TelegramAdapter constructions pass the system-topic hooks', () => {
    expect(server.match(/systemTopics: systemTopicsHooks\(state\),/g)?.length).toBe(2);
    expect(server).toMatch(/canCreate: \(\) => !state\.readOnly/);
  });
  it('both boot paths start the standby adoption loop', () => {
    expect(server.match(/wireSystemTopicAdoption\(\{/g)?.length).toBe(2);
    expect(fnBody('wireSystemTopicAdoption')).toMatch(/adopt: \(key, topicId\) => input\.state\.adoptSystemTopicId\(key, topicId\)/);
  });
  it('boot ensure* never mints a topic on a read-only standby', () => {
    for (const name of ['ensureAgentUpdatesTopic', 'ensureAgentAttentionTopic']) {
      const body = fnBody(name);
      const guard = body.indexOf('if (state.readOnly)');
      const create = body.indexOf('findOrCreateForumTopic(');
      expect(guard, `${name} guards on readOnly`).toBeGreaterThan(-1);
      expect(create, `${name} reuses by name`).toBeGreaterThan(guard);
      expect(body).not.toMatch(/telegram\.createForumTopic\(/);
    }
  });
});
