/**
 * Wiring-integrity guard for the G1 cold-start lifeline fallback reply
 * ("The Agent Is Always Reachable", corollary 2: no silent resource rejection).
 *
 * A pure builder that compiles but is never called is the "shipped inert" failure
 * mode this repo keeps hitting (see rate-limit-recovery-wiring.test.ts). This asserts
 * server.ts actually wires `buildColdStartFallbackReply` into BOTH inbound
 * session-start failure paths — the cold spawn AND the restart — delivers it on the
 * DETERMINISTIC path (sendToTopic, never the LLM tone gate), resolves the real
 * Lifeline topic id, and that the old jargon-leaking message is gone.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SERVER_SRC = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');

describe('G1 cold-start fallback — wiring integrity', () => {
  it('imports the builder from the messaging module', () => {
    expect(SERVER_SRC).toContain("import { buildColdStartFallbackReply } from '../messaging/ColdStartFallbackReply.js'");
  });

  it('wires the builder into BOTH inbound failure paths (spawn + restart)', () => {
    const calls = SERVER_SRC.match(/buildColdStartFallbackReply\(/g) || [];
    // One in the cold-spawn catch, one in the restart catch.
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('resolves the REAL Lifeline topic id (not a hardcoded/no-op)', () => {
    expect(SERVER_SRC).toMatch(/lifelineTopicId:\s*telegram\.getLifelineTopicId\(\)/);
  });

  it('passes both kinds so the wording matches the failure', () => {
    expect(SERVER_SRC).toMatch(/kind:\s*'spawn'/);
    expect(SERVER_SRC).toMatch(/kind:\s*'restart'/);
  });

  it('delivers the fallback on the deterministic path (sendToTopic with the built userMessage)', () => {
    expect(SERVER_SRC).toMatch(/telegram\.sendToTopic\(topicId,\s*userMessage\)/);
  });

  it('drops the old jargon-leaking "increase maxSessions in your config" message', () => {
    expect(SERVER_SRC).not.toContain('increase maxSessions in your config');
  });
});
