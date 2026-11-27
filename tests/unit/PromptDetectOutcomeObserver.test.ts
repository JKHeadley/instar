/**
 * CMT-1677 — terminal-input outcome label for PromptGate's prompt-detect.
 * Each outcome kind on both sides of its boundary, the session cap, the
 * flag-off byte-identity, and the retired-id alias read.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  PromptDetectOutcomeObserver,
  TERMINAL_PROMPT_PROGRESSED_RULE_ID,
  TERMINAL_PROMPT_UNRESOLVED_RULE_ID,
  type PromptDetectOutcome,
} from '../../src/monitoring/PromptDetectOutcomeObserver.js';
import { InputDetector, PROMPT_GATE_LLM_DETECT_PROMPT_ID, paneBottomFingerprint } from '../../src/monitoring/PromptGate.js';
import { buildPromptJevFirst, promptDetectState } from '../../src/core/JevFirstPrompt.js';
import { DP_TERMINAL_PROMPT_DETECT, TERMINAL_PROMPT_OUTCOME_HORIZON_MS } from '../../src/data/provenanceCoverage.js';
import { mergeAliasedPointStats } from '../../src/server/routes.js';

const H = TERMINAL_PROMPT_OUTCOME_HORIZON_MS;

function rig(opts: { maxSessions?: number; annotate?: (a: any) => any } = {}) {
  let t = 1_000_000;
  const annotations: any[] = [];
  const outcomes: PromptDetectOutcome[] = [];
  const obs = new PromptDetectOutcomeObserver({
    annotate: opts.annotate ?? ((a) => { annotations.push(a); return { applied: true }; }),
    now: () => t,
    maxSessions: opts.maxSessions,
    onOutcome: (o) => outcomes.push(o),
  });
  return { obs, annotations, outcomes, advance: (ms: number) => { t += ms; } };
}

describe('PromptDetectOutcomeObserver outcome kinds', () => {
  it('progressed-without-input: a changed bottom grades the incumbent; an unchanged one records nothing', () => {
    for (const [verdict, grade] of [['no-prompt', 'right'], ['blocking', 'wrong'], ['unknown', 'unknown']] as const) {
      const r = rig();
      r.obs.track({ sessionName: 's', correlationId: 'd-m_1', bottomFingerprint: 'A' });
      r.obs.setIncumbent('s', 'd-m_1', verdict);
      r.obs.onPane('s', 'A'); // same bottom: not progressed
      expect(r.annotations).toHaveLength(0);
      r.obs.onPane('s', 'B');
      expect(r.annotations).toHaveLength(1);
      expect(r.annotations[0]).toMatchObject({
        correlationId: 'd-m_1', ruleId: TERMINAL_PROMPT_PROGRESSED_RULE_ID, grade,
        gradedBy: { component: 'PromptGate' }, decisionPoint: DP_TERMINAL_PROMPT_DETECT,
        evidence: { outcomeKind: 'progressed-without-input', evidenceClass: 'tool', incumbent: verdict },
      });
      expect(r.obs.size()).toBe(0);
    }
  });

  it('input-while-unchanged: input before any change is candidate evidence (unknown); input after a change adds nothing', () => {
    const a = rig();
    a.obs.track({ sessionName: 's', correlationId: 'd-m_1', bottomFingerprint: 'A' });
    a.obs.setIncumbent('s', 'd-m_1', 'blocking');
    a.obs.onPane('s', 'A');
    a.obs.onInput('s');
    expect(a.annotations).toHaveLength(1);
    expect(a.annotations[0]).toMatchObject({ ruleId: TERMINAL_PROMPT_UNRESOLVED_RULE_ID, grade: 'unknown',
      evidence: { outcomeKind: 'input-while-unchanged', evidenceClass: 'candidate' } });

    const b = rig();
    b.obs.track({ sessionName: 's', correlationId: 'd-m_2', bottomFingerprint: 'A' });
    b.obs.setIncumbent('s', 'd-m_2', 'no-prompt');
    b.obs.onPane('s', 'B');
    b.obs.onInput('s');
    expect(b.annotations).toHaveLength(1);
    expect(b.annotations[0].evidence.outcomeKind).toBe('progressed-without-input');
  });

  it('unchanged-no-input: closes exactly at the 15-minute horizon, not before', () => {
    const r = rig();
    r.obs.track({ sessionName: 's', correlationId: 'd-m_1', bottomFingerprint: 'A' });
    r.advance(H - 1);
    r.obs.sweep();
    expect(r.annotations).toHaveLength(0);
    r.advance(1);
    r.obs.onPane('other', 'X'); // any capture sweeps every session
    expect(r.annotations).toHaveLength(1);
    expect(r.annotations[0]).toMatchObject({ grade: 'unknown',
      evidence: { outcomeKind: 'unchanged-no-input', evidenceClass: 'unresolved', elapsedMs: H, horizonMs: H } });
  });

  it('a change after the horizon is not read as progress', () => {
    const r = rig();
    r.obs.track({ sessionName: 's', correlationId: 'd-m_1', bottomFingerprint: 'A' });
    r.obs.setIncumbent('s', 'd-m_1', 'no-prompt');
    r.advance(H);
    r.obs.onPane('s', 'B');
    expect(r.annotations).toHaveLength(1);
    expect(r.annotations[0].evidence.outcomeKind).toBe('unchanged-no-input');
  });

  it('session-ended and dispose record unresolved rows; an untracked session records nothing', () => {
    const r = rig();
    r.obs.onSessionEnded('nobody');
    expect(r.annotations).toHaveLength(0);
    r.obs.track({ sessionName: 's', correlationId: 'd-m_1', bottomFingerprint: 'A' });
    r.obs.onSessionEnded('s');
    r.obs.track({ sessionName: 't', correlationId: 'd-m_2', bottomFingerprint: 'A' });
    r.obs.dispose();
    expect(r.annotations.map((a) => a.evidence.outcomeKind)).toEqual(['session-ended', 'observer-lost']);
    expect(r.annotations[1].evidence.lostReason).toBe('disposed');
    expect(r.annotations.every((a) => a.grade === 'unknown')).toBe(true);
  });

  it('a new snapshot for the same session supersedes the old one as observer-lost; the same id is idempotent', () => {
    const r = rig();
    r.obs.track({ sessionName: 's', correlationId: 'd-m_1', bottomFingerprint: 'A' });
    r.obs.track({ sessionName: 's', correlationId: 'd-m_1', bottomFingerprint: 'A' });
    expect(r.annotations).toHaveLength(0);
    r.obs.track({ sessionName: 's', correlationId: 'd-m_2', bottomFingerprint: 'A' });
    expect(r.annotations).toEqual([expect.objectContaining({ correlationId: 'd-m_1',
      evidence: expect.objectContaining({ outcomeKind: 'observer-lost', lostReason: 'superseded' }) })]);
    expect(r.obs.size()).toBe(1);
  });

  it('is bounded: past the cap the oldest session is dropped with an observer-lost row', () => {
    const r = rig({ maxSessions: 2 });
    r.obs.track({ sessionName: 'a', correlationId: 'd-m_a', bottomFingerprint: 'A' });
    r.obs.track({ sessionName: 'b', correlationId: 'd-m_b', bottomFingerprint: 'A' });
    expect(r.annotations).toHaveLength(0);
    r.obs.track({ sessionName: 'c', correlationId: 'd-m_c', bottomFingerprint: 'A' });
    expect(r.obs.size()).toBe(2);
    expect(r.annotations).toEqual([expect.objectContaining({ correlationId: 'd-m_a',
      evidence: expect.objectContaining({ outcomeKind: 'observer-lost', lostReason: 'evicted' }) })]);
  });

  it('an event before the verdict is held and recorded WITH the verdict, at the event time (first event wins)', () => {
    const r = rig();
    r.obs.track({ sessionName: 's', correlationId: 'd-m_1', bottomFingerprint: 'A' });
    r.advance(500);
    r.obs.onPane('s', 'B'); // pane moved while the incumbent call was still running
    r.advance(500);
    r.obs.onInput('s'); // later event ignored: first wins
    expect(r.annotations).toHaveLength(0);
    r.advance(2_000);
    r.obs.setIncumbent('s', 'd-m_1', 'no-prompt');
    expect(r.annotations).toHaveLength(1);
    expect(r.annotations[0]).toMatchObject({ grade: 'right', ruleId: TERMINAL_PROMPT_PROGRESSED_RULE_ID,
      evidence: { outcomeKind: 'progressed-without-input', incumbent: 'no-prompt', elapsedMs: 500 } });
    r.obs.setIncumbent('s', 'd-m_1', 'blocking'); // a second settle is ignored
    expect(r.annotations).toHaveLength(1);
  });

  it('a failed incumbent call records a held event ungraded; a verdict that never comes closes at the horizon', () => {
    const a = rig();
    a.obs.track({ sessionName: 's', correlationId: 'd-m_1', bottomFingerprint: 'A' });
    a.obs.onPane('s', 'B');
    a.obs.setIncumbent('s', 'd-m_1', 'unknown');
    expect(a.annotations[0]).toMatchObject({ grade: 'unknown', evidence: { outcomeKind: 'progressed-without-input', incumbent: 'unknown' } });

    const b = rig();
    b.obs.track({ sessionName: 's', correlationId: 'd-m_2', bottomFingerprint: 'A' });
    b.advance(1_000);
    b.obs.onInput('s');
    b.advance(H);
    b.obs.sweep();
    expect(b.annotations).toHaveLength(1);
    expect(b.annotations[0]).toMatchObject({ grade: 'unknown', evidence: { outcomeKind: 'input-while-unchanged', elapsedMs: 1_000 } });
  });

  it('never fabricates a join key and never throws when the chokepoint does', () => {
    const r = rig({ annotate: () => { throw new Error('disk'); } });
    r.obs.track({ sessionName: 's', correlationId: '', bottomFingerprint: 'A' });
    expect(r.obs.size()).toBe(0);
    r.obs.track({ sessionName: 's', correlationId: 'd-m_1', bottomFingerprint: 'A' });
    r.obs.setIncumbent('s', 'd-m_1', 'no-prompt');
    expect(() => r.obs.onPane('s', 'B')).not.toThrow();
    expect(r.obs.counters.annotateErrors).toBe(1);
  });

  it('evidence is content-free (ids, enums and numbers only)', () => {
    const r = rig();
    r.obs.track({ sessionName: 's', correlationId: 'd-m_1', bottomFingerprint: 'secretpane' });
    r.obs.setIncumbent('s', 'd-m_1', 'blocking');
    r.obs.onPane('s', 'otherpane');
    expect(JSON.stringify(r.annotations[0])).not.toContain('pane');
  });
});

// ── PromptGate wiring ─────────────────────────────────────────────────────

const IDLE = 'Done with the change.\n❯ \n';

async function settle(detector: InputDetector): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  await detector.lastJevShadow;
}

function gate(stage: 'off' | 'shadow') {
  const rows: any[] = [];
  const annotations: any[] = [];
  const evaluate = vi.fn(async (_prompt: string, opts: any) => {
    opts?.provenance?.onCorrelationId?.('d-m_test1');
    return 'NO_PROMPT';
  });
  const { gateway, getPoint } = buildPromptJevFirst({
    stateDir: '/nonexistent', developmentAgent: true,
    readConfig: () => ({ enabled: stage !== 'off', stage }),
    provenance: () => ({ recordDecisionFlushed: (row: any) => { rows.push(row); return `row-${rows.length}`; } }) as any,
    readKey: () => 'k', askJev: async () => ({ model: 'jev-1.13.0', probability: 0.03, ms: 5 }),
  });
  const observer = new PromptDetectOutcomeObserver({ annotate: (a) => { annotations.push(a); return { applied: true }; } });
  const detector = new InputDetector({ detectionWindowLines: 50, enabled: true, intelligence: { evaluate } as any,
    jevFirst: gateway, getJevPoint: getPoint, jevState: promptDetectState, outcomeObserver: observer });
  return { detector, evaluate, rows, annotations, observer };
}

async function snapshot(detector: InputDetector, session: string, pane: string): Promise<void> {
  detector.onCapture(session, pane);
  detector.onCapture(session, pane);
  detector.onCapture(session, pane);
  await settle(detector);
}

describe('PromptGate × outcome observer', () => {
  it('gate on: Jev row carries the producer correlation id and session; a pane change records progressed-without-input', async () => {
    const g = gate('shadow');
    await snapshot(g.detector, 'echo-s1', IDLE);
    expect(g.evaluate).toHaveBeenCalledOnce();
    expect(g.evaluate.mock.calls[0][1].provenance).toMatchObject({ decisionPoint: DP_TERMINAL_PROMPT_DETECT, promptId: PROMPT_GATE_LLM_DETECT_PROMPT_ID });
    expect(PROMPT_GATE_LLM_DETECT_PROMPT_ID).toBe('terminal-prompt-detect-v1');
    expect(g.rows).toHaveLength(1);
    expect(g.rows[0].producerCorrelationId).toBe('d-m_test1');
    expect(g.rows[0].context.sessionName).toBe('echo-s1');
    expect(g.rows[0].context.producerCorrelationId).toBeUndefined();
    expect(g.observer.size()).toBe(1);
    g.detector.onCapture('echo-s1', 'Now working on the next step\n' + IDLE);
    expect(g.annotations).toEqual([expect.objectContaining({ correlationId: 'd-m_test1', grade: 'right',
      evidence: expect.objectContaining({ outcomeKind: 'progressed-without-input', incumbent: 'no-prompt' }) })]);
  });

  it('gate on: input through the session write guard before any change is input-while-unchanged', async () => {
    const g = gate('shadow');
    await snapshot(g.detector, 'echo-s1', IDLE);
    g.detector.noteSessionInput('echo-s1');
    expect(g.annotations[0].evidence.outcomeKind).toBe('input-while-unchanged');
  });

  it('gate on: session cleanup records session-ended', async () => {
    const g = gate('shadow');
    await snapshot(g.detector, 'echo-s1', IDLE);
    g.detector.cleanup('echo-s1');
    expect(g.annotations[0].evidence.outcomeKind).toBe('session-ended');
  });

  it('gate off: no callback is added, nothing is tracked, no row or outcome is written', async () => {
    const g = gate('off');
    await snapshot(g.detector, 'echo-s1', IDLE);
    expect(g.evaluate).toHaveBeenCalledOnce();
    const provenance = g.evaluate.mock.calls[0][1].provenance;
    expect(Object.keys(provenance).sort()).toEqual(['context', 'decisionPoint', 'optionsPresented', 'promptId']);
    expect(g.rows).toHaveLength(0);
    expect(g.observer.size()).toBe(0);
    g.detector.onCapture('echo-s1', 'changed\n' + IDLE);
    g.detector.noteSessionInput('echo-s1');
    expect(g.annotations).toHaveLength(0);
  });

  it('paneBottomFingerprint looks only at the last five lines', () => {
    const base = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(paneBottomFingerprint(['zzz', ...base.slice(1)])).toBe(paneBottomFingerprint(base));
    expect(paneBottomFingerprint([...base.slice(0, 5), 'g'])).not.toBe(paneBottomFingerprint(base));
  });
});

describe('retired decision-point alias on the /decision-quality read', () => {
  it('repartitions history recorded under prompt-injection-detect into terminal-prompt-detect', () => {
    const merged = mergeAliasedPointStats([
      { decisionPoint: 'prompt-injection-detect', decisions: 70, models: ['haiku'], frameworks: ['claude'], promptIds: ['prompt-injection-detect-v1'] },
      { decisionPoint: 'terminal-prompt-detect', decisions: 3, models: ['haiku'], frameworks: ['claude'], promptIds: ['terminal-prompt-detect-v1'] },
      { decisionPoint: 'messaging-tone-gate', decisions: 5, models: [], frameworks: [], promptIds: [] },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.find((m) => m.decisionPoint === 'terminal-prompt-detect')).toEqual({
      decisionPoint: 'terminal-prompt-detect', decisions: 73, models: ['haiku'], frameworks: ['claude'],
      promptIds: ['prompt-injection-detect-v1', 'terminal-prompt-detect-v1'],
    });
    expect(merged.some((m) => m.decisionPoint === 'prompt-injection-detect')).toBe(false);
  });
});

describe('JudgmentProvenanceLog producerCorrelationId', () => {
  it('stores a well-formed seam id top-level and drops anything else', async () => {
    const { validProducerCorrelationId } = await import('../../src/core/JudgmentProvenanceLog.js');
    expect(validProducerCorrelationId('d-1b2c3d4e-0000-4000-8000-000000000000')).toBe('d-1b2c3d4e-0000-4000-8000-000000000000');
    expect(validProducerCorrelationId('b-abc12345-x')).toBe('b-abc12345-x');
    for (const bad of ['', 'x-123', 'd-', 'd-has space', 'd-' + 'a'.repeat(101), 42, null, undefined]) {
      expect(validProducerCorrelationId(bad)).toBeUndefined();
    }
  });
});
