// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * e2e — the shadow fold runner is ALIVE on the production trigger path
 * (context-budget-layered-summaries §16 Phase 2; slice P2-4b):
 *  1. startShadowFoldRunner (the boot wiring server.ts calls) with the REAL
 *     runner, coordinator, layer store, handoff/packet/probe/grade/answerer
 *     modules, and an EventEmitter in the hook receiver's place: a topic
 *     session's Stop event produces a graded shadow fold, the record ends
 *     `aborted` by design, no carrier is left, and the record is readable.
 *  2. WIRED: server.ts starts the runner after the AgentServer, behind the
 *     dev-gated switch read on every trigger, and gives the fold coordinator
 *     the pool-live ownership record and mesh identity.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startShadowFoldRunner, type ShadowRunnerBootDeps } from '../../src/monitoring/foldShadowRunnerBoot.js';
import type { ShadowRunnerDeps, LiveTopicSession } from '../../src/monitoring/foldShadowRunner.js';
import { buildFoldCoordinator } from '../../src/monitoring/foldCoordinatorBoot.js';
import { FoldRecordStore } from '../../src/monitoring/FoldCoordinator.js';
import { LayerStore, rowRefFor, type LayerMeta } from '../../src/monitoring/contextLayers/LayerStore.js';
import { foldMarkerPath, listFoldMarkers } from '../../src/monitoring/foldMarker.js';
import { listStagedFoldPackets } from '../../src/monitoring/foldPacket.js';
import { readShadowFolds, summarizeShadowFolds } from '../../src/monitoring/foldShadowLog.js';
import { HANDOFF_SCHEMA } from '../../src/monitoring/foldHandoff.js';
import { finalAssistantText } from '../../src/scheduler/jobTranscriptEvidence.js';
import type { IntelligenceProvider } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OP = 'tests/e2e/context-budget-fold-shadow-alive.test.ts';
const T = '141133';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });

const HANDOFF_REPLY = JSON.stringify({ schema: HANDOFF_SCHEMA, finished: [{ fromMessageId: 1, toMessageId: 4, outcome: 'Built the store.', artifacts: [] }], stillNeeded: [{ text: 'Never cut an operator quote.', origin: 'user' }], openThreads: ['wire the probe'], nextStep: 'Open the PR.', background: 'none', decisions: [] });

const meta = (): LayerMeta => ({ author: { sessionId: 's1', machine: 'm1', model: 'opus', kind: 'derived' }, asOf: { at: Date.UTC(2026, 10, 20, 12), lastMessageId: 6 } });
const ts = (i: number) => new Date(Date.UTC(2026, 10, 20, 10, i)).toISOString();

const SESSION: LiveTopicSession = { topicKey: T, tmuxSession: 'echo-141133', instarSessionId: 'live-sess-1', claudeSessionId: 'c-1', framework: 'claude-code', model: 'opus' };

