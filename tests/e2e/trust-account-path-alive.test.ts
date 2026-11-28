/**
 * Tier-3 E2E (feature is alive): trust-journey stage 0 part B on the production paths. A real
 * AgentServer serves the routes; the store rides a real CoherenceJournal through the replicated
 * emitter (the sink server.ts uses wherever the journal runs). The card flow raises a setting, the
 * record is durable in the journal, and a rebuilt runtime (a restart) runs the load check: the proven
 * raise stays, a hand-edited one is restored.
 */
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ReplicatedRecordEmitter } from '../../src/core/ReplicatedRecordEmitter.js';
import { ReplicatedPeerStreamReader } from '../../src/core/ReplicatedPeerStreamReader.js';
import { HybridLogicalClock } from '../../src/core/HybridLogicalClock.js';
import { AdaptiveTrust } from '../../src/core/AdaptiveTrust.js';
import { ExternalOperationGate, AUTONOMY_PROFILES } from '../../src/core/ExternalOperationGate.js';
import { createTrustJourneyRuntime, journalSink } from '../../src/core/trustJourney/TrustJourneyRuntime.js';
import { TRUST_GRANT_KIND_REGISTRATION, TRUST_JOURNEY_STORE_KEY } from '../../src/core/trustJourney/TrustJourneyStore.js';
import { acceptanceStatement } from '../../src/core/trustJourney/accountPath.js';
import { trustJourneyBackupFiles } from '../../src/core/BackupManager.js';

