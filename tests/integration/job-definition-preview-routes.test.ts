import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createJobDefinitionPreviewRouter } from '../../src/server/jobDefinitionPreviewRoutes.js';

const PATH = '/jobs/reconcile';
const PREVIEW = PATH + '?preview=job-definitions';
const configPath = '/test-fixture/alternate-jobs.json';

const page = {
  complete: true,
  coverage: { legacy: 'complete', 'portable-journal': 'complete', 'manifest-inventory': 'complete' },
  scheduler: 'unknown', pool: 'unchecked', truncated: false, rows: [],
} as const;

function fixture(worker: Parameters<typeof createJobDefinitionPreviewRouter>[0]['worker']) {
  let enabled = true;
  let activeSession = 'owner-session-a';
  let jobsFile = configPath;
  const app = express();
  app.use(createJobDefinitionPreviewRouter({
    available: () => enabled, jobsFile: () => jobsFile, machineId: 'fixture',
    verifyCurrentOwner: (req) => req.get('Authorization') === 'Bearer fixture'
      && req.get('X-Instar-Operator-Session') === activeSession ? activeSession : null,
    worker,
  }));
  const ordinary = vi.fn((_, res) => res.json({ findings: [] }));
  app.get(PATH, ordinary);
  return { app, ordinary, disable: () => { enabled = false; },
    select: (value: string) => { jobsFile = value; },
    replaceOwner: (value: string) => { activeSession = value; } };
}

function owner(req: request.Test, proof = 'owner-session-a') {
  return req.set('Authorization', 'Bearer fixture').set('X-Instar-Operator-Session', proof);
}

describe('job definition preview route', () => {
  it('reserves malformed preview parameters without scanning the old route or source', async () => {
    const read = vi.fn();
    const f = fixture({ read });
    await request(f.app).get(PATH).expect(200, { findings: [] });
    await owner(request(f.app).get(PATH + '?cursor=not-a-preview')).expect(400).expect('Cache-Control', 'no-store');
    await owner(request(f.app).get(PREVIEW + '&preview=job-definitions')).expect(400);
    await owner(request(f.app).get(PREVIEW + '&unknown=1')).expect(400);
    await owner(request(f.app).head(PREVIEW)).expect(405);
    await request(f.app).get(PREVIEW).set('Authorization', 'Bearer fixture').expect(403);
    expect(f.ordinary).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
  });

  it('passes the configured catalog to the worker, binds a cursor to the owner and omits the fingerprint', async () => {
    const next = { fingerprint: 'a'.repeat(64), nextIndex: 250 };
    const read = vi.fn(async () => ({ status: 'ready' as const, page: { ...page, rows: [] }, continuation: next }));
    const f = fixture({ read });
    const first = await owner(request(f.app).get(PREVIEW)).expect(200).expect('Cache-Control', 'no-store');
    expect(first.body).toMatchObject({ schemaVersion: 1, pool: 'unchecked' });
    expect(first.body.cursor).toEqual(expect.any(String));
    expect(first.text).not.toContain(next.fingerprint);
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ jobsFile: configPath, continuation: undefined }));
    const nextUrl = PREVIEW + '&cursor=' + encodeURIComponent(first.body.cursor);
    await owner(request(f.app).get(nextUrl)).expect(200);
    expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ continuation: next }));
    f.replaceOwner('owner-session-b');
    await owner(request(f.app).get(nextUrl), 'owner-session-b').expect(409);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each(['owner', 'flag', 'catalog'] as const)('rechecks %s after reading and does not release stale results', async (changed) => {
    let release!: () => void;
    const read = vi.fn(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return { status: 'ready' as const, page: { ...page, rows: [] } };
    });
    const f = fixture({ read });
    const pending = owner(request(f.app).get(PREVIEW)).then(r => r);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    if (changed === 'owner') f.replaceOwner('owner-session-b');
    else if (changed === 'flag') f.disable();
    else f.select('/test-fixture/replacement.json');
    release();
    expect((await pending).status).toBe(changed === 'owner' ? 403 : 503);
  });
});
