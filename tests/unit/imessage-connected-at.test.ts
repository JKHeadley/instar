/**
 * `getConnectionInfo().connectedAt` must report when the adapter CONNECTED, not when you asked.
 *
 * THE DEFECT. The field was computed inline as `started ? new Date().toISOString() : undefined`, so
 * every read returned the current time. Ask three times, get three different "connection times", all
 * wrong — and each looks MORE precise than the `state` field beside it, which is what makes it worse
 * than an absent value: a fabricated timestamp invites arithmetic (uptime, staleness, "connected
 * how long ago?") on a number that means nothing.
 *
 * Found while adding the iMessage row to the channel registry, where the honest choice was to build
 * the verdict on `state` and explicitly NOT on this field. This fixes the field rather than leaving a
 * permanent "do not trust that one" note beside it.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/messaging/imessage/IMessageAdapter.ts'),
  'utf-8',
);

describe('iMessage connectedAt is recorded, not synthesised', () => {
  it('THE FIX: getConnectionInfo no longer manufactures a timestamp on read', () => {
    const fn = SRC.slice(SRC.indexOf('getConnectionInfo(): ConnectionInfo'));
    const body = fn.slice(0, fn.indexOf('\n  }'));
    // The exact defect: a fresh Date() inside the getter.
    expect(body).not.toMatch(/new Date\(\)/);
    expect(body).toContain('this.connectedAtIso');
  });

  it('the instant is captured at connect time, immediately after started flips true', () => {
    const start = SRC.slice(SRC.indexOf('async start(): Promise<void>'));
    const body = start.slice(0, start.indexOf('\n  }'));
    expect(body).toContain('this.started = true');
    expect(body).toContain('this.connectedAtIso = new Date().toISOString()');
  });

  it('and is CLEARED on stop — a stale timestamp would outlive the connection', () => {
    // The other side of the boundary. Without this, a stopped adapter would still report a
    // connection time, which is the same class of false precision in a different direction.
    const stop = SRC.slice(SRC.indexOf('async stop(): Promise<void>'));
    const body = stop.slice(0, stop.indexOf('\n  }'));
    expect(body).toContain('this.connectedAtIso = null');
  });

  it('the field starts null, so an adapter that never connected reports no time', () => {
    expect(SRC).toMatch(/private connectedAtIso: string \| null = null;/);
  });
});
