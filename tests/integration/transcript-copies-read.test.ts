/**
 * native-conversation-any-machine-access §3f — reading a session from this machine's copy when the
 * machine that ran it does not answer, through createRoutes over real HTTP.
 *
 * The source machine's checkpoints reach this machine's copy store the way the journal delivers
 * them (one ingest per committed entry). The asking machine's signed read then times out, so the
 * route answers from the copy, states its coverage, and applies the same audience rule as the live
 * read: the owner only, never for a session of someone else's private conversation, and not while
 * this machine cannot confirm who may see it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TranscriptCheckpointSource, TranscriptCopyStore } from '../../src/core/transcriptCheckpoints.js';
import { DEVICE_ALLOWLIST } from '../../src/server/mobilePairingRoutes.js';

const SRC = 'm_source';
const SELF = 'm_reader';
const TOKEN = 'source-token-secret-value';
const base = () => (process.env.TMPDIR && !process.env.TMPDIR.includes('/.') ? process.env.TMPDIR : os.tmpdir());
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function tmp(): string { const d = fs.mkdtempSync(path.join(base(), 'tcr-')); cleanup.push(() => SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/transcript-copies-read.test.ts' })); return d; }

const row = (o: unknown) => `${JSON.stringify(o)}\n`;

/** Copy one session from a source to the reader's copy store, as the journal would deliver it. */
async function copied(readerDir: string, conversations: string[], final = false): Promise<TranscriptCopyStore> {
  const srcDir = tmp();
  const file = path.join(srcDir, 's.jsonl');
  fs.writeFileSync(file, [
    row({ type: 'user', timestamp: '2026-11-11T14:00:00Z', message: { content: 'what is on the Mini?' } }),
    row({ type: 'assistant', timestamp: '2026-11-11T14:02:00Z', message: { content: [{ type: 'text', text: `copied while it sleeps ${TOKEN}` }] } }),
  ].join(''));
  const store = new TranscriptCopyStore(readerDir);
  const source = new TranscriptCheckpointSource({
    stateDir: srcDir, machineId: SRC, secrets: () => [TOKEN],
    emit: async (chunks) => { for (const c of chunks) store.ingest(SRC, { ...c.data, origin: SRC }); return true; },
  });
  const s = { sessionId: 'claude-1', session: 'echo-on-mini', filePath: file, conversations };
  await source.tick([s], final ? { final: new Set(['claude-1']) } : {});
  return store;
}

async function reader(opts: { store: TranscriptCopyStore | null; dir: string; team?: { gaps: number; refusing: boolean }; confined?: Array<{ ref: string; personKey?: string }> }) {
  if (opts.confined) {
    fs.mkdirSync(path.join(opts.dir, 'state', 'team-access'), { recursive: true });
    fs.writeFileSync(path.join(opts.dir, 'state', 'team-access', 'confined.json'), JSON.stringify({ entries: opts.confined }));
  }
  const svc = opts.team ? {
    teamOn: () => true,
    teamLog: () => ({ healthState: () => 'healthy', state: () => ({ ownerPersonKey: 'owner-key', grants: new Map() }), gaps: () => Array.from({ length: opts.team!.gaps }) }),
    teamPuller: { refusing: () => opts.team!.refusing },
  } : undefined;
  const ctx = {
    config: { authToken: 'reader-token', stateDir: opts.dir, port: 0, projectDir: opts.dir },
    stateDir: opts.dir,
    meshSelfId: SELF,
    resolvePeerUrls: () => [{ machineId: SRC, url: 'http://127.0.0.1:9', kind: 'lan' }],
    meshSignedRead: () => new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), 10)),
    machinePoolRegistry: { getCapacity: (id: string) => (id === SRC ? { machineId: SRC, nickname: 'Mini', selfReportedLastSeen: '2026-11-11T14:05:00Z', hardware: { instarVersion: '1.3.1740' } } : null) },
    state: { findSessionByTmux: () => null, listSessions: () => [] },
    transcriptCopies: opts.store ? { store: opts.store, status: () => ({ machineId: SELF, sessions: [] }) } : null,
    ...(svc ? { mobilePairingService: svc } : {}),
  } as never;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (req.headers['x-test-device']) (req as unknown as { instarPrincipal: unknown }).instarPrincipal = { kind: 'device' }; next(); });
  app.use(createRoutes(ctx));
  const srv = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => srv.once('listening', () => r()));
  cleanup.push(() => new Promise<void>((r) => srv.close(() => r())));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return async (p: string, device = false) => {
    const r = await fetch(`${url}${p}`, { headers: { Authorization: 'Bearer reader-token', ...(device ? { 'x-test-device': '1' } : {}) } });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };
}

