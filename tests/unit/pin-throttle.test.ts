import { describe, it, expect } from 'vitest';
import { PinThrottle, normalizePinSource, coarsePinNetwork, DEFAULT_PIN_THROTTLE_CONFIG } from '../../src/core/PinThrottle.js';

const CFG = {
  ...DEFAULT_PIN_THROTTLE_CONFIG,
  softFailures: 3, markedSoftFailures: 8, markedAbuseCap: 50, globalMarkedFailureBudget: 100,
  baseMs: 1000, maxBackoffMs: 60_000, windowMs: 100_000, globalFailureBudget: 10, coarseFailureBudget: 6,
  alertCooldownMs: 1000, maxSources: 16,
};
const COOKIE = 'cookie-id-aaa'; // a marker id

describe('normalizePinSource', () => {
  it('reduces IPv6 to its /64; distinct /64s stay distinct; canonicalizes leading zeros and mapped/dotted forms', () => {
    expect(normalizePinSource('2001:db8:abcd:1234:5:6:7:8')).toBe(normalizePinSource('2001:db8:abcd:1234:ffff::1'));
    expect(normalizePinSource('2001:db8:abcd:9999::1')).not.toBe(normalizePinSource('2001:db8:abcd:1234::1'));
    expect(normalizePinSource('2001:0db8:00ab:0001::1')).toBe(normalizePinSource('2001:db8:ab:1::9'));
    expect(normalizePinSource('::ffff:203.0.113.5')).toBe('203.0.113.5');
  });
  it('passes IPv4 through', () => { expect(normalizePinSource('203.0.113.5')).toBe('203.0.113.5'); expect(normalizePinSource('')).toBe('unknown'); });
  it('coarse network is /48 (IPv6) and /24 (IPv4)', () => {
    expect(coarsePinNetwork(normalizePinSource('2001:db8:abcd:1111::1'))).toBe(coarsePinNetwork(normalizePinSource('2001:db8:abcd:2222::9')));
    expect(coarsePinNetwork('203.0.113.5')).toBe(coarsePinNetwork('203.0.113.200'));
    expect(coarsePinNetwork('203.0.113.5')).not.toBe(coarsePinNetwork('203.0.114.5'));
  });
});

describe('PinThrottle (b) — a known browser is always admitted', () => {
  it('a marked owner unlocks while a saturating attack has drained the hard cap — even from the SAME IP the attacker uses (shared NAT)', () => {
    const t = new PinThrottle(CFG);
    let now = 1000;
    // saturate the unmarked cap from a shared NAT address
    for (let i = 0; i < 200; i++) { t.consult('nat-ip', null, now); t.recordFailure('nat-ip', null, now); now += 1; }
    // a brand-new UNMARKED browser on that IP is refused (the hard bound — it recovers out of band)
    expect(t.consult('nat-ip', null, now).allow).toBe(false);
    // the MARKED owner, judged by cookie id not IP, is admitted even from the same NAT address
    expect(t.consult('nat-ip', COOKIE, now).allow).toBe(true);
  });
});

describe('PinThrottle (b) — a stolen cookie stays under its own backoff', () => {
  it('a marked source is backed off after markedSoftFailures (gentler than unmarked), by its cookie id', () => {
    const t = new PinThrottle({ ...CFG, markedSoftFailures: 3 });
    let now = 1000;
    for (let i = 0; i < 4; i++) { t.consult('ipA', COOKIE, now); t.recordFailure('ipA', COOKIE, now); now += 1; }
    // the cookie itself is now in backoff — even from a DIFFERENT ip, because it is keyed on the id
    const d = t.consult('ipB', COOKIE, now);
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('marker-backoff');
  });

  it('one stolen cookie is bounded to its own abuse cap then revoked; it never affects another browser\'s marker', () => {
    const t = new PinThrottle({ ...CFG, markedAbuseCap: 5, markedSoftFailures: 50 });
    let now = 1000;
    // the stolen cookie guesses from rotating addresses; it is judged by its id, so it accrues
    for (let i = 0; i < 5; i++) { t.consult(`ip${i}`, COOKIE, now); t.recordFailure(`ip${i}`, COOKIE, now); now += 1; }
    // past its abuse cap the marker is no longer honored → it falls to the unmarked path (no bypass)
    // a DIFFERENT owner's cookie is completely unaffected — per-id isolation
    expect(t.consult('owner-ip', 'other-cookie-id', now).allow).toBe(true);
    // and the stolen cookie, now unmarked, is subject to the hard cap once drained
    for (let i = 0; i < CFG.globalFailureBudget; i++) { const s = `u${i}`; t.consult(s, null, now); t.recordFailure(s, null, now); now += 1; }
    expect(t.consult('ipX', COOKIE, now).allow).toBe(false);
  });
});

