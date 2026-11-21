// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * Unit — the shadow runner's prerequisites (context-budget-layered-summaries
 * §9.3, §10, §16 Phase 2): the coordinator's lock window and renew, removing
 * ONE session's marker, the per-prompt hook not muted by a shadow-probing
 * record, the shadow-fold log and its 40-fold summary, and the handoff request.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFoldCoordinator } from '../../src/monitoring/foldCoordinatorBoot.js';
import { FoldRecordStore, readLockWindows } from '../../src/monitoring/FoldCoordinator.js';
import { writeFoldMarker, removeFoldMarkerFor, foldMarkerPath } from '../../src/monitoring/foldMarker.js';
import { foldSuppression } from '../../src/monitoring/contextLayers/promptContext.js';
import { appendShadowFold, readShadowFolds, summarizeShadowFolds, PHASE2_EXIT_FOLDS, FOLD_SHADOW_LOG_MAX_BYTES } from '../../src/monitoring/foldShadowLog.js';
import { buildHandoffRequest, parseHandoff, HANDOFF_INDEX_MAX } from '../../src/monitoring/foldHandoff.js';
import { DEV_GATED_FEATURES } from '../../src/core/devGatedFeatures.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/fold-runner-prereqs.test.ts';
const T = '141133';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });
const stateDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-prereqs-')); dirs.push(d); return d; };

const coordinator = (dir: string) => buildFoldCoordinator({
  stateDir: dir, runningTopicSessions: () => [{ topicKey: T }], poolPlacementLive: () => false,
  inboundQueueLive: () => true, topicRowsPresent: () => true, sentinelHeartbeatFresh: () => true, layerKindPresent: () => true,
}).coordinator;

describe('FoldCoordinator lock window and renew', () => {
  it('records the lock-window bounds on an open record, and renews its lock', () => {
    const dir = stateDir();
    const c = coordinator(dir);
    const b = c.begin(T, 'prepare');
    if (!b.ok) throw new Error(b.reason);
    expect(c.setLockWindow(T, b.record.foldId, { fromEntry: 'e-10' })).toBe(true);
    expect(c.setLockWindow(T, b.record.foldId, { toEntry: 'e-14' })).toBe(true);
    expect(new FoldRecordStore(dir).getSidecar(T, b.record.foldId).lockWindow).toEqual({ fromEntry: 'e-10', toEntry: 'e-14' });
    expect(c.renew(T, b.record.foldId, { generation: b.record.generation })).toBe(true);
    expect(c.renew(T, b.record.foldId, { generation: b.record.generation + 1 })).toBe(false); // not the generation this hand holds
    // The bounds outlive the record's settle (a shadow fold ends aborted by design).
    const done = c.transition(T, b.record.foldId, { state: b.record.state, seq: b.record.seq, generation: b.record.generation }, 'aborted');
    expect(done.ok).toBe(true);
    expect(new FoldRecordStore(dir).getSidecar(T, b.record.foldId).lockWindow).toBeUndefined();
    expect(readLockWindows(dir, T)).toEqual([expect.objectContaining({ foldId: b.record.foldId, fromEntry: 'e-10', toEntry: 'e-14' })]);
  });

  it('the lock-window log is bounded on disk: it compacts to the newest merged rows', () => {
    const dir = stateDir();
    const c = coordinator(dir);
    const b = c.begin(T, 'prepare');
    if (!b.ok) throw new Error(b.reason);
    for (let i = 0; i < 3_000; i++) expect(c.setLockWindow(T, b.record.foldId, { fromEntry: `e-${i}`, toEntry: `x-${'p'.repeat(60)}-${i}` })).toBe(true);
    const file = path.join(dir, 'state', 'context-layers', T, 'fold-records', 'lock-windows.jsonl');
    expect(fs.statSync(file).size).toBeLessThan(300 * 1024);
    expect(readLockWindows(dir, T)).toEqual([expect.objectContaining({ foldId: b.record.foldId, fromEntry: 'e-2999' })]);
  });

  it('renew refuses a quarantined fold (its lock is the sentinel\'s)', () => {
    const dir = stateDir();
    const c = coordinator(dir);
    const b = c.begin(T);
    if (!b.ok) throw new Error(b.reason);
    let rec = b.record;
    for (const to of ['snapshotted', 'staged', 'replacing'] as const) {
      const r = c.transition(T, rec.foldId, { state: rec.state, seq: rec.seq, generation: rec.generation }, to);
      if (!r.ok) throw new Error(r.reason);
      rec = r.record;
    }
    expect(c.quarantine(T, rec.foldId, 'test').ok).toBe(true);
    expect(c.renew(T, rec.foldId, { generation: rec.generation })).toBe(false);
  });
  it('refuses both on a terminal record and an unknown fold', () => {
    const dir = stateDir();
    const c = coordinator(dir);
    const b = c.begin(T, 'prepare');
    if (!b.ok) throw new Error(b.reason);
    const r = c.transition(T, b.record.foldId, { state: b.record.state, seq: b.record.seq, generation: b.record.generation }, 'aborted');
    expect(r.ok).toBe(true);
    expect(c.setLockWindow(T, b.record.foldId, { fromEntry: 'x' })).toBe(false);
    expect(c.renew(T, b.record.foldId, { generation: b.record.generation })).toBe(false);
    expect(c.renew(T, 'fold-none', { generation: 0 })).toBe(false);
  });
});

