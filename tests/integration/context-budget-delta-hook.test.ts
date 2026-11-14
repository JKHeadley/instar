// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * Integration — the REAL per-prompt hook script against a REAL HTTP server
 * running the prompt-context route (context-budget-layered-summaries §7.7;
 * Phase 1 S15): one request, the full output while in shadow, sizes logged, the
 * fallback to the two older calls on a 404, suppression under a fold marker,
 * and the 9,000-character bound.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { createPromptContextRoutes } from '../../src/server/promptContextRoutes.js';
import { SeedFetchLog, DeltaShadowLog } from '../../src/monitoring/contextLayers/promptContext.js';
import { writeFoldMarker } from '../../src/monitoring/foldMarker.js';
import { FoldRecordStore } from '../../src/monitoring/FoldCoordinator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/integration/context-budget-delta-hook.test.ts';
const T = 777001;
const TOKEN = 'itest-token';
const BRIEFING = `=== TOPIC ${T} INTENT BRIEFING (auto-injected) ===\n  CURRENT WORK\n    goal: prove the delta hook\n=== END TOPIC INTENT BRIEFING ===`;

interface Rig { home: string; port: number; server: http.Server; hits: string[]; messages: Array<Record<string, unknown>>; briefing: string; reduce: boolean; seedFetches: SeedFetchLog }

async function startRig(withRoute: boolean): Promise<Rig> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-delta-int-'));
  const stateDir = path.join(home, '.instar');
  fs.mkdirSync(path.join(stateDir, 'hooks', 'instar'), { recursive: true });
  const rig: Rig = { home, port: 0, server: null as unknown as http.Server, hits: [], messages: [], briefing: BRIEFING, reduce: false, seedFetches: new SeedFetchLog() };
  const app = express();
  app.use((req, res, next) => {
    rig.hits.push(req.path);
    if (req.path === '/health') return next();
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.status(401).json({ error: 'unauthorized' }); return; }
    next();
  });
  app.get('/health', (_q, r) => { r.json({ ok: true }); });
  if (withRoute) {
    app.use(createPromptContextRoutes({
      stateDir, shadowOn: () => true, deltaSwitchOn: () => rig.reduce,
      // A healthy canary for the running version (the reduced-path test turns the switch on).
      canary: () => ({ report: { epochStartedAt: 0, switchOn: true, ledgerResetAt: null, unreadableTranscripts: 0,
        groups: [{ machine: 'm', engine: 'claude-code', version: '2.1', state: 'healthy', detected: 3, complete: 3, pending: 0, synthetic: 1 }],
        recent: [{ machine: 'm', engine: 'claude-code', version: '2.1', topicKey: String(T), sessionId: 's', boundaryUuid: 'b', at: 1, trigger: 'auto', recoveryBlock: true, postCompact: true, synthetic: true }] } }),
      briefing: () => rig.briefing, messages: (_t, limit) => rig.messages.slice(-limit), seedFetches: rig.seedFetches,
    }));
  }
  // The two calls an older server answers.
  app.get('/topic-intent/:id/briefing', (_q, r) => { r.type('text/plain').send(rig.briefing); });
  app.get('/telegram/topics/:id/messages', (_q, r) => { r.json({ topicId: T, messages: rig.messages.slice(-15) }); });
  await new Promise<void>((resolve) => { rig.server = app.listen(0, '127.0.0.1', () => resolve()); });
  rig.port = (rig.server.address() as AddressInfo).port;
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'itest', port: rig.port }));
  const m = new PostUpdateMigrator({ projectDir: home, stateDir, port: rig.port, hasTelegram: true, projectName: 'itest' });
  fs.writeFileSync(path.join(stateDir, 'hooks', 'instar', 'telegram-topic-context.sh'), (m as unknown as { getTelegramTopicContextHook(): string }).getTelegramTopicContextHook(), { mode: 0o755 });
  return rig;
}

