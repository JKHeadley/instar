// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * e2e — the Codex next-prompt seed is ALIVE on the production init path
 * (context-budget-layered-summaries §9.6 Codex column, §9.1; Phase 1 S17):
 * with server.ts's own gate the layers are built and the stager attached; a
 * Codex rollout compaction is detected by the canary (S16); the first prompt
 * after it is offered the verified standing packet through the route the
 * per-prompt hook calls; the hook's acknowledgement writes the seeded marker;
 * once Codex records the printed seed as model input, the canary counts that
 * compaction as RECOVERED (complete) and the next prompt gets nothing. A fleet agent (layers off) gets 503, so the hook prints
 * exactly today's output. Plus WIRED checks: the hook calls the route only for
 * Codex, Codex registers that hook on UserPromptSubmit, and server.ts wires the
 * Codex suite trigger.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContextLayers, contextLayersEnabled, type ContextLayers } from '../../src/monitoring/contextLayers/contextLayersBoot.js';
import { wireStandingPacket } from '../../src/monitoring/contextLayers/standingPacketBoot.js';
import { rowRefFor } from '../../src/monitoring/contextLayers/LayerStore.js';
import { CompactionCanary } from '../../src/monitoring/compactionCanary.js';
import { buildInstarCodexHookGroups } from '../../src/core/installCodexHooks.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/e2e/context-budget-codex-seed-alive.test.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const T = 141133;
const SID = '01a1c8e9-8b19-7d00-92cb-92bda3000003';
const FRAME = 'OPERATOR FRAME: keep Codex topics coherent across compactions.';

