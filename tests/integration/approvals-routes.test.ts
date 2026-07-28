/**
 * Tier-2 integration tests for the Approval-as-Data routes (spec Part B / Phase 2):
 * the full HTTP pipeline over a REAL ApprovalLedger (temp-file backed), proving the
 * route↔store round-trip — record, summary (with surface breakdown), list, the
 * operator-inconsistency 400s, and the 503 when the ledger is unavailable.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import { ApprovalLedger } from '../../src/core/ApprovalLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface Server { url: string; close: () => Promise<void>; }

async function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

const sign = (c: string) => `sig::${c}`;
const verifySig = (c: string, s: string) => s === `sig::${c}`;

function buildApp(approvalLedger: ApprovalLedger | null): express.Express {
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  const ctx: any = {
    approvalLedger,
    config: { authToken: 'test', stateDir: '/tmp', port: 0 },
    stateDir: '/tmp',
  };
  app.use(createRoutes(ctx));
  return app;
}

describe('Approval-as-Data routes (Part B / Phase 2)', () => {
  let dir: string;
  let ledger: ApprovalLedger;
  let server: Server;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-routes-'));
    ledger = new ApprovalLedger({ filePath: path.join(dir, 'approval-ledger.jsonl'), sign, verifySig });
    server = await listen(buildApp(ledger));
  });
  afterEach(async () => {
    await server.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/approvals-routes.test.ts' });
  });

  it('POST /approvals records a chat approved-as-is decision (201) and it lists back', async () => {
    const post = await fetch(`${server.url}/approvals`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'coordination-mandate', decisionClass: 'governance-safety', surface: 'chat', mode: 'approved-as-is' }),
    });
    expect(post.status).toBe(201);
    const body = await post.json();
    expect(body.recorded).toBe(true);
    expect(body.row.mode).toBe('approved-as-is');

    const list = await fetch(`${server.url}/approvals`);
    const lj = await list.json();
    expect(lj.total).toBe(1);
    expect(lj.rows[0].subject).toBe('coordination-mandate');
  });

  it('POST /approvals records a with-change decision carrying a divergence', async () => {
    const post = await fetch(`${server.url}/approvals`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject: 'approval-ledger-scope', decisionClass: 'design-decision', surface: 'chat',
        mode: 'approved-with-change',
        divergences: [{ category: 'scope-correction', summary: 'track all approvals', why: 'most happen in chat, not as specs' }],
      }),
    });
    expect(post.status).toBe(201);
    const summary = await (await fetch(`${server.url}/approvals/summary`)).json();
    const dd = summary.classes.find((c: any) => c.decisionClass === 'design-decision');
    expect(dd.approvedWithChange).toBe(1);
    expect(dd.divergenceCounts['scope-correction']).toBe(1);
  });

  it('GET /approvals/summary reports per-class ratios + a surface breakdown', async () => {
    await ledger.recordApproval({ subject: 'a', decisionClass: 'k', surface: 'chat', approver: 'justin', mode: 'approved-as-is' });
    await ledger.recordApproval({ subject: 'b', decisionClass: 'k', surface: 'spec', approver: 'justin', mode: 'approved-as-is', commitSha: 'abc' });
    const s = await (await fetch(`${server.url}/approvals/summary`)).json();
    expect(s.total).toBe(2);
    expect(s.bySurface.chat.total).toBe(1);
    expect(s.bySurface.spec.total).toBe(1);
    const k = s.classes.find((c: any) => c.decisionClass === 'k');
    expect(k.ratio).toBe(1);
  });

  it('POST /approvals rejects an operator-inconsistent row with 400 (as-is WITH a divergence)', async () => {
    const post = await fetch(`${server.url}/approvals`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'x', decisionClass: 'k', surface: 'chat', mode: 'approved-as-is', divergences: [{ category: 'style', summary: 's', why: 'w' }] }),
    });
    expect(post.status).toBe(400);
    expect((await post.json()).error).toMatch(/no divergences/);
  });

  it('POST /approvals 400s when subject is missing', async () => {
    const post = await fetch(`${server.url}/approvals`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decisionClass: 'k', mode: 'approved-as-is' }),
    });
    expect(post.status).toBe(400);
  });

  it('all approval routes 503 when the ledger is unavailable', async () => {
    const s2 = await listen(buildApp(null));
    try {
      expect((await fetch(`${s2.url}/approvals/summary`)).status).toBe(503);
      expect((await fetch(`${s2.url}/approvals`)).status).toBe(503);
      const post = await fetch(`${s2.url}/approvals`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: 'x', decisionClass: 'k', mode: 'approved-as-is' }),
      });
      expect(post.status).toBe(503);
    } finally {
      await s2.close();
    }
  });
});