/** Async: the server runs in THIS process, so a synchronous spawn would block it from answering. */
function runHook(rig: Rig, opts: { session?: string; env?: Record<string, string> } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [path.join(rig.home, '.instar', 'hooks', 'instar', 'telegram-topic-context.sh')], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', CLAUDE_PROJECT_DIR: rig.home, INSTAR_AUTH_TOKEN: TOKEN, INSTAR_AGENT_ID: 'itest', ...(opts.env ?? {}) },
    });
    let out = '';
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (c: string) => { out += c; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('hook timed out')); }, 30_000);
    child.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(out); else reject(new Error(`hook exited ${code}`)); });
    child.stdin.end(JSON.stringify({ prompt: `[telegram:${T}] hello there`, session_id: opts.session ?? 'sess-int-1' }));
  });
}

const now = Date.now();
const MSGS = [
  { messageId: 1, fromUser: true, timestamp: new Date(now - 60_000).toISOString(), text: 'first ask from the user' },
  { messageId: 2, fromUser: false, timestamp: new Date(now - 50_000).toISOString(), text: 'agent reply' },
  { messageId: 3, fromUser: true, timestamp: new Date(now - 10_000).toISOString(), text: 'hello there' },
];

describe('per-prompt hook → prompt-context route (real script, real server)', () => {
  let withRoute: Rig;
  let older: Rig;
  beforeAll(async () => { withRoute = await startRig(true); older = await startRig(false); });
  afterAll(async () => {
    for (const r of [withRoute, older]) {
      await new Promise<void>((resolve) => r.server.close(() => resolve()));
      SafeFsExecutor.safeRmSync(r.home, { recursive: true, force: true, operation: OP });
    }
  });
  afterEach(() => { withRoute.hits.length = 0; older.hits.length = 0; withRoute.messages = [...MSGS]; older.messages = [...MSGS]; withRoute.briefing = BRIEFING; withRoute.reduce = false; });

  it('makes ONE request for the context and prints the full output while in shadow', async () => {
    withRoute.messages = [...MSGS];
    const out = await runHook(withRoute);
    const ctx = withRoute.hits.filter((p) => p !== '/health');
    expect(ctx).toEqual([`/topic/${T}/prompt-context`]);
    expect(out).toContain('--- CURRENT TIME ---');
    expect(out).toContain('goal: prove the delta hook');
    expect(out).toContain(`TOPIC ${T} RECENT HISTORY (auto-injected):`);
    expect(out).toContain('first ask from the user');
    expect(out).toContain('*** UNANSWERED MESSAGE(S) FROM USER ***');
  });

  it('prints the same context as the two older calls (an older server: 404 → fallback)', async () => {
    older.messages = [...MSGS];
    withRoute.messages = [...MSGS];
    const viaFallback = await runHook(older);
    expect(older.hits.filter((p) => p !== '/health').sort()).toEqual([`/telegram/topics/${T}/messages`, `/topic-intent/${T}/briefing`, `/topic/${T}/prompt-context`].sort());
    const viaRoute = await runHook(withRoute);
    const strip = (s: string) => s.replace(/--- CURRENT TIME ---[\s\S]*?--- END CURRENT TIME ---/, '');
    expect(strip(viaRoute)).toBe(strip(viaFallback));
  });

  it('logs both sizes to the shadow log, ids only', async () => {
    withRoute.messages = [...MSGS];
    await runHook(withRoute, { session: 'sess-size-1' });
    const rows = new DeltaShadowLog(path.join(withRoute.home, '.instar')).rows().filter((r) => r.t === 'prompt' && r.session === 'sess-size-1');
    expect(rows).toHaveLength(1);
    const r = rows[0] as { fullChars: number; deltaChars: number; basis: string; returned: string };
    expect(r.fullChars).toBeGreaterThan(100);
    expect(r.deltaChars).toBe(r.fullChars); // never seeded ⇒ the delta is the full output
    expect(r.basis).toBe('unseeded-full');
    expect(r.returned).toBe('full');
    const raw = fs.readFileSync(new DeltaShadowLog(path.join(withRoute.home, '.instar')).file(), 'utf-8');
    expect(raw).not.toContain('first ask from the user');
  });

  it('a seeded session: the full output is still returned in shadow, and the delta is smaller', async () => {
    withRoute.messages = [...MSGS];
    const sd = path.join(withRoute.home, '.instar');
    fs.mkdirSync(path.join(sd, 'state', 'context-layers', '_seeded'), { recursive: true });
    // The seed's own fetches, then its marker.
    withRoute.seedFetches.noteBriefing(T, BRIEFING);
    withRoute.seedFetches.noteHistory(T);
    fs.writeFileSync(path.join(sd, 'state', 'context-layers', '_seeded', 'sess-seeded-1.json'), JSON.stringify({ sessionId: 'sess-seeded-1', epoch: '', source: 'compact', seededAt: Date.now() }));
    const out = await runHook(withRoute, { session: 'sess-seeded-1' });
    expect(out).toContain('first ask from the user'); // shadow: the full output reaches the session
    const r = new DeltaShadowLog(sd).rows().filter((x) => x.t === 'prompt' && x.session === 'sess-seeded-1')[0] as { basis: string; deltaChars: number; fullChars: number; omittedCount: number };
    expect(r.basis).toBe('seed');
    expect(r.omittedCount).toBeGreaterThanOrEqual(2);
    expect(r.deltaChars).toBeLessThan(r.fullChars);
  });

  it('a held fold marker suppresses the hook entirely (no time block, no request)', async () => {
    const sd = path.join(withRoute.home, '.instar');
    writeFoldMarker(sd, { instarSessionId: 'iid-fold-1', foldId: 'f1', topicKey: String(T), expiresAt: Date.now() + 60_000 });
    const out = await runHook(withRoute, { env: { INSTAR_SESSION_ID: 'iid-fold-1' } });
    expect(out).toBe('');
    expect(withRoute.hits).toEqual([]);
  });

  it('keeps the output under 9,000 characters on Claude Code, oldest history first', async () => {
    withRoute.messages = Array.from({ length: 15 }, (_, i) => ({ messageId: 100 + i, fromUser: i % 2 === 0, timestamp: new Date(now - (15 - i) * 1000).toISOString(), text: `m${i} ${'z'.repeat(290)}` }));
    withRoute.briefing = `${BRIEFING.split('\n')[0]}\n${Array.from({ length: 60 }, (_, i) => `  • [fact] item ${i} ${'b'.repeat(80)}`).join('\n')}\n=== END TOPIC INTENT BRIEFING ===`;
    const out = await runHook(withRoute);
    expect(Buffer.from(out, 'utf16le').length / 2).toBeLessThanOrEqual(9_001);
    expect(out).toContain('m14 '); // the newest message survives
    expect(out).toContain('to fit the hook output limit');
    // Codex keeps today's behaviour: no fitting.
    const codex = await runHook(withRoute, { env: { INSTAR_FRAMEWORK: 'codex-cli' } });
    expect(codex.length).toBeGreaterThan(9_000);
  });

  it('multi-line messages are dropped whole, and the newest messages outlast a huge briefing', async () => {
    withRoute.messages = Array.from({ length: 15 }, (_, i) => ({ messageId: 300 + i, fromUser: i % 2 === 0, timestamp: new Date(now - (15 - i) * 1000).toISOString(), text: `ml${i} ${'z'.repeat(200)}\ncontinued-ml${i}` }));
    withRoute.briefing = `${BRIEFING.split('\n')[0]}\n${Array.from({ length: 120 }, (_, i) => `  • [fact] item ${i} ${'b'.repeat(90)}`).join('\n')}\n=== END TOPIC INTENT BRIEFING ===`;
    const out = await runHook(withRoute);
    expect(Buffer.from(out, 'utf16le').length / 2).toBeLessThanOrEqual(9_001);
    for (let i = 10; i < 15; i++) expect(out).toContain(`ml${i} `); // the newest five always survive
    for (const m of out.matchAll(/continued-ml(\d+)/g)) expect(out).toContain(`ml${m[1]} z`); // no orphaned continuation line
    expect(out).toContain('briefing shortened to fit the hook output limit');
  });

  it('REDUCED path: with the switch on and the canary healthy, a seeded session receives only the delta', async () => {
    withRoute.reduce = true;
    const sd = path.join(withRoute.home, '.instar');
    fs.mkdirSync(path.join(sd, 'state', 'context-layers', '_seeded'), { recursive: true });
    withRoute.messages = MSGS.slice(0, 2);
    withRoute.seedFetches.noteBriefing(T, BRIEFING);
    withRoute.seedFetches.noteHistory(T);
    fs.writeFileSync(path.join(sd, 'state', 'context-layers', '_seeded', 'sess-red-1.json'), JSON.stringify({ sessionId: 'sess-red-1', epoch: '', source: 'compact', seededAt: Date.now() }));
    // The first prompt after the seed: no briefing (the seed delivered it), no old messages.
    const first = await runHook(withRoute, { session: 'sess-red-1' });
    expect(first).not.toContain('goal: prove the delta hook');
    expect(first).not.toContain('first ask from the user');
    expect(first).toContain(`TOPIC ${T}: no new messages since your last prompt`);
    // A new user message arrives: only it is sent, with the unanswered block taken from the full history.
    withRoute.messages = [...MSGS.slice(0, 2), { messageId: 9, fromUser: true, timestamp: new Date().toISOString(), text: 'a brand new question' }];
    const second = await runHook(withRoute, { session: 'sess-red-1' });
    expect(second).toContain(`TOPIC ${T} NEW MESSAGES SINCE YOUR LAST PROMPT`);
    expect(second).toContain('a brand new question');
    expect(second).not.toContain('agent reply');
    expect(second).toContain('*** UNANSWERED MESSAGE(S) FROM USER ***');
    // A changed briefing is sent again.
    withRoute.briefing = BRIEFING.replace('prove the delta hook', 'prove the reduced path');
    expect(await runHook(withRoute, { session: 'sess-red-1' })).toContain('prove the reduced path');
    // A changed briefing too large for the delta budget: that prompt gets the full output, never a starved briefing.
    withRoute.briefing = `${BRIEFING.split('\n')[0]}\n  big change ${'k'.repeat(8000)}\n=== END TOPIC INTENT BRIEFING ===`;
    const big = await runHook(withRoute, { session: 'sess-red-1' });
    expect(big).toContain('big change');
    expect(big).toContain(`TOPIC ${T} RECENT HISTORY (auto-injected):`);
    withRoute.briefing = BRIEFING;
    // Never seeded: the full output, switch or not.
    expect(await runHook(withRoute, { session: 'sess-red-unseeded' })).toContain('first ask from the user');
  });

  it('an open fold record for the topic: the route answers suppressed and the hook prints nothing at all', async () => {
    const sd = path.join(withRoute.home, '.instar');
    const store = new FoldRecordStore(sd);
    const t = Date.now();
    store.put({ schema: 'fold-record/1', foldId: 'fopen1', topicKey: String(T), machineId: 'm', state: 'locked', seq: 1, ownerEpoch: null, generation: 1, role: 'coordinator', counts: {}, createdAt: t, updatedAt: t });
    try {
      expect(await runHook(withRoute)).toBe('');
      expect(withRoute.hits).toContain(`/topic/${T}/prompt-context`);
      // Codex never folds: it still gets its context.
      expect(await runHook(withRoute, { env: { INSTAR_FRAMEWORK: 'codex-cli' } })).toContain('first ask from the user');
    } finally {
      store.put({ schema: 'fold-record/1', foldId: 'fopen1', topicKey: String(T), machineId: 'm', state: 'aborted', seq: 2, ownerEpoch: null, generation: 1, role: 'coordinator', counts: {}, createdAt: t, updatedAt: t });
    }
  });
});
