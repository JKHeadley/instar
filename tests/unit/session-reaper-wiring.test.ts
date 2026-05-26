/**
 * Wiring-integrity guard for the SessionReaper (lesson: PR #334 shipped
 * sentinels as dead code with a false "wired in" claim — green unit tests are
 * not proof of instantiation). Asserts the construct → start → pass-to-server
 * chain in the boot path, and the AgentServer → RouteContext hand-off. The
 * runtime "feature is alive (200 not 503)" proof lives in the e2e suite.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('SessionReaper wiring integrity', () => {
  it('server.ts constructs the reaper, starts it, and passes it to AgentServer', () => {
    const src = read('src/commands/server.ts');
    expect(src).toContain('new SessionReaper(');
    expect(src).toContain('sessionReaper.start()');
    // Passed into the AgentServer options object (the dead-code guard).
    expect(/new AgentServer\(\{[\s\S]*sessionReaper[\s\S]*\}\)/.test(src)).toBe(true);
  });

  it('server.ts composes socket+silence into the recovery veto (compose, not replace)', () => {
    const src = read('src/commands/server.ts');
    expect(src).toContain('socketRecoveryActive');
    expect(src).toContain('silenceRecoveryActive');
    expect(src).toContain('composedRecoveryActive');
    // The composed predicate must still include compaction + rate-limit.
    expect(/composedRecoveryActive[\s\S]{0,400}compactionSentinel\.isRecoveryActive/.test(src)).toBe(true);
    expect(/composedRecoveryActive[\s\S]{0,400}rateLimitSentinel\.isRecoveryActive/.test(src)).toBe(true);
  });

  it('AgentServer threads options.sessionReaper into the route context', () => {
    const src = read('src/server/AgentServer.ts');
    expect(src).toContain('sessionReaper: options.sessionReaper ?? null');
  });

  it('routes.ts exposes GET /sessions/reaper backed by ctx.sessionReaper', () => {
    const src = read('src/server/routes.ts');
    expect(src).toContain("router.get('/sessions/reaper'");
    expect(src).toContain('ctx.sessionReaper.snapshot()');
  });
});