function harness(o: { handoffReply?: string | null; noJudge?: boolean; clean?: boolean; estimateOk?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-')); dirs.push(root);
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(stateDir);
  const store = new LayerStore({ stateDir, liveSecrets: () => [] });
  const rows = new Map<number, { text: string; fromUser: boolean }>([
    [1, { text: 'Build the context budget.', fromUser: true }], [2, { text: 'On it.', fromUser: false }],
    [3, { text: 'Never cut an operator quote.', fromUser: true }], [4, { text: 'Store built.', fromUser: false }],
    [5, { text: 'What next?', fromUser: true }], [6, { text: 'The probe.', fromUser: false }],
  ]);
  for (const [id, r] of rows) if (r.fromUser) store.writeProtected(T, 'u', `m-${id}`, [rowRefFor(id, r.text)], meta(), { label: 'operator', authority: 'operator', rowId: id, at: Date.parse(ts(id)) });
  store.writeProtected(T, 'anchor', 'current', [rowRefFor(1, rows.get(1)!.text)], { ...meta(), status: 'anchored' }, { at: [Date.parse(ts(1))], skippedGreetings: 0 });
  store.writeDerived(T, 'h1', 'current', { goal: 'Phase 2.' }, { ...meta(), status: 'live' });
  const coordinator = buildFoldCoordinator({ stateDir, runningTopicSessions: () => [{ topicKey: T }], poolPlacementLive: () => false, inboundQueueLive: () => true, topicRowsPresent: () => true, sentinelHeartbeatFresh: () => true, layerKindPresent: () => true }).coordinator;
  const events: string[] = [];
  const holds = new Set<string>();
  const inboundHeld = new Set<string>();
  const handoff = { schema: HANDOFF_SCHEMA, finished: [{ fromMessageId: 1, toMessageId: 4, outcome: 'Built the store.', artifacts: [] }], stillNeeded: [{ text: 'Never cut an operator quote.', origin: 'user' }], openThreads: ['wire the probe'], nextStep: 'Open the PR.', background: 'none', decisions: [] };
  const model: IntelligenceProvider = {
    evaluate: async (prompt, opts) => {
      const c = (opts as { attribution?: { component?: string } })?.attribution?.component;
      events.push(`model ${c}`);
      if (c === 'FoldAudit') return '{"verdict":"accept","questions":[],"protectedDefect":false}';
      if (prompt.includes('You write held-out probe questions')) return JSON.stringify({ questions: [{ type: 'constraint', source: 'span', sourceRef: null, spanIndex: 0, sample: 'named', question: 'What must never be cut?', expected: 'An operator quote must never be cut.', referenceEntryIds: ['e1'] }, { type: 'open-thread', source: 'open-thread', sourceRef: '0', spanIndex: null, sample: 'named', question: 'What is open?', expected: 'Wiring the probe.', referenceEntryIds: [] }] });
      return '{"grade":"retained","absent":false,"reason":"ok"}';
    },
  };
  const answerTranscript = path.join(root, 'answer.jsonl');
  fs.writeFileSync(answerTranscript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'PLACEHOLDER', answer: 'x' }] }) }] } }));
  const d: ShadowRunnerDeps = {
    stateDir, enabled: () => true, now: () => Date.now(),
    coordinator,
    holds: { write: (t, f) => { holds.add(`${t}/${f}`); events.push('hold'); return true; }, release: (t, f) => { if (holds.delete(`${t}/${f}`)) events.push('hold-released'); } },
    inbound: { holdForFold: (_t, f) => { inboundHeld.add(f); events.push('inbound-held'); return true; }, releaseFold: (f) => { if (inboundHeld.delete(f)) events.push('inbound-released'); }, waiting: () => 0 },
    session: {
      exists: () => true, paneIdle: async () => (o.clean === false ? false : true), liveToolShell: () => false, liveHelpers: () => false, pendingInjection: () => false,
      inject: async (_s, text) => { events.push(`inject ${text.slice(0, 40)}`); return true; },
      awaitTurnEnd: async () => (o.handoffReply === undefined ? JSON.stringify(handoff) : o.handoffReply),
    },
    transcript: { read: async () => '{"type":"assistant","uuid":"e-last","message":{"content":[]}}', lastEntryId: () => 'e-last', openBackgroundTasks: () => 0 },
    nextCheckInAt: () => null,
    estimate: () => (o.estimateOk === false ? { status: 'unknown', reason: 'the live context size is behind the ledger poller' } : { status: 'ok', cost: 100, savingPerTurn: 50, breakEvenTurns: 2, expectedRemainingTurns: 20, margin: 1.5, worthAsking: true, belowFloor: false, terms: { handoff: 1, sendBacks: 0, packetWrite: 1, fixed: 1 } }),
    messages: () => [...rows].map(([messageId, r]) => ({ messageId, fromUser: r.fromUser, text: r.text, at: ts(messageId) })),
    archivedEntryIds: () => new Set(['e1']),
    foldedSpans: () => [{ index: 0, outcome: 'Built the store.', entries: [{ entryId: 'e1', kind: 'user-message', text: 'Never cut an operator quote.', messageIds: [3], isError: false, hasFilePath: false, timestamp: null, toolName: null }] }],
    artifactSignals: () => ({ signals: [], mergedNotMentioned: [] }),
    packetInputs: () => ({ store, rows: { getRow: (_t, id) => { const r = rows.get(id); return r ? { text: r.text, timestamp: ts(id) } : null; }, countMessagesAfter: () => ({ total: 0, fromUser: 0 }), lastAgentMessage: () => ({ messageId: 6, timestamp: ts(6) }) }, intent: null, anchorText: 'Build the context budget.', ledgerText: '', ledgerItems: [], ledgerDecisions: [] }),
    intelligence: o.noJudge ? null : model,
    answerer: {
      stateDir, port: 4042,
      spawn: async (opts) => {
        // The live session must already be released when the answerer starts.
        events.push(`answerer-spawn live-marker=${fs.existsSync(foldMarkerPath(stateDir, SESSION.instarSessionId)!)} holds=${holds.size} inbound=${inboundHeld.size}`);
        const ids = [...opts.prompt.matchAll(/^- \[([^\]]+-q\d+)\]/gm)].map((m) => m[1]);
        fs.writeFileSync(answerTranscript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify({ answers: ids.map((id) => ({ id, answer: 'An operator quote must never be cut.' })) }) }] } }));
        return { id: opts.instarSessionId, tmuxSession: opts.name };
      },
      isAlive: () => false, kill: async () => undefined,
      issueToken: () => `mps_${'t'.repeat(43)}`, revokeTokens: () => undefined,
      findTranscript: () => answerTranscript, finalText: finalAssistantText,
    },
  };
  return { d, stateDir, events };
}


