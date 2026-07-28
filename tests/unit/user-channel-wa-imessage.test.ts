/**
 * WhatsApp and iMessage join the channel registry.
 *
 * WHY THIS EXISTS. When the direct user channels were added (PR #1665) the artifact recorded an
 * explicit gap: "WhatsApp and iMessage adapters exist in the tree and are NOT covered — under the
 * registry's own 'absence is impossible' property that is a real gap." A channel with no row cannot
 * report that it is missing, so the honest limit was a hole in the very invariant the registry
 * exists to hold. This closes it rather than leaving the note standing permanently.
 *
 * THE STATE THAT MATTERS. WhatsApp is not a boolean — its adapter runs a real state machine, and
 * `qr-pending` means the link is alive and waiting for a HUMAN to scan a pairing code. A boolean
 * would flatten that into "not working" and send someone to debug a connection behaving exactly as
 * designed. It is `reachable-no-credential`: reachable, unauthenticated, and a restart will not help.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { whatsappStateFrom, imessageStateFrom } from '../../src/core/userChannels.js';

describe('WhatsApp channel verdicts', () => {
  it('THE STATE A BOOLEAN LOSES: qr-pending is reachable-no-credential, not broken', () => {
    const r = whatsappStateFrom('qr-pending');
    expect(r.state).toBe('reachable-no-credential');
    // The operator must be told a restart is the wrong action here.
    expect(r.detail).toMatch(/scan/i);
  });

  it('connected is working, and says what it does NOT prove', () => {
    const r = whatsappStateFrom('connected');
    expect(r.state).toBe('working');
    expect(r.detail).toMatch(/not proof/i);
  });

  it.each(['disconnected', 'closed'] as const)('%s is broken', (s) => {
    expect(whatsappStateFrom(s).state).toBe('broken');
  });

  it.each(['connecting', 'reconnecting'] as const)('%s is unknown — in flight, not guessed', (s) => {
    const r = whatsappStateFrom(s);
    expect(r.state).toBe('unknown');
    expect(r.detail).toMatch(/in flight/i);
  });

  it('no adapter is not-configured — off is not broken', () => {
    expect(whatsappStateFrom(null).state).toBe('not-configured');
  });

  it('an UNRECOGNISED state is unknown — never working, never a confident broken', () => {
    // The failure direction that matters: a state this module has not seen must not read as healthy.
    const r = whatsappStateFrom('some-future-state' as never);
    expect(r.state).toBe('unknown');
    expect(r.detail).toMatch(/unrecognised/i);
  });
});

describe('iMessage channel verdicts', () => {
  it('connected is working, and says what it does NOT prove', () => {
    const r = imessageStateFrom('connected');
    expect(r.state).toBe('working');
    expect(r.detail).toMatch(/not proof/i);
  });

  it('disconnected is broken', () => {
    expect(imessageStateFrom('disconnected').state).toBe('broken');
  });

  it('connecting is unknown — in flight', () => {
    expect(imessageStateFrom('connecting').state).toBe('unknown');
  });

  it('no adapter is not-configured', () => {
    expect(imessageStateFrom(null).state).toBe('not-configured');
  });

  it('an unrecognised backend state is unknown', () => {
    expect(imessageStateFrom('weird').state).toBe('unknown');
  });
});

describe('source ratchets — the verdicts must keep reading LIVE state', () => {
  const src = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/core/userChannels.ts'),
    'utf-8',
  );

  it('never reads configuration to decide liveness', () => {
    // The original defect this whole module exists to prevent: a setting read as a state.
    expect(src).not.toMatch(/\.configured\b/);
  });

  /**
   * The trap inside this fix. `getConnectionInfo()` also exposes `connectedAt`, computed as
   * `started ? new Date().toISOString() : undefined` — it reports the moment you ASKED, never the
   * moment it connected. A row built on it would look precise and be fiction, which is exactly the
   * failure the registry exists to prevent, rebuilt inside its own extension.
   */
  it('RATCHET: the iMessage verdict is not built on the always-now connectedAt field', () => {
    const fn = src.slice(src.indexOf('export function imessageStateFrom'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).not.toMatch(/connectedAt/);
  });

  it('RATCHET: the route wires WhatsApp from getStatus().state, not a boolean', () => {
    const routes = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/server/routes.ts'),
      'utf-8',
    );
    expect(routes).toContain('ctx.whatsapp.getStatus().state');
    expect(routes).toContain('ctx.imessage.getConnectionInfo().state');
  });
});
