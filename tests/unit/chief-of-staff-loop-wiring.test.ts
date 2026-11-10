/**
 * Wiring-integrity for the Chief of Staff check-in loop (docs/specs/chief-of-staff-topic.md PR 3).
 * A loop whose wiring is silently dropped passes its unit tests but fails HERE: the server
 * constructs the loop with the REAL seams, exposes it to the routes, captures owner renewals on
 * the inbound hook, threads the CoS fields through the register route, offers the unlocked spawn
 * entry point, and the migration + provenance registry carry the feature.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PROVENANCE_COVERAGE, DP_COS_PROJECT_VERDICT } from '../../src/data/provenanceCoverage.js';

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

describe('Chief of Staff loop wiring', () => {
  const server = read('src/commands/server.ts');
  it('constructs the loop with real gather/judge/sender seams and starts it behind the dev gate', () => {
    for (const s of ['new loopMod.ChiefOfStaffLoop({', 'evMod.buildGather({', 'evMod.buildJudge({', 'sharedLlmQueue!.enqueueMetered(req)', 'sharedIntelligence!.evaluate(prompt', "sendAutomationReply('chief-of-staff'", 'telegram.sendToOwnerDM(text)', 'loop.start();', '_cosLoop = loop;', 'cosRunStore.blockingStateForTopic(String(t))', 'telegram?.getTopicHistory(t, limit)', 'ghMod.createAuthenticatedGhExec({ stateDir: config.stateDir })']) {
      expect(server, s).toContain(s);
    }
  });
  it('the protocol now reads the operator lease and the action gate from the loop', () => {
    expect(server).toContain('operatorLeaseLive: () => _cosLoop?.lease().live ?? false');
    expect(server).toContain('actionGate: (conversationKey) => _cosLoop?.actionGate(conversationKey)');
  });
  it('the run executor registers with the CoS fields and spawns without re-taking the conversation lock it already holds', () => {
    expect(server).toContain('cosNoRespawn: true, idempotencyKey }');
    expect(server).toContain('{ unlocked: true });');
    expect(server).toContain('...(spawnOpts?.unlocked ? { conversationLockHeld: true } : {}),');
    expect(read('src/core/SessionManager.ts')).toContain('if (!ref || options?.conversationLockHeld) return this.spawnInteractiveSessionUnlocked(...args);');
    expect(read('src/server/routes.ts')).toContain("...(body.cosNoRespawn === true ? { cosNoRespawn: true } : {})");
  });
  it('second-pass fixes: one-reader rule fails CLOSED, an orphan run is compensated, a lease-expired CoS run is not revived', () => {
    expect(server).toContain('readers === null || readers > 1');
    expect(server).toContain("cosRunStore.markTerminal(String(t), registeredRun, 'ended', 'cos-spawn-failed')");
    expect(server).toContain('cosRunStore.findByRunId(runId)');
    expect(server).toContain("return 'cos-lease-expired'");
  });
  it('an owner message in the CoS topic renews the lease through the module-scope hook', () => {
    expect(server).toContain('let _cosRenewalHook:');
    expect(server).toContain('if (_cosRenewalHook && telegramUserId && resolveApprovalOwner(telegram.getOwnerUserId(), [], []) === telegramUserId)'); // owner id normalised (PR 4 review #3)
    expect(server).toContain("loop.recordRenewal({ renewedVia: 'telegram'");
  });
  it('routes expose the loop and the protocol', () => {
    const routes = read('src/server/routes.ts');
    expect(routes).toContain("router.get('/chief-of-staff',"); expect(routes).toContain("router.get('/chief-of-staff/projects/:key',");
    expect(server).toContain('chiefOfStaffLoop: _cosLoop ?? undefined, chiefOfStaffProtocol: _cosProtocol ?? undefined');
    expect(read('src/server/AgentServer.ts')).toContain('chiefOfStaffLoop: options.chiefOfStaffLoop ?? null');
  });
  it('migration adds the owner-tunable defaults without touching enabled; the decision point is registered', () => {
    const mig = read('src/core/PostUpdateMigrator.ts');
    expect(mig).toContain("displayName: 'Chief of Staff'"); expect(mig).not.toMatch(/chiefOfStaff[\s\S]{0,400}enabled: (true|false)/);
    const entry = PROVENANCE_COVERAGE.find((e) => e.decisionPoint === DP_COS_PROJECT_VERDICT);
    expect(entry?.status).toBe('wired'); expect(entry?.component).toBe('ChiefOfStaffLoop');
  });
});
