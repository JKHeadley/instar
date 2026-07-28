/**
 * Integration test — Self-Violation Signal recording path (Correction &
 * Preference Learning Sentinel extension).
 *
 * Tier 2: the full HTTP pipeline. A finalized outbound message that contradicts
 * a stored preference (one carrying a `violationPattern`) is recorded as a
 * self-violation in the CorrectionLedger when enabled + the sub-flag is on, and
 * is observable on the /corrections read surface. The recording reinforces the
 * matched preference's recurrence: a SECOND self-violation of the SAME
 * preference collapses to one record (occurrenceCount increments).
 *
 * Gating is asserted on both sides of the boundary: sub-flag off / feature off.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { PreferencesManager } from '../../src/core/PreferencesManager.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'sv-int-token';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

interface Built { dir: string; server: AgentServer; delivered: Array<{ topicId: number; text: string }>; }

function telegramStub(delivered: Array<{ topicId: number; text: string }>): any {
  return {
    onMessageLogged: null,
    async sendToTopic(topicId: number, text: string) { delivered.push({ topicId, text }); return {}; },
    getSessionForTopic: () => null,
    isSessionAlive: () => true,
  };
}

function build(opts: { enabled: boolean; selfViolationSignal?: boolean }): Built {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-int-'));
  fs.mkdirSync(path.join(dir, '.instar', 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.instar', 'state', 'jobs'), { recursive: true });
  const delivered: Array<{ topicId: number; text: string }> = [];
  const config: InstarConfig = {
    projectName: 'sv-int', agentName: 'Int', projectDir: dir,
    stateDir: path.join(dir, '.instar'), port: 0, authToken: AUTH,
    ...(opts.enabled
      ? { monitoring: { correctionLearning: { enabled: true, selfViolationSignal: opts.selfViolationSignal ?? false } } }
      : {}),
  } as InstarConfig;
  const sm = createMockSessionManager() as any;
  sm.clearInjectionTracker = () => {};
  const server = new AgentServer({
    config, sessionManager: sm, state: new StateManager(path.join(dir, '.instar')), telegram: telegramStub(delivered),
  });
  return { dir, server, delivered };
}

function seedPref(dir: string, pattern: string, dedupeKey = 'user-preference:fresh'): void {
  new PreferencesManager(path.join(dir, '.instar')).recordPreference({
    learning: "don't defer work to a fresh session — there is no tail of a session",
    dedupeKey, confidence: 0.9, violationPattern: pattern,
  });
}

/** Poll /corrections until at least minRecords land (the observe call is async). */
async function waitForRecords(server: AgentServer, minRecords: number): Promise<any[]> {
  for (let i = 0; i < 40; i++) {
    const list = await request(server.getApp()).get('/corrections').set(auth());
    if (list.status === 200 && list.body.records.length >= minRecords) return list.body.records;
    await new Promise((r) => setTimeout(r, 25));
  }
  const last = await request(server.getApp()).get('/corrections').set(auth());
  return last.body?.records ?? [];
}

describe('Self-Violation Signal — recording path (integration)', () => {
  let built: Built | null = null;
  afterEach(() => {
    if (built) { SafeFsExecutor.safeRmSync(built.dir, { recursive: true, force: true, operation: 'sv-int' }); built = null; }
  });

  it('records a self-violation as a user-preference correction when enabled + flag on', async () => {
    built = build({ enabled: true, selfViolationSignal: true });
    seedPref(built.dir, 'regex:fresh session');

    const res = await request(built.server.getApp())
      .post('/telegram/reply/901').set(auth())
      .send({ text: "I'll continue this in a fresh session tomorrow." });
    expect(res.status).toBe(200);

    const records = await waitForRecords(built.server, 1);
    expect(records.length).toBe(1);
    expect(records[0].kind).toBe('user-preference');
    expect(records[0].topicId).toBe(901);
    // The dedupeKey is the violated preference's KEY-class (kind:hash) — but the
    // ledger keys on kind:hash(learning), so the scrubbed summary is what serves.
    expect(typeof records[0].scrubbedSummary).toBe('string');
    expect(records[0].scrubbedSummary.length).toBeGreaterThan(0);
  });

  it('a repeated self-violation of the SAME preference collapses to one record (occurrence increments)', async () => {
    built = build({ enabled: true, selfViolationSignal: true });
    seedPref(built.dir, 'regex:fresh session');

    await request(built.server.getApp()).post('/telegram/reply/902').set(auth())
      .send({ text: 'going to a fresh session now' });
    await waitForRecords(built.server, 1);
    await request(built.server.getApp()).post('/telegram/reply/902').set(auth())
      .send({ text: 'again, a fresh session please' });

    // Still exactly ONE record; occurrenceCount escalates (recurrence reinforced).
    let records: any[] = [];
    for (let i = 0; i < 40; i++) {
      const list = await request(built.server.getApp()).get('/corrections').set(auth());
      records = list.body.records;
      if (records.length === 1 && records[0].occurrenceCount >= 2) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(records.length).toBe(1);
    expect(records[0].occurrenceCount).toBeGreaterThanOrEqual(2);
  });

  it('GATED: sub-flag OFF records nothing (ledger present, /corrections 200 empty)', async () => {
    built = build({ enabled: true, selfViolationSignal: false });
    seedPref(built.dir, 'regex:fresh session');
    const res = await request(built.server.getApp()).post('/telegram/reply/903').set(auth())
      .send({ text: 'a fresh session, just for fun' });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 120));
    const list = await request(built.server.getApp()).get('/corrections').set(auth());
    expect(list.status).toBe(200);
    expect(list.body.records).toHaveLength(0);
  });

  it('GATED: feature fully OFF → /corrections 503 and message still delivers', async () => {
    built = build({ enabled: false });
    const res = await request(built.server.getApp()).post('/telegram/reply/904').set(auth())
      .send({ text: 'a fresh session here' });
    expect(res.status).toBe(200);
    expect(built.delivered[0].text).toBe('a fresh session here');
    const list = await request(built.server.getApp()).get('/corrections').set(auth());
    expect(list.status).toBe(503);
  });

  it('the served record never leaks the raw violated-preference learning text over HTTP', async () => {
    built = build({ enabled: true, selfViolationSignal: true });
    // Use a sentinel string inside the preference learning; the recorded
    // `learning` quotes it, but toApiView must strip `learning` from the wire.
    new PreferencesManager(path.join(built.dir, '.instar')).recordPreference({
      learning: 'RAW-SV-PREF-MUST-NOT-LEAK fresh session',
      dedupeKey: 'user-preference:leaktest',
      confidence: 0.9,
      violationPattern: 'regex:fresh session',
    });
    await request(built.server.getApp()).post('/telegram/reply/905').set(auth())
      .send({ text: 'fresh session incoming' });
    const records = await waitForRecords(built.server, 1);
    expect(records.length).toBe(1);
    const list = await request(built.server.getApp()).get('/corrections').set(auth());
    expect(JSON.stringify(list.body)).not.toContain('RAW-SV-PREF-MUST-NOT-LEAK');
  });
});
