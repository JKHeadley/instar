/**
 * machineWedgeJudge parser contract (LLM_PARSER_CONTRACT for MachineWedgeJudge) and its
 * call shape: attributed, provenance-enrolled, structured evidence only, a bounded space
 * of four, and a null answer for anything else. Also the dry-run notice text and its
 * governor-gated sender.
 */
import { describe, expect, it } from 'vitest';
import {
  MACHINE_WEDGE_JUDGE_COMPONENT, MACHINE_WEDGE_JUDGE_PROMPT_ID, buildMachineWedgeDecisionContext, buildMachineWedgePrompt, makeMachineWedgeJudge, parseMachineWedgeAnswer,
} from '../../src/monitoring/MachineWedgeJudge.js';
import { deriveTargetKey, makeWedgeNoticeSender, wedgeNoticeItem } from '../../src/monitoring/MachineWedgeNotice.js';
import { DP_MACHINE_WEDGE_JUDGE, getCensusEntry } from '../../src/data/provenanceCoverage.js';
import type { WedgeJudgeEvidence, WedgeNoticeInput } from '../../src/monitoring/machineMaintenance/WedgeMonitor.js';
import type { IntelligenceOptions, IntelligenceProvider } from '../../src/core/types.js';

const evidence: WedgeJudgeEvidence = {
  pair: 'F2+F4',
  families: {
    F1: { result: 'unknown', reason: 'canary-not-installed', ageMinutes: 0 },
    F2: { result: 'positive', reason: 'ps-timed-out', ageMinutes: 0 },
    F3: { result: 'not-covered', reason: 'dialog-probe-not-built', ageMinutes: null },
    F4: { result: 'positive', reason: 'impaired-while-idle', ageMinutes: 0 },
  },
  windowMinutes: 20, observations: 11, uptimeHours: 72, recentlyRestarted: false, sessionsCount: 4, blockers: ['enrolment-not-built'],
};

describe('parseMachineWedgeAnswer (parser contract)', () => {
  it('accepts each of the four actions, with a clamped one-line reason', () => {
    for (const action of ['leave', 'gentle', 'restart-next-window', 'restart-now']) {
      expect(parseMachineWedgeAnswer(`{"action":"${action}","reason":"ok"}`)).toEqual({ action, reason: 'ok' });
    }
    expect(parseMachineWedgeAnswer('Sure.\n{"action":"gentle","reason":"a\\nb   c"} trailing')).toEqual({ action: 'gentle', reason: 'a b c' });
    expect(parseMachineWedgeAnswer(`{"action":"leave","reason":"${'x'.repeat(500)}"}`)!.reason).toHaveLength(200);
    expect(parseMachineWedgeAnswer('{"action":"leave"}')).toEqual({ action: 'leave', reason: '' });
  });

  it('refuses anything outside the bounded space: null, never a guess', () => {
    for (const raw of ['', 'restart-now', '{"action":"reboot"}', '{"action":"RESTART-NOW"}', '{"action":1}', '{not json}', 'no braces']) {
      expect(parseMachineWedgeAnswer(raw), raw).toBeNull();
    }
    expect(parseMachineWedgeAnswer(undefined as unknown as string)).toBeNull();
  });
});

describe('the prompt and the provenance context', () => {
  it('the prompt carries the structured evidence and names the four actions', () => {
    const p = buildMachineWedgePrompt(evidence);
    expect(p).toContain('"pair":"F2+F4"');
    for (const a of ['leave', 'gentle', 'restart-next-window', 'restart-now']) expect(p).toContain(a);
    expect(p).toMatch(/unknown, ineligible or not-covered means that family could not be read/);
  });

  it('the provenance context is identity and numbers only', () => {
    const ctx = buildMachineWedgeDecisionContext(evidence, buildMachineWedgePrompt(evidence));
    expect(ctx).toMatchObject({ pair: 'F2+F4', observations: 11, windowMinutes: 20, sessionsCount: 4, blockerCount: 1 });
    expect(String(ctx.promptIdentitySha256)).toMatch(/^sha256:/);
    expect(JSON.stringify(ctx)).not.toContain('ps-timed-out');
  });

  it('is enrolled in the Decision Quality census as a wired, budgeted, measurement-only point', () => {
    expect(getCensusEntry(DP_MACHINE_WEDGE_JUDGE)).toMatchObject({ component: 'MachineWedgeJudge', status: 'wired', volumeClass: 'budget:20', gradingPosture: 'measurement-only' });
  });
});

