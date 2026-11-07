// safe-fs-allow: temporary test fixture cleanup.
import fs from 'node:fs';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { feedbackGitHubRuntimeHarness, FEEDBACK_RUNTIME_AUTH, settledFeedbackRuntimeTick } from '../fixtures/feedbackGitHubRuntimeHarness.js';

const edge = vi.hoisted(() => ({ ghPath: '' }));
// Keep real vault resolution, cache, environment construction, gateway and service.
vi.mock('../../src/core/githubRuntime.js', async (original) => {
  const actual = await original<typeof import('../../src/core/githubRuntime.js')>();
  return { ...actual, createAuthenticatedGitHubCliRuntimeResolver: (options: Parameters<typeof actual.createAuthenticatedGitHubCliRuntimeResolver>[0]) =>
    actual.createAuthenticatedGitHubCliRuntimeResolver({ ...options, resolveExecutable: () => edge.ghPath }) };
});
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'feedback runtime HTTP fixture cleanup' });
});

describe('feedback runtime authentication over HTTP', () => {
  it('the real executor registers its restart hold with the updater', async () => {
    const f = feedbackGitHubRuntimeHarness(); roots.push(f.root); edge.ghPath = f.ghPath;
    f.vault.set('github_token', 'fixture-vault-identity');
    const holds = new Map<string, () => unknown[]>();
    const server = f.createServer({ autoUpdater: {
      getStatus: () => null,
      setRestartHold: (key: string, provider: () => unknown[]) => { holds.set(key, provider); },
    } });
    try {
      await server.start();
      expect(holds.get('feedback-executor')?.()).toEqual([]);
    } finally { await server.stop(); }
  });

  it.each([true, false])('vault identity present=%s: the real executor reports the matching availability', async (present) => {
    const f = feedbackGitHubRuntimeHarness(); roots.push(f.root); edge.ghPath = f.ghPath;
    vi.stubEnv('GH_TOKEN', 'fixture-stale-ambient'); vi.stubEnv('GITHUB_TOKEN', '');
    if (present) f.vault.set('github_token', 'fixture-vault-identity');
    const server = f.createServer();
    try {
      await server.start();
      const app = server.getApp();
      expect((await request(app).get('/feedback-factory/execute/status')).status).toBe(401);
      const headers = { Authorization: `Bearer ${FEEDBACK_RUNTIME_AUTH}`, 'X-Instar-AgentId': 'runtime-fixture', 'X-Instar-Request': '1' };
      const { tick, status } = await settledFeedbackRuntimeTick(server, headers);
      expect(tick.status).toBe(202);
      expect(status.body.lastTick.runId).toBe(tick.body.runId);
      expect(status.status).toBe(200);
      expect(status.body.availability).toMatchObject({ available: present, reason: present ? 'ok' : 'github-unavailable' });
      expect(fs.existsSync(f.marker)).toBe(present);
      if (present) expect(status.body.availability).toMatchObject({ publisher: 'fixture-agent', approver: 'fixture-owner' });
      // Invoke the default consumer installed by production triage construction, not a fake list.
      const triage = (server as unknown as { feedbackTriage: { service: { opts: { listMergedPrs: () => Promise<unknown> } } } }).feedbackTriage;
      expect(await triage.service.opts.listMergedPrs()).toEqual(present
        ? [{ number: 17, title: 'Fixture fix', body: 'feedback-fixture', commits: [] }]
        : null);
    } finally { await server.stop(); }
  });
});