const AUTH = 'tj-e2e-token';
const OWNER = 424242;
const tmpDirs: string[] = [];
afterAll(() => { for (const d of tmpDirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/trust-account-path-alive.test.ts' }); });

function mkConfig() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tj-alive-e2e-')); tmpDirs.push(tmpDir);
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
  const config = {
    projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH, requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
  } as unknown as InstarConfig;
  return { config, stateDir };
}

function journalRig(stateDir: string) {
  const reg = new ReplicatedKindRegistry(); reg.register(TRUST_GRANT_KIND_REGISTRATION);
  const journal = new CoherenceJournal({ stateDir, machineId: 'm1', flushIntervalMs: 1_000_000 } as never);
  journal.open(); journal.setReplicatedKindRegistry(reg);
  let t = Date.parse('2026-11-16T08:00:00Z');
  const emitter = new ReplicatedRecordEmitter({ journal, clock: new HybridLogicalClock({ node: 'm1', now: () => (t += 1000) }), registry: reg, origin: 'm1', stores: () => ({ [TRUST_JOURNEY_STORE_KEY]: { enabled: true } }), loadWitness: () => undefined });
  const streams = new ReplicatedPeerStreamReader({ stateDir, registry: reg, selfMachineId: 'm1', autoRebuild: false });
  const sink = journalSink({
    emit: (k, b) => { const r = emitter.emit(TRUST_JOURNEY_STORE_KEY, k, b as never); journal.flush(); return { outcome: r.outcome, ...(r.seq !== undefined ? { seq: r.seq } : {}) }; },
    awaitDurable: async () => { journal.flush(); },
    loadUnion: () => {
      journal.flush();
      const out: Array<{ recordKey: string; data: Record<string, unknown> }> = [];
      for (const byOrigin of streams.loadAllOriginRecords(TRUST_JOURNEY_STORE_KEY).values()) for (const r of byOrigin) out.push({ recordKey: r.envelope.recordKey, data: { ...r.data } });
      return out;
    },
  });
  return { journal, sink };
}

describe('Trust account path E2E (feature is alive)', () => {
  it('a started production server admits connector reads without granting writes, including after runtime reload', async () => {
    const { config, stateDir } = mkConfig();
    const rig = journalRig(stateDir);
    const trust = new AdaptiveTrust({ stateDir });
    const makeRuntime = () => createTrustJourneyRuntime({
      stateDir, configPath: path.join(stateDir, 'config.json'), runtimeConfig: config as never,
      installationId: 'connector-e2e', sink: rig.sink, adaptiveTrust: trust,
      autonomyManager: null, trustRecovery: null, telegram: null, slack: null,
      slackOwnerUserId: () => null, holdsLease: () => true,
    });
    try {
      for (let boot = 0; boot < 2; boot++) {
        const runtime = makeRuntime();
        const server = new AgentServer({ config, sessionManager: { listRunningSessions: () => [], getSession: () => null } as never,
          state: new StateManager(stateDir), adaptiveTrust: trust, trustAccountPath: runtime,
          operationGate: new ExternalOperationGate({ stateDir, autonomyDefaults: AUTONOMY_PROFILES.collaborative }),
        });
        await server.start();
        try {
          const evaluate = (tool_name: string) => request(server.getApp()).post('/operations/evaluate')
            .set('Authorization', `Bearer ${AUTH}`).send({ service: tool_name.split('__')[1], mutability: 'modify',
              reversibility: 'reversible', description: 'connector lifecycle fixture', tool_name, tool_input: {} });
          for (const name of ['mcp__codex_apps__github__fetch_pr', 'mcp__codex_apps__github_get_pr_info', 'mcp__other_engine__github__list_pull_requests',
            'mcp__threadline__threadline_discover', 'mcp__threadline__threadline_agents']) {
            const response = await evaluate(name);
            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({ action: 'proceed', trust: { verdict: 'not-gated', why: 'read' } });
          }
          expect(runtime.store.openRequests()).toHaveLength(0);
          for (const name of ['mcp__codex_apps__github__push_files', 'mcp__other_engine__github_read_then_merge', 'mcp__bridge__inspect_read', 'mcp__bridge__opaque',
            'mcp__threadline__threadline_send', 'mcp__threadline__threadline_delete']) {
            const response = await evaluate(name);
            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({ action: 'ask', trust: { verdict: 'ask', why: 'no-grant' } });
          }
        } finally { await server.stop(); }
      }
    } finally { rig.journal.close(); }
  });

  it('routes answer, the card flow raises through the journal, and a restart keeps the proven raise and restores a hand edit', async () => {
    const { config, stateDir } = mkConfig();
    const rig = journalRig(stateDir);
    const trust = new AdaptiveTrust({ stateDir });
    const sent: Array<{ text: string; replyTo?: number; messageId: number }> = [];
    let id = 100;
    const mk = (sink = rig.sink) => createTrustJourneyRuntime({
      stateDir, configPath: path.join(stateDir, 'config.json'), runtimeConfig: config as never, installationId: 'e2e', sink,
      adaptiveTrust: trust, autonomyManager: null, trustRecovery: null,
      telegram: { getOwnerUserId: () => OWNER, sendOwnerDirect: async (text, replyTo) => { const messageId = id++; sent.push({ text, replyTo, messageId }); return { messageId }; } },
      slack: null, slackOwnerUserId: () => null, holdsLease: () => true,
    });
    const runtime = mk();
    const server = new AgentServer({ config, sessionManager: { listRunningSessions: () => [], getSession: () => null } as never, state: new StateManager(stateDir), adaptiveTrust: trust, trustAccountPath: runtime });
    await server.start();
    try {
      const app = server.getApp();
      const auth = { Authorization: `Bearer ${AUTH}` };
      // Alive: the routes answer (not 503) with the runtime wired through AgentServer.
      expect((await request(app).get('/trust/requests').set(auth)).status).toBe(200);
      // The token alone cannot raise.
      expect((await request(app).post('/trust/grant').set(auth).send({ service: 'gmail', operation: 'write', level: 'autonomous', statement: 'self' })).status).toBe(403);
      // The agent opens the request; the server asks for acceptance first.
      const open = await request(app).post('/trust/requests').set(auth).send({ change: { kind: 'trust-grant', service: 'gmail', operation: 'write', level: 'autonomous' } });
      expect(open.status).toBe(202);
      const stmt = acceptanceStatement({ adapter: 'telegram', accountId: String(OWNER), installationId: 'e2e' });
      const receipt = (text: string, n: number, replyTo?: string) => ({
        receiptId: `tg-${n}`, adapter: 'telegram' as const, senderId: String(OWNER), chatId: String(OWNER), chatType: 'private',
        messageId: String(9000 + n), ...(replyTo ? { replyToMessageId: replyTo } : {}), text, senderIsBot: false, forwarded: false,
        uniqueKey: `tg-update:${n}`, receivedAt: new Date().toISOString(), receivedBy: 'self',
      });
      expect(await runtime.ingest(receipt(stmt, 1))).toBe('acceptance-recorded');
      const card = sent.find((m) => m.text.includes('reply to this message with: approve'))!;
      // The code is on the person's card only; the agent's response never carries it.
      expect(open.body.code).toBeUndefined();
      const code = /approve ([0-9A-Z]{6})/.exec(card.text)![1];
      expect(await runtime.ingest(receipt(`approve ${code}`, 2, String(card.messageId)))).toBe('approved');
      expect(trust.getTrustLevel('gmail', 'write').level).toBe('autonomous');
      // Durable in the journal and in the backup set.
      rig.journal.flush();
      expect(trustJourneyBackupFiles(stateDir).some((f) => f.endsWith('.trust-grant-record.jsonl'))).toBe(true);

      // Restart: a new runtime over the same journal keeps the proven raise.
      const restarted = mk();
      expect(await restarted.checkAtLoad()).toEqual([]);
      expect(trust.getTrustLevel('gmail', 'write').level).toBe('autonomous');
      expect(restarted.store.openRequests()).toHaveLength(0);

      // A hand edit of another operation, wider than its committed narrowing, is restored at load.
      trust.grantTrust('gmail', 'delete', 'blocked', 'never delete');
      await new Promise((r) => setTimeout(r, 50));
      const profileFile = path.join(stateDir, 'state', 'trust-profile.json');
      const p = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
      p.services.gmail.operations.delete.level = 'autonomous';
      fs.writeFileSync(profileFile, JSON.stringify(p));
      const trust2 = new AdaptiveTrust({ stateDir });
      const again = createTrustJourneyRuntime({
        stateDir, configPath: path.join(stateDir, 'config.json'), runtimeConfig: config as never, installationId: 'e2e', sink: rig.sink,
        adaptiveTrust: trust2, autonomyManager: null, trustRecovery: null, telegram: null, slack: null, slackOwnerUserId: () => null, holdsLease: () => true,
      });
      const narrowed = await again.checkAtLoad();
      expect(narrowed.map((n) => n.key)).toEqual(['gmail.delete']);
      expect(trust2.getTrustLevel('gmail', 'delete').level).toBe('blocked');
      expect(trust2.getTrustLevel('gmail', 'write').level).toBe('autonomous');
    } finally { await server.stop(); rig.journal.close(); }
  });
});
