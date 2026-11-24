// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * identity-security-piece1b: truthful approval records (trust tool and MoltBridge).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTrustManager } from '../../src/threadline/AgentTrustManager.js';
import { createMoltBridgeRoutes } from '../../src/moltbridge/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('truthful trust provenance (piece 1b §1)', () => {
  let dir: string;
  let tm: AgentTrustManager;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1b-trust-')); tm = new AgentTrustManager({ stateDir: dir }); });
  afterEach(() => { tm.flush(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/identity-piece1b-truthful-approvals.test.ts:cleanup' }); });

  it('an agent-proposal upgrade is allowed at Basic, recorded honestly and not user-initiated', () => {
    expect(tm.setTrustLevel('PeerA', 'trusted', 'agent-proposal', 'agent proposal')).toBe(true);
    const audit = fs.readFileSync(path.join(dir, 'threadline', 'trust-audit.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    const last = audit[audit.length - 1];
    expect(last.source).toBe('agent-proposal');
    expect(last.userInitiated).toBe(false);
  });

  it('the trust tool writes agent-proposal, never user-granted', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/threadline/ThreadlineMCPServer.ts'), 'utf-8');
    const start = src.indexOf("'threadline_trust'");
    const handler = src.slice(start, src.indexOf("case 'list'", start));
    expect(handler).toContain("'agent-proposal'");
    expect(handler).not.toContain("'user-granted'");
  });

  it('every reader that accepts user-granted also accepts agent-proposal (behaviour unchanged at Basic)', () => {
    for (const f of ['src/threadline/TrustEvaluator.ts', 'src/threadline/httpPeerTrust.ts', 'src/users/peerPlaceAdmission.ts', 'src/threadline/AgentTrustManager.ts']) {
      const t = fs.readFileSync(path.resolve(__dirname, '../..', f), 'utf-8');
      expect(t, f).toContain('agent-proposal');
    }
  });

  it('ratchet: only the known readers mention user-granted (none may treat it as proof of a person)', () => {
    const root = path.resolve(__dirname, '../../src');
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts') && /user-granted/.test(fs.readFileSync(p, 'utf-8').replace(/^\s*(\*|\/\/).*$/gm, ''))) hits.push(path.relative(root, p));
      }
    };
    walk(root);
    expect(hits.sort()).toEqual(['threadline/AgentTrustManager.ts', 'threadline/TrustEvaluator.ts', 'threadline/httpPeerTrust.ts', 'users/peerPlaceAdmission.ts']);
  });
});

describe('truthful MoltBridge approval (piece 1b §2)', () => {
  it('a bearer approve records agent-proposal and publishes once', async () => {
    const draft = { status: 'pending', profile: { name: 'x' } } as Record<string, unknown>;
    const publishProfile = vi.fn().mockResolvedValue({ ok: true });
    const markPublished = vi.fn();
    const app = express();
    app.use(express.json());
    app.use(createMoltBridgeRoutes({ client: { publishProfile } as never, identity: {} as never, profileCompiler: { getCurrentDraft: () => draft, markPublished } as never }));
    const res = await request(app).post('/moltbridge/profile/approve').send({});
    expect(res.status).toBe(200);
    expect(draft.approvedBy).toBe('agent-proposal');
    expect(publishProfile).toHaveBeenCalledTimes(1);
    expect(markPublished).toHaveBeenCalledTimes(1);
  });
});
