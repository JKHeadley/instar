// safe-git-allow: test file — tmpdir scratch dirs only.
// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 "feature is alive" for the attribution paper trail (docs/specs/attribution-paper-trail.md).
 * Boots the REAL AgentServer on the production init path, on a dev config and a fleet config, and runs
 * the REAL generated hook as a subprocess against it. The laptop-rule chain from the case study is the
 * regression case, on the row shapes the logs really hold.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig, IntelligenceProvider } from '../../src/core/types.js';
import { AgentServer } from '../../src/server/AgentServer.js';

const AUTH = 'test-e2e-attribution';
const OWNER = 7812716706;
const created: string[] = [];

// A real Telegram row, a real agent post under the same topic.
const realRow = { messageId: 123160, topicId: 102965, text: 'at least every hour and a half or so or two hours', fromUser: true, timestamp: '2026-10-08T04:34:33.000Z', sessionName: 'echo-1', senderName: 'Justin', senderUsername: 'jk', telegramUserId: OWNER, forwarded: false, provenance: 'user' };
const agentPost = { messageId: 123161, topicId: 102965, text: 'I will never spawn on the laptop.', fromUser: false, timestamp: '2026-10-08T04:35:00.000Z', sessionName: 'echo-1', provenance: 'agent' };
const SOURCED = 'Justin: "at least every hour and a half or so or two hours" [source: telegram 102965/123160 2026-10-08]';

const claimsOf = (list: unknown[]) => JSON.stringify({ claims: list });
const credit = (over: object) => ({ person: 'Justin', kind: 'rule', markerIndex: null, labelled: false, stillCredits: false, ...over });

/**
 * Stands in for the model on its real prompts, and only the model. It reads the text as the judge
 * would for this fixture's phrases, so the verdict path through the server is the real one.
 */
const stubIntelligence: IntelligenceProvider = {
  evaluate: async (prompt: string) => {
    if (prompt.includes('You decide whether a new claim')) {
      const list = prompt.split('name="earlier-claims"')[1] ?? '';
      const first = list.match(/^(\d+): /m);
      return JSON.stringify({ match: first ? Number(first[1]) : null });
    }
    if (prompt.includes('You compare a claim')) return JSON.stringify({ ownWords: 'own', faithful: true, why: 'stub' });
    const text = prompt.split('name="text"')[1] ?? '';
    const found: unknown[] = [];
    const spans: Array<[RegExp, object]> = [
      [/An earlier note credited this to Justin; source unknown\. \[source unknown\]/, { labelled: true }],
      [/Justin's standing rule: never spawn on the laptop \[source unknown\]/, { labelled: true, stillCredits: true }],
      [/Justin corrected me/, {}],
      [/# Justin's standing rules/, {}],
      [/I broke your rule/, {}],
    ];
    for (const [pattern, over] of spans) {
      const match = pattern.exec(text);
      if (match) found.push(credit({ span: match[0], ...over }));
    }
    if (text.includes('[source: telegram')) found.push(credit({ span: 'Justin:', markerIndex: 0 }));
    return claimsOf(found);
  },
};

interface Booted { server: AgentServer; project: string; stateDir: string; hook: string; port: number; close: () => Promise<void> }

function config(project: string, stateDir: string, attribution: InstarConfig['attribution'], developmentAgent: boolean): InstarConfig {
  const base = { projectName: 'e2e', projectDir: project, stateDir, port: 0, authToken: AUTH, requestTimeoutMs: 10000, version: '0.0.0', developmentAgent, monitoring: { promptGate: { ownerId: OWNER } } } as unknown as Record<string, unknown>;
  applyDefaults(base, getMigrationDefaults('standalone'));
  if (attribution) base.attribution = attribution;
  return base as unknown as InstarConfig;
}

async function boot(attribution: InstarConfig['attribution'], developmentAgent: boolean): Promise<Booted> {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'attr-e2e-')));
  created.push(project);
  const stateDir = path.join(project, '.instar');
  fs.mkdirSync(path.join(stateDir, 'hooks', 'instar'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'agent-memory'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'telegram-messages.jsonl'), `${[realRow, agentPost].map((r) => JSON.stringify(r)).join('\n')}\n`);
  // The owner name is read from the config file on disk, as in production.
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, authToken: AUTH, projectName: 'e2e', threadline: { ownerName: 'Justin' } }));
  const server = new AgentServer({
    config: config(project, stateDir, attribution, developmentAgent),
    sessionManager: { listRunningSessions: () => [], getSession: () => null } as never,
    state: new StateManager(stateDir),
    intelligence: stubIntelligence,
  } as never);
  await server.start();
  const listener: Server = await new Promise((resolve) => { const s = server.getApp().listen(0, '127.0.0.1', () => resolve(s)); });
  const port = (listener.address() as AddressInfo).port;
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port, authToken: AUTH, projectName: 'e2e', threadline: { ownerName: 'Justin' } }));
  const migrator = new PostUpdateMigrator({ projectDir: project, stateDir, port, hasTelegram: false, projectName: 'e2e' });
  const hook = path.join(stateDir, 'hooks', 'instar', 'attribution-gate.js');
  fs.writeFileSync(hook, migrator.getHookContent('attribution-gate'), { mode: 0o755 });
  return {
    server, project, stateDir, hook, port,
    close: async () => {
      await new Promise<void>((done) => { listener.closeAllConnections?.(); listener.close(() => done()); });
      await server.stop();
    },
  };
}