describe('PinThrottle (b) — unknown guessing is hard-bounded', () => {
  it('once the global unmarked budget is drained, further unmarked attempts are REFUSED for the window', () => {
    const t = new PinThrottle(CFG);
    let now = 1000;
    for (let i = 0; i < CFG.globalFailureBudget; i++) { const s = `g${i}`; t.consult(s, null, now); t.recordFailure(s, null, now); now += 1; }
    const d = t.consult('fresh-unmarked', null, now);
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('global-cap');
  });

  it('a single hammering source is backed off exponentially after softFailures', () => {
    const t = new PinThrottle(CFG);
    let now = 1000;
    for (let i = 0; i < CFG.softFailures + 1; i++) { t.consult('a', null, now); t.recordFailure('a', null, now); now += 1; }
    const d = t.consult('a', null, now);
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('source-backoff');
  });

  it('a coarse /24 budget bounds sub-address rotation within one network', () => {
    const t = new PinThrottle({ ...CFG, globalFailureBudget: 1000 });
    let now = 1000;
    for (let i = 0; i < CFG.coarseFailureBudget; i++) { const s = `203.0.113.${i}`; t.consult(s, null, now); t.recordFailure(s, null, now); now += 1; }
    const d = t.consult('203.0.113.250', null, now);
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('coarse-cap');
    expect(t.consult('203.0.114.1', null, now).allow).toBe(true);
  });

  it('a marked source does NOT consume the unmarked global budget', () => {
    const t = new PinThrottle(CFG);
    let now = 1000;
    for (let i = 0; i < CFG.globalFailureBudget + 5; i++) { t.consult('mk', COOKIE, now); t.recordFailure('mk', COOKIE, now); now += 1; }
    expect(t.consult('fresh', null, now).allow).toBe(true);
  });

  it('does not reset the global budget on a success', () => {
    const t = new PinThrottle(CFG);
    let now = 1000;
    for (let i = 0; i < CFG.globalFailureBudget; i++) { const s = `g${i}`; t.consult(s, null, now); t.recordFailure(s, null, now); now += 1; }
    t.recordSuccess('owner', COOKIE);
    expect(t.consult('fresh', null, now).allow).toBe(false);
  });
});

describe('PinThrottle (b) — alerts', () => {
  it('fires once per cooldown when the hard cap is reached (kind global-cap)', () => {
    const t = new PinThrottle(CFG);
    const now = 1000;
    let alerts = 0; let kind = '';
    for (let i = 0; i < CFG.globalFailureBudget + 3; i++) { const s = `u${i}`; t.consult(s, null, now); const r = t.recordFailure(s, null, now); if (r.alert) { alerts++; kind = r.alert.kind; } }
    expect(alerts).toBe(1);
    expect(kind).toBe('global-cap');
  });
  it('does not alert on a few failures below the cap', () => {
    const t = new PinThrottle(CFG);
    const now = 1000;
    let alerts = 0;
    for (let i = 0; i < 2; i++) { if (t.recordFailure(`u${i}`, null, now).alert) alerts++; }
    expect(alerts).toBe(0);
  });
});

describe('PinThrottle — bounds and config', () => {
  it('bounds the source table even when every entry is blocked (hard maxSources)', () => {
    const t = new PinThrottle({ ...CFG, maxSources: 16, windowMs: 1_000_000, softFailures: 1 });
    let now = 1000;
    // 40 distinct sources, each failed enough to be blocked → all blocked, table must still be bounded
    for (let i = 0; i < 40; i++) { t.consult(`s${i}`, null, now); t.recordFailure(`s${i}`, null, now); t.recordFailure(`s${i}`, null, now); now += 1; }
    expect(t.size()).toBeLessThanOrEqual(16);
  });
  it('sanitizes a bad config and stays usable', () => {
    const t = new PinThrottle({ softFailures: -1 as unknown as number, maxSources: 0 });
    expect(t.consult('x', null, 1).allow).toBe(true);
  });
});
