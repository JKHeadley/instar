/**
 * Tier-3 "feature is alive" E2E for the relationship index (docs/specs/work-front-doors.md §4):
 * through the REAL AgentServer stack (auth middleware, the real createRoutes wiring, the real
 * prompt-context route), a development agent answers GET /conversation-neighbourhood with 200 (not
 * 503), the session-context route answers, the per-prompt route carries the field, and a fleet agent
 * answers 503. Also checks the hooks every agent gets on update fetch the block, the dev-gate
 * registration, and the awareness entry.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { boundAgentServerBase } from '../helpers/boundAgentServerBase.js';
import { DEV_GATED_FEATURES } from '../../src/core/devGatedFeatures.js';

const TOKEN = 'e2e-token';
const auth = { Authorization: `Bearer ${TOKEN}` };

async function boot(developmentAgent: boolean): Promise<{ server: AgentServer; base: string; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbh-alive-e2e-'));
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  const config = { projectName: 'nbh-alive-e2e', projectDir: dir, stateDir, port: 0, authToken: TOKEN, developmentAgent } as unknown as InstarConfig;
  const server = new AgentServer({ config, sessionManager: new SessionManager({ projectDir: dir, port: 0 }), state: new StateManager(stateDir) } as never);
  await server.start();
  return { server, base: boundAgentServerBase(server), dir };
}

describe('E2E: the conversation neighbourhood is ALIVE through the real AgentServer (development agent)', () => {
  let s: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => { s = await boot(true); }, 20000);
  afterAll(async () => {
    await s?.server.stop();
    SafeFsExecutor.safeRmSync(s.dir, { recursive: true, force: true, operation: 'tests/e2e/conversation-neighbourhood-alive.test.ts' });
  });

  it('GET /conversation-neighbourhood answers 200 with honest could-not-check labels, not 503', async () => {
    const r = await fetch(`${s.base}/conversation-neighbourhood?conversation=telegram:42`, { headers: auth });
    expect(r.status).toBe(200);
    const body = await r.json() as { schema: string; conversation: string; complete: boolean; couldNotCheck: string[]; ceilings: { blockBytes: number }; audience: { kind: string } };
    expect(body.schema).toBe('conversation-neighbourhood/1');
    expect(body.conversation).toBe('telegram:42');
    expect(body.audience.kind).not.toBe('unresolved');
    expect(body.ceilings.blockBytes).toBe(1800);
    // Nothing behind it on a bare agent: every source is named, never a false zero.
    expect(body.complete).toBe(false);
    expect(body.couldNotCheck.length).toBeGreaterThan(0);
  });

  it('the session-context route answers for a topic', async () => {
    const r = await fetch(`${s.base}/conversation-neighbourhood/session-context?topicId=42`, { headers: auth });
    expect(r.status).toBe(200);
    const body = await r.json() as { present: boolean; revision: string; block?: string };
    expect(typeof body.revision).toBe('string');
    if (body.present) expect(body.block).toMatch(/^<conversation-neighbourhood/);
  });

  it('the per-prompt route carries the neighbourhood field (wired, not undefined)', async () => {
    const r = await fetch(`${s.base}/topic/42/prompt-context?session=e2e1`, { headers: auth });
    expect(r.status).toBe(200);
    const body = await r.json() as { schema: string; neighbourhood?: unknown };
    expect(body.schema).toBe('prompt-context/1');
    expect(typeof body.neighbourhood).toBe('string');
  });

  it('without the bearer it is refused', async () => {
    expect((await fetch(`${s.base}/conversation-neighbourhood?conversation=telegram:42`)).status).toBe(401);
  });
});

describe('E2E: dark on the fleet', () => {
  let s: Awaited<ReturnType<typeof boot>>;
  beforeAll(async () => { s = await boot(false); }, 20000);
  afterAll(async () => {
    await s?.server.stop();
    SafeFsExecutor.safeRmSync(s.dir, { recursive: true, force: true, operation: 'tests/e2e/conversation-neighbourhood-alive.test.ts' });
  });

  it('a fleet agent answers 503 relationship-index-off', async () => {
    const r = await fetch(`${s.base}/conversation-neighbourhood?conversation=telegram:42`, { headers: auth });
    expect(r.status).toBe(503);
    expect((await r.json() as { error: string }).error).toBe('relationship-index-off');
  });
});

describe('E2E: what every agent receives on update', () => {
  it('the per-prompt hook prints the block and compaction-recovery fetches it; plain session start does not (its output is not fitted)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbh-hooks-'));
    const m = new PostUpdateMigrator({ stateDir: path.join(dir, '.instar'), port: 1, sessions: { claudePath: 'claude' } } as never) as unknown as { getHookContent(n: string): string };
    expect(m.getHookContent('session-start')).not.toMatch(/conversation-neighbourhood/);
    expect(m.getHookContent('compaction-recovery')).toMatch(/\/conversation-neighbourhood\/session-context\?topicId=/);
    expect(m.getHookContent('telegram-topic-context')).toMatch(/CB_PC_NEIGHBOURHOOD/);
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/conversation-neighbourhood-alive.test.ts' });
  });

  it('the feature is registered with the dev gate, and its awareness entry ships', () => {
    expect(DEV_GATED_FEATURES.find((f) => f.configPath === 'relationshipIndex.enabled')).toBeTruthy();
    expect(fs.existsSync(path.join(__dirname, '../../src/data/awareness/conversation-neighbourhood.md'))).toBe(true);
  });
});
