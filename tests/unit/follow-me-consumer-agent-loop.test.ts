import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'follow-me-agent-loop-test' });
  }
});

describe('AgentServer delivered follow-me controller', () => {
  it('attempts once per pair, parks unchanged identity failures, and wakes only when identity resolves', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-23T00:00:00.000Z'));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'follow-me-agent-loop-'));
    dirs.push(stateDir);
    const mandate = (id: string) => ({
      id,
      portable: {
        mandate: {
          revoked: false,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          authorities: [{ action: 'account-follow-me', bounds: { accountId: 'acct' } }],
        },
      },
    });
    const server = Object.create(AgentServer.prototype) as AgentServer & Record<string, unknown>;
    server.config = {
      host: '127.0.0.1', port: 4044, authToken: 'test', stateDir, projectName: 'test',
      machineId: 'target',
    };
    server.deliveredMandateStore = { list: () => [mandate('m1'), mandate('m2')] };
    server.followMeConsumerRunning = false;
    server.followMeConsumerBackoff = null;

    let resolved = false;
    let enrollCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('pending-logins')) return new Response(JSON.stringify({ logins: [] }), { status: 200 });
      if (url.includes('scope=pool')) {
        return new Response(JSON.stringify(resolved
          ? { accounts: [{ id: 'acct', email: 'owner@example.com' }], emailGaps: [] }
          : { accounts: [], emailGaps: [{ accountId: 'acct' }] }), { status: 200 });
      }
      if (url.endsWith('/subscription-pool')) {
        return new Response(JSON.stringify({ accounts: [] }), { status: 200 });
      }
      enrollCalls += 1;
      return new Response(JSON.stringify({
        code: 'account-record-missing-email',
      }), { status: 409 });
    }));

    const advances = [0, 60_000, 5 * 60_000, 15 * 60_000];
    for (let pass = 0; pass < 4; pass += 1) {
      vi.advanceTimersByTime(advances[pass]!);
      await (server as unknown as { driveDeliveredFollowMeEnrollments(): Promise<void> })
        .driveDeliveredFollowMeEnrollments();
    }
    expect(enrollCalls).toBe(4);
    await (server as unknown as { driveDeliveredFollowMeEnrollments(): Promise<void> })
      .driveDeliveredFollowMeEnrollments();
    expect(enrollCalls).toBe(4);

    resolved = true;
    await (server as unknown as { driveDeliveredFollowMeEnrollments(): Promise<void> })
      .driveDeliveredFollowMeEnrollments();
    expect(enrollCalls).toBe(5);
  });
});