describe('makeMachineWedgeJudge', () => {
  it('no provider: no judge, so the caller records the fallback', () => {
    expect(makeMachineWedgeJudge(null)).toBeNull();
  });

  it('calls the provider once with attribution and provenance, and parses its answer', async () => {
    const calls: Array<{ prompt: string; opts: IntelligenceOptions | undefined }> = [];
    const provider: IntelligenceProvider = { evaluate: async (prompt, opts) => { calls.push({ prompt, opts }); return '{"action":"restart-next-window","reason":"two families for 20 min"}'; } };
    const judge = makeMachineWedgeJudge(provider)!;
    expect(await judge(evidence)).toEqual({ action: 'restart-next-window', reason: 'two families for 20 min' });
    expect(calls).toHaveLength(1);
    expect(calls[0].opts).toMatchObject({ attribution: { component: MACHINE_WEDGE_JUDGE_COMPONENT }, provenance: { decisionPoint: DP_MACHINE_WEDGE_JUDGE, promptId: MACHINE_WEDGE_JUDGE_PROMPT_ID, optionsPresented: ['leave', 'gentle', 'restart-next-window', 'restart-now'] } });
  });

  it('an unusable answer is null; a provider error propagates for the caller to record', async () => {
    expect(await makeMachineWedgeJudge({ evaluate: async () => 'restart it' })!(evidence)).toBeNull();
    await expect(makeMachineWedgeJudge({ evaluate: async () => { throw new Error('down'); } })!(evidence)).rejects.toThrow('down');
  });
});

describe('the dry-run notice', () => {
  const input: WedgeNoticeInput = { episodeId: 'm1:F2+F4:1', machineId: 'm1', pair: 'F2+F4', reasons: ['ps-timed-out', 'impaired-while-idle'], proposal: 'gentle', recentlyRestarted: false, critical: false, forcedDueAt: null };

  it('says plainly that nothing was done and that the restart button is not built; reason codes become words', () => {
    const item = wedgeNoticeItem(input, 'Mac Studio');
    expect(item).toMatchObject({ id: 'machine-wedge:m1:F2+F4:1', title: 'Mac Studio looks wedged', priority: 'NORMAL', sourceContext: 'machine-maintenance' });
    expect(item.description).toMatch(/Nothing has been done automatically/);
    expect(item.description).toMatch(/restart button is not built yet/);
    expect(item.summary).toContain('listing processes timed out');
    expect(wedgeNoticeItem({ ...input, critical: true }, 'X').priority).toBe('HIGH');
  });

  it('sends once per episode through the governor; no channel is reported, not faked', async () => {
    const sent: unknown[] = [];
    const send = makeWedgeNoticeSender({ createAttentionItem: async (i) => { sent.push(i); }, machineLabel: () => 'Studio' });
    const first = await send(input);
    expect(['sent', 'held-by-governor']).toContain(first);
    expect(await send(input)).toBe(first === 'sent' ? 'duplicate' : 'held-by-governor');
    expect(sent.length).toBeLessThanOrEqual(1);
    expect(await makeWedgeNoticeSender({ createAttentionItem: null, machineLabel: () => 'x' })(input)).toBe('no-channel');
    expect(deriveTargetKey('m1')).toEqual({ key: 'machine-wedge-notice:m1', classId: 'machine-wedge-notice', keyIsVolatile: false });
  });
});
