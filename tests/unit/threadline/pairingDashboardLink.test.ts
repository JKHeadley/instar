/**
 * The "do this on the dashboard" sentence for pairing messages (topic 10000002573: Cora's
 * no-owner refusal said "Open the Threadline tab" with no link). Every origin state is covered:
 * public link, local-only link with the reason, no link yet, address unknown.
 */
import { describe, it, expect } from 'vitest';
import {
  pairingDashboardLine, pairingDashboardUrl, readPairingOrigin, PAIRING_PAGE_ROUTE, PAIRING_PASTE_ROUTE,
} from '../../../src/threadline/pairingDashboardLink.js';

describe('pairingDashboardLine', () => {
  it('tunnel up: the public link to the exact page, with nothing after it', () => {
    const t = pairingDashboardLine({ kind: 'public', origin: 'https://cora.example.dev' }, 'Paste the invite', PAIRING_PASTE_ROUTE);
    expect(t).toBe('Paste the invite on the dashboard with your PIN: https://cora.example.dev/dashboard/console/#/people/agents?connect=paste');
  });
  it('no tunnel: the local link, and says plainly it opens only on the agent\'s computer', () => {
    const t = pairingDashboardLine({ kind: 'local', origin: 'http://localhost:4041', reason: 'no-tunnel' }, 'Finish it', PAIRING_PAGE_ROUTE);
    expect(t).toContain('opens only on the computer it runs on');
    expect(t.endsWith('http://localhost:4041/dashboard/console/#/people/agents')).toBe(true);
  });
  it('tunnel down too long: the local link with that reason', () => {
    const t = pairingDashboardLine({ kind: 'local', origin: 'http://localhost:4041', reason: 'tunnel-wait-exceeded' }, 'Finish it', PAIRING_PAGE_ROUTE);
    expect(t).toContain('public address is down');
    expect(t).toContain('http://localhost:4041/dashboard/console/#/people/agents');
  });
  it('tunnel still starting: no link, and it says why and when to try again', () => {
    const t = pairingDashboardLine({ kind: 'pending' }, 'Paste the invite', PAIRING_PASTE_ROUTE);
    expect(t).not.toMatch(/https?:\/\//);
    expect(t).toContain("can't give you a link yet");
    expect(t).toContain('Other agents page');
  });
  it('address unknown: no link, and it says so (never a bare "open the tab")', () => {
    const t = pairingDashboardLine(null, 'Paste the invite', PAIRING_PASTE_ROUTE);
    expect(t).not.toMatch(/https?:\/\//);
    expect(t).toContain("I don't know this agent's dashboard address");
  });
  it('pairingDashboardUrl: a link only when there is an origin to use', () => {
    expect(pairingDashboardUrl({ kind: 'public', origin: 'https://a.dev/' }, PAIRING_PAGE_ROUTE)).toBe('https://a.dev/dashboard/console/#/people/agents');
    expect(pairingDashboardUrl({ kind: 'pending' }, PAIRING_PAGE_ROUTE)).toBeNull();
    expect(pairingDashboardUrl(null, PAIRING_PAGE_ROUTE)).toBeNull();
  });
  it('readPairingOrigin: a missing or throwing resolver reads as unknown', () => {
    expect(readPairingOrigin(undefined)).toBeNull();
    expect(readPairingOrigin(() => { throw new Error('x'); })).toBeNull();
    expect(readPairingOrigin(() => ({ kind: 'pending' }))).toEqual({ kind: 'pending' });
  });
});
