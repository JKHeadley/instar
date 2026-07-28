import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mock the cloudflared wrapper so Tunnel.quick returns a controllable EventEmitter.
const fakeTunnels: EventEmitter[] = [];
vi.mock('cloudflared', () => ({
  bin: '/fake/path/to/cloudflared',
  install: vi.fn(async () => {}),
  Tunnel: {
    quick: vi.fn(() => {
      const t = new EventEmitter() as EventEmitter & { process?: unknown; stop?: () => void };
      t.process = { pid: 999999, stderr: null };
      t.stop = () => {};
      fakeTunnels.push(t);
      return t;
    }),
  },
}));

import { classifyQuickTunnelError, CloudflareQuickProvider } from '../../src/tunnel/CloudflareQuickProvider.js';

describe('classifyQuickTunnelError — failure-reason decision boundary', () => {
  it('Cloudflare 429 / 1015 in stderr → rate-limited (even with a generic exit msg)', () => {
    // THE REGRESSION the stderr-capture fix targets: the exit msg is the opaque
    // "process-exit code 1", and the 429 lives only in the captured stderr.
    const e = classifyQuickTunnelError(
      'process-exit code 1: ',
      'ERR Error unmarshaling QuickTunnel response: error code: 1015 status_code="429 Too Many Requests"',
    );
    expect(e.message).toMatch(/^rate-limited:/);
  });

  it('"too many requests" / "rate limit" phrasing → rate-limited', () => {
    expect(classifyQuickTunnelError('x', 'Too Many Requests').message).toMatch(/^rate-limited:/);
    expect(classifyQuickTunnelError('x', 'rate limit exceeded').message).toMatch(/^rate-limited:/);
  });

  it('ENOENT / not found → binary-missing', () => {
    expect(classifyQuickTunnelError('spawn ENOENT', '').message).toMatch(/^binary-missing:/);
  });

  it('DNS / ECONNREFUSED → network', () => {
    expect(classifyQuickTunnelError('getaddrinfo EAI_AGAIN', '').message).toMatch(/^network:/);
    expect(classifyQuickTunnelError('connect ECONNREFUSED', '').message).toMatch(/^network:/);
  });

  it('an unrecognized failure is preserved as-is (so the manager sees the original prefix)', () => {
    expect(classifyQuickTunnelError('process-exit code 1: no stderr captured', '').message)
      .toBe('process-exit code 1: no stderr captured');
  });
});

describe('CloudflareQuickProvider — captures cloudflared stderr so 429 is detected (the fix)', () => {
  it("the 'stderr' listener feeds the 429 into classifyError → start() rejects rate-limited (not opaque process-exit)", async () => {
    fakeTunnels.length = 0;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfq-'));
    const provider = new CloudflareQuickProvider({ port: 4099, stateDir: tmp, startTimeoutMs: 8000 });
    const started = provider.start(4099);
    // start() awaits an async install; wait for Tunnel.quick to create the fake.
    await vi.waitFor(() => expect(fakeTunnels.length).toBeGreaterThan(0), { timeout: 4000 });
    const t = fakeTunnels[fakeTunnels.length - 1];
    // cloudflared prints the rate-limit on stderr, THEN the child exits non-zero.
    t.emit('stderr', 'ERR Error unmarshaling QuickTunnel response: error code: 1015 status_code="429 Too Many Requests"');
    t.emit('exit', 1);
    await expect(started).rejects.toThrow(/rate-limited/);
  });
});
