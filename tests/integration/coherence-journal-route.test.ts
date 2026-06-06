// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
// safe-fs-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * GET /coherence/journal through the real createRoutes pipeline (P1.2 §3.5,
 * §6 integration list).
 *  - 503 when the coherence journal is not wired (dark).
 *  - 200 + merged view + filters + caps + (topic,epoch) collapse +
 *    traversal-shaped params match nothing, when a real CoherenceJournal is
 *    wired into a StateManager via setCoherenceJournal and entries are emitted.
 *  - read-only (POST/DELETE not registered).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';

let tmpDir: string;
let stateDir: string;
let journal: CoherenceJournal | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coherence-journal-route-'));
  stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  try {
    journal?.close();
  } catch {
    /* best-effort */
  }
  journal = undefined;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** Build a RouteContext whose StateManager exposes only getCoherenceJournal. */
function ctxWith(j: CoherenceJournal | undefined): RouteContext {
  return {
    config: { projectName: 'test', projectDir: tmpDir, stateDir, port: 0, sessions: {} as any, scheduler: {} as any } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: {
      getJobState: () => null,
      getSession: () => null,
      listSessions: () => [],
      getCoherenceJournal: () => j,
    } as any,
    tokenLedger: null,
    reapLog: null,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function appWith(j: CoherenceJournal | undefined): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctxWith(j)));
  return app;
}

/** Open a real journal, emit entries, and flush them durably. */
function liveJournal(machineId = 'm1'): CoherenceJournal {
  const j = new CoherenceJournal({ stateDir, machineId, flushIntervalMs: 5 });
  j.open();
  return j;
}

describe('GET /coherence/journal (integration P1.2 §3.5)', () => {
  it('returns 503 when the journal is not wired', async () => {
    const res = await request(appWith(undefined)).get('/coherence/journal');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not enabled/);
  });

  it('returns 200 with a merged placement history when the journal is wired', async () => {
    journal = liveJournal('m1');
    journal.emitPlacement(13481, { owner: 'm1', epoch: 1, reason: 'placed' });
    journal.emitPlacement(13481, { owner: 'm2', epoch: 2, reason: 'user-move', prevOwner: 'm1' });
    journal.flush(); // durable

    const res = await request(appWith(journal)).get('/coherence/journal?topic=13481&kind=topic-placement');
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(2);
    // Newest-first by (epoch, ts): epoch 2 then epoch 1.
    expect(res.body.entries.map((e: any) => e.data.epoch)).toEqual([2, 1]);
    expect(res.body.entries[0]).toMatchObject({ source: 'own', kind: 'topic-placement', topic: 13481 });
    expect(res.body.skippedCorrupt).toBe(0);
    expect(res.body.truncated).toBe(false);
    // streams map carries the own placement stream as current.
    const streamKey = Object.keys(res.body.streams).find((k) => k.endsWith('.topic-placement'));
    expect(streamKey).toBeTruthy();
    expect(res.body.streams[streamKey!]).toMatchObject({ source: 'own', status: 'current', lastSeq: 2 });
  });

  it('honours the kind filter and session-lifecycle ordering', async () => {
    journal = liveJournal('m1');
    journal.emitPlacement(1, { owner: 'm1', epoch: 1, reason: 'placed' });
    journal.emitLifecycle({ sessionId: 's-1', status: 'created' }, 1);
    journal.emitLifecycle({ sessionId: 's-1', status: 'completed' }, 1);
    journal.flush();

    const res = await request(appWith(journal)).get('/coherence/journal?kind=session-lifecycle');
    expect(res.status).toBe(200);
    expect(res.body.entries.every((e: any) => e.kind === 'session-lifecycle')).toBe(true);
    expect(res.body.entries).toHaveLength(2);
    // Newest-first: completed (higher seq) before created at equal-ish ts.
    const statuses = res.body.entries.map((e: any) => e.data.status);
    expect(statuses[0]).toBe('completed');
  });

  it('caps limit at 500 and pages via cursor', async () => {
    journal = liveJournal('m1');
    for (let i = 1; i <= 6; i++) journal.emitLifecycle({ sessionId: `s${i}`, status: 'created' }, 1);
    journal.flush();

    const page1 = await request(appWith(journal)).get('/coherence/journal?kind=session-lifecycle&limit=3');
    expect(page1.status).toBe(200);
    expect(page1.body.entries).toHaveLength(3);
    // Build a cursor from the last returned entry (the route returns the keyset
    // fields on each entry: ts, machine, seq — base64url-encode the same shape).
    const last = page1.body.entries[page1.body.entries.length - 1];
    const cursor = Buffer.from(
      JSON.stringify({ ts: last.ts, machineId: last.machine, seq: last.seq }),
      'utf-8',
    ).toString('base64url');
    const page2 = await request(appWith(journal)).get(
      `/coherence/journal?kind=session-lifecycle&limit=3&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(page2.status).toBe(200);
    expect(page2.body.entries).toHaveLength(3);
    // No overlap between pages.
    const p1seqs = page1.body.entries.map((e: any) => e.seq);
    const p2seqs = page2.body.entries.map((e: any) => e.seq);
    expect(p1seqs.some((s: number) => p2seqs.includes(s))).toBe(false);
  });

  it('a traversal-shaped machine param matches nothing', async () => {
    journal = liveJournal('m1');
    journal.emitPlacement(7, { owner: 'm1', epoch: 1, reason: 'placed' });
    journal.flush();
    const res = await request(appWith(journal)).get('/coherence/journal?machine=../../etc/passwd');
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(0);
  });

  it('rejects a malformed cursor with 400', async () => {
    journal = liveJournal('m1');
    journal.emitLifecycle({ sessionId: 's', status: 'created' }, 1);
    journal.flush();
    const res = await request(appWith(journal)).get('/coherence/journal?kind=session-lifecycle&cursor=%24%24not-valid');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cursor/);
  });

  it('is read-only — POST/DELETE are not registered', async () => {
    journal = liveJournal('m1');
    const app = appWith(journal);
    expect((await request(app).post('/coherence/journal')).status).toBe(404);
    expect((await request(app).delete('/coherence/journal')).status).toBe(404);
  });
});
