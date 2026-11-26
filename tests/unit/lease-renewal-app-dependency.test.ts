/**
 * A Telegram-free agent keeps its serving lease for native app conversations.
 *
 * Before: only an enabled Telegram adapter enrolled the holder-only renewal timer. On a
 * non-development agent with no Telegram the lease lapsed at TTL and was re-acquired only at
 * the next 2-minute heartbeat (epoch +1 per tick), so POST /mobile/chat/app/:key answered
 * 503 owner-unavailable for the gap. Now native app conversations enroll the same carrier.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { originLeaseDependencyFixture } from '../helpers/originLeaseDependency.js';
import { leaseRenewalDependencies } from '../../src/server/leaseRenewalDependencies.js';
import type { InstarConfig } from '../../src/core/types.js';
import { ORIGIN_LEASE_APP_SENTENCE, ORIGIN_LEASE_LEGACY_SENTENCE, refreshOriginLeaseAwareness, telegramOriginLeaseAwareness } from '../../src/messaging/telegram-origin/OriginAwareness.js';

const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); vi.useRealTimers(); });

async function fixture(options: Parameters<typeof originLeaseDependencyFixture>[0] = {}) {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const clock = { value: Date.now() };
  const h = await originLeaseDependencyFixture({ ...options, clock });
  close.push(h.close);
  const advance = async (ms: number) => { clock.value += ms; await vi.advanceTimersByTimeAsync(ms); };
  /** Sample holdsLease every 5 s across `seconds` (crosses the 2-minute heartbeat ticks). */
  const sample = async (seconds: number) => {
    const held: boolean[] = [];
    for (let t = 0; t < seconds; t += 5) { held.push(h.coordinator.holdsLease()); await advance(5000); }
    return held;
  };
  return { ...h, clock, advance, sample };
}

const cfg = (c: Record<string, unknown>) => ({ messaging: [], ...c }) as unknown as InstarConfig;

describe('leaseRenewalDependencies', () => {
  it('names app conversations on a Telegram-free agent with the app on', () => {
    expect(leaseRenewalDependencies(cfg({ mobilePairing: { enabled: true, native: { enabled: true } } }))).toEqual(['app-conversations']);
  });
  it('names both surfaces when both are on, and the Telegram writer alone without the app', () => {
    const telegram = [{ type: 'telegram', enabled: true, config: {} }];
    expect(leaseRenewalDependencies(cfg({ messaging: telegram, mobilePairing: { enabled: true, native: { enabled: true } } })))
      .toEqual(['telegram-origin-writer', 'app-conversations']);
    expect(leaseRenewalDependencies(cfg({ messaging: telegram }))).toEqual(['telegram-origin-writer']);
  });
  it('names nothing on a non-development agent with neither surface (the standalone gate is unchanged)', () => {
    expect(leaseRenewalDependencies(cfg({}))).toEqual([]);
    expect(leaseRenewalDependencies(cfg({ messaging: [{ type: 'telegram', enabled: false, config: {} }] }))).toEqual([]);
    expect(leaseRenewalDependencies(cfg({ mobilePairing: { enabled: true, native: { enabled: false } } }))).toEqual([]);
  });
  it('names the takeover survivor only when the takeover switch is on, with no surface needed', () => {
    const lease = (enabled: boolean) => ({ multiMachine: { leaseSelfHeal: { soloCaptainHold: { enabled } } } });
    expect(leaseRenewalDependencies(cfg(lease(true)))).toEqual(['takeover-survivor']);
    expect(leaseRenewalDependencies(cfg(lease(false)))).toEqual([]);
  });
  it('follows the app gate on a development agent (omitted ⇒ on)', () => {
    expect(leaseRenewalDependencies(cfg({ developmentAgent: true }))).toEqual(['app-conversations']);
  });
});

describe('app-conversations lease renewal dependency', () => {
  it('REPRODUCTION: on a shared store without any dependency, a non-development agent loses its lease between heartbeat ticks', async () => {
    const h = await fixture({ enroll: false, sharedStore: true });
    const held = await h.sample(240);
    expect(held.filter((x) => !x).length).toBeGreaterThan(0);
    expect(h.lc.currentEpoch()).toBeGreaterThan(1); // re-acquired, epoch climbed
  });

  it('keeps the lease held continuously at the same epoch across heartbeat ticks', async () => {
    const h = await fixture({ dependency: 'app-conversations' });
    const held = await h.sample(360);
    expect(held.every(Boolean)).toBe(true);
    expect(h.lc.currentEpoch()).toBe(1);
  });

  it('still yields to a higher-epoch holder elsewhere: no renewal, no hold', async () => {
    const h = await fixture({ dependency: 'app-conversations' });
    const renew = vi.spyOn(h.lc, 'renew');
    const peer = h.peerLease.signLease(2, new Date(h.clock.value).toISOString(), new Date(h.clock.value + 60_000).toISOString(), 1);
    expect(h.store.casWrite(peer).ok).toBe(true);
    await h.advance(30_000);
    expect(renew).not.toHaveBeenCalled();
    expect(h.coordinator.holdsLease()).toBe(false);
  });

  it('respects an explicit resilientRenew false', async () => {
    const h = await fixture({ dependency: 'app-conversations', enabled: false });
    const renew = vi.spyOn(h.lc, 'renew');
    await h.advance(30_000); await h.advance(30_000); await h.advance(1000);
    expect(renew).not.toHaveBeenCalled();
    expect(h.coordinator.holdsLease()).toBe(false);
  });

  it('does not renew on an observe-only machine', async () => {
    const h = await fixture({ dependency: 'app-conversations' });
    const renew = vi.spyOn(h.lc, 'renew');
    Object.assign(h.config.multiMachine.leaseSelfHeal, { leaseRole: 'observe-only' });
    await h.advance(30_000); await h.advance(30_000); await h.advance(1000);
    expect(renew).not.toHaveBeenCalled();
  });
});

describe('server boot wiring', () => {
  it('enrolls every lease renewal dependency before the lease is initialized', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/commands/server.ts'), 'utf8');
    const enroll = src.indexOf('leaseRenewalDependencies(config).map((name) => coordinator.enrollLeaseRenewalDependency(name))');
    expect(enroll).toBeGreaterThan(0);
    expect(src.indexOf('await coordinator.initializeLease()')).toBeGreaterThan(enroll);
  });
});

describe('agent awareness', () => {
  it('new agents get the app sentence; an installed paragraph is refreshed in place, once', () => {
    expect(telegramOriginLeaseAwareness()).toContain(ORIGIN_LEASE_APP_SENTENCE);
    expect(telegramOriginLeaseAwareness()).not.toContain(ORIGIN_LEASE_LEGACY_SENTENCE);
    const installed = `# Agent\n\n${telegramOriginLeaseAwareness().replace(ORIGIN_LEASE_APP_SENTENCE, ORIGIN_LEASE_LEGACY_SENTENCE)}\nOther text mentioning: ${ORIGIN_LEASE_LEGACY_SENTENCE}\n`;
    const once = refreshOriginLeaseAwareness(installed);
    expect(once).toContain(ORIGIN_LEASE_APP_SENTENCE);
    expect(once).toContain(`Other text mentioning: ${ORIGIN_LEASE_LEGACY_SENTENCE}`); // only the paragraph line
    expect(refreshOriginLeaseAwareness(once)).toBe(once);
  });
});
