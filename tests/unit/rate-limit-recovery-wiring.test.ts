/**
 * Wiring-integrity + security-boundary guards for the rate-limit recovery fix.
 *
 * T5 (wiring integrity): server.ts must build the recovery deps from the REAL
 *   primitives (injectInternalMessage, getLifelineTopicId), not no-ops. A feature
 *   that compiles but is wired to nulls is the exact "shipped inert" failure mode
 *   we keep hitting — this asserts the live wiring delegates to real functions.
 *
 * T7 (InputGuard boundary): injectInternalMessage bypasses the topic-prefix
 *   provenance check, so it MUST NOT be reachable over HTTP. This asserts the
 *   method exists on SessionManager but is never exposed through a route.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SERVER_SRC = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');
const SESSION_MANAGER_SRC = fs.readFileSync(path.join(process.cwd(), 'src/core/SessionManager.ts'), 'utf-8');
const ROUTES_SRC = fs.readFileSync(path.join(process.cwd(), 'src/server/routes.ts'), 'utf-8');

describe('T5 — rate-limit recovery wiring integrity', () => {
  it('server.ts builds recovery deps via buildRateLimitRecoveryDeps', () => {
    expect(SERVER_SRC).toContain('buildRateLimitRecoveryDeps');
  });

  it('wires the REAL non-topic-bound primitives (not no-ops)', () => {
    // The whole bug was the non-topic path doing nothing. These two callbacks
    // are what makes the non-topic path actually reach the user.
    expect(SERVER_SRC).toContain('injectInternalMessage');
    expect(SERVER_SRC).toContain('getLifelineTopicId');
  });

  it('the built resumeFn/notifyFn are handed to the RateLimitSentinel', () => {
    // Guards against building the deps then forgetting to pass them in.
    expect(SERVER_SRC).toMatch(/resumeFn:\s*rateLimitResume/);
    expect(SERVER_SRC).toMatch(/notifyFn:\s*rateLimitNotify/);
  });
});

describe('T7 — injectInternalMessage security boundary', () => {
  it('SessionManager exposes injectInternalMessage', () => {
    expect(SESSION_MANAGER_SRC).toContain('injectInternalMessage(');
  });

  it('injectInternalMessage is NOT reachable over any HTTP route', () => {
    // The internal path bypasses InputGuard topic prefixing — it must stay
    // in-process only. HTTP injection continues to flow through injectMessage,
    // which enforces provenance.
    expect(ROUTES_SRC).not.toContain('injectInternalMessage');
  });

  it('records a distinguishable audit event for the trusted bypass', () => {
    expect(SESSION_MANAGER_SRC).toContain('internal-recovery-injection');
    expect(SESSION_MANAGER_SRC).toContain("source = 'sentinel-recovery'");
  });
});
