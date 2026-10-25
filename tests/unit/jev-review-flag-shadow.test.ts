/**
 * jev-review-flag-shadow — unit tier. Spec: docs/specs/jev-review-flag-shadow.md.
 *
 * Covers reply selection (agent provenance only, per-topic watermark, 30-minute
 * window, seeded after restart, the cap leaving a reply eligible), request
 * selection (operator only, before the reply, 6-hour window), scrub-before-cut
 * and cut disclosure, the exact request body (model pin, both orders, three
 * labels), the would-flag threshold on both sides, every skip reason, the
 * daily cap across a restart and a new day, the live kill switch, metering,
 * the dev gate on both sides, and the summary.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  JevReviewFlagShadow,
  buildJevReviewFlagShadow,
  selectCandidates,
  buildState,
  scrubThenCut,
  reviewFlagQuestions,
  summarizeReviewFlagLog,
  REVIEW_FLAG_CRITERIA,
  JEV_REVIEW_FLAG_FEATURE,
  type HistoryMessage,
  type JevReviewFlagShadowConfig,
} from '../../src/core/JevReviewFlagShadow.js';

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;

function msg(p: Partial<HistoryMessage> & { messageId: number }): HistoryMessage {
  return { topicId: 100, text: 'hello', fromUser: false, timestamp: iso(MIN), sessionName: 'echo-x', provenance: 'agent', ...p };
}

function jevResponse(p: Record<string, number>, pRev: Record<string, number> = p, model = 'jev-1.13.0') {
  const choice = (q: Record<string, number>) => Object.entries(q).sort((a, b) => b[1] - a[1])[0][0];
  return {
    ok: true, status: 200,
    json: async () => ({ model, usage: { input_tokens: 700 }, answers: {
      review: { type: 'choice', choice: choice(p), probabilities: p },
      review_rev: { type: 'choice', choice: choice(pRev), probabilities: pRev },
    } }),
  } as unknown as Response;
}
const FLAG = { needs_review: 0.81, fine: 0.17, cannot_tell: 0.02 };
const OK = { needs_review: 0.12, fine: 0.86, cannot_tell: 0.02 };

function rig(opts: { history?: HistoryMessage[]; cfg?: JevReviewFlagShadowConfig | (() => JevReviewFlagShadowConfig); key?: string | null; fetchImpl?: unknown; root?: string; now?: () => number } = {}) {
  const root = opts.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'jev-rf-'));
  const historyPath = path.join(root, '.instar', 'telegram-messages.jsonl');
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  if (opts.history) fs.writeFileSync(historyPath, opts.history.map((m) => JSON.stringify(m)).join('\n') + '\n');
  const logPath = path.join(root, 'logs', 'jev-review-flag-shadow.jsonl');
  const fetchImpl = (opts.fetchImpl ?? vi.fn(async () => jevResponse(FLAG))) as ReturnType<typeof vi.fn>;
  const metrics = { record: vi.fn() };
  const cfg = opts.cfg ?? { enabled: true };
  const shadow = new JevReviewFlagShadow({
    getConfig: typeof cfg === 'function' ? cfg : () => cfg,
    readKey: () => (opts.key === undefined ? 'k' : opts.key),
    logPath,
    historyPath,
    metrics,
    fetchImpl: fetchImpl as never,
    now: opts.now ?? (() => NOW),
  });
  const rows = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const append = (m: HistoryMessage) => fs.appendFileSync(historyPath, JSON.stringify(m) + '\n');
  return { root, shadow, fetchImpl, metrics, rows, logPath, historyPath, append };
}

describe('selectCandidates', () => {
  it('picks agent conversational replies only, oldest first, each with its request', () => {
    const h = [
      msg({ messageId: 1, fromUser: true, provenance: 'user', text: 'can you fix X?', timestamp: iso(20 * MIN) }),
      msg({ messageId: 2, provenance: 'automation', timestamp: iso(19 * MIN) }),
      msg({ messageId: 3, text: 'Fixed.', timestamp: iso(18 * MIN) }),
      msg({ messageId: 4, topicId: 200, text: 'other topic', timestamp: iso(17 * MIN) }),
    ];
    const c = selectCandidates(h, new Map(), NOW);
    expect(c.map((x) => x.reply.messageId)).toEqual([3, 4]);
    expect(c[0].request?.messageId).toBe(1);
    expect(c[1].request).toBeNull();
  });

  it('honours the 30-minute window and the per-topic watermark', () => {
    const h = [msg({ messageId: 5, timestamp: iso(31 * MIN) }), msg({ messageId: 6, timestamp: iso(29 * MIN) }), msg({ messageId: 7 })];
    expect(selectCandidates(h, new Map(), NOW).map((x) => x.reply.messageId)).toEqual([6, 7]);
    expect(selectCandidates(h, new Map([[100, 6]]), NOW).map((x) => x.reply.messageId)).toEqual([7]);
    expect(selectCandidates(h, new Map([[999, 6]]), NOW).map((x) => x.reply.messageId)).toEqual([6, 7]);
  });

  it('drops a request older than 6 hours before the reply, and a request after the reply', () => {
    const old = [msg({ messageId: 1, fromUser: true, provenance: 'user', timestamp: iso(6 * 60 * MIN + 2 * MIN) }), msg({ messageId: 2 })];
    expect(selectCandidates(old, new Map(), NOW)[0].request).toBeNull();
    const fresh = [msg({ messageId: 1, fromUser: true, provenance: 'user', timestamp: iso(6 * 60 * MIN - 2 * MIN) }), msg({ messageId: 2 })];
    expect(selectCandidates(fresh, new Map(), NOW)[0].request?.messageId).toBe(1);
  });

  it('ignores negative or missing topic ids (non-Telegram rows)', () => {
    const c = selectCandidates([msg({ messageId: 1, topicId: -5 }), msg({ messageId: 2, topicId: 0 })], new Map(), NOW);
    expect(c).toEqual([]);
  });
});

describe('scrub before cut, and cut disclosure', () => {
  it('a secret straddling the cut is scrubbed first, so no part of it survives', () => {
    const secret = 'ghp_' + 'A'.repeat(36);
    const text = 'word '.repeat(398) + secret; // the secret starts at 1990, across the 2,000 cut
    const out = scrubThenCut(text, 2000)!;
    expect(out.text).not.toContain('ghp_');
    expect(out.text).not.toContain('AAAAAAAAAA');
  });

  it('a private-key marker withholds the field whole', () => {
    expect(scrubThenCut('-----BEGIN RSA PRIVATE KEY-----\nabc', 2000)).toEqual({ text: '[REDACTED]', cut: false });
  });

  it('discloses a cut reply and request in band', () => {
    const b = buildState({ reply: msg({ messageId: 2, text: 'r'.repeat(2500) }), request: msg({ messageId: 1, fromUser: true, text: 'q'.repeat(700) }) })!;
    expect(b.replyCut).toBe(true);
    expect(b.requestCut).toBe(true);
    expect(b.state).toContain('[reply cut at 2,000 characters]');
    expect(b.state).toContain('[message cut at 600 characters]');
    expect(b.state.startsWith("OPERATOR'S MESSAGE:\n")).toBe(true);
  });

  it('omits the request block when there is no request', () => {
    const b = buildState({ reply: msg({ messageId: 2, text: 'Done.' }), request: null })!;
    expect(b.state).toBe("AGENT'S REPLY:\nDone.");
  });
});

describe('the shadow', () => {
  const history = [
    msg({ messageId: 10, fromUser: true, provenance: 'user', text: 'did the deploy work?', timestamp: iso(10 * MIN) }),
    msg({ messageId: 11, text: 'Yes, it is fixed.', timestamp: iso(5 * MIN) }),
  ];

  it('sends the exact request body (model pin, both orders, three labels) and logs a content-free row', async () => {
    const r = rig({ history });
    await r.shadow.tick();
    expect(r.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = r.fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('jev-1.13.0');
    expect(body.state).toBe("OPERATOR'S MESSAGE:\ndid the deploy work?\n\nAGENT'S REPLY:\nYes, it is fixed.");
    expect(body.questions).toEqual(reviewFlagQuestions());
    expect(Object.keys(body.questions.review.criteria)).toEqual(['needs_review', 'fine', 'cannot_tell']);
    expect(Object.keys(body.questions.review_rev.criteria)).toEqual(['cannot_tell', 'fine', 'needs_review']);
    expect(Object.keys(REVIEW_FLAG_CRITERIA)).toContain('cannot_tell');
    const rows = r.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'check', topicId: 100, replyMessageId: 11, requestMessageId: 10, session: 'echo-x', hadRequest: true, label: 'needs_review', pNeedsReview: 0.81, labelRev: 'needs_review', wouldFlag: true, model: 'jev-1.13.0', replyCut: false, requestCut: false, replyChars: 17 });
    const raw = fs.readFileSync(r.logPath, 'utf8');
    expect(raw).not.toContain('deploy');
    expect(raw).not.toContain('fixed');
  });

  it('threshold: 0.5 flags, 0.49 does not', async () => {
    const at = rig({ history, fetchImpl: vi.fn(async () => jevResponse({ needs_review: 0.5, fine: 0.5, cannot_tell: 0 })) });
    await at.shadow.tick();
    expect(at.rows()[0].wouldFlag).toBe(true);
    const under = rig({ history, fetchImpl: vi.fn(async () => jevResponse({ needs_review: 0.49, fine: 0.51, cannot_tell: 0 })) });
    await under.shadow.tick();
    expect(under.rows()[0]).toMatchObject({ wouldFlag: false, label: 'fine' });
  });

  it('judges each reply once, including across a restart (watermark seeded from the log)', async () => {
    const r = rig({ history, fetchImpl: vi.fn(async () => jevResponse(OK)) });
    await r.shadow.tick();
    await r.shadow.tick();
    expect(r.fetchImpl).toHaveBeenCalledTimes(1);
    r.append(msg({ messageId: 12, text: 'A new reply.', timestamp: iso(MIN) }));
    await r.shadow.tick();
    expect(r.fetchImpl).toHaveBeenCalledTimes(2);
    const restarted = rig({ root: r.root, fetchImpl: vi.fn(async () => jevResponse(OK)) });
    await restarted.shadow.tick();
    expect(restarted.fetchImpl).not.toHaveBeenCalled();
  });

  it('a late-logged reply is picked up on the next tick', async () => {
    const r = rig({ history: [history[0]] });
    await r.shadow.tick();
    expect(r.fetchImpl).not.toHaveBeenCalled();
    r.append(history[1]);
    await r.shadow.tick();
    expect(r.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('kill switch is read live at every tick', async () => {
    let enabled = false;
    const r = rig({ history, cfg: () => ({ enabled }) });
    await r.shadow.tick();
    expect(r.fetchImpl).not.toHaveBeenCalled();
    expect(r.rows()).toEqual([]);
    enabled = true;
    await r.shadow.tick();
    expect(r.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('no key: one disabled-no-key row per process, no vendor call', async () => {
    const r = rig({ history, key: null });
    await r.shadow.tick();
    await r.shadow.tick();
    expect(r.fetchImpl).not.toHaveBeenCalled();
    expect(r.rows()).toEqual([expect.objectContaining({ kind: 'skipped', reason: 'disabled-no-key' })]);
  });

  it('daily cap: one row per day, the reply stays eligible, the cap survives a restart and resets on a new day', async () => {
    const two = [msg({ messageId: 21, timestamp: iso(3 * MIN) }), msg({ messageId: 22, timestamp: iso(2 * MIN) })];
    const r = rig({ history: two, cfg: { enabled: true, maxChecksPerDay: 1 }, fetchImpl: vi.fn(async () => jevResponse(OK)) });
    await r.shadow.tick();
    await r.shadow.tick();
    expect(r.fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.rows().filter((x) => x.reason === 'daily-cap')).toHaveLength(1);
    const restarted = rig({ root: r.root, cfg: { enabled: true, maxChecksPerDay: 1 }, fetchImpl: vi.fn(async () => jevResponse(OK)) });
    await restarted.shadow.tick();
    expect(restarted.fetchImpl).not.toHaveBeenCalled();
    // A new day (still within the 30-minute window of the history rewritten below).
    const later = NOW + 24 * 60 * MIN;
    fs.appendFileSync(restarted.historyPath, JSON.stringify(msg({ messageId: 23, timestamp: new Date(later - MIN).toISOString() })) + '\n');
    const nextDay = rig({ root: r.root, cfg: { enabled: true, maxChecksPerDay: 1 }, fetchImpl: vi.fn(async () => jevResponse(OK)), now: () => later });
    await nextDay.shadow.tick();
    expect(nextDay.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('every vendor failure is a closed-enum skip that settles the reply', async () => {
    const cases: Array<[string, () => Promise<Response>]> = [
      ['http-error', async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom secret-body' }) }) as unknown as Response],
      ['model-mismatch', async () => jevResponse(FLAG, FLAG, 'jev-latest')],
      ['no-answers', async () => ({ ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers: {} }) }) as unknown as Response],
      ['timeout', async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }],
      ['http-error', async () => { throw new Error('ECONNRESET'); }],
    ];
    for (const [reason, impl] of cases) {
      const r = rig({ history, fetchImpl: vi.fn(impl) });
      await r.shadow.tick();
      await r.shadow.tick();
      expect(r.fetchImpl).toHaveBeenCalledTimes(1);
      expect(r.rows()).toEqual([{ kind: 'skipped', ts: expect.any(String), topicId: 100, replyMessageId: 11, reason }]);
      expect(fs.readFileSync(r.logPath, 'utf8')).not.toContain('secret-body');
      expect(r.metrics.record).toHaveBeenCalledWith(expect.objectContaining({ feature: JEV_REVIEW_FLAG_FEATURE, outcome: 'error' }));
    }
  });

  it('a 401 drops the cached key', async () => {
    const r = rig({ history: [...history, msg({ messageId: 12, timestamp: iso(MIN) })], fetchImpl: vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response) });
    await r.shadow.tick();
    expect(r.fetchImpl).toHaveBeenCalledTimes(1);
    await r.shadow.tick(); // the key is not re-read for 10 minutes
    expect(r.fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.rows().map((x) => x.reason)).toEqual(['http-error', 'disabled-no-key']);
  });

  it('meters every call with the served model', async () => {
    const r = rig({ history });
    await r.shadow.tick();
    expect(r.metrics.record).toHaveBeenCalledWith(expect.objectContaining({ feature: JEV_REVIEW_FLAG_FEATURE, kind: 'llm', outcome: 'fired', tokensIn: 700, tokensOut: 0, model: 'jev-1.13.0', framework: 'typesafe-api' }));
  });

  it('ticks never overlap', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const r = rig({ history, fetchImpl: vi.fn(async () => { await gate; return jevResponse(OK); }) });
    const first = r.shadow.tick();
    await r.shadow.tick();
    release();
    await first;
    expect(r.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('summary counts checks, flags, labels, skips and per-topic', async () => {
    const r = rig({ history: [...history, msg({ messageId: 12, topicId: 200, timestamp: iso(MIN) })], fetchImpl: vi.fn().mockResolvedValueOnce(jevResponse(FLAG)).mockResolvedValueOnce(jevResponse(OK)) });
    await r.shadow.tick();
    const s = summarizeReviewFlagLog(r.logPath, true);
    expect(s).toMatchObject({ enabled: true, checks: 2, wouldFlags: 1, labels: { needs_review: 1, fine: 1 } });
    expect(s.perTopic['100']).toMatchObject({ checks: 1, wouldFlags: 1 });
    expect(s.perTopic['200']).toMatchObject({ checks: 1, wouldFlags: 0 });
    expect(r.shadow.summary().checks).toBe(2);
  });
});

describe('dev gate (production factory)', () => {
  function build(developmentAgent: boolean, block: Record<string, unknown> | undefined) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-rf-f-'));
    const stateDir = path.join(root, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'telegram-messages.jsonl'), JSON.stringify(msg({ messageId: 1 })) + '\n');
    const fetchImpl = vi.fn(async () => jevResponse(OK));
    const shadow = buildJevReviewFlagShadow({
      readLiveIntelligence: () => (block ? { jevReviewFlagShadow: block } : {}),
      developmentAgent,
      readSecret: (n) => (n === 'typesafe_api_key' ? 'k' : null),
      stateDir,
      fetchImpl: fetchImpl as never,
      now: () => NOW,
    });
    return { shadow, fetchImpl, root };
  }

  it('omitted enabled: live on a development agent, dark on the fleet', async () => {
    const dev = build(true, {});
    await dev.shadow.tick();
    expect(dev.fetchImpl).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(dev.root, 'logs', 'jev-review-flag-shadow.jsonl'))).toBe(true);
    const fleet = build(false, {});
    await fleet.shadow.tick();
    expect(fleet.fetchImpl).not.toHaveBeenCalled();
  });

  it('explicit enabled wins on both sides', async () => {
    const off = build(true, { enabled: false });
    await off.shadow.tick();
    expect(off.fetchImpl).not.toHaveBeenCalled();
    const on = build(false, { enabled: true });
    await on.shadow.tick();
    expect(on.fetchImpl).toHaveBeenCalledTimes(1);
  });
});
