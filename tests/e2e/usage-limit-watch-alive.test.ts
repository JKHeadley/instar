// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Phase-1 "is it alive": the production wiring constructs the watch and registers it for /health,
 * and the whole episode runs on a real state file: limit, operator told, restart, usage back.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { UsageLimitWatch, activeUsageLimitWatch, setActiveUsageLimitWatch, OPERATOR_OK_TEXT, PROBE_START_MS } from '../../src/core/UsageLimitWatch.js';

const ROOT = path.resolve(__dirname, '../..');

describe('usage limit watch is alive', () => {
  it('server.ts builds it, registers it and boots it', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf-8');
    expect(source).toContain('const usageLimitWatch = new UsageLimitWatch({');
    expect(source).toContain('setActiveUsageLimitWatch(usageLimitWatch);');
    expect(source).toContain('usageLimitWatch.boot();');
    expect(source).toContain('activeUsageLimitWatch()?.start();');
    expect(fs.readFileSync(path.join(ROOT, 'src/server/routes.ts'), 'utf-8')).toContain('activeUsageLimitWatch()?.status()');
  });

  it('a whole episode, through a server restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-limit-alive-'));
    let clock = 1_000_000;
    const operator: string[] = [];
    const refreshed: string[] = [];
    const probes: Array<'ok' | 'limited'> = ['limited', 'ok'];
    const make = () => new UsageLimitWatch({
      stateFile: path.join(dir, 'state', 'usage-limit-watch.json'),
      confirmSession: () => true,
      anotherAccountHasRoom: () => false,
      accountKnownToHaveRoom: () => false,
      stillWalled: () => true,
      bannerFor: () => "You've hit your weekly limit · resets Nov 8, 11am (UTC)",
      channelFor: () => ({ platform: 'telegram', topicId: 5 }),
      probe: async () => probes.shift() ?? 'ok',
      keyFingerprint: () => null,
      isKeyAgent: () => false,
      listWalledSessions: async () => [],
      isSessionRunning: () => true,
      recoveryPrompt: async () => ({ prompt: 'answer', held: 1 }),
      refresh: async (s) => { refreshed.push(s); return { ok: true }; },
      answeredSince: async () => true,
      notifyOperator: async (t) => { operator.push(t); return true; },
      notifySession: async () => true,
      notifyChannel: async () => true,
      report: () => {},
      now: () => clock,
      manualTimers: true,
    });
    const first = make();
    first.boot();
    first.start();
    setActiveUsageLimitWatch(first);
    await first.noteWall('sess');
    expect(activeUsageLimitWatch()?.status()?.status).toBe('limited');
    const second = make();
    second.boot();
    second.start();
    setActiveUsageLimitWatch(second);
    clock += PROBE_START_MS;
    await second.tick(); // still limited
    expect(second.isLimited()).toBe(true);
    clock += PROBE_START_MS * 2;
    await second.tick(); // back
    expect(activeUsageLimitWatch()?.status()).toBeNull();
    expect(refreshed).toEqual(['sess']);
    expect(operator.at(-1)).toBe(OPERATOR_OK_TEXT);
    setActiveUsageLimitWatch(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