describe('Codex next-prompt seed — alive on the production init path', () => {
  const dirs: string[] = [];
  const mems: TopicMemory[] = [];
  const stops: Array<() => void> = [];
  afterEach(() => {
    for (const s of stops.splice(0)) s();
    for (const m of mems.splice(0)) m.close();
    for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP });
  });

  async function boot(config: { developmentAgent?: boolean; contextBudget?: { enabled?: boolean } }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cbcs-e2e-')); dirs.push(root);
    const sd = path.join(root, '.instar'); fs.mkdirSync(sd);
    const topicMemory = new TopicMemory(sd); await topicMemory.open(); mems.push(topicMemory);
    topicMemory.insertMessage({ messageId: 1, topicId: T, text: FRAME, fromUser: true, timestamp: new Date(Date.UTC(2026, 10, 10, 10)).toISOString(), sessionName: null });
    const sessions = [{ id: 'inst-codex', telegramTopicId: T, framework: 'codex-cli', claudeSessionId: SID }];
    // server.ts: the layers, gated; then the standing packet.
    const layers: ContextLayers | null = contextLayersEnabled(config, config.contextBudget?.enabled) ? buildContextLayers({ stateDir: sd, authToken: 'e2e-auth-token-0123456789' }) : null;
    if (layers) { const s = wireStandingPacket({ layers, stateDir: sd, topicMemory, sessions: () => sessions, debounceMs: 60_000 }); stops.push(() => s.stop()); }
    const ctx = {
      config: { projectName: 'e2e', projectDir: root, stateDir: sd, port: 0, authToken: 'e2e-auth-token-0123456789' } as never,
      sessionManager: { listRunningSessions: () => sessions } as never,
      state: { getJobState: () => null, getSession: () => null } as never,
      topicMemory, startTime: new Date(), contextLayers: layers,
    } as unknown as RouteContext;
    const app = express(); app.use(express.json()); app.use('/', createRoutes(ctx));
    const day = path.join(root, 'codex-home', 'sessions', '2026', '11', '10'); fs.mkdirSync(day, { recursive: true });
    const rollout = path.join(day, `rollout-2026-11-10T10-00-00-${SID}.jsonl`);
    // Stamped just after the canary's verification epoch starts (its first scan), as a live rollout would be.
    const t = new Date(Date.now() + 5_000).toISOString();
    fs.writeFileSync(rollout, [
      { timestamp: t, type: 'session_meta', payload: { id: SID, cli_version: '0.167.1' } },
      { timestamp: t, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 200_000 }, model_context_window: 258_400 } } },
      { timestamp: t, type: 'compacted', payload: { message: '', window_id: 'w-e2e-seed', replacement_history: [] } },
      { timestamp: t, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `[telegram:${T}] where were we?` }] } },
    ].map((x) => JSON.stringify(x)).join('\n') + '\n');
    return { app, layers, sd, rollout };
  }

  it('dev agent: detection → the first prompt gets the verified packet → the ack marks the epoch → the canary counts it recovered', async () => {
    const b = await boot({ developmentAgent: true });
    const meta = { author: { sessionId: null, machine: 'm_e2e', model: null, kind: 'derived' as const }, asOf: { at: Date.now(), lastMessageId: 1 } };
    b.layers!.store.writeProtected(String(T), 'u', 'm-1', [rowRefFor(1, FRAME)], meta, { label: 'operator', authority: 'operator', rowId: 1, at: Date.now() });
    b.layers!.store.writeProtected(String(T), 'anchor', 'current', [rowRefFor(1, FRAME)], { ...meta, status: 'anchored' }, { at: [Date.now()] });
    const canary = new CompactionCanary({ stateDir: b.sd, machineId: 'm_e2e', engineHooks: { onUsage: () => false, onCompaction: () => {}, onRearm: () => {} } });
    const session = { topicKey: String(T), claudeSessionId: SID, transcriptPath: b.rollout, engine: 'codex-cli' };
    canary.scan([session], true);
    expect(canary.report(true).groups.find((g) => g.engine === 'codex-cli')).toMatchObject({ detected: 1, complete: 0, pending: 1 });

    const body = { topicId: T, sessionId: SID, transcriptPath: b.rollout, framework: 'codex-cli' };
    const offer = await request(b.app).post('/context-budget/codex-seed').send(body);
    expect(offer.status).toBe(200);
    expect(offer.body).toMatchObject({ deliver: true, epoch: 'w-e2e-seed' });
    expect(offer.body.text).toContain(FRAME);
    expect((await request(b.app).post('/context-budget/codex-seed/ack').send({ sessionId: SID, transcriptPath: b.rollout, epoch: offer.body.epoch, carrier: offer.body.carrier })).status).toBe(200);
    // Codex records the printed seed as model input (a developer message): the canary's transcript evidence.
    fs.appendFileSync(b.rollout, `${JSON.stringify({ timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: offer.body.text }] } })}\n`);

    canary.scan([session], true);
    const g = canary.report(true).groups.find((x) => x.engine === 'codex-cli')!;
    expect(g).toMatchObject({ detected: 1, complete: 1, pending: 0, state: 'accruing', marking: 'synthesized' });
    expect(canary.report(true).recent.find((d) => d.boundaryUuid === 'w-e2e-seed')?.seededCarrier).toBe(offer.body.carrier);
    expect((await request(b.app).post('/context-budget/codex-seed').send(body)).body).toEqual({ deliver: false, reason: 'already-seeded' });
  });

  it('fleet agent: 503 — the hook falls through to today\'s output', async () => {
    const b = await boot({});
    expect(b.layers).toBeNull();
    expect((await request(b.app).post('/context-budget/codex-seed').send({ topicId: T, sessionId: SID, transcriptPath: b.rollout, framework: 'codex-cli' })).status).toBe(503);
  });

  it('WIRED: the per-prompt hook asks only for Codex and prints before acknowledging; Codex runs that hook on UserPromptSubmit; server.ts wires the Codex suite trigger', () => {
    const mig = fs.readFileSync(path.join(ROOT, 'src/core/PostUpdateMigrator.ts'), 'utf-8');
    expect(mig).toContain('if [ "\\${INSTAR_FRAMEWORK:-}" = "codex-cli" ] && [ -n "\\$AUTH_TOKEN" ]; then');
    const printAt = mig.indexOf(String.raw`printf '%s\\n\\n' "\$CB_SEED_TEXT"`);
    const ackAt = mig.indexOf('/context-budget/codex-seed/ack');
    expect(printAt).toBeGreaterThan(-1);
    expect(ackAt).toBeGreaterThan(printAt);
    const groups = buildInstarCodexHookGroups('/p');
    expect(groups.UserPromptSubmit[0].hooks.some((h) => h.command.includes('telegram-topic-context.sh'))).toBe(true);
    const src = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf-8');
    expect(src).toContain("codexAdapterSuite: productionAdapterSuite({ stateDir: config.stateDir, machine: built.holderId, claudePath: codexBinForSuite, engine: 'codex-cli' })");
    const routes = fs.readFileSync(path.join(ROOT, 'src/server/routes.ts'), 'utf-8');
    expect(routes).toContain("router.post('/context-budget/codex-seed'");
    expect(routes).toContain("router.post('/context-budget/codex-seed/ack'");
  });
});
