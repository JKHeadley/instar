// safe-fs-allow: temporary test fixture cleanup.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { feedbackGitHubRuntimeHarness, FEEDBACK_RUNTIME_AUTH, settledFeedbackRuntimeTick } from '../fixtures/feedbackGitHubRuntimeHarness.js';

const edge = vi.hoisted(() => ({ ghPath: '' }));
vi.mock('../../src/core/githubRuntime.js', async (original) => {
  const actual = await original<typeof import('../../src/core/githubRuntime.js')>();
  return { ...actual, createAuthenticatedGitHubCliRuntimeResolver: (options: Parameters<typeof actual.createAuthenticatedGitHubCliRuntimeResolver>[0]) =>
    actual.createAuthenticatedGitHubCliRuntimeResolver({ ...options, resolveExecutable: () => edge.ghPath }) };
});
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'feedback runtime lifecycle fixture cleanup' });
});

describe('production feedback GitHub runtime lifecycle', () => {
  it('recovers on real AgentServer reconstruction after the canonical vault credential changes', async () => {
    const f = feedbackGitHubRuntimeHarness(); roots.push(f.root); edge.ghPath = f.ghPath;
    vi.stubEnv('GH_TOKEN', 'fixture-stale-ambient'); vi.stubEnv('GITHUB_TOKEN', '');
    f.vault.set('github_token', 'fixture-old-vault');
    const headers = { Authorization: `Bearer ${FEEDBACK_RUNTIME_AUTH}`, 'X-Instar-AgentId': 'runtime-fixture', 'X-Instar-Request': '1' };
    for (const repaired of [false, true]) {
      if (repaired) f.vault.set('github_token', 'fixture-vault-identity');
      const server = f.createServer();
      try {
        await server.start();
        const { tick, status } = await settledFeedbackRuntimeTick(server, headers);
        expect(tick.status).toBe(202);
        expect(status.body.lastTick.runId).toBe(tick.body.runId);
        expect(status.status).toBe(200);
        expect(status.body.availability).toMatchObject({ available: repaired, reason: repaired ? 'ok' : 'github-unavailable' });
        expect(status.body.live).toBe(0);
      } finally { await server.stop(); }
    }
  });
});
