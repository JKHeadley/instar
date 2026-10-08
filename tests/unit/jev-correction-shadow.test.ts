/**
 * jev-correction-shadow — unit tier. Spec: docs/specs/jev-correction-shadow.md.
 *
 * The module in isolation with its real scrubber, real Layer-0 classifier and a
 * stubbed vendor fetch: what is sent, what is logged (content-free), every skip
 * reason, the bounds, the live kill switch and the dev gate on both sides.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  JevCorrectionShadow,
  buildJevCorrectionShadow,
  renderCorrectionState,
  correctionQuestions,
  summarizeCorrectionLog,
  CORRECTION_MODEL,
  CORRECTION_CRITERIA,
  MAX_TOPICS,
  type JevCorrectionShadowDeps,
} from '../../src/core/JevCorrectionShadow.js';
import { HumanAsDetectorLog } from '../../src/monitoring/HumanAsDetectorLog.js';

const realLayer0 = (t: string) => HumanAsDetectorLog.getInstance().classify(t);

function tmpLog(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-correction-unit-'));
  return path.join(root, 'logs', 'jev-correction-shadow.jsonl');
}

function answer(p: Record<string, number>, model = CORRECTION_MODEL, rev?: Record<string, number>) {
  const choice = Object.entries(p).sort((a, b) => b[1] - a[1])[0][0];
  const r = rev ?? p;
  const choiceRev = Object.entries(r).sort((a, b) => b[1] - a[1])[0][0];
  return {
    ok: true,
    status: 200,
    json: async () => ({ model, usage: { input_tokens: 420 }, answers: { kind: { choice, probabilities: p }, kind_rev: { choice: choiceRev, probabilities: r } } }),
  } as unknown as Response;
}

function make(over: Partial<JevCorrectionShadowDeps> = {}, p: Record<string, number> = { correction: 0.9, preference: 0.05, neither: 0.05, cannot_tell: 0 }) {
  const logPath = over.logPath ?? tmpLog();
  const fetchImpl = vi.fn(async () => answer(p));
  const metrics = { record: vi.fn() };
  const shadow = new JevCorrectionShadow({
    getConfig: () => ({ enabled: true }),
    readKey: () => 'test-key',
    layer0: realLayer0,
    logPath,
    metrics,
    fetchImpl: fetchImpl as never,
    ...over,
  });
  const rows = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { shadow, fetchImpl: (over.fetchImpl as unknown as typeof fetchImpl) ?? fetchImpl, metrics, logPath, rows };
}

const USER = { topicId: 7, messageId: 101, fromUser: true, provenance: 'user' };
const AGENT = { topicId: 7, fromUser: false, provenance: 'agent' };

describe('renderCorrectionState — what leaves the machine', () => {
  it('carries the user message and the tail of the previous agent message, labelled', () => {
    const s = renderCorrectionState('No, that is wrong — undo it.', 'I deployed the change to production.')!;
    expect(s).toContain('AGENT MESSAGE (context only):\nI deployed the change to production.');
    expect(s).toContain('USER MESSAGE (classify this one):\nNo, that is wrong — undo it.');
  });

  it('marks a missing previous message as (none)', () => {
    expect(renderCorrectionState('hi', '')).toContain('AGENT MESSAGE (context only):\n(none)');
  });

  it('keeps the head of a long user message and the tail of a long agent message (code points)', () => {
    const s = renderCorrectionState('A'.repeat(1499) + '😀' + 'Z'.repeat(50), 'x'.repeat(5000) + 'END')!;
    expect(s).toContain('A'.repeat(1499) + '😀\n'.slice(0, 2));
    expect(s).not.toContain('ZZ');
    expect(s).toContain('xEND');
  });

  it('scrubs secrets in both fields before any cut', () => {
    const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    const s = renderCorrectionState(`here is the key ${token} use it`, `my token was sk-ant-api03-${'Q'.repeat(60)} ok`)!;
    expect(s).not.toContain(token);
    expect(s).not.toContain('Q'.repeat(30));
  });

  it('a secret straddling the user cut is redacted, not half-sent', () => {
    const token = 'ghp_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2';
    const s = renderCorrectionState('w '.repeat(740) + token + ' tail', '')!;
    expect(s).not.toContain('ghp_Z9y8');
    expect(s).not.toMatch(/Z9y8X7w6V5u4/);
  });

  it('withholds a field showing a private-key marker', () => {
    const s = renderCorrectionState('-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', '')!;
    expect(s).toContain('USER MESSAGE (classify this one):\n[REDACTED]');
    expect(s).not.toContain('MIIEow');
  });
});

describe('the question', () => {
  it('has four options including cannot_tell, asked in both orders; never a count', () => {
    const q = correctionQuestions();
    expect(Object.keys(q.kind.criteria)).toEqual(['correction', 'preference', 'neither', 'cannot_tell']);
    expect(Object.keys(q.kind_rev.criteria)).toEqual(['cannot_tell', 'neither', 'preference', 'correction']);
    expect(q.kind.type).toBe('choice');
    expect(JSON.stringify(q)).not.toMatch(/how many|count/i);
    expect(CORRECTION_CRITERIA.cannot_tell).toBeTruthy();
  });

  it('sends the pinned model, the questions and the scrubbed state with the key as a bearer token', async () => {
    const m = make();
    m.shadow.observe({ ...AGENT, text: 'Done: I removed the PIN step.' });
    m.shadow.observe({ ...USER, text: 'You removed the wrong one, put it back.' });
    await m.shadow.lastCheck;
    expect(m.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = m.fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('jev-1.13.0');
    expect(body.questions).toEqual(correctionQuestions());
    expect(body.state).toContain('Done: I removed the PIN step.');
    expect(body.state).toContain('You removed the wrong one, put it back.');
  });
});

describe('observe — rows', () => {
  it('logs a content-free row with Jev probabilities, the Layer-0 verdict and agreement', async () => {
    const m = make();
    const text = 'Stop asking me to approve every fix, this is really frustrating.';
    m.shadow.observe({ ...AGENT, text: 'Shall I wait for your approval?' });
    m.shadow.observe({ ...USER, text });
    await m.shadow.lastCheck;
    const [row] = m.rows();
    expect(row).toMatchObject({
      kind: 'check', topic: 7, messageId: 101, chars: Array.from(text).length,
      hadContext: true, label: 'correction', confidence: 0.9, pCorrection: 0.9, pPreference: 0.05, pNeither: 0.05, pCannotTell: 0,
      labelRev: 'correction', jevFlag: true,
    });
    const l0 = realLayer0(text);
    expect(row.layer0).toEqual({ signal: l0?.learningKind != null, kind: l0?.learningKind ?? null, weight: l0?.deterministicWeight ?? 0 });
    expect(row.agree).toBe(row.jevFlag === row.layer0.signal);
    const raw = fs.readFileSync(m.logPath, 'utf8');
    expect(raw).not.toContain('approve every fix');
    expect(raw).not.toContain('Shall I wait');
  });

  it('a correction Layer-0 cannot see is logged as a disagreement (the recall gap)', async () => {
    const m = make();
    const text = 'These are not critical things that need my approval. Please carry on.';
    expect(realLayer0(text)?.learningKind ?? null).toBeNull();
    m.shadow.observe({ ...USER, text });
    await m.shadow.lastCheck;
    expect(m.rows()[0]).toMatchObject({ jevFlag: true, layer0: { signal: false }, agree: false, hadContext: false });
  });

  it('flag threshold on P(correction)+P(preference): 0.5 flags, 0.49 does not; a split vote still flags', async () => {
    const a = make({}, { correction: 0.2, preference: 0.3, neither: 0.5, cannot_tell: 0 });
    a.shadow.observe({ ...USER, text: 'From now on keep it short.' });
    await a.shadow.lastCheck;
    expect(a.rows()[0]).toMatchObject({ jevFlag: true });

    const b = make({}, { correction: 0.2, preference: 0.29, neither: 0.51, cannot_tell: 0 });
    b.shadow.observe({ ...USER, text: 'From now on keep it short.' });
    await b.shadow.lastCheck;
    expect(b.rows()[0]).toMatchObject({ label: 'neither', jevFlag: false });

    // Recorded backfill shape: Jev split a clear correction across the two labels.
    const c = make({}, { correction: 0.49, neither: 0.03, preference: 0.48, cannot_tell: 0 });
    c.shadow.observe({ ...USER, text: 'x' });
    await c.shadow.lastCheck;
    expect(c.rows()[0]).toMatchObject({ jevFlag: true });

    const d = make({}, { correction: 0.1, preference: 0.1, neither: 0.1, cannot_tell: 0.7 });
    d.shadow.observe({ ...USER, text: 'hm' });
    await d.shadow.lastCheck;
    expect(d.rows()[0]).toMatchObject({ label: 'cannot_tell', jevFlag: false, pCannotTell: 0.7 });
  });

  it('replays a real recorded Jev answer shape (2026-10-05 backfill)', async () => {
    const p = { neither: 0.03, cannot_tell: 0, correction: 0.97, preference: 0 };
    const m = make({}, p);
    m.shadow.observe({ ...USER, text: 'x' });
    await m.shadow.lastCheck;
    expect(m.rows()[0]).toMatchObject({ label: 'correction', jevFlag: true, pCorrection: 0.97 });
  });

  it('context: only the last conversational agent message of the same topic; automation and other topics ignored', async () => {
    const m = make();
    m.shadow.observe({ ...AGENT, text: 'first agent reply' });
    m.shadow.observe({ ...AGENT, text: 'second agent reply' });
    m.shadow.observe({ topicId: 7, fromUser: false, provenance: 'automation', text: 'AUTOMATED HEARTBEAT' });
    m.shadow.observe({ topicId: 8, fromUser: false, provenance: 'agent', text: 'OTHER TOPIC' });
    m.shadow.observe({ ...USER, text: 'no' });
    await m.shadow.lastCheck;
    const state = JSON.parse(String((m.fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)).state;
    expect(state).toContain('second agent reply');
    expect(state).not.toContain('first agent reply');
    expect(state).not.toContain('AUTOMATED HEARTBEAT');
    expect(state).not.toContain('OTHER TOPIC');
  });

  it('observe returns before any of the check runs (no vault read, no Layer 0 on the message seam)', async () => {
    const readKey = vi.fn(() => 'k');
    const layer0 = vi.fn(realLayer0);
    const m = make({ readKey, layer0, logPath: tmpLog() });
    readKey.mockClear();
    m.shadow.observe({ ...USER, text: 'wrong' });
    expect(layer0).not.toHaveBeenCalled();
    expect(m.fetchImpl).not.toHaveBeenCalled();
    await m.shadow.lastCheck;
    expect(layer0).toHaveBeenCalledTimes(1);
    expect(m.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stored agent context is scrubbed before it is cut (a long token ending a message never half-leaks)', async () => {
    const m = make();
    const token = 'ghp_' + 'K'.repeat(36);
    const blob = 'eyJhbGciOiJIUzI1NiJ9.' + 'A'.repeat(4000) + '.' + 'B'.repeat(43);
    m.shadow.observe({ ...AGENT, text: 'start ' + token + ' ' + blob });
    m.shadow.observe({ ...USER, text: 'no' });
    await m.shadow.lastCheck;
    const state = JSON.parse(String((m.fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)).state;
    expect(state).not.toContain('KKKKKKKK');
    expect(state).not.toContain('AAAAAAAAAAAAAAAAAAAA');
  });

  it('agent messages and empty user messages never call Jev', async () => {
    const m = make();
    m.shadow.observe({ ...AGENT, text: 'hello' });
    m.shadow.observe({ ...USER, text: '' });
    await m.shadow.lastCheck;
    expect(m.fetchImpl).not.toHaveBeenCalled();
    expect(m.rows()).toEqual([]);
  });

  it('remembers at most MAX_TOPICS agent messages (least recently active dropped)', async () => {
    const m = make();
    for (let t = 0; t <= MAX_TOPICS; t++) m.shadow.observe({ topicId: t, fromUser: false, provenance: 'agent', text: `ctx-${t}` });
    m.shadow.observe({ topicId: 0, messageId: 1, fromUser: true, text: 'no' });
    await m.shadow.lastCheck;
    expect(JSON.parse(String((m.fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)).state).toContain('(none)');
  });

  it('meters every call as feature jev-correction-shadow', async () => {
    const m = make();
    m.shadow.observe({ ...USER, text: 'wrong' });
    await m.shadow.lastCheck;
    expect(m.metrics.record).toHaveBeenCalledWith(expect.objectContaining({ feature: 'jev-correction-shadow', outcome: 'fired', tokensIn: 420, model: 'jev-1.13.0', framework: 'typesafe-api' }));
  });
});

describe('observe — skips, bounds, floors', () => {
  it('disabled: no call, no row', async () => {
    const m = make({ getConfig: () => ({ enabled: false }) });
    m.shadow.observe({ ...USER, text: 'wrong' });
    await m.shadow.lastCheck;
    expect(m.fetchImpl).not.toHaveBeenCalled();
    expect(m.rows()).toEqual([]);
  });

  it('kill switch is read live on the next message', async () => {
    let enabled = true;
    const m = make({ getConfig: () => ({ enabled }) });
    m.shadow.observe({ ...USER, text: 'one' });
    await m.shadow.lastCheck;
    enabled = false;
    m.shadow.observe({ ...USER, text: 'two' });
    await m.shadow.lastCheck;
    expect(m.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('no key: one disabled-no-key row, no call', async () => {
    const m = make({ readKey: () => null });
    m.shadow.observe({ ...USER, text: 'a' });
    await m.shadow.lastCheck;
    m.shadow.observe({ ...USER, text: 'b' });
    await m.shadow.lastCheck;
    expect(m.fetchImpl).not.toHaveBeenCalled();
    expect(m.rows()).toEqual([{ kind: 'skipped', ts: expect.any(String), topic: 7, reason: 'disabled-no-key' }]);
  });

  it('a throwing vault reads as no key', async () => {
    const m = make({ readKey: () => { throw new Error('locked'); } });
    m.shadow.observe({ ...USER, text: 'a' });
    await m.shadow.lastCheck;
    expect(m.rows()[0].reason).toBe('disabled-no-key');
  });

  it('daily cap: seeded from the log so a restart keeps the bound; one cap row per day', async () => {
    const now = () => Date.parse('2026-10-05T12:00:00Z');
    const logPath = tmpLog();
    const first = make({ logPath, now, getConfig: () => ({ enabled: true, maxChecksPerDay: 2 }) });
    for (const t of ['a', 'b', 'c']) { first.shadow.observe({ ...USER, text: t }); await first.shadow.lastCheck; }
    expect(first.fetchImpl).toHaveBeenCalledTimes(2);
    const restarted = make({ logPath, now, getConfig: () => ({ enabled: true, maxChecksPerDay: 2 }) });
    restarted.shadow.observe({ ...USER, text: 'd' });
    await restarted.shadow.lastCheck;
    expect(restarted.fetchImpl).not.toHaveBeenCalled();
    const caps = restarted.rows().filter((r) => r.reason === 'daily-cap');
    expect(caps).toHaveLength(1); // once per day, even across a restart (the note is seeded from the log)
    const nextDay = make({ logPath, now: () => Date.parse('2026-10-06T00:01:00Z'), getConfig: () => ({ enabled: true, maxChecksPerDay: 2 }) });
    nextDay.shadow.observe({ ...USER, text: 'e' });
    await nextDay.shadow.lastCheck;
    expect(nextDay.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('busy: at most two calls in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetchImpl = vi.fn(async () => { await gate; return answer({ correction: 0.9, preference: 0, neither: 0.1, cannot_tell: 0 }); });
    const m = make({ fetchImpl: fetchImpl as never });
    m.shadow.observe({ ...USER, text: 'a' });
    const p1 = m.shadow.lastCheck;
    m.shadow.observe({ ...USER, text: 'b' });
    const p2 = m.shadow.lastCheck;
    m.shadow.observe({ ...USER, text: 'c' });
    await m.shadow.lastCheck;
    release();
    await Promise.all([p1, p2]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(m.rows().filter((r) => r.reason === 'busy')).toHaveLength(1);
  });

  it('http-error, and a 401 drops the cached key', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response);
    const readKey = vi.fn(() => 'k');
    const m = make({ fetchImpl: fetchImpl as never, readKey });
    m.shadow.observe({ ...USER, text: 'a' });
    await m.shadow.lastCheck;
    m.shadow.observe({ ...USER, text: 'b' });
    await m.shadow.lastCheck;
    expect(m.rows().map((r) => r.reason)).toEqual(['http-error', 'disabled-no-key']);
  });

  it('timeout aborts the call and records timeout', async () => {
    const fetchImpl = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_r, rej) => {
      init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const m = make({ fetchImpl: fetchImpl as never, getConfig: () => ({ enabled: true, timeoutMs: 20 }) });
    m.shadow.observe({ ...USER, text: 'a' });
    await m.shadow.lastCheck;
    expect(m.rows()[0].reason).toBe('timeout');
    expect(m.metrics.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error' }));
  });

  it('model-mismatch and no-answers', async () => {
    const a = make({ fetchImpl: vi.fn(async () => answer({ correction: 1 }, 'jev-latest')) as never });
    a.shadow.observe({ ...USER, text: 'a' });
    await a.shadow.lastCheck;
    expect(a.rows()[0].reason).toBe('model-mismatch');
    const b = make({ fetchImpl: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers: {} }) }) as unknown as Response) as never });
    b.shadow.observe({ ...USER, text: 'a' });
    await b.shadow.lastCheck;
    expect(b.rows()[0].reason).toBe('no-answers');
  });

  it('a throwing Layer-0 reads as no signal and never breaks the check', async () => {
    const m = make({ layer0: () => { throw new Error('boom'); } });
    m.shadow.observe({ ...USER, text: 'a' });
    await m.shadow.lastCheck;
    expect(m.rows()[0].layer0).toEqual({ signal: false, kind: null, weight: 0 });
  });

  it('observe never throws, even when config read throws', () => {
    const m = make({ getConfig: () => { throw new Error('x'); } });
    expect(() => m.shadow.observe({ ...USER, text: 'a' })).not.toThrow();
  });
});

describe('summary', () => {
  it('counts Jev flags vs Layer-0 signals, agreement, labels, order flips and skips', () => {
    const logPath = tmpLog();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const base = { kind: 'check', topic: 1, messageId: 1, chars: 1, hadContext: true, confidence: 0.9, pCorrection: 0, pPreference: 0, pNeither: 0, pCannotTell: 0, ms: 1 };
    const rows = [
      { ...base, ts: '2026-10-05T01:00:00Z', label: 'correction', labelRev: 'correction', jevFlag: true, layer0: { signal: true, kind: 'frustration', weight: 3 }, agree: true },
      { ...base, ts: '2026-10-05T02:00:00Z', label: 'preference', labelRev: 'neither', jevFlag: true, layer0: { signal: false, kind: null, weight: 0 }, agree: false },
      { ...base, ts: '2026-10-05T03:00:00Z', label: 'neither', jevFlag: false, layer0: { signal: true, kind: 'preference', weight: 2 }, agree: false },
      { ...base, ts: '2026-10-05T04:00:00Z', label: 'neither', jevFlag: false, layer0: { signal: false, kind: null, weight: 0 }, agree: true },
      { kind: 'skipped', ts: '2026-10-05T05:00:00Z', topic: 1, reason: 'timeout' },
    ];
    fs.writeFileSync(logPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n{torn');
    expect(summarizeCorrectionLog(logPath, true)).toEqual({
      enabled: true, since: '2026-10-05T01:00:00Z', checks: 4, jevFlags: 2, layer0Signals: 2, both: 1, jevOnly: 1, layer0Only: 1,
      agreement: 0.5, labels: { correction: 1, preference: 1, neither: 2 }, orderFlips: 1, skipped: { timeout: 1 },
    });
  });

  it('no log yet: zeros and a null agreement', () => {
    expect(summarizeCorrectionLog(tmpLog(), false)).toMatchObject({ enabled: false, checks: 0, agreement: null });
  });
});

describe('production factory — dev gate both sides, live config', () => {
  function build(developmentAgent: boolean, intel: () => unknown) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-correction-factory-'));
    const fetchImpl = vi.fn(async () => answer({ correction: 0.9, preference: 0, neither: 0.1, cannot_tell: 0 }));
    const shadow = buildJevCorrectionShadow({
      readLiveIntelligence: intel,
      developmentAgent,
      readSecret: (n) => (n === 'typesafe_api_key' ? 'k' : null),
      layer0: realLayer0,
      stateDir: path.join(root, '.instar'),
      fetchImpl: fetchImpl as never,
    });
    return { shadow, fetchImpl, logPath: path.join(root, 'logs', 'jev-correction-shadow.jsonl') };
  }

  it('development agent with enabled omitted: live, logs under <agent>/logs', async () => {
    const b = build(true, () => ({}));
    b.shadow.observe({ ...USER, text: 'wrong' });
    await b.shadow.lastCheck;
    expect(b.fetchImpl).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(b.logPath)).toBe(true);
  });

  it('fleet agent with enabled omitted: dark', async () => {
    const b = build(false, () => ({}));
    b.shadow.observe({ ...USER, text: 'wrong' });
    await b.shadow.lastCheck;
    expect(b.fetchImpl).not.toHaveBeenCalled();
  });

  it('explicit false on a dev agent is the kill switch, read live', async () => {
    let intel: Record<string, unknown> = {};
    const b = build(true, () => intel);
    intel = { jevCorrectionShadow: { enabled: false } };
    b.shadow.observe({ ...USER, text: 'wrong' });
    await b.shadow.lastCheck;
    expect(b.fetchImpl).not.toHaveBeenCalled();
    expect(b.shadow.summary().enabled).toBe(false);
  });
});
