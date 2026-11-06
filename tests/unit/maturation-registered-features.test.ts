/**
 * The switched-off features the 2026-11-05 review found on no ladder, the finished
 * disposition that lets a live feature register without an invented bar, the last-rung
 * numbers, and the signal-only rows behind them. Spec: docs/specs/feature-maturation-ladder.md.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import {
  computeLadderState,
  deriveLadderRung,
  nextRung,
  parseLadderRegistry,
  type LadderEntry,
} from '../../src/monitoring/MaturationLadder.js';
import { MaturationLadderService, readShippedRegistry, type MaturationLadderDeps } from '../../src/monitoring/MaturationLadderService.js';
import { FeatureEvidenceLog, setFeatureEvidenceLog, type FeatureEvidenceRow } from '../../src/monitoring/FeatureEvidenceLog.js';
import { memoryReplyChannel } from '../../src/server/memorySessionGuard.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { PermissionActionAudit } from '../../src/server/mobilePermissionsRoutes.js';
import { MemoryPrivacy } from '../../src/users/MemoryPrivacy.js';
import { MemoryInboundTracker } from '../../src/users/MemoryInboundTracker.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  SelfActionGovernorCore,
  initSelfActionGovernor,
  resetSelfActionGovernorModuleForTest,
} from '../../src/monitoring/selfaction/governor.js';
import { resetAnchorForTest } from '../../src/monitoring/selfaction/anchor.js';
import { classClosureEvidence } from '../../scripts/class-closure-lint.mjs';

const DAY = 86_400_000;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-registered-'));
  setFeatureEvidenceLog(new FeatureEvidenceLog({ projectDir: dir, machine: 'm1', instarVersion: '0.0.0' }));
});
afterEach(() => {
  setFeatureEvidenceLog(null);
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/maturation-registered-features.test.ts' });
});

const rows = (): FeatureEvidenceRow[] => {
  const file = path.join(dir, 'logs/feature-evidence.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').trim().split('\n').map(l => JSON.parse(l) as FeatureEvidenceRow);
};

function shipped(): LadderEntry[] {
  const parsed = parseLadderRegistry(readShippedRegistry());
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.registry.entries;
}
const entry = (id: string) => {
  const e = shipped().find(x => x.id === id);
  if (!e) throw new Error(`${id} is not on the ladder`);
  return e;
};

describe('the review\'s unregistered features are on the ladder', () => {
  it.each([
    ['intelligence.selfActionGovernor', 'ladder'],
    ['benchmarkDivergence', 'ladder'],
    ['intelligence.jevJobCompletionAudit', 'ladder'],
    ['sessions.dynamicMcp', 'ladder'],
    ['feedbackFactory.receiverPersistence', 'composed'],
    ['gitBackup', 'finished'],
    ['monitoring.collaborationRedrive', 'ladder'],
    ['monitoring.principalCoherence', 'ladder'],
    ['monitoring.reportExternalProcesses', 'finished'],
    ['monitoring.staleBackstop', 'finished'],
    ['responseReview', 'ladder'],
  ])('%s is %s', (id, disposition) => {
    expect(entry(id).disposition).toBe(disposition);
  });

  it.each([
    ['multiMachine.identityReannounce (+ identityDivergenceMonitor)', 'multiMachine.identityReannounce'],
    ['responseReview (+ conversationalContext)', 'responseReview'],
    ['models.tierEscalation.ridesTopic', 'models.tierEscalation'],
    ['monitoring.processFootprintMonitor.alertEnabled', 'monitoring.processFootprintMonitor'],
  ])('the review row %s finds %s', (row, id) => {
    expect(entry(id).aliases).toContain(row);
  });

  it('reads each rung from what actually runs on a development agent', () => {
    const dev = { developmentAgent: true };
    expect(deriveLadderRung(entry('intelligence.selfActionGovernor'), dev, {}).rung).toBe('dry-run');
    // The code reads `=== true`, so the dev gate must not make it look live.
    expect(deriveLadderRung(entry('sessions.dynamicMcp'), dev, {}).rung).toBe('dark');
    expect(deriveLadderRung(entry('monitoring.principalCoherence'), dev, {}).rung).toBe('dark');
    // These read their switch directly, with no dev gate: absent must read dark, never live.
    for (const id of ['responseReview', 'intelligence.jevJobCompletionAudit', 'monitoring.collaborationRedrive']) {
      expect(deriveLadderRung(entry(id), dev, {}).rung, id).toBe('dark');
    }
    expect(deriveLadderRung(entry('responseReview'), { ...dev, responseReview: { enabled: true, observeOnly: true } }, {}).rung).toBe('dry-run');
    expect(deriveLadderRung(entry('responseReview'), { ...dev, responseReview: { enabled: true, observeOnly: false } }, {}).rung).toBe('dev-agent-live');
  });

  it('reads the governor as watch-only on a fleet agent too, because it runs on every machine', () => {
    const e = entry('intelligence.selfActionGovernor');
    expect(deriveLadderRung(e, {}, {})).toEqual({ rung: 'dry-run', flagMissing: false });
    expect(nextRung(e, 'dry-run')).toBe('dev-agent-live');
  });

  it('keeps the governor bar at the numbers its code and spec use', () => {
    const bar = entry('intelligence.selfActionGovernor').rungs['dev-agent-live']!.metrics;
    expect(bar.find(m => m.id === 'admits')).toMatchObject({ threshold: 100, minSamples: 100 });
    expect(bar.find(m => m.id === 'would-deny-rate')).toMatchObject({ threshold: 0.01, direction: 'at-most' });
  });
});

describe('the finished disposition', () => {
  const base = { id: 'x.y', title: 'X', flag: { path: 'x.y' }, final: 'default-on', risk: 'standard', tracking: { state: 'measured', plan: 'p' } };
  const parse = (e: Record<string, unknown>) => parseLadderRegistry(JSON.stringify({ schema: 'feature-ladders/1', entries: [e] }));
  const finished = { reason: 'on by default', ref: 'src/x.ts' };

  it('needs its reason and ref, and carries no bar', () => {
    expect(parse({ ...base, disposition: 'finished', finished }).ok).toBe(true);
    expect(parse({ ...base, disposition: 'finished' })).toMatchObject({ ok: false, reason: 'entries[0].finished' });
    expect(parse({ ...base, disposition: 'finished', finished: { reason: 'r' } })).toMatchObject({ ok: false });
    const metric = { id: 'r', role: 'ran', source: 'guard-posture', ref: { key: 'k' }, direction: 'at-least', threshold: 1, minSamples: 1, windowDays: 1 };
    const harm = { id: 'h', role: 'harm', source: 'feature-metrics', ref: { feature: 'f', field: 'errorRate' }, direction: 'at-most', threshold: 1, minSamples: 1, windowDays: 1 };
    expect(parse({ ...base, disposition: 'finished', finished, rungs: { fleet: { soakDays: 1, advance: { kind: 'code' }, metrics: [metric, harm] } } }))
      .toMatchObject({ ok: false, reason: 'entries[0].finished-has-no-rungs' });
  });

  it('cannot hide a preference final', () => {
    const preference = { decidedBy: 'a', reason: 'b', decidedAt: '2026-11-06', ref: 'c' };
    expect(parse({ ...base, disposition: 'finished', finished, final: 'default-off-by-preference', preference }))
      .toMatchObject({ ok: false, reason: 'entries[0].finished-needs-default-on' });
  });

  it('reads as fleet and at its final, whatever this agent has set', () => {
    const e = entry('gitBackup');
    const { rung } = deriveLadderRung(e, { gitBackup: { enabled: false } }, {});
    expect(rung).toBe('fleet');
    const state = computeLadderState({ entry: e, rung, target: null, readings: [], afterMove: [], evaluations: [], contractHash: null, now: 0, lastMoveAt: null, heldReason: null });
    expect(state).toMatchObject({ state: 'at-final', because: 'finished' });
  });
});

describe('a feature at its last rung shows its numbers', () => {
  const fid = 'monitoring.h';
  const m = (id: string, role: string, kind: string, value: string, direction: string, threshold: number, windowDays: number) => ({
    id, role, source: 'jsonl-log', direction, threshold, minSamples: 3, windowDays,
    ref: { file: 'logs/feature-evidence.jsonl', where: { featureId: fid, kind }, of: { featureId: fid }, value },
  });
  const h = {
    id: fid, title: 'H', flag: { path: fid }, disposition: 'ladder', final: 'default-on', risk: 'standard',
    shippedOn: { ref: 'PR #1' }, tracking: { state: 'measured', plan: 'p' },
    rungs: { fleet: { soakDays: 7, advance: { kind: 'code' }, metrics: [m('fired', 'ran', 'fired', 'count', 'at-least', 3, 14), m('error-rate', 'harm', 'error', 'ratio', 'at-most', 0.05, 3)] } },
  };
  function service(now: { t: number }) {
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    const audit = path.join(dir, 'logs/maturation-advances.jsonl');
    fs.writeFileSync(audit, `${JSON.stringify({ at: new Date(90 * DAY).toISOString(), action: 'rung-observed', id: fid, from: 'dev-agent-live', to: 'fleet' })}\n`);
    const deps = {
      projectDir: dir, machine: 'm1', now: () => now.t,
      readRegistry: () => JSON.stringify({ schema: 'feature-ladders/1', entries: [h] }),
      readLiveConfig: () => ({ developmentAgent: true }),
      shippedDefaults: () => ({}),
      d7: null, featureMetrics: null, guardEffective: () => new Map(),
      commitments: { record: () => ({ id: 'CMT-1' }), getActive: () => [] },
      holdsLease: () => true, reviewTopic: () => null, isCoherenceCritical: () => false,
      setConfig: () => undefined, isDevelopmentAgent: () => true,
    } as unknown as MaturationLadderDeps;
    return new MaturationLadderService(deps);
  }
  const write = (list: Array<[number, string]>) => fs.writeFileSync(
    path.join(dir, 'logs/feature-evidence.jsonl'),
    list.map(([day, kind]) => JSON.stringify({ at: new Date(day * DAY).toISOString(), featureId: fid, kind })).join('\n') + '\n',
  );

  it('shows why it reads harmed, then clears once the fix has outlasted the window', async () => {
    const now = { t: 92 * DAY };
    const svc = service(now);
    write([[91, 'error'], [91, 'error'], [91, 'error'], [91, 'error'], [91, 'fired']]);
    await svc.refresh();
    const broken = svc.features()[0];
    expect(broken).toMatchObject({ state: 'harmed', because: 'error-rate' });
    expect(broken.metrics.find(x => x.id === 'error-rate')).toMatchObject({ value: 0.8, samples: 5, pass: false });

    // The fix lands on day 92: from there it only fires. Still inside the 14-day watch on day 96.
    now.t = 96 * DAY;
    write([[91, 'error'], [91, 'error'], [91, 'error'], [91, 'error'], [91, 'fired'], [93, 'fired'], [94, 'fired'], [95, 'fired']]);
    await svc.refresh();
    const fixed = svc.features()[0];
    expect(fixed.state).toBe('at-final');
    expect(fixed.metrics.find(x => x.id === 'error-rate')).toMatchObject({ value: 0, pass: true });
  });

  it('the shipped heartbeat looks back 3 days at the fleet rung', () => {
    const e = entry('monitoring.autonomousHeartbeat');
    expect(e.rungs.fleet!.metrics.find(x => x.id === 'error-rate')).toMatchObject({ windowDays: 3, role: 'harm', threshold: 0.05 });
  });
});

describe('the governor records its would-deny rate without changing a verdict', () => {
  afterEach(() => { resetSelfActionGovernorModuleForTest(); resetAnchorForTest(); });
  function governor(): SelfActionGovernorCore {
    resetSelfActionGovernorModuleForTest();
    resetAnchorForTest();
    return initSelfActionGovernor({
      stateDir: dir, readEmergencyDisable: () => false, readClassesConfig: () => undefined, readCensus: () => null,
      registeredMachineCount: () => 1, emitAttention: () => undefined, now: () => 1_000_000_000,
    });
  }

  it('writes fired for an admit and held for a would-deny; observe still allows', () => {
    const h = governor().for('age-kill-backoff');
    const target = { key: 'session:s1', classId: 'session', keyIsVolatile: false };
    expect(h.admitSync(target).outcome).toBe('allow');
    for (let i = 0; i < 4; i++) h.admitSync(target);
    const sixth = h.admitSync(target);
    expect(sixth).toMatchObject({ outcome: 'allow', reason: 'observe-would-deny' });
    const mine = rows().filter(r => r.featureId === 'intelligence.selfActionGovernor');
    expect(mine.map(r => r.kind).sort()).toEqual(['fired', 'held']);
    expect(mine[0].context).toMatchObject({ controllerId: 'age-kill-backoff', mode: 'observe' });
  });
});

describe('phone permission actions', () => {
  it('a failed audit write records error and never throws', () => {
    const stateDir = path.join(dir, 'blocked');
    fs.writeFileSync(stateDir, 'a file, so the state folder cannot be made');
    expect(() => new PermissionActionAudit(stateDir).record({ event: 'approved', deviceId: 'd' } as never)).not.toThrow();
    expect(rows()).toEqual([expect.objectContaining({ featureId: 'mobilePairing.permissionActions', kind: 'error' })]);
  });
});

describe('memory privacy', () => {
  const privacyAt = (root: string) => new MemoryPrivacy({
    stateDir: path.join(root, 'a'), instarRoot: root, agentId: 'x', config: () => ({ ownerUserId: 'justin' }),
    users: () => [{ id: 'justin', slackUserId: 'U1' }, { id: 'vince', slackUserId: 'U2' }] as never, reachable: () => ({}),
  });

  it.each([
    ['POST', '/telegram/reply/5', 'telegram'],
    ['POST', '/slack/reply/C1', 'slack'],
    ['POST', '/imessage/reply/x', 'imessage'],
    ['POST', '/whatsapp/send/x', 'whatsapp'],
    ['POST', '/slack/session-reply', 'slack'],
    ['POST', '/app/session-reply', 'app'],
    ['POST', '/messaging/preflight', null],
    ['POST', '/imessage/validate-send/x', null],
    ['GET', '/telegram/reply/5', null],
  ])('%s %s is the %s channel', (method, url, channel) => {
    expect(memoryReplyChannel(method, url)).toBe(channel);
  });

  async function post(status: number, seen: string[]) {
    const privacy = privacyAt(dir);
    const token = privacy.issueSessionToken('s1', { kind: 'person', userId: 'vince' }, 'slack:D2');
    const app = express();
    app.use(authMiddleware(
      'agent-token', undefined, undefined, undefined,
      t => privacy.sessionForToken(t),
      s => { seen.push(s.sessionId); privacy.noteSessionReply(s.sessionId); },
    ));
    app.post('/slack/reply/D2', (_req, res) => { res.status(status).json({}); });
    await request(app).post('/slack/reply/D2').set('Authorization', `Bearer ${token}`).send({});
    return privacy;
  }

  it('a reply that went out records fired and marks the session', async () => {
    const seen: string[] = [];
    const privacy = await post(200, seen);
    expect(seen).toEqual(['s1']);
    expect(privacy.sessionReplied('s1')).toBe(true);
    // Durable: a restart between the reply and the session's end must not read as a lost reply.
    expect(privacyAt(dir).sessionReplied('s1')).toBe(true);
    expect(rows()).toEqual([expect.objectContaining({ featureId: 'memoryPrivacy', kind: 'fired', context: expect.objectContaining({ channel: 'slack', audience: 'person' }) })]);
    expect(JSON.stringify(rows())).not.toContain('slack:D2');
  });

  it('a refused reply records nothing', async () => {
    const seen: string[] = [];
    const privacy = await post(500, seen);
    expect(seen).toEqual([]);
    expect(privacy.sessionReplied('s1')).toBe(false);
    expect(rows()).toEqual([]);
  });

  it('a session ending with no reply records error; one that replied does not', () => {
    const release = (SessionManager.prototype as unknown as { releaseMemorySession: (this: unknown, s: unknown) => void }).releaseMemorySession;
    const privacy = privacyAt(dir);
    privacy.issueSessionToken('silent', { kind: 'person', userId: 'vince' }, 'slack:D2');
    privacy.issueSessionToken('spoke', { kind: 'person', userId: 'vince' }, 'slack:D2');
    privacy.noteSessionReply('spoke');
    const self = { memoryPrivacyWiring: { privacy } };
    const scope = fs.mkdtempSync(path.join(dir, 'scope-'));
    release.call(self, { id: 'spoke', memoryScopeDir: scope, memoryAudience: 'person' });
    expect(rows()).toEqual([]);
    release.call(self, { id: 'silent', memoryScopeDir: scope, memoryAudience: 'person' });
    expect(rows()).toEqual([expect.objectContaining({ kind: 'error', reason: 'session ended with no reply' })]);
    release.call(self, { id: 'open' });
    expect(rows()).toHaveLength(1);
  });

  it('an owner refused is the harm; anyone else refused is the boundary working', async () => {
    const tracker = new MemoryInboundTracker({
      privacy: privacyAt(dir), framework: () => 'claude-code', sandboxReady: () => false,
      retireSessions: async () => [], retireSessionUnlessAudience: async () => true,
    });
    await tracker.refuse({ placeKey: 'slack:C1', placeKind: 'shared', senderKey: 'user:justin', personId: 'justin' });
    await tracker.refuse({ placeKey: 'slack:C1', placeKind: 'shared', senderKey: 'user:vince', personId: 'vince' });
    expect(rows().map(r => [r.kind, r.reason])).toEqual([['error', 'owner refused'], ['held', 'person refused']]);
  });
});

describe('class-closure evidence', () => {
  const res = (over: Record<string, unknown>) => ({ inScope: true, exempt: undefined, prDeclared: true, hardViolations: [], ...over });

  it('fired with a class block, error without one, keyed so a re-push replaces the row', () => {
    expect(classClosureEvidence(res({}), 'fix/a')).toMatchObject({ featureId: 'prGate.classClosure', kind: 'fired', gradesEventId: 'fix/a' });
    expect(classClosureEvidence(res({ prDeclared: false }), 'fix/a')).toMatchObject({ kind: 'error', reason: 'class block missing' });
  });

  it('a broken registry is pipeline breakage even with a block', () => {
    expect(classClosureEvidence(res({ hardViolations: ['malformed registry: x'] }), 'b')).toMatchObject({ kind: 'error', reason: 'class registry unreadable' });
  });

  it('counts fixes only: a feature touching a skill is neither a pass nor a miss', () => {
    expect(classClosureEvidence(res({ prDeclared: false }), 'feat/a', false)).toBeNull();
    expect(classClosureEvidence(res({}), 'feat/a', false)).toBeNull();
  });

  it('says nothing about an out-of-scope or exempt diff', () => {
    expect(classClosureEvidence(res({ inScope: false }), 'b')).toBeNull();
    expect(classClosureEvidence(res({ exempt: 'gate-source-only' }), 'b')).toBeNull();
  });

  it('the shipped bar dedupes on that key', () => {
    const metrics = entry('prGate.classClosure').rungs['dev-agent-live']!.metrics;
    for (const m of metrics) expect(m.ref).toMatchObject({ dedupe: 'gradesEventId' });
  });
});
