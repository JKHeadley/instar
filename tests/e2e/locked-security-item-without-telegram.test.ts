/**
 * Production boot path, no Telegram: the locked-screen security item
 * ("a Mac may still be unlocked") lands on the local attention list and is
 * readable through GET /attention. Remote desktop stays off here, so no real
 * Mac desktop helper is ever started.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locked-security-no-tg-'));
  const stateDir = path.join(dir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'no-telegram', port: 0 }));
  const config = {
    projectName: 'no-telegram', projectDir: dir, stateDir, port: 0, authToken: 'no-tg-e2e',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
  } as InstarConfig;
  const server = new AgentServer({ config, state: new StateManager(stateDir), telegram: null,
    sessionManager: { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [] } as never });
  await server.start();
  return { server, dir, stateDir };
}
const auth = { Authorization: 'Bearer no-tg-e2e' };

describe('locked-screen security item without Telegram (production boot path)', () => {
  it('the attention list is alive (200, not 503) and the security item reaches it', async () => {
    const { server, dir, stateDir } = await boot();
    try {
      const empty = await request(server.getApp()).get('/attention').set(auth);
      expect(empty.status).toBe(200);
      expect(empty.body).toMatchObject({ items: [], count: 0, surface: 'local' });

      // The same method the DesktopLockedController's raiseSecurity dependency calls.
      const raise = (server as unknown as { raiseLockedSecurityItem: (i: { key: string; title: string; body: string }) => Promise<boolean> }).raiseLockedSecurityItem.bind(server);
      expect(await raise({ key: 'desktop-relock-failed:abc', title: 'A Mac may still be unlocked', body: 'Lock it, or open it to check.' })).toBe(true);

      const list = await request(server.getApp()).get('/attention').set(auth);
      expect(list.status).toBe(200);
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0]).toMatchObject({ id: 'agent:desktop-relock-failed:abc', title: 'A Mac may still be unlocked',
        priority: 'HIGH', category: 'security', sourceContext: 'desktop-locked', status: 'OPEN' });
      expect(fs.existsSync(path.join(stateDir, 'state', 'local-attention-items.json'))).toBe(true);
    } finally { await server.stop(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test cleanup' }); }
  });
});
