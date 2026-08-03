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

  it('starts SessionManager maintenance only after guard and pool-write posture wiring', () => {
    const src = read('src/commands/server.ts');
    const guardAt = src.indexOf('sessionManager.setReapGuard(');
    const poolPostureAt = src.indexOf('state.setSessionPoolActive(true)');
    const monitoringAt = src.indexOf('sessionManager.startMonitoring()');
    const serverAt = src.indexOf('await server.start()', monitoringAt);
    expect(guardAt).toBeGreaterThan(-1);
    expect(poolPostureAt).toBeGreaterThan(guardAt);
    expect(monitoringAt).toBeGreaterThan(poolPostureAt);
    expect(serverAt).toBeGreaterThan(monitoringAt);
    expect(src.match(/sessionManager\.startMonitoring\(\)/g)).toHaveLength(1);
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

  it('server wiring captures the terminate authority at manager birth and gives it to the reaper', () => {
    const src = read('src/commands/server.ts');
    expect(src).toContain('bindTerminateAuthority: (authority) => { boundTerminateAuthority = authority; }');
    expect(src).toContain('terminateWithAuthority(id, reason');
    expect(src).toContain('localPostTransferCloseout: opts?.localPostTransferCloseout');
    expect(src).not.toContain('bypassLeaseForTopicMovedCloseout: opts?.bypassLeaseForTopicMovedCloseout');
  });

  it('the write-first synchronous kill is bounded with SIGKILL, not ignorable SIGTERM', () => {
    const manager = read('src/core/SessionManager.ts');
    expect(manager).toContain("timeout: this.tmuxCallTimeoutMs, killSignal: 'SIGKILL'");
  });

  it('F8 scope-guard: the assertion exists only behind runtime-private reaper deps', () => {
    const src = read('src/monitoring/SessionReaper.ts');
    const closeoutStart = src.indexOf('async #attemptCloseoutTerminate(');
    const closeoutEnd = src.indexOf('\n  private ', closeoutStart + 1);
    const body = src.slice(closeoutStart, closeoutEnd === -1 ? undefined : closeoutEnd);
    expect(body).toContain('localPostTransferCloseout: true');
    expect(body).toContain('this.#deps.terminate(');
    expect(src).toContain('readonly #deps: Readonly<SessionReaperDeps>');
    expect(src).not.toContain('private async attemptCloseoutTerminate(');
    expect(src).toContain('async #runCloseoutLegacy(');
    expect(src).toContain('async #runCloseoutGated(');
    expect(src).toContain('async #performReap(');
    expect(src).not.toContain('private async runCloseoutLegacy(');
    expect(src).not.toContain('private async runCloseoutGated(');
    expect(src).not.toContain('private async performReap(');
    expect(src).not.toContain('bypassLeaseForTopicMovedCloseout');
    expect(src).not.toContain('TopicMovedCloseoutProof');

    const manager = read('src/core/SessionManager.ts');
    expect(manager).toContain('bindTerminateAuthority?:');
    expect(manager).not.toContain('registerTopicMovedCloseoutTarget');
    expect(manager).not.toContain('consumeTopicMovedCloseoutProof');
  });

  it('AgentServer threads options.sessionReaper into the route context', () => {
    const src = read('src/server/AgentServer.ts');
    expect(src).toContain('sessionReaper: options.sessionReaper ?? null');
  });

  it('the authenticated operator route receives the birth-bound authority, not raw killSession', () => {
    const server = read('src/commands/server.ts');
    const agentServer = read('src/server/AgentServer.ts');
    const routes = read('src/server/routes.ts');
    expect(server).toContain('terminateSessionAuthority: terminateWithAuthority');
    expect(agentServer).toContain('terminateSessionAuthority: options.terminateSessionAuthority');
    expect(routes).toContain("ctx.terminateSessionAuthority(target.id, 'operator-kill'");
    const start = routes.indexOf("router.delete('/sessions/:id'");
    const end = routes.indexOf("router.post('/sessions/:name/remote-close'", start);
    expect(routes.slice(start, end)).not.toContain('killSession(');
  });

  it('routes.ts exposes GET /sessions/reaper backed by ctx.sessionReaper', () => {
    const src = read('src/server/routes.ts');
    expect(src).toContain("router.get('/sessions/reaper'");
    expect(src).toContain('ctx.sessionReaper.snapshot()');
  });
});