function runHook(agent: Pick<Booted, 'project' | 'hook'>, payload: unknown): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [agent.hook], { env: { ...process.env, CLAUDE_PROJECT_DIR: agent.project, INSTAR_AUTH_TOKEN: AUTH } });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

describe('attribution paper trail: feature alive, dark on the fleet', () => {
  let dev: Booted;
  let fleet: Booted;
  let enforced: Booted;

  beforeAll(async () => {
    dev = await boot(undefined, true);
    fleet = await boot(undefined, false);
    enforced = await boot({ enabled: true, mode: 'enforce' }, false);
  }, 60_000);

  afterAll(async () => {
    for (const agent of [dev, fleet, enforced]) await agent?.close();
    for (const dir of created.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/attribution-feature-alive.test.ts:cleanup' });
  });

  const auth = { Authorization: `Bearer ${AUTH}` };
  const memory = (agent: Booted) => path.join(agent.stateDir, 'MEMORY.md');
  const writeNote = (agent: Booted, content: string) => runHook(agent, { tool_name: 'Write', tool_input: { file_path: memory(agent), content } });

  it('is alive on a development agent in record mode (200, not 503)', async () => {
    const res = await request(dev.server.getApp()).get('/attribution/status').set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, mode: 'record' });
  });

  it('is dark on a fleet config, every route 503', async () => {
    expect((await request(fleet.server.getApp()).get('/attribution/status').set(auth)).status).toBe(503);
    expect((await request(fleet.server.getApp()).post('/attribution/check').set(auth).send({ text: 'x' })).status).toBe(503);
  });

  it('the routes require Bearer auth', async () => {
    expect((await request(dev.server.getApp()).get('/attribution/status')).status).toBe(401);
  });

  it('a fleet agent\'s hook passes a credited write, untouched', async () => {
    expect((await writeNote(fleet, 'Justin corrected me: never spawn on the laptop.')).code).toBe(0);
  });

  it('a dev agent in record mode passes it too, and writes the would-refuse to the ledger', async () => {
    expect((await writeNote(dev, 'Justin corrected me: never spawn on the laptop.')).code).toBe(0);
    const ledger = path.join(dev.stateDir, 'attribution', 'ledger.jsonl');
    await expect.poll(() => fs.existsSync(ledger) && fs.readFileSync(ledger, 'utf8').includes('Justin corrected me')).toBe(true);
    expect(fs.readFileSync(ledger, 'utf8')).toContain('"enforced":false');
  });

  it('enforce: the hook refuses a credited write with exit 2 and the honest ways through', async () => {
    const result = await writeNote(enforced, 'Justin corrected me: never spawn on the laptop.');
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Justin corrected me');
    expect(result.stderr).toContain('[source unknown]');
  });

  it('enforce: a label that removes the credit passes', async () => {
    expect((await writeNote(enforced, 'Never spawn on the laptop. An earlier note credited this to Justin; source unknown. [source unknown]')).code).toBe(0);
  });

  it('enforce: a label that still credits is refused as promoted-unsourced', async () => {
    const result = await writeNote(enforced, "Justin's standing rule: never spawn on the laptop [source unknown]");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('still credits');
  });

  it('enforce: a real source passes', async () => {
    expect((await writeNote(enforced, SOURCED)).code).toBe(0);
    const status = await request(enforced.server.getApp()).get('/attribution/status').set(auth);
    expect(status.body.pins).toBeGreaterThan(0);
  });

  it('enforce: a heading-only reattribution is seen', async () => {
    fs.writeFileSync(memory(enforced), '# Rules\n- never spawn on the laptop\n');
    const result = await runHook(enforced, { tool_name: 'Edit', tool_input: { file_path: memory(enforced), old_string: '# Rules', new_string: "# Justin's standing rules" } });
    expect(result.code).toBe(2);
  });

  it('a Codex apply_patch payload reaches the same gate', async () => {
    const patch = `*** Begin Patch\n*** Update File: ${memory(enforced)}\n@@\n # Rules\n+Justin corrected me\n*** End Patch`;
    expect((await runHook(enforced, { tool_name: 'functions.apply_patch', tool_input: { input: patch } })).code).toBe(2);
  });

  it('a file out of scope exits at once without asking, and other tools too', async () => {
    const out = await runHook(enforced, { tool_name: 'Write', tool_input: { file_path: path.join(enforced.project, 'src.ts'), content: 'Justin corrected me' } });
    expect(out.code).toBe(0);
    expect((await runHook(enforced, { tool_name: 'Read', tool_input: { file_path: memory(enforced) } })).code).toBe(0);
  });

  it('the hook passes when the server is gone', async () => {
    const lonely = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'attr-e2e-lonely-')));
    created.push(lonely);
    fs.mkdirSync(path.join(lonely, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(lonely, '.instar', 'config.json'), JSON.stringify({ port: 9, authToken: AUTH }));
    const result = await runHook({ project: lonely, hook: enforced.hook }, { tool_name: 'Write', tool_input: { file_path: path.join(lonely, '.instar', 'MEMORY.md'), content: 'Justin corrected me' } });
    expect(result.code).toBe(0);
  });

  it('the laptop-rule chain: a note, a firmer note and a message read as one visible chain', async () => {
    const app = dev.server.getApp();
    const ledger = path.join(dev.stateDir, 'attribution', 'ledger.jsonl');
    // "Justin corrected me", with no pointer. Refused in enforce; recorded here.
    await writeNote(dev, 'Justin corrected me: never spawn on the laptop.');
    await expect.poll(() => fs.existsSync(ledger) && fs.readFileSync(ledger, 'utf8').includes('Justin corrected me')).toBe(true);
    // Later: the copy reads as his standing rule, in another note.
    await runHook(dev, { tool_name: 'Write', tool_input: { file_path: path.join(dev.stateDir, 'agent-memory', 'laptop.md'), content: "# Justin's standing rules\n- never spawn on the laptop" } });
    await expect.poll(() => fs.readFileSync(ledger, 'utf8').includes("# Justin's standing rules")).toBe(true);
    // Then the message to him.
    await request(app).post('/attribution/check').set(auth).send({ text: 'I broke your rule about the laptop.', surface: 'send' });

    await expect.poll(async () => {
      const res = await request(app).get('/attribution/trace').query({ q: 'I broke your rule' }).set(auth);
      return (res.body.rows as Array<{ claim: string }>).map((r) => r.claim);
    }).toEqual(expect.arrayContaining(['Justin corrected me', "# Justin's standing rules", 'I broke your rule']));
    const final = await request(app).get('/attribution/trace').query({ q: 'I broke your rule' }).set(auth);
    const claims = (final.body.rows as Array<{ claim: string }>).map((r) => r.claim);
    expect(claims.indexOf('Justin corrected me')).toBeLessThan(claims.indexOf('I broke your rule'));
    expect((final.body.rows as Array<{ inferred?: boolean }>).some((r) => r.inferred)).toBe(true);
  });

  it('an agent post under the person\'s topic is never accepted as their words', async () => {
    const res = await request(enforced.server.getApp()).post('/attribution/check').set(auth)
      .send({ text: 'Justin: "I will never spawn on the laptop." [source: telegram 102965/123161 2026-10-08]' });
    expect(res.body.verdict).toBe('refuse');
    expect(res.body.findings[0].reason).toBe('record-not-theirs');
  });

  it('a citation no machine can show is refused, not called false', async () => {
    const res = await request(enforced.server.getApp()).post('/attribution/check').set(auth)
      .send({ text: 'Justin: "made up words" [source: telegram 102965/999 2026-10-08]' });
    expect(res.body.findings[0]).toMatchObject({ reason: 'cannot-be-shown', outcome: 'not-found' });
  });

  it('the audit runs through the route and writes nothing to the note', async () => {
    fs.writeFileSync(memory(enforced), 'Justin corrected me long ago.\n');
    const before = fs.readFileSync(memory(enforced), 'utf8');
    const res = await request(enforced.server.getApp()).post('/attribution/audit').set(auth).send({});
    expect(res.status).toBe(200);
    expect(res.body.report.unsourced.length).toBeGreaterThan(0);
    expect(fs.readFileSync(memory(enforced), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(enforced.stateDir, 'attribution', 'report.json'))).toBe(true);
  });
});
