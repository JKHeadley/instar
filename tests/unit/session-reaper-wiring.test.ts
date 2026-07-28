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

  it('reaper deps wire descendantCpuSeconds + the cpuAwareActiveProcessKeep dev-gate', () => {
    const src = read('src/commands/server.ts');
    // The CPU-progress dep that backs cpuAwareActiveProcessKeep must actually be
    // passed (else the tightening silently never engages — the dead-dep trap).
    expect(/descendantCpuSeconds:\s*\(s\)\s*=>\s*sessionManager\.descendantCpuSeconds\(s\)/.test(src)).toBe(true);
    // The flag is gated by developmentAgent (dark fleet-wide, live on dev agents);
    // an explicit config value wins. Resolved via the resolveDevAgentGate funnel
    // (DEV-AGENT-DARK-GATE-CONFORMANCE-SPEC) rather than a hand-rolled `?? !!`.
    expect(/cpuAwareActiveProcessKeep:\s*resolveDevAgentGate\(\s*rcfg\.cpuAwareActiveProcessKeep,\s*config\s*\)/.test(src)).toBe(true);
    // The observe-only busy-orphan detection rides the same dev-gate.
    expect(/busyOrphanDetection:\s*resolveDevAgentGate\(\s*rcfg\.busyOrphanDetection,\s*config\s*\)/.test(src)).toBe(true);
  });

  it('reaper terminate dep threads the F8 lease carve-out through to the authority', () => {
    // F8 (roadmap 0.6): the closeout's bypassLeaseForTopicMovedCloseout must
    // survive the server.ts terminate-dep hop into terminateSession — dropping
    // it there would silently restore the not-lease-holder veto the carve-out
    // exists to lift (the dead-dep trap, again).
    const src = read('src/commands/server.ts');
    expect(/bypassLeaseForTopicMovedCloseout:\s*opts\?\.bypassLeaseForTopicMovedCloseout/.test(src)).toBe(true);
  });

  it('F8 scope-guard: the lease carve-out is minted ONLY inside the topic-moved closeout machinery', () => {
    // The carve-out's whole safety story is its scope: only the closeout of a
    // session whose topic PROVABLY moved away (topicOwnerElsewhere + dwell,
    // both enforced before attemptCloseoutTerminate is reachable) may lift the
    // lease gate. The reaper's OTHER terminate (the idle reap) must never
    // carry it — exact-object toHaveBeenCalledWith assertions in
    // session-reaper.test.ts prove the runtime side; this pins the source side.
    const src = read('src/monitoring/SessionReaper.ts');
    const mints = src.match(/bypassLeaseForTopicMovedCloseout:\s*true/g) ?? [];
    expect(mints.length).toBe(2); // both arms of the ONE closeout terminate call
    const closeoutStart = src.indexOf('private async attemptCloseoutTerminate(');
    const closeoutEnd = src.indexOf('\n  private ', closeoutStart + 1);
    const body = src.slice(closeoutStart, closeoutEnd === -1 ? undefined : closeoutEnd);
    expect((body.match(/bypassLeaseForTopicMovedCloseout:\s*true/g) ?? []).length).toBe(2);
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