describe('a read from the copy while the source sleeps', () => {
  it('answers with the copied rows, says how far the copy reaches, and names the sleeping machine', async () => {
    const dir = tmp();
    const get = await reader({ store: await copied(dir, ['telegram:1']), dir });
    const t = await get(`/sessions/echo-on-mini/transcript?machineId=${SRC}`);
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ ok: true, via: 'copy', machineId: SRC, conversations: ['telegram:1'] });
    const entries = t.body.entries as Array<{ text: string }>;
    expect(entries.map((e) => e.text)).toEqual(['what is on the Mini?', 'copied while it sleeps [redacted]']);
    expect(JSON.stringify(t.body)).not.toContain(TOKEN);
    const copy = t.body.copy as { sentence: string; complete: boolean; sourceAwake: boolean };
    expect(copy).toMatchObject({ complete: false, sourceAwake: false });
    expect(copy.sentence).toMatch(/^Copied through \d\d:\d\d; the machine that ran it is asleep; later rows are not here yet\.$/);
    expect(t.body.machine).toMatchObject({ machineId: SRC, name: 'Mini', asleepOrUnreachable: true });
  });

  it('answers from the copy for a session not recorded here at all, and says a complete copy is complete', async () => {
    const dir = tmp();
    const get = await reader({ store: await copied(dir, [], true), dir });
    const t = await get('/sessions/echo-on-mini/transcript');
    expect(t.status).toBe(200);
    expect(t.body.via).toBe('copy');
    // Not recorded here, so the machine that ran it was not asked: the sentence does not claim it sleeps.
    expect(t.body.copy).toMatchObject({ complete: true, sourceAwake: null, withheldRows: 0 });
    expect((t.body.copy as { sentence: string }).sentence).toMatch(/^Copied in full, through \d\d:\d\d; the machine that ran it was not asked\.$/);
  });

  it('is refused to the owner for a session of someone else\'s private conversation', async () => {
    const dir = tmp();
    const get = await reader({ store: await copied(dir, ['app-private']), dir, confined: [{ ref: 'app-private', personKey: 'member-key' }] });
    const t = await get(`/sessions/echo-on-mini/transcript?machineId=${SRC}`);
    expect(t.status).toBe(403);
    expect(t.body.error).toBe('This session serves a conversation that is private to someone else.');
    expect(t.body.entries).toBeUndefined();
  });

  it('is refused when a checkpoint could not name every conversation the session served', async () => {
    const dir = tmp();
    const get = await reader({ store: await copied(dir, Array.from({ length: 70 }, (_, i) => `telegram:${i}`)), dir });
    const t = await get(`/sessions/echo-on-mini/transcript?machineId=${SRC}`);
    expect(t.status).toBe(403);
    expect(t.body.error).toBe('This machine cannot confirm who may see this session right now.');
  });

  it('is refused while this machine cannot confirm who may see it (a gap in the team log, or a refusing puller)', async () => {
    for (const team of [{ gaps: 1, refusing: false }, { gaps: 0, refusing: true }]) {
      const dir = tmp();
      const get = await reader({ store: await copied(dir, ['telegram:1']), dir, team });
      const t = await get(`/sessions/echo-on-mini/transcript?machineId=${SRC}`);
      expect(t.status).toBe(403);
      expect(t.body.error).toBe('This machine cannot confirm who may see this session right now.');
    }
  });

  it('a phone, member or guest is refused the copy and the coverage list', async () => {
    const dir = tmp();
    const get = await reader({ store: await copied(dir, []), dir });
    expect((await get(`/sessions/echo-on-mini/transcript?machineId=${SRC}`, true)).status).toBe(403);
    expect((await get('/transcript-copies', true)).status).toBe(403);
  });

  it('with copies switched off the route still says the machine did not answer', async () => {
    const dir = tmp();
    const get = await reader({ store: null, dir });
    const t = await get(`/sessions/echo-on-mini/transcript?machineId=${SRC}`);
    expect(t.status).toBe(502);
    expect(t.body.reason).toBe('peer-unreachable');
    expect((await get('/transcript-copies')).status).toBe(503);
  });
});

describe('the coverage list', () => {
  it('lists what each copy reaches with no transcript text', async () => {
    const dir = tmp();
    const get = await reader({ store: await copied(dir, ['telegram:1']), dir });
    const r = await get('/transcript-copies');
    expect(r.status).toBe(200);
    expect(r.body.copies).toEqual([expect.objectContaining({ sourceMachineId: SRC, session: 'echo-on-mini', rowCount: 2, complete: false })]);
    expect(JSON.stringify(r.body)).not.toContain('what is on the Mini?');
  });
});

describe('no device or team route reads the store', () => {
  it('no device rule lists the transcript route or the coverage list', () => {
    const rules = DEVICE_ALLOWLIST as unknown as Array<{ re: RegExp }>;
    expect(rules.length).toBeGreaterThan(10);
    for (const p of ['/transcript-copies', '/sessions/echo-on-mini/transcript']) {
      expect(rules.filter((r) => r.re.test(p)).map((r) => r.re.source)).toEqual([]);
    }
  });
});