describe('removeFoldMarkerFor', () => {
  it('removes one session\'s marker for this fold only', () => {
    const dir = stateDir();
    writeFoldMarker(dir, { instarSessionId: 'live1', foldId: 'f1', topicKey: T, expiresAt: Date.now() + 60_000 });
    writeFoldMarker(dir, { instarSessionId: 'answer1', foldId: 'f1', topicKey: T, expiresAt: Date.now() + 60_000 });
    expect(removeFoldMarkerFor(dir, 'live1', 'f-other')).toBe(false);
    expect(removeFoldMarkerFor(dir, 'live1', 'f1')).toBe(true);
    expect(fs.existsSync(foldMarkerPath(dir, 'live1')!)).toBe(false);
    expect(fs.existsSync(foldMarkerPath(dir, 'answer1')!)).toBe(true);
    expect(removeFoldMarkerFor(dir, 'nobody', 'f1')).toBe(false);
  });
});

describe('foldSuppression and shadow-probing', () => {
  it('a prepared record mutes the per-prompt hook; once shadow-probing, the live session is no longer muted', () => {
    const dir = stateDir();
    const c = coordinator(dir);
    const b = c.begin(T, 'prepare');
    if (!b.ok) throw new Error(b.reason);
    expect(foldSuppression(dir, Number(T), 'live-session')).toEqual({ suppress: true, reason: 'fold-open' });
    const r = c.transition(T, b.record.foldId, { state: b.record.state, seq: b.record.seq, generation: b.record.generation }, 'shadow-probing');
    expect(r.ok).toBe(true);
    expect(foldSuppression(dir, Number(T), 'live-session')).toEqual({ suppress: false });
  });
});

