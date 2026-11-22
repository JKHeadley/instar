// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * identity-security-piece1c: one owner-PIN policy for every place the PIN is checked.
 * Spec: docs/specs/identity-security-piece1c-pin-policy.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { PinAttemptStore } from '../../src/core/PinAttemptStore.js';
import { DEFAULT_PIN_THROTTLE_CONFIG, PinThrottle, UNATTRIBUTED_PIN_SOURCE } from '../../src/core/PinThrottle.js';
import { createMandatePinCheck, createOwnerPinVerdict } from '../../src/server/mandatePin.js';
import { setDashboardSessionFamilyLookup, signedInPinSource } from '../../src/server/ownerPinSource.js';
import { issuePinMarker, PIN_MARKER_COOKIE } from '../../src/server/pinUnlockMarker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const PIN = '482916';
const AGENT_KEY = 'agent-key-for-tests';
let dir = '';
afterEach(() => { setDashboardSessionFamilyLookup(null); if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/owner-pin-verifier.test.ts:cleanup' }); dir = ''; });
const store = () => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-pin-')); return new PinAttemptStore({ stateDir: dir }); };
const req = (headers: Record<string, string> = {}, body: Record<string, unknown> = {}): Request =>
  ({ headers, body, ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' } }) as unknown as Request;
function res(): Response & { statusCode: number; body: unknown } {
  const r = { statusCode: 200, body: undefined } as Response & { statusCode: number; body: unknown };
  r.status = ((n: number) => { r.statusCode = n; return r; }) as Response['status'];
  r.json = ((b: unknown) => { r.body = b; return r; }) as Response['json'];
  return r;
}

describe('signed-in source', () => {
  it('dashboard session family first, then a verified peer machine, then the remembered-browser cookie, else agent-bearer', () => {
    setDashboardSessionFamilyLookup((t) => (t === 'dst_live' ? 'fam-1' : null));
    const deps = { agentToken: () => AGENT_KEY };
    expect(signedInPinSource(req({ authorization: 'Bearer dst_live' }), deps)).toBe('session:fam-1');
    expect(signedInPinSource(req({ authorization: 'Bearer dst_dead' }), deps)).toBe('agent-bearer');
    expect(signedInPinSource(req({ authorization: `Bearer ${AGENT_KEY}` }), deps, 'forwarded:m_2')).toBe('forwarded:m_2');
    const marker = issuePinMarker(AGENT_KEY, Date.now(), 60_000);
    const cookie = `${PIN_MARKER_COOKIE}=${encodeURIComponent(marker)}`;
    expect(signedInPinSource(req({ authorization: `Bearer ${AGENT_KEY}`, cookie }), deps)).toMatch(/^browser:/);
    expect(signedInPinSource(req({ authorization: `Bearer ${AGENT_KEY}`, cookie: `${PIN_MARKER_COOKIE}=forged` }), deps)).toBe('agent-bearer');
    expect(signedInPinSource(req({ authorization: `Bearer ${AGENT_KEY}` }), deps)).toBe('agent-bearer');
  });
});

describe('signed-in budget', () => {
  const deps = (s: PinAttemptStore) => ({ dashboardPin: () => PIN, pinAttemptStore: () => s, pinSource: (r: Request, fwd?: string) => signedInPinSource(r, { agentToken: () => AGENT_KEY }, fwd) });

  it('one credential is limited on its own; another credential is never refused by it', () => {
    const s = store();
    setDashboardSessionFamilyLookup((t) => ({ dst_a: 'fam-a', dst_b: 'fam-b' } as Record<string, string>)[t] ?? null);
    const verdict = createOwnerPinVerdict(deps(s));
    const a = req({ authorization: 'Bearer dst_a' });
    for (let i = 0; i < 5; i++) expect(verdict(a, '000000')).toMatchObject({ ok: false, reason: 'wrong' });
    expect(verdict(a, PIN)).toMatchObject({ ok: false, reason: 'throttled' }); // refused before the compare
    expect(verdict(req({ authorization: 'Bearer dst_b' }), PIN)).toEqual({ ok: true });
  });

  it('a refresh in the same session family does not grant fresh guesses', () => {
    const s = store();
    setDashboardSessionFamilyLookup(() => 'fam-same');
    const verdict = createOwnerPinVerdict(deps(s));
    for (let i = 0; i < 5; i++) verdict(req({ authorization: 'Bearer dst_old' }), '000000');
    expect(verdict(req({ authorization: 'Bearer dst_refreshed' }), PIN)).toMatchObject({ reason: 'throttled' });
  });

  it('the limit survives a restart (durable store)', () => {
    const s = store();
    const v1 = createOwnerPinVerdict(deps(s));
    for (let i = 0; i < 5; i++) v1(req({ authorization: `Bearer ${AGENT_KEY}` }), '000000');
    const v2 = createOwnerPinVerdict(deps(new PinAttemptStore({ stateDir: dir })));
    expect(v2(req({ authorization: `Bearer ${AGENT_KEY}` }), PIN)).toMatchObject({ reason: 'throttled' });
  });

  it('the mandate check keys on the forwarded machine instead of the shared loopback address', () => {
    const s = store();
    const check = createMandatePinCheck(deps(s));
    for (let i = 0; i < 5; i++) check(req({}, { pin: '000000' }), res(), { forwardedBucketKey: 'forwarded:m_peer' });
    const r1 = res();
    expect(check(req({}, { pin: PIN }), r1, { forwardedBucketKey: 'forwarded:m_peer' })).toBe(false);
    expect(r1.statusCode).toBe(429);
    // a local caller (agent-bearer) is not affected by the peer's guesses
    expect(check(req({ authorization: `Bearer ${AGENT_KEY}` }, { pin: PIN }), res())).toBe(true);
  });

  it('a right PIN on a shared public-cap check never clears the strangers\' cap', () => {
    const s = store();
    const check = createMandatePinCheck({ dashboardPin: () => PIN, pinAttemptStore: () => s, pinSource: () => '__dashboard_unlock_global__', maxAttempts: 20, clearOnSuccess: false });
    for (let i = 0; i < 19; i++) check(req({}, { pin: '000000' }), res());
    expect(check(req({}, { pin: PIN }), res())).toBe(true);
    check(req({}, { pin: '000000' }), res());
    const r = res();
    expect(check(req({}, { pin: PIN }), r)).toBe(false);
    expect(r.statusCode).toBe(429);
  });

  it('a success clears only its own source', () => {
    const s = store();
    setDashboardSessionFamilyLookup((t) => (t === 'dst_a' ? 'fam-a' : null));
    const verdict = createOwnerPinVerdict(deps(s));
    for (let i = 0; i < 4; i++) verdict(req({ authorization: `Bearer ${AGENT_KEY}` }), '000000');
    expect(verdict(req({ authorization: 'Bearer dst_a' }), PIN)).toEqual({ ok: true });
    expect(verdict(req({ authorization: `Bearer ${AGENT_KEY}` }), '000000')).toMatchObject({ reason: 'wrong', remaining: 0 });
  });
});

describe('public budget: PinThrottle', () => {
  it('an unattributable caller counts only toward the global budget, never a shared source key', () => {
    const t = new PinThrottle();
    const now = 1_000_000;
    for (let i = 0; i < 10; i++) t.recordFailure(UNATTRIBUTED_PIN_SOURCE, null, now);
    // no shared per-source backoff: the next unattributed attempt is still admitted
    expect(t.consult(UNATTRIBUTED_PIN_SOURCE, null, now).allow).toBe(true);
    for (let i = 0; i < 10; i++) t.recordFailure(UNATTRIBUTED_PIN_SOURCE, null, now);
    expect(t.consult(UNATTRIBUTED_PIN_SOURCE, null, now)).toMatchObject({ allow: false, reason: 'global-cap' });
  });

  it('settings can make the budgets stricter, never looser', () => {
    const loose = new PinThrottle({ globalFailureBudget: 500, softFailures: 50, coarseFailureBudget: 99, maxBackoffMs: 1_000 });
    const now = 1_000_000;
    for (let i = 0; i < DEFAULT_PIN_THROTTLE_CONFIG.globalFailureBudget; i++) loose.recordFailure(`10.0.${i}.1`, null, now);
    expect(loose.consult('10.9.9.9', null, now)).toMatchObject({ allow: false, reason: 'global-cap' });
    const strict = new PinThrottle({ globalFailureBudget: 5 });
    for (let i = 0; i < 5; i++) strict.recordFailure(`10.1.${i}.1`, null, now);
    expect(strict.consult('10.9.9.9', null, now)).toMatchObject({ allow: false, reason: 'global-cap' });
  });
});

describe('ratchet: every dashboard-PIN compare goes through the verifier', () => {
  // Files allowed to compare against the dashboard PIN, with the reason. Anything else is a new,
  // unlimited PIN oracle.
  const ALLOWED: Record<string, string> = {
    'src/server/mandatePin.ts': 'the signed-in verifier itself',
    'src/server/AgentServer.ts': 'sign-in and step-up on the public budget helpers, and the graph owner re-check after a success',
  };
  const ALLOWED_LINES: Array<[string, string]> = [
    ['src/server/routes.ts', 'x-instar-principal-pin'], // audit only: recorded, never changes the response
  ];
  it('no other file compares input with dashboardPin', () => {
    const offenders: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.ts')) continue;
        const rel = path.relative(process.cwd(), p);
        if (ALLOWED[rel]) continue;
        const lines = fs.readFileSync(p, 'utf-8').split('\n');
        lines.forEach((line, i) => {
          if (!/dashboardPin/.test(line)) return;
          const window = lines.slice(i, i + 4).join('\n');
          if (!/timingSafeEqual|===\s*\w*[pP]in\b|createHash\('sha256'\)\.update\([^)]*dashboardPin/.test(window)) return;
          if (/timingSafeEqual|createHash/.test(window) === false) return;
          const near = lines.slice(Math.max(0, i - 6), i + 6).join('\n');
          if (ALLOWED_LINES.some(([f, marker]) => rel === f && near.includes(marker))) return;
          offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
        });
      }
    };
    walk(path.join(process.cwd(), 'src'));
    expect(offenders).toEqual([]);
  });
});
