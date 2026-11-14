/** Wiring integrity: production must pass both deps, and the verb must be reachable. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf-8');
const server = read('src/commands/server.ts');
const rpc = read('src/core/MeshRpc.ts');

describe('step 2 claim and history wiring', () => {
  it('the router gets a real live-session check for Telegram and Slack', () => {
    const start = server.indexOf('liveLocalSession: (sk) => {');
    expect(start).toBeGreaterThan(-1);
    const block = server.slice(start, start + 340);
    expect(block).toContain('getSessionForTopic');
    expect(block).toContain('getSessionForChannel');
    expect(block).toContain('isSessionAlive');
  });
  it('the dispatcher serves the verb from real Telegram history', () => {
    const start = server.indexOf("'topic-history-pull': (cmd) =>");
    expect(start).toBeGreaterThan(-1);
    expect(server.slice(start, start + 220)).toContain('getTopicHistory');
  });
  it('the verb is in the read class, open to any registered peer', () => {
    expect(rpc).toMatch(/case 'topic-history-pull':\n/);
  });
  it('the moved-session spawn asks over the signed mesh first, from the lease holder', () => {
    expect(server).toContain('signedPull: _pullRouterHistory');
    const start = server.indexOf('_pullRouterHistory = async (topic) => {');
    expect(start).toBeGreaterThan(-1);
    const block = server.slice(start, start + 420);
    expect(block).toContain('leaseHolder');
    expect(block).toContain("type: 'topic-history-pull'");
  });
  it('the bearer fallback has a deadline, so a hung holder cannot stall the spawn', () => {
    const start = server.indexOf('bearerFetch: async (topic) => {');
    expect(server.slice(start, start + 420)).toContain('AbortSignal.timeout');
  });
});