describe('the shadow-fold log', () => {
  const row = (outcome: 'graded' | 'skipped' | 'declined' | 'aborted', over: Record<string, unknown> = {}) => ({
    at: 1, topicKey: T, foldId: 'f', engine: 'claude-code', outcome, reason: outcome === 'graded' ? null : 'not-sampled',
    ...(outcome === 'graded' ? { grades: { retained: 8, retrievable: 1, lost: 1, ungraded: 0, lostRate: 0.1, wouldBe: 'correct-and-reprobe', protectedLost: false }, durations: { handoff: 1000, probe: 2000 } } : {}),
    ...over,
  });

  it('summarizes graded folds toward the 40-fold exit, the pooled lost rate and skip reasons', () => {
    const dir = stateDir();
    for (let i = 0; i < 3; i++) appendShadowFold(dir, row('graded'));
    appendShadowFold(dir, row('graded', { grades: { retained: 0, retrievable: 0, lost: 2, ungraded: 0, lostRate: 1, wouldBe: 'rollback', protectedLost: true } }));
    appendShadowFold(dir, row('skipped'));
    appendShadowFold(dir, row('aborted', { reason: 'no-judge' }));
    const s = summarizeShadowFolds(readShadowFolds(dir));
    expect(s).toMatchObject({ graded: 4, exit: { needed: PHASE2_EXIT_FOLDS, reached: false }, wouldRollBack: 1, protectedLost: 1, reasons: { 'not-sampled': 1, 'no-judge': 1 }, byEngine: { 'claude-code': 4 } });
    expect(s.lostRate).toBeCloseTo(5 / 32, 4);
    expect(fs.statSync(path.join(dir, 'state', 'context-layers', '_fold-shadow', 'folds.jsonl')).mode & 0o777).toBe(0o600);
  });

  it('writes codes only: detail text after a reason, and non-code list entries, never reach the log', () => {
    const dir = stateDir();
    appendShadowFold(dir, { at: 1, topicKey: T, foldId: 'f', engine: 'claude-code', outcome: 'aborted', reason: 'answerer-unparseable: the operator said Never cut an operator quote', handoff: { deficiencies: ['span-overlap', 'finished[0] overlaps finished[1] with words'], relabels: 0, sendBacks: 0, demoted: 0 }, packet: { bytes: 1, problems: ['still-needed-missing', 'Never cut an operator quote.'] } });
    appendShadowFold(dir, { at: 2, topicKey: T, foldId: 'g', engine: 'claude-code', outcome: 'skipped', reason: 'Some Operator Words' });
    appendShadowFold(dir, { at: 3, topicKey: T, foldId: 'h', engine: 'claude-code', outcome: 'skipped', reason: 'not-clean: mid-turn' });
    const raw = fs.readFileSync(path.join(dir, 'state', 'context-layers', '_fold-shadow', 'folds.jsonl'), 'utf-8');
    expect(raw).not.toMatch(/operator said|Never cut|with words|Some Operator/);
    const rows = readShadowFolds(dir);
    expect(rows.map((r) => r.reason)).toEqual(['answerer-unparseable', 'redacted', 'not-clean: mid-turn']);
    expect(rows[0].handoff!.deficiencies).toEqual(['span-overlap']);
    expect(rows[0].packet!.problems).toEqual(['still-needed-missing']);
    // A single plain word (or a secret) is never a code.
    appendShadowFold(dir, { at: 4, topicKey: T, foldId: 'i', engine: 'claude-code', outcome: 'aborted', reason: 'password', packet: { bytes: 1, problems: ['hunter2', 'oversize'] } });
    const last = readShadowFolds(dir).pop()!;
    expect(last.reason).toBe('redacted');
    expect(last.packet!.problems).toEqual(['oversize']);
  });

  it('rotates one segment and still reads both; a torn line is skipped; empty reads empty', () => {
    const dir = stateDir();
    expect(summarizeShadowFolds(readShadowFolds(dir))).toMatchObject({ graded: 0, lostRate: null, medianDurationMs: null });
    appendShadowFold(dir, row('graded'), 10);
    appendShadowFold(dir, row('graded'), 10); // the first segment is over 10 bytes: rotated
    fs.appendFileSync(path.join(dir, 'state', 'context-layers', '_fold-shadow', 'folds.jsonl'), '{torn');
    expect(readShadowFolds(dir)).toHaveLength(2);
    expect(FOLD_SHADOW_LOG_MAX_BYTES).toBe(2 * 1024 * 1024);
  });
});

describe('buildHandoffRequest', () => {
  it('is marked internal, carries a bounded message index, and asks for the parseable schema', () => {
    const messages = Array.from({ length: HANDOFF_INDEX_MAX + 5 }, (_, i) => ({ messageId: i + 1, at: '2026-11-20T10:00:00Z', fromUser: i % 2 === 0, text: `message ${i + 1} ${'x'.repeat(200)}` }));
    const p = buildHandoffRequest({ foldId: 'fold-1', messages, questions: ['Is PR #3043 merged?'] });
    expect(p.startsWith('[internal: context-budget handoff request, fold fold-1;')).toBe(true);
    expect(p).not.toContain('#1 '); // the oldest five fell off the bounded index
    expect(p).toContain(`#${HANDOFF_INDEX_MAX + 5} `);
    expect(p).toContain('- Is PR #3043 merged?');
    // The schema line it asks for parses as a handoff once filled in.
    const example = p.split('\n').pop()!.replace(/"background":"none\|paused\|live"/, '"background":"none"').replace(/"origin":"user\|agent\|tool"/, '"origin":"agent"').replace(/"kind":"decision\|evolution"/, '"kind":"decision"');
    expect(parseHandoff(example).ok).toBe(true);
  });
});

describe('the switch', () => {
  it('contextBudget.fold.shadow is dev-gated (live on a dev agent, dark on the fleet)', () => {
    expect(DEV_GATED_FEATURES.find((f) => f.configPath === 'contextBudget.fold.shadow')?.name).toBe('contextBudgetFoldShadow');
  });
});
