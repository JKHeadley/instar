/**
 * Jev live signals through the PRODUCTION wiring into a real MessagingToneGate —
 * the integration tier. Spec: docs/specs/jev-signal-live.md (Tests).
 *
 * Uses the same factory server.ts calls (`buildJevSignalShadow`), the same
 * operator-config resolver the gate's getter uses (`resolveToneGateOperatorConfig`)
 * and a live-read config object, so the dev-agent gate, the kill switch and the
 * advisory-migration requirement are exercised exactly as in production.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessagingToneGate, resolveToneGateOperatorConfig, TONE_GATE_PROMPT_ID, TONE_GATE_PROMPT_ID_JEV } from '../../src/core/MessagingToneGate.js';
import { buildJevSignalShadow, SHADOW_QUESTIONS } from '../../src/core/JevSignalShadow.js';
import type { IntelligenceProvider } from '../../src/core/types.js';
import { installDecisionQualityRecorder } from '../../src/core/DecisionQualityRecorderImpl.js';

// Live signals need decision-quality recording to be live (the route otherwise
// turns a migration advisory back into a hard block). Install a stub recorder
// through the production seam; individual tests flip it off.
let recordingLive = true;
beforeEach(() => { recordingLive = true; installDecisionQualityRecorder({ isRecordingLive: () => recordingLive } as never); });
afterEach(() => installDecisionQualityRecorder(null));

const TEXT = 'Done. It will run on the schedule we agreed and report back in the morning.';

function okFetch(p: Record<string, number>) {
  return vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({ model: 'jev-1.13.0', usage: { input_tokens: 5 }, answers: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { noul: v }])) }),
  }) as unknown as Response);
}
const answers = { ...Object.fromEntries(SHADOW_QUESTIONS.map((q) => [q.rule, 0.02])), cron_or_slug: 0.92 };

function setup(config: Record<string, unknown>) {
  const stateDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-live-int-')), '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  const live = { config };
  const fetchImpl = okFetch(answers);
  const shadow = buildJevSignalShadow({
    readLiveIntelligence: () => live.config.intelligence,
    readSecret: (n) => (n === 'typesafe_api_key' ? 'k' : null),
    stateDir,
    fetchImpl: fetchImpl as never,
    developmentAgent: config.developmentAgent === true,
  });
  const evaluate = vi.fn(async (_p: string, _o: unknown) => JSON.stringify({ pass: true, rule: '', issue: '', suggestion: '' }));
  const gate = new MessagingToneGate({ evaluate } as unknown as IntelligenceProvider, () => resolveToneGateOperatorConfig(live.config));
  gate.setSignalShadow(shadow);
  const promptIds = () => evaluate.mock.calls.map((c) => (c[1] as { provenance: { promptId: string } }).provenance.promptId);
  const logPath = path.join(stateDir, '..', 'logs', 'jev-signal-shadow.jsonl');
  const rows = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { live, gate, fetchImpl, evaluate, promptIds, rows, shadow };
}
const ctx = { channel: 'telegram', messageKind: 'reply', liveArtefactSignals: true } as never;

describe('jev-signal-live — production wiring', () => {
  it('development agent, enabled omitted ⇒ LIVE: Jev shapes the prompt and the row records sources', async () => {
    const e = setup({ developmentAgent: true, intelligence: { jevSignalLive: { timeoutMs: 1000 } } });
    await e.gate.review(TEXT, ctx);
    expect(e.fetchImpl).toHaveBeenCalledTimes(1);
    expect(e.promptIds()).toEqual([TONE_GATE_PROMPT_ID_JEV]);
    expect(e.evaluate.mock.calls[0][0]).toContain('- cron-or-slug: detected=true source=jev');
    const [row] = e.rows();
    expect(row).toMatchObject({ kind: 'compared', live: true });
    expect(row.liveSources.cron_or_slug).toBe('jev');
  });

  it('fleet agent, enabled omitted ⇒ DARK: no vendor call (shadow block off), today\'s prompt', async () => {
    const e = setup({ developmentAgent: false, intelligence: { jevSignalLive: { timeoutMs: 1000 } } });
    await e.gate.review(TEXT, ctx);
    expect(e.fetchImpl).not.toHaveBeenCalled();
    expect(e.promptIds()).toEqual([TONE_GATE_PROMPT_ID]);
  });

  it('fleet agent with live flipped on but the advisory migration off ⇒ still not consulted', async () => {
    const e = setup({ developmentAgent: false, toneGate: { advisoryMigration: false }, intelligence: { jevSignalLive: { enabled: true } } });
    await e.gate.review(TEXT, ctx);
    expect(e.fetchImpl).not.toHaveBeenCalled();
    expect(e.promptIds()).toEqual([TONE_GATE_PROMPT_ID]);
  });

  it('fleet flip (live + advisory migration explicitly on) ⇒ live', async () => {
    const e = setup({ developmentAgent: false, toneGate: { advisoryMigration: true }, intelligence: { jevSignalLive: { enabled: true } } });
    await e.gate.review(TEXT, ctx);
    expect(e.promptIds()).toEqual([TONE_GATE_PROMPT_ID_JEV]);
  });

  it('the kill switch is read live — enabled:false on a dev agent takes effect on the next message, no restart', async () => {
    const e = setup({ developmentAgent: true, intelligence: { jevSignalLive: { timeoutMs: 1000 } } });
    await e.gate.review(TEXT, ctx);
    await e.shadow.lastDispatch;
    e.live.config = { developmentAgent: true, intelligence: { jevSignalLive: { enabled: false } } };
    await e.gate.review(TEXT, ctx);
    expect(e.promptIds()).toEqual([TONE_GATE_PROMPT_ID_JEV, TONE_GATE_PROMPT_ID]);
    expect(e.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('a vendor outage costs a bounded wait and returns today\'s prompt', async () => {
    const e = setup({ developmentAgent: true, intelligence: { jevSignalLive: { timeoutMs: 30 } } });
    e.fetchImpl.mockImplementation((() => new Promise(() => {})) as never);
    const t0 = Date.now();
    const r = await e.gate.review(TEXT, ctx);
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(r.pass).toBe(true);
    expect(e.promptIds()).toEqual([TONE_GATE_PROMPT_ID]);
  });
});

describe('jev-signal-live — through the real outbound route', () => {
  it('POST /telegram/reply opts in: the judge sees the Jev-shaped list and the message sends', async () => {
    const express = (await import('express')).default;
    const { createRoutes } = await import('../../src/server/routes.js');
    const e = setup({ developmentAgent: true, intelligence: { jevSignalLive: { timeoutMs: 1000 } } });
    const sent: string[] = [];
    const app = express();
    app.use(express.json());
    app.use(createRoutes({
      config: { authToken: 'test', stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'jev-live-route-')), port: 0, projectName: 'echo' },
      messagingToneGate: e.gate,
      topicOperatorStore: { asVerifiedOperator: () => ({ uid: 'u', displayName: 'Op' }), all: () => ({}) },
      telegram: { sendToTopic: async (_t: number, text: string) => { sent.push(text); } },
      sessionManager: { clearInjectionTracker: () => {} },
    } as never));
    const srv = await new Promise<import('node:http').Server>((r) => { const s = app.listen(0, () => r(s)); });
    try {
      const port = (srv.address() as import('node:net').AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/telegram/reply/29723`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
        body: JSON.stringify({ text: TEXT }),
      });
      expect(res.status, await res.text()).toBe(200);
      expect(e.fetchImpl).toHaveBeenCalledTimes(1);
      expect(e.promptIds()).toEqual([TONE_GATE_PROMPT_ID_JEV]);
      expect(sent).toHaveLength(1);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe('jev-signal-live — a route with no override path never opts in', () => {
  it('POST /attention (a hold there is final) reviews with detector-only signals and never calls Jev', async () => {
    const express = (await import('express')).default;
    const { createRoutes } = await import('../../src/server/routes.js');
    const e = setup({ developmentAgent: true, intelligence: { jevSignalLive: { timeoutMs: 1000 } } });
    const seen: Array<Record<string, unknown>> = [];
    const original = e.gate.review.bind(e.gate);
    e.gate.review = (async (text: string, context: never) => { seen.push(context); return original(text, context); }) as never;
    const app = express();
    app.use(express.json());
    app.use(createRoutes({
      config: { authToken: 'test', stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'jev-live-attn-')), port: 0 },
      messagingToneGate: e.gate,
      telegram: { createAttentionItem: async (item: Record<string, unknown>) => ({ ...item, status: 'OPEN', createdAt: 't', updatedAt: 't' }) },
    } as never));
    const srv = await new Promise<import('node:http').Server>((r) => { const s = app.listen(0, () => r(s)); });
    try {
      const port = (srv.address() as import('node:net').AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/attention`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
        body: JSON.stringify({ id: 'a1', title: 'Heads up', summary: TEXT, priority: 'NORMAL', category: 'degradation' }),
      });
      expect(res.status, await res.text()).toBeLessThan(500);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0].liveArtefactSignals).not.toBe(true);
      expect(e.fetchImpl).not.toHaveBeenCalled();
      expect(e.promptIds()).toEqual([TONE_GATE_PROMPT_ID]);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});
