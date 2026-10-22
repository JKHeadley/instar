/**
 * A held-reply notice must not promise a retry it will never perform.
 *
 * Two kinds of hold share one notice. A FORWARDED hold (handed to the lease
 * holder, handover failed) genuinely is retried. A DIRECT-PATH hold — sealed by
 * this machine before it discovered it does not hold the serving lease — cannot
 * be forwarded at all, because the sealed record is bound to the machine that
 * produced it. It is never retried; it waits for the lease and otherwise expires.
 *
 * Measured on one agent before this change: 152 direct-path operations, 0 ever
 * retried, 0 ever sent, 133 expired undelivered. Every one had produced a notice
 * saying it was "retried on the recovery schedule".
 *
 * The notice text is built inline at its call site, so these assertions are made
 * against the real source — the same approach the convergence-check tests take.
 * That verifies the wording and the wiring, not the runtime render; the honest
 * limit is stated rather than papered over.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const SRC = path.join(
  path.dirname(url.fileURLToPath(import.meta.url)),
  '..', '..', 'src', 'commands', 'server.ts',
);
const source = fs.readFileSync(SRC, 'utf-8');

describe('held-reply notice tells the truth about retrying', () => {
  it('the direct-path branch says it is NOT retried', () => {
    expect(source).toMatch(/awaitsLeaseReturn\s*\n?\s*\?[^]*?is NOT retried/);
  });

  it('the direct-path branch says it cannot be forwarded, and why', () => {
    const branch = source.slice(source.indexOf('input.awaitsLeaseReturn'));
    expect(branch).toMatch(/sealed to this machine/);
    expect(branch).toMatch(/CANNOT be forwarded/);
  });

  it('the direct-path branch names the lease as the only way it can still be sent', () => {
    const branch = source.slice(source.indexOf('input.awaitsLeaseReturn'));
    expect(branch).toMatch(/if the lease returns here/);
  });

  it('the forwarded branch still promises the retry it genuinely performs', () => {
    expect(source).toContain('retried on the recovery schedule');
  });

  it('the two branches are different text, not the same sentence twice', () => {
    const i = source.indexOf('input.awaitsLeaseReturn');
    const branch = source.slice(i, i + 1200);
    const directSaysNotRetried = /is NOT retried/.test(branch);
    const forwardedSaysRetried = /retried on the recovery schedule/.test(branch);
    expect(directSaysNotRetried && forwardedSaysRetried).toBe(true);
  });

  it('exactly one call site claims the direct path', () => {
    const hits = source.match(/awaitsLeaseReturn:\s*true/g) ?? [];
    expect(hits).toHaveLength(1);
  });

  it('that call site is the direct-path observer, not the forward path', () => {
    const marker = source.indexOf('awaitsLeaseReturn: true');
    const observer = source.lastIndexOf('onLeaseHoldObserved', marker);
    const forwardPath = source.lastIndexOf('outcome.noticeDelivered', marker);
    expect(observer).toBeGreaterThan(-1);
    // the nearest preceding handler must be the direct-path observer
    expect(observer).toBeGreaterThan(forwardPath);
  });
});