describe('the shadow fold runner on the production trigger path', () => {
  it('a topic session\'s Stop events drive a graded shadow fold end to end', async () => {
    const h = harness();
    const hooks = new EventEmitter();
    const raw = { id: SESSION.instarSessionId, tmuxSession: SESSION.tmuxSession, telegramTopicId: Number(T), claudeSessionId: 'c-1', framework: 'claude-code', model: 'opus' };
    const d = h.d as ShadowRunnerDeps;
    const transcript = path.join(h.stateDir, 'live-transcript.jsonl');
    fs.writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', uuid: 'e-last', message: { content: [] } })}\n`);
    const runner = startShadowFoldRunner({
      stateDir: h.stateDir, enabled: () => true, sessions: () => [raw], transcriptPath: () => transcript,
      onStop: (cb) => { hooks.on('Stop', cb); return () => { hooks.off('Stop', cb); }; },
      base: {
        coordinator: d.coordinator, holds: d.holds, inbound: d.inbound, nextCheckInAt: d.nextCheckInAt, messages: d.messages,
        archivedEntryIds: d.archivedEntryIds, artifactSignals: d.artifactSignals, packetInputs: d.packetInputs, intelligence: d.intelligence,
        sessionOps: { exists: () => true, workState: async () => 'idle', hasLiveToolShell: () => false, hasActiveSubagents: () => false, pendingInjection: () => false, inject: () => { setTimeout(() => hooks.emit('Stop', { instar_session_id: SESSION.instarSessionId, last_assistant_message: HANDOFF_REPLY }), 5); return true; } },
        archive: { spansForMessage: () => ['span-a'], readSpan: () => [{ entryId: 'e1', messageIds: [3], fields: { text: 'Never cut an operator quote.' }, meta: { kind: 'user-message' } }] },
        ledger: { liveContextTokens: () => 400_000, lagging: () => false, turnsLastHour: () => 40 },
        packetTokens: () => 2_000,
        answerer: d.answerer,
      } as ShadowRunnerBootDeps['base'],
    });
    // Turn ends until the 1-in-3 sample asks; the handoff turn's own Stop is the reply.
    for (let i = 0; i < 12 && readShadowFolds(h.stateDir).length === 0; i++) {
      hooks.emit('Stop', { instar_session_id: SESSION.instarSessionId });
      for (let w = 0; w < 50 && runner.status().inFlight !== null; w++) await new Promise((r) => setTimeout(r, 20));
    }
    runner.stop();
    const rows = readShadowFolds(h.stateDir);
    expect(rows.map((r) => [r.outcome, r.reason])).toEqual([['graded', null]]);
    expect(summarizeShadowFolds(rows)).toMatchObject({ graded: 1, lostRate: 0 });
    expect(new FoldRecordStore(h.stateDir).list(T).map((r) => [r.state, r.reason])).toEqual([['aborted', 'shadow-graded']]);
    expect(listStagedFoldPackets(h.stateDir)).toEqual([]);
    expect(listFoldMarkers(h.stateDir)).toEqual([]);
    expect(h.events.find((e) => e.startsWith('answerer-spawn'))).toBe('answerer-spawn live-marker=false holds=0 inbound=0');
  }, 60_000);

  it('WIRED: server.ts starts the runner after the AgentServer, behind the dev-gated switch, with pool-live ownership', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf-8');
    const agentServer = src.indexOf('const server = new AgentServer(');
    const runner = src.indexOf("await import('../monitoring/foldShadowRunnerBoot.js')");
    expect(agentServer).toBeGreaterThan(0);
    expect(runner).toBeGreaterThan(agentServer);
    expect(src).toContain("shadowGate(liveConfig.get<boolean | undefined>('contextBudget.fold.shadow', undefined), config)");
    expect(src).toContain("onStop: (cb) => { hookEventReceiver.on('Stop', cb);");
    expect(src).toContain('ledger = () => server.getTokenLedger()');
    expect(src).toContain('issueToken: (id, t) => _memoryPrivacyWired.issueFoldProbeToken(id, t)');
    const coordBuild = src.indexOf("await import('../monitoring/foldCoordinatorBoot.js')");
    const owner = src.indexOf('ownershipRecord: (k) => {', coordBuild);
    expect(owner).toBeGreaterThan(coordBuild);
    expect(owner).toBeLessThan(src.indexOf('built.coordinator.recoverPendingFolds()', coordBuild));
    expect(src.slice(owner, owner + 800)).toContain('sessionOwnershipRegistry?.read(k)');
    expect(src.slice(owner, owner + 800)).toContain('selfMachineId: () =>');
  });
});
