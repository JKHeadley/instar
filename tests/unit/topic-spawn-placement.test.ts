/**
 * Tier-1 unit tests for placement Step 2 (docs/specs/topic-spawns-placed-by-load.md):
 * src/core/topicSpawnPlacement.ts (eligibility, the busy floor + judgment, the forwarded agent
 * task on the target, one placement attempt and the checked local fallback),
 * src/core/TopicSpawnBriefReplicatedStore.ts (the replicated brief) and the Step 1 service's
 * topic-aware reconciliation. Both sides of each decision.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { MachineCapacity } from '../../src/core/types.js';
import type { MachineLoadReport } from '../../src/core/machineLoadReport.js';
import {
  AGENT_BRIEF_FLAG, buildAgentTaskText, classifyForwardedAgentTask, decideTopicSpawnPlacement, isAgentSpawnMessageId,
  agentSpawnMessageId, placeTopicSpawn, runCheckedLocalFallback, topicBoundPlacementEnabled, topicOwnershipState,
  topicTravelBlocker, type TopicPlaceDeps, type LocalFallbackDeps,
} from '../../src/core/topicSpawnPlacement.js';
import {
  AgentSessionPlacementService, AgentSessionPlacementStore, RECONCILE_WINDOW_MS, agentSessionReservations, sessionRunningIn,
} from '../../src/core/agentSessionPlacement.js';
import {
  TOPIC_SPAWN_BRIEF_KIND, TOPIC_SPAWN_BRIEF_KIND_REGISTRATION, TOPIC_SPAWN_BRIEF_STORE_KEY, briefFitsOneRecord,
  createTopicSpawnBriefReplication, topicSpawnBriefStoreSchema,
} from '../../src/core/TopicSpawnBriefReplicatedStore.js';
import { TopicSpawnBriefStore, formatAgentTaskBlock } from '../../src/core/TopicSpawnBriefStore.js';
import { JOURNAL_KINDS, DEFAULT_RETENTION, REPLICATED_RECORD_MAX_ENTRY_BYTES } from '../../src/core/CoherenceJournal.js';
import { RECONCILER_ALLOWLIST } from '../../src/core/ReplicatedStoreReconcilerWiring.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { DEV_GATED_FEATURES } from '../../src/core/devGatedFeatures.js';
import { resolveDevAgentGate } from '../../src/core/devAgentGate.js';
import { heavyReservations } from '../../src/core/heavyWorkPlacement.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { StartTopicOnMachineResult } from '../../src/core/dashboardMachineChoice.js';

const GIB = 1024 ** 3;
const ROOT = path.join(__dirname, '..', '..');
function row(machineId: string, o: { lpc?: number; verdict?: MachineLoadReport['verdict']; memoryPressured?: boolean; brief?: boolean; ageMs?: number } = {}): MachineCapacity {
  const report = {
    bootId: 'b', seq: 1, sampleAgeMs: 0, platform: 'darwin', cores: 16, totalMemBytes: 64 * GIB, loadPerCore: o.lpc ?? 0.2,
    cpuIdlePct: 40, memAvailablePct: o.memoryPressured ? 3 : 40, memPressureNative: o.memoryPressured ? 'critical' : 'normal', eventLoopLagP99Ms: 5,
    sessionsActive: 1, sessionsMax: 25, spawnCapSaturated: false, testRunnerSaturated: false, verdict: o.verdict ?? 'ok', uptimeS: 1000,
    ...(o.memoryPressured !== undefined ? { memoryPressured: o.memoryPressured } : {}),
  } as MachineLoadReport;
  return {
    machineId, nickname: machineId, online: true, activeSessionCount: 1, maxSessions: 25,
    loadVerdict: o.verdict ?? 'ok', loadReport: report, loadReportAgeMs: o.ageMs ?? 1000,
    ...(o.brief === false ? {} : { seamlessnessFlags: { [AGENT_BRIEF_FLAG]: true } }),
  } as unknown as MachineCapacity;
}

beforeEach(() => { agentSessionReservations.clear(); heavyReservations.clear(); });

describe('the switch', () => {
  it('topicBound is dev-gated and needs Step 1 on', () => {
    expect(topicBoundPlacementEnabled({ developmentAgent: true }, resolveDevAgentGate)).toBe(true);
    expect(topicBoundPlacementEnabled({ developmentAgent: false }, resolveDevAgentGate)).toBe(false);
    expect(topicBoundPlacementEnabled({ developmentAgent: true, multiMachine: { placement: { agentSessions: { topicBound: false } } } }, resolveDevAgentGate)).toBe(false);
    expect(topicBoundPlacementEnabled({ developmentAgent: true, multiMachine: { placement: { agentSessions: { enabled: false } } } }, resolveDevAgentGate)).toBe(false);
    expect(topicBoundPlacementEnabled({ developmentAgent: false, multiMachine: { placement: { agentSessions: { enabled: true, topicBound: true } } } }, resolveDevAgentGate)).toBe(true);
  });
  it('is listed in DEV_GATED_FEATURES and the ladder', () => {
    expect(DEV_GATED_FEATURES.some((f) => f.configPath === 'multiMachine.placement.agentSessions.topicBound')).toBe(true);
    const ladders = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/feature-ladders.json'), 'utf8')) as { features?: Array<{ id: string }> } | Array<{ id: string }>;
    expect(JSON.stringify(ladders)).toContain('"multiMachine.placement.agentSessions.topicBound"');
  });
});

describe('eligibility: what can travel, ownership state', () => {
  it('explicit model/framework, heavy work, job fields and bind tokens stay local; a plain request travels', () => {
    expect(topicTravelBlocker({ topicId: 5 }, {})).toBeNull();
    expect(topicTravelBlocker({ topicId: 5, workWeight: 'standard' }, {})).toBeNull();
    expect(topicTravelBlocker({ topicId: 5, model: 'opus' }, {})).toBe('options-do-not-travel');
    expect(topicTravelBlocker({ topicId: 5, framework: 'codex-cli' }, {})).toBe('options-do-not-travel');
    expect(topicTravelBlocker({ topicId: 5, workWeight: 'heavy' }, {})).toBe('options-do-not-travel');
    expect(topicTravelBlocker({ topicId: 5, jobSlug: 'x' }, {})).toBe('options-do-not-travel');
    expect(topicTravelBlocker({ topicId: 5 }, { 'x-instar-bind-token': 't' })).toBe('options-do-not-travel');
  });
  it('ownership state: none, released, self, peer', () => {
    expect(topicOwnershipState(null, 'a')).toBe('none');
    expect(topicOwnershipState({ status: 'released', ownerMachineId: 'b' }, 'a')).toBe('released');
    expect(topicOwnershipState({ status: 'active', ownerMachineId: 'a' }, 'a')).toBe('self');
    expect(topicOwnershipState({ status: 'placing', ownerMachineId: 'b' }, 'a')).toBe('peer');
  });
});

describe('the busy floor and the judgment above it', () => {
  it('a saturated verdict at load 0.5 is busy: placed on the idle peer', () => {
    const d = decideTopicSpawnPlacement({ capacities: [row('self', { lpc: 0.5, verdict: 'saturated' }), row('peer', { lpc: 0.1 })], selfMachineId: 'self' });
    expect(d.target).toBe('peer');
  });
  it('own memory pressure is busy', () => {
    const d = decideTopicSpawnPlacement({ capacities: [row('self', { lpc: 0.2, memoryPressured: true }), row('peer', { lpc: 0.1 })], selfMachineId: 'self' });
    expect(d.target).toBe('peer');
  });
  it('a stale verdict stays local (placement not considered)', () => {
    const d = decideTopicSpawnPlacement({ capacities: [row('self', { lpc: 0.9, verdict: 'saturated', ageMs: 10 * 60_000 }), row('peer', { lpc: 0.1 })], selfMachineId: 'self' });
    expect(d).toMatchObject({ target: null, reason: 'self-load-unknown' });
  });
  it('a healthy machine at 0.6 can hand work to an idle peer (judgment)', () => {
    const d = decideTopicSpawnPlacement({ capacities: [row('self', { lpc: 0.6 }), row('peer', { lpc: 0.05 })], selfMachineId: 'self' });
    expect(d.target).toBe('peer');
  });
  it('an equally loaded peer is not chosen', () => {
    const d = decideTopicSpawnPlacement({ capacities: [row('self', { lpc: 0.4 }), row('peer', { lpc: 0.4 })], selfMachineId: 'self' });
    expect(d).toMatchObject({ target: null, reason: 'not-busy' });
  });
  it('a peer that does not advertise agent-brief@1 is never chosen', () => {
    const d = decideTopicSpawnPlacement({ capacities: [row('self', { lpc: 0.5, verdict: 'saturated' }), row('old', { lpc: 0.1, brief: false })], selfMachineId: 'self' });
    expect(d).toMatchObject({ target: null, reason: 'no-eligible-peer' });
    expect(d.peers[0]).toMatchObject({ eligible: false, reason: 'no-agent-brief' });
  });
  it('a memory-short peer is never chosen', () => {
    const d = decideTopicSpawnPlacement({ capacities: [row('self', { lpc: 0.5, verdict: 'saturated' }), row('peer', { lpc: 0.1, memoryPressured: true })], selfMachineId: 'self' });
    expect(d.target).toBeNull();
  });
  it('no pool means local', () => {
    expect(decideTopicSpawnPlacement({ capacities: [row('self', { verdict: 'saturated' })], selfMachineId: 'self' }).reason).toBe('no-pool');
  });
});

describe('the target side: a forwarded agent task', () => {
  const payload = (origin: string) => ({ text: '[Agent task started by s on Studio]\ndo x', authorship: { kind: 'agent', originMachineId: origin, session: 's' } });
  it('an agent-spawn messageId from the signed sender is the agent task', () => {
    const r = classifyForwardedAgentTask('agent-spawn:5:n1', payload('m_studio'), 'm_studio');
    expect(r).toMatchObject({ kind: 'agent-task', authorship: { originMachineId: 'm_studio', session: 's' } });
  });
  it('a claimed origin that is not the signed sender is refused', () => {
    expect(classifyForwardedAgentTask('agent-spawn:5:n1', payload('m_other'), 'm_studio')).toEqual({ kind: 'refused', reason: 'agent-origin-mismatch' });
  });
  it('agent authorship without the agent-spawn id, or the id without authorship, is refused', () => {
    expect(classifyForwardedAgentTask('123', payload('m_studio'), 'm_studio').kind).toBe('refused');
    expect(classifyForwardedAgentTask('agent-spawn:5:n1', { text: 'hi' }, 'm_studio').kind).toBe('refused');
  });
  it('an ordinary forwarded message is untouched, even if its text looks like the header', () => {
    expect(classifyForwardedAgentTask('123', { text: '[Agent task started by s on Studio] do x' }, 'm_studio')).toEqual({ kind: 'none' });
    expect(classifyForwardedAgentTask('123', 'plain text', 'm_studio')).toEqual({ kind: 'none' });
  });
  it('message ids and the header', () => {
    expect(agentSpawnMessageId(5, 'n')).toBe('agent-spawn:5:n');
    expect(isAgentSpawnMessageId('agent-spawn:5:n')).toBe(true);
    expect(isAgentSpawnMessageId('dashboard-create:5:n')).toBe(false);
    expect(buildAgentTaskText('do x', 'review-1', 'Mac Studio')).toBe('[Agent task started by review-1 on Mac Studio]\ndo x');
  });
  it('the fresh-task framing never reads as a person\'s message or a resume to wait on', () => {
    const b = formatAgentTaskBlock('do x');
    expect(b).toContain('Task started by the agent: do this now');
    expect(b).toContain('do x');
    expect(b).not.toMatch(/latest message|restarted|wait/i);
  });
  it('server.ts wires the arm, the media id, the spawn framing and the heartbeat flag', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf8');
    expect(src).toContain('classifyForwardedAgentTask(cmd.messageId, cmd.payload, sender)');
    expect(src).toContain('agentTask ? null : cmd.messageId');
    expect(src).toContain('{ agentTask: agentTask.text }');
    expect(src).toContain('[AGENT_BRIEF_FLAG]: _agentBriefAdvertised');
    expect(src).toContain('replicatedKindRegistry.register(TOPIC_SPAWN_BRIEF_KIND_REGISTRATION)');
  });
});

describe('the replicated brief (topic-spawn-brief)', () => {
  it('is in both registries, the reconciler allowlist and the applier map', () => {
    expect(JOURNAL_KINDS).toContain(TOPIC_SPAWN_BRIEF_KIND);
    expect(DEFAULT_RETENTION[TOPIC_SPAWN_BRIEF_KIND]).toBeDefined();
    expect(RECONCILER_ALLOWLIST[TOPIC_SPAWN_BRIEF_STORE_KEY]).toMatch(/TopicSpawnBriefReplicatedStore/);
    expect(fs.readFileSync(path.join(ROOT, 'src/core/JournalSyncApplier.ts'), 'utf8')).toContain("'topic-spawn-brief': 'multiMachine.placement.agentSessions.topicBound'");
    const reg = new ReplicatedKindRegistry();
    reg.register(TOPIC_SPAWN_BRIEF_KIND_REGISTRATION);
    expect(reg.getByStore(TOPIC_SPAWN_BRIEF_STORE_KEY)?.kind).toBe(TOPIC_SPAWN_BRIEF_KIND);
  });
  it('the schema keeps the fields and never truncates the prompt', () => {
    const ctx = { countDroppedField: () => undefined, countJailReject: () => undefined };
    const ok = topicSpawnBriefStoreSchema.validate({ topicId: 5, name: 'n', prompt: 'p', placedOn: 'm_b', originMachineId: 'm_a', createdAt: 'now' }, ctx);
    expect(ok).toMatchObject({ topicId: 5, status: 'placed' });
    expect(topicSpawnBriefStoreSchema.validate({ topicId: 5, name: 'n', prompt: 'x'.repeat(REPLICATED_RECORD_MAX_ENTRY_BYTES + 1), placedOn: 'm_b', originMachineId: 'm_a', createdAt: 'now' }, ctx)).toBeNull();
  });
  it('size: a prompt that fits one record fits; one whose escaping pushes it over does not', () => {
    expect(briefFitsOneRecord('short')).toBe(true);
    expect(briefFitsOneRecord('"'.repeat(Math.floor(REPLICATED_RECORD_MAX_ENTRY_BYTES / 2)))).toBe(false);
  });

  function fakeReplication(outcome: string = 'emitted') {
    const records: Array<{ origin: string; envelope: { recordKey: string; hlc: { physical: number; logical: number; node: string }; op: 'put' }; data: Record<string, unknown> }> = [];
    let t = 1;
    const emits: string[] = [];
    const repl = createTopicSpawnBriefReplication({
      emitter: {
        emit: (_store, key, build) => {
          const hlc = { physical: t++, logical: 0, node: 'm_a' };
          const data = build(hlc, 'm_a', undefined)!;
          emits.push(String(data.status));
          if (outcome === 'emitted') records.push({ origin: 'm_a', envelope: { recordKey: String(key), hlc, op: 'put' }, data });
          return { outcome: outcome as never, hlc };
        },
      },
      reader: { loadOriginRecords: () => records as never },
      secrets: () => ['SUPERSECRETTOKEN'],
    });
    return { repl, records, emits };
  }
  it('emitted, oversize and refused map to the spawn outcomes', () => {
    expect(fakeReplication('emitted').repl.emit({ topicId: 5, name: 'n', prompt: 'p', placedOn: 'm_b', originMachineId: 'm_a' })).toBe('emitted');
    expect(fakeReplication('dropped:oversize').repl.emit({ topicId: 5, name: 'n', prompt: 'p', placedOn: 'm_b', originMachineId: 'm_a' })).toBe('prompt-too-large');
    expect(fakeReplication('dropped:rate-limited').repl.emit({ topicId: 5, name: 'n', prompt: 'p', placedOn: 'm_b', originMachineId: 'm_a' })).toBe('brief-not-replicated');
    expect(fakeReplication('disabled').repl.emit({ topicId: 5, name: 'n', prompt: 'p', placedOn: 'm_b', originMachineId: 'm_a' })).toBe('brief-not-replicated');
    const big = fakeReplication('emitted');
    expect(big.repl.emit({ topicId: 5, name: 'n', prompt: 'x'.repeat(REPLICATED_RECORD_MAX_ENTRY_BYTES), placedOn: 'm_b', originMachineId: 'm_a' })).toBe('prompt-too-large');
    expect(big.emits).toHaveLength(0);
  });
  it('the prompt is credential-redacted, read back, and marked completed by an update (never a delete)', () => {
    const { repl, records } = fakeReplication();
    repl.emit({ topicId: 5, name: 'n', prompt: 'use SUPERSECRETTOKEN now', placedOn: 'm_b', originMachineId: 'm_a' });
    expect(repl.read(5)?.prompt).toBe('use [REDACTED] now');
    expect(repl.markCompleted(5, 'm_other')).toBe('nothing-to-mark');
    expect(repl.markCompleted(5, 'm_b')).toBe('emitted');
    expect(records.every((r) => r.envelope.op === 'put')).toBe(true);
    expect(repl.read(5)).toMatchObject({ status: 'completed', placedOn: 'm_b' });
    expect(repl.markCompleted(5)).toBe('nothing-to-mark');
  });
  it('the origin brief store keeps placedOn', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tsb-'));
    const s = new TopicSpawnBriefStore(d);
    s.record(5, 'echo-x', 'p', new Date(), { placedOn: 'm_b' });
    expect(s.get(5)?.placedOn).toBe('m_b');
    SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/topic-spawn-placement.test.ts' });
  });
});

// ── one placement attempt ──────────────────────────────────────────────────

describe('placeTopicSpawn (origin side)', () => {
  let dir: string;
  let svc: AgentSessionPlacementService;
  let starts: Array<{ key: string; target: string; payload: { text: string; authorship: Record<string, unknown> } }>;
  let startAnswer: StartTopicOnMachineResult;
  let peerList: unknown[];
  let emitted: Array<Record<string, unknown>>;
  let localBriefs: string[];
  let ownership: { status: string; ownerMachineId: string } | null;
  let order: string[];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsp-'));
    starts = []; emitted = []; localBriefs = []; order = []; peerList = []; ownership = null;
    startAnswer = { ok: true, epoch: 2, settled: true };
    svc = new AgentSessionPlacementService({
      store: new AgentSessionPlacementStore(path.join(dir, 'p.json')),
      logPath: path.join(dir, 'log.jsonl'),
      readPeerSessions: async () => peerList,
      raiseAttention: () => undefined,
      nickname: (id) => (id === 'm_b' ? 'Mac M5' : id === 'm_a' ? 'Mac Studio' : null),
      sleep: async () => undefined,
    });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/topic-spawn-placement.test.ts' }));

  const deps = (over: Partial<TopicPlaceDeps> = {}): TopicPlaceDeps => ({
    svc, selfMachineId: 'm_a', nickname: (id) => (id === 'm_b' ? 'Mac M5' : id === 'm_a' ? 'Mac Studio' : null),
    readOwnership: () => ownership, ownerReachable: () => true, holdsLease: () => true, seamWired: () => true,
    decision: () => decideTopicSpawnPlacement({ capacities: [row('m_a', { lpc: 0.5, verdict: 'saturated' }), row('m_b', { lpc: 0.1 })], selfMachineId: 'm_a' }),
    emitBrief: (rec) => { order.push('emit'); emitted.push(rec); return 'emitted'; },
    recordLocalBrief: (p) => { localBriefs.push(p); },
    start: async (key, target, payload) => { order.push('start'); starts.push({ key, target, payload: payload as never }); return startAnswer; },
    reconcileReads: 1, reconcileGapMs: 0,
    ...over,
  });
  const place = (body: Record<string, unknown> = {}, over: Partial<TopicPlaceDeps> = {}) =>
    placeTopicSpawn({ name: 'review-1', topicId: 77, prompt: 'review PR 9', body: { topicId: 77, ...body }, headers: {}, runningHere: false, deps: deps(over) });
  const logRows = () => fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  it('accepted: 202 peer-accepted with tmuxSession null; the brief is replicated before the hand-off; agent authorship', async () => {
    const r = await place();
    expect(r).toMatchObject({ kind: 'respond', status: 202, body: { placementOutcome: 'peer-accepted', tmuxSession: null, topicId: 77, placedOn: { machineId: 'm_b' } } });
    expect(order).toEqual(['emit', 'start']);
    expect(emitted[0]).toMatchObject({ topicId: 77, placedOn: 'm_b', originMachineId: 'm_a' });
    expect(localBriefs).toEqual(['m_b']);
    expect(starts[0].key).toBe('77');
    expect(starts[0].payload.authorship).toEqual({ kind: 'agent', originMachineId: 'm_a', session: 'review-1' });
    expect(starts[0].payload.text).toBe('[Agent task started by review-1 on Mac Studio]\nreview PR 9');
    expect(svc.deps.store.get('review-1')).toMatchObject({ machineId: 'm_b', state: 'pending', topicId: 77 });
    expect(logRows().at(-1)).toMatchObject({ topicBound: true, topicId: 77, topicOwnership: 'none', outcome: 'peer-accepted' });
  });
  it('unknown: the claim is kept, nothing starts locally, 202 unconfirmed', async () => {
    startAnswer = { ok: false, code: 'start-unknown', error: 'timeout', settled: false };
    const r = await place();
    expect(r).toMatchObject({ kind: 'respond', status: 202, body: { placementOutcome: 'unconfirmed' } });
    expect(svc.deps.store.get('review-1')?.state).toBe('pending');
  });
  it('unknown, then the session is seen bound to the topic: peer-accepted with its real name', async () => {
    startAnswer = { ok: false, code: 'start-unknown', error: 'timeout', settled: false };
    peerList = [{ tmuxSession: 'echo-topic-77', telegramTopicId: 77, status: 'running', id: 'sid' }];
    const r = await place();
    expect(r).toMatchObject({ kind: 'respond', status: 202, body: { placementOutcome: 'peer-accepted', tmuxSession: 'echo-topic-77' } });
  });
  it('superseded after an accepted or unknown deliver: nothing starts locally, 202 unconfirmed, tracking kept', async () => {
    for (const delivered of ['accepted', 'unknown'] as const) {
      startAnswer = { ok: false, code: 'start-superseded', delivered, ownerNow: null, epochNow: 3, statusNow: 'missing' };
      const r = await place();
      expect(r).toMatchObject({ kind: 'respond', status: 202, body: { placementOutcome: 'unconfirmed' } });
      expect(svc.deps.store.get('review-1')?.state).toBe('pending');
    }
  });
  it('superseded after a rejected deliver falls back to the checked local path', async () => {
    startAnswer = { ok: false, code: 'start-superseded', delivered: 'rejected', ownerNow: null, epochNow: 3, statusNow: 'missing', error: 'rejected' };
    const r = await place();
    expect(r).toMatchObject({ kind: 'local-fallback' });
  });
  it('a rejected deliver falls back to the checked local path', async () => {
    startAnswer = { ok: false, code: 'start-failed', error: 'rejected 403', released: true, settled: true };
    const r = await place();
    expect(r).toMatchObject({ kind: 'local-fallback' });
    expect(svc.deps.store.get('review-1')).toBeNull();
  });
  it('the protocol finding a peer owner at claim time answers 409 topic-owned-elsewhere', async () => {
    startAnswer = { ok: false, code: 'topic-owned-elsewhere', reason: 'record-active' };
    const owned = { status: 'active', ownerMachineId: 'm_c' };
    let reads = 0;
    const r = await place({}, { readOwnership: () => (reads++ === 0 ? null : owned) });
    expect(r).toMatchObject({ kind: 'respond', status: 409, body: { placementOutcome: 'topic-owned-elsewhere', owner: { machineId: 'm_c' }, ownerReachable: true } });
  });
  it('a peer-owned topic answers 409 before anything is sent, with ownerReachable false when unreachable', async () => {
    ownership = { status: 'active', ownerMachineId: 'm_c' };
    const r = await place({}, { ownerReachable: () => false });
    expect(r).toMatchObject({ kind: 'respond', status: 409, body: { ownerReachable: false } });
    expect(starts).toHaveLength(0);
  });
  it('stays local: explicit model, heavy, not the lease holder, unwired seam, not busy, owned here', async () => {
    expect(await place({ model: 'opus' })).toEqual({ kind: 'local', reason: 'options-do-not-travel' });
    expect(await place({ workWeight: 'heavy' })).toEqual({ kind: 'local', reason: 'options-do-not-travel' });
    expect(await place({}, { holdsLease: () => false })).toEqual({ kind: 'local', reason: 'not-router' });
    expect(await place({}, { seamWired: () => false })).toEqual({ kind: 'local', reason: 'router-not-wired' });
    expect(await place({}, { decision: () => decideTopicSpawnPlacement({ capacities: [row('m_a', { lpc: 0.3 }), row('m_b', { lpc: 0.3 })], selfMachineId: 'm_a' }) })).toEqual({ kind: 'local', reason: 'not-busy' });
    ownership = { status: 'active', ownerMachineId: 'm_a' };
    expect(await place()).toEqual({ kind: 'local', reason: 'topic-owned-here' });
    expect(starts).toHaveLength(0);
  });
  it('a refused emit keeps the spawn local and sends nothing', async () => {
    expect(await place({}, { emitBrief: () => 'brief-not-replicated' })).toEqual({ kind: 'local', reason: 'brief-not-replicated' });
    expect(await place({}, { emitBrief: () => 'prompt-too-large' })).toEqual({ kind: 'local', reason: 'prompt-too-large' });
    expect(await place({}, { emitBrief: null })).toEqual({ kind: 'local', reason: 'brief-not-replicated' });
    expect(starts).toHaveLength(0);
    expect(svc.deps.store.size()).toBe(0);
  });
  it('a same-name retry is read-only while the placement is unresolved', async () => {
    await place();
    peerList = [];
    const bound = await svc.boundAnswer('review-1');
    expect(bound).toMatchObject({ status: 202, body: { placementOutcome: 'unconfirmed', tmuxSession: null, topicId: 77 } });
  });
});

describe('the checked local fallback', () => {
  let calls: string[];
  const fb = (over: Partial<LocalFallbackDeps> = {}) => runCheckedLocalFallback({
    name: 'review-1', topicId: 77, prompt: 'p', reason: 'peer-refused:x',
    deps: {
      claim: () => ({ place: () => { calls.push('place'); return { ok: true }; }, confirm: () => { calls.push('confirm'); return true; }, release: () => { calls.push('release'); return true; } }),
      spawnForTopic: async (_t, _n, task) => { calls.push(`spawn:${task}`); return { ok: true, session: 'echo-topic-77', registered: true }; },
      isRunning: () => true,
      readOwnership: () => ({ status: 'active', ownerMachineId: 'm_c' }),
      selfMachineId: 'm_a', nickname: () => null, ownerReachable: () => true,
      answerSpawnError: () => ({ status: 500, body: { error: 'boom' } }),
      recordLocalBrief: () => { calls.push('brief'); },
      log: () => undefined,
      ...over,
    },
  });
  beforeEach(() => { calls = []; });
  it('claim won and a running session: 201 local-fallback, claim confirmed, task framing', async () => {
    const r = await fb();
    expect(r).toMatchObject({ status: 201, body: { placementOutcome: 'local-fallback', tmuxSession: 'echo-topic-77' } });
    expect(calls).toEqual(['place', 'spawn:p', 'confirm', 'brief']);
  });
  it('a lost local claim answers 409 and starts nothing', async () => {
    const r = await fb({ claim: () => ({ place: () => ({ ok: false, reason: 'not-free' }), confirm: () => true, release: () => true }) });
    expect(r).toMatchObject({ status: 409, body: { placementOutcome: 'topic-owned-elsewhere', owner: { machineId: 'm_c' } } });
    expect(calls).toEqual([]);
  });
  it('a spawn that fails or is not running releases the claim; 201 only for a running session', async () => {
    expect((await fb({ spawnForTopic: async () => ({ ok: false, code: 'topic-spawning' }) })).status).toBe(409);
    expect(calls).toContain('release');
    calls = [];
    expect((await fb({ isRunning: () => false })).status).toBe(500);
    expect(calls).toContain('release');
    calls = [];
    expect(await fb({ spawnForTopic: async () => { throw new Error('x'); } })).toEqual({ status: 500, body: { error: 'boom' } });
    expect(calls).toEqual(['place', 'release']);
  });
  it('no local claim available: nothing starts (never the blind spawn)', async () => {
    expect((await fb({ claim: () => null })).status).toBe(503);
  });
});

describe('topic-aware reconciliation (Step 1 service)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsr-')); });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/topic-spawn-placement.test.ts' }));
  it('a topic entry matches the session bound to its topic, not only its name', () => {
    const entry = { machineId: 'm_b', state: 'pending' as const, at: '', lastSeenAt: null, lastCheckAt: null, okReads: 0, topicId: 77 };
    expect(sessionRunningIn([{ tmuxSession: 'echo-topic-77', telegramTopicId: 77, status: 'running' }], 'review-1', entry)).toBe(true);
    expect(sessionRunningIn([{ tmuxSession: 'echo-topic-78', telegramTopicId: 78, status: 'running' }], 'review-1', entry)).toBe(false);
  });
  it('learns the real name, marks the brief on gone, and the attention item names the topic, machine, claim and holders', async () => {
    let now = Date.parse('2026-11-18T10:00:00Z');
    let list: unknown[] = [{ tmuxSession: 'echo-topic-77', telegramTopicId: 77, status: 'running', id: 'sid' }];
    const gone: string[] = [];
    const items: Array<{ title: string; summary: string }> = [];
    const store = new AgentSessionPlacementStore(path.join(dir, 'p.json'), () => now);
    const svc = new AgentSessionPlacementService({
      store, logPath: path.join(dir, 'l.jsonl'), readPeerSessions: async () => list, raiseAttention: (i) => items.push(i),
      nickname: (id) => id, now: () => now, sleep: async () => undefined,
      onGone: (n) => gone.push(n), briefHolders: () => ({ heldBy: ['m_a'], notYet: ['m_b', 'm_c'] }),
    });
    store.setPending('review-1', 'm_b', { topicId: 77 });
    expect(await svc.reconcileNow('review-1', 'm_b', 1, 0)).toBe(true);
    expect(store.get('review-1')?.tmuxSession).toBe('echo-topic-77');
    list = [];
    now += 11 * 60_000;
    await svc.tick();
    expect(store.get('review-1')?.state).toBe('gone');
    expect(gone).toEqual(['review-1']);

    store.setPending('review-2', 'm_b', { topicId: 78 });
    list = [];
    now += RECONCILE_WINDOW_MS + 60_000;
    await svc.tick();
    expect(items).toHaveLength(1);
    expect(items[0].title).toContain('topic 78');
    expect(items[0].summary).toMatch(/held by: m_a; not yet confirmed on: m_b, m_c/);
    expect(items[0].summary).toMatch(/stays claimed/);
  });
});
