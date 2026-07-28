/**
 * Integration (Tier 2) — the Turn-End Self-Deferral Guard shadow-record path
 * over HTTP. Spec: turn-end-self-deferral-guard.md §7 (Tier 2).
 *
 * Mirrors the routes-stopGate.test.ts pattern (a minimal express app rather than
 * the full AgentServer) but wires the REAL components the production route uses
 * on the success/allow path: the REAL UnjustifiedStopGate authority (mock
 * IntelligenceProvider), the REAL StopGateDb, and the REAL resolveDevAgentGate.
 * Asserts the request/response round trip lands the widened columns in SQLite,
 * stores NO raw user/message text, and blocks nothing (decision:'allow').
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import { StopGateDb } from '../../src/core/StopGateDb.js';
import { UnjustifiedStopGate, type EvaluateInput } from '../../src/core/UnjustifiedStopGate.js';
import { resolveDevAgentGate } from '../../src/core/devAgentGate.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const SELF_DEFERRAL_RESPONSE = JSON.stringify({
  decision: 'allow',
  rule: 'U_SELF_DEFERRAL',
  evidence_pointer: {},
  rationale: 'handed the operator an agent-ownable build step',
  selfDeferral: true,
  confidence: 'high',
  deferredWorkIsAgentOwnable: true,
  turnEnding: true,
});

function buildApp(opts: { developmentAgent: boolean; db: StopGateDb; response: string }): { server: Server; port: number } {
  const intelligence: IntelligenceProvider = { evaluate: async () => opts.response };
  const guardOn = resolveDevAgentGate(undefined, { developmentAgent: opts.developmentAgent });
  const authority = new UnjustifiedStopGate({ intelligence, selfDeferralGuardEnabled: guardOn });

  const app = express();
  app.use(express.json());
  // A faithful slice of the production /internal/stop-gate/evaluate success path.
  app.post('/internal/stop-gate/evaluate', async (req, res) => {
    const body = req.body as {
      sessionId: string;
      evidenceMetadata: EvaluateInput['evidenceMetadata'];
      untrustedContent: EvaluateInput['untrustedContent'];
    };
    const ts = Date.now();
    const reasonPreview = (body.untrustedContent.stopReason ?? '').slice(0, 200);
    const contextTurns = Array.isArray(body.untrustedContent.recentTurns)
      ? body.untrustedContent.recentTurns.filter(t => t && t.source === 'user').length
      : 0;
    const surface = 'non-autonomous';
    const outcome = await authority.evaluate({
      evidenceMetadata: body.evidenceMetadata,
      untrustedContent: body.untrustedContent,
    });
    if (!outcome.ok) {
      res.json({ decision: 'allow', rule: null, failOpen: outcome.failure.kind });
      return;
    }
    const r = outcome.result;
    const cols = guardOn
      ? {
          selfDeferral: r.selfDeferral === undefined ? null : r.selfDeferral ? 1 : 0,
          confidence: r.confidence ?? null,
          agentOwnable: r.deferredWorkIsAgentOwnable === undefined ? null : r.deferredWorkIsAgentOwnable ? 1 : 0,
          turnEnding: r.turnEnding === undefined ? null : r.turnEnding ? 1 : 0,
          allowClassRule: r.decision === 'allow' ? r.rule : null,
          promptHash: r.promptHash ?? null,
          surface,
          contextTurns,
        }
      : {};
    opts.db.recordEvent({
      eventId: 'evt-' + Math.random().toString(36).slice(2),
      sessionId: body.sessionId,
      agentId: 'echo',
      ts,
      mode: 'shadow',
      decision: r.decision,
      rule: r.rule,
      invalidKind: null,
      evidencePointerJson: JSON.stringify(r.evidencePointer),
      latencyMs: r.latencyMs,
      reasonPreview,
      ...cols,
    });
    res.json({ decision: r.decision, rule: r.rule, reminder: '' });
  });

  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  return { server, port };
}

const REQUEST = {
  sessionId: 'sess-int',
  evidenceMetadata: { artifacts: [], signals: {}, sessionStartTs: 1 },
  untrustedContent: {
    stopReason: 'stopping the build here on purpose',
    recentTurns: [
      { source: 'user', text: 'SECRET-USER-PROSE build the guard' },
      { source: 'agent', text: 'want me to line that up, or steer me elsewhere?' },
    ],
  },
};

describe('self-deferral guard — evaluate route records widened columns (dev agent)', () => {
  let handle: { server: Server; port: number } | null = null;
  let db: StopGateDb | null = null;
  afterEach(() => {
    if (handle) handle.server.close();
    if (db) db.close();
    handle = null;
    db = null;
  });

  it('records the four fields + surface + contextTurns + promptHash; blocks nothing', async () => {
    db = new StopGateDb({ db: new Database(':memory:') });
    handle = buildApp({ developmentAgent: true, db, response: SELF_DEFERRAL_RESPONSE });

    const res = await fetch(`http://127.0.0.1:${handle.port}/internal/stop-gate/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(REQUEST),
    });
    const json = (await res.json()) as { decision: string; rule: string };
    expect(json.decision).toBe('allow'); // shadow — never a block
    expect(json.rule).toBe('U_SELF_DEFERRAL');

    const rows = db.recentEvents(5);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.selfDeferral).toBe(1);
    expect(row.confidence).toBe('high');
    expect(row.agentOwnable).toBe(1);
    expect(row.turnEnding).toBe(1);
    expect(row.allowClassRule).toBe('U_SELF_DEFERRAL');
    expect(typeof row.promptHash).toBe('string');
    expect(row.surface).toBe('non-autonomous');
    expect(row.contextTurns).toBe(1); // one user turn in recentTurns

    // No raw user/message text is stored (§3.4 S4) — only the stop-reason
    // preview column exists, and it must NOT carry the user prose.
    expect(row.reasonPreview).not.toContain('SECRET-USER-PROSE');
  });

  it('on the fleet (dark) the guard records NO self-deferral columns', async () => {
    db = new StopGateDb({ db: new Database(':memory:') });
    handle = buildApp({ developmentAgent: false, db, response: SELF_DEFERRAL_RESPONSE });

    const res = await fetch(`http://127.0.0.1:${handle.port}/internal/stop-gate/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(REQUEST),
    });
    expect(((await res.json()) as { decision: string }).decision).toBe('allow');

    const row = db.recentEvents(1)[0];
    expect(row.selfDeferral).toBeNull();
    expect(row.confidence).toBeNull();
    expect(row.promptHash).toBeNull();
    expect(row.surface).toBeNull();
    expect(row.contextTurns).toBeNull();
  });
});
