/** Unit tests for the mobile pairing state (docs/specs/mobile-pairing-link.md). */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PairingCodeStore, buildPairLink, cleanText, codeTtlMs, stableOrigin, pingAnswer,
  MAX_LIVE_CODES, MAX_MINTS_PER_HOUR, MAX_FAILED_REDEEMS, CODE_PATTERN,
} from '../../src/core/MobilePairing.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const TOKEN = 'token-A';
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/mobile-pairing.test.ts' }); });

describe('PairingCodeStore', () => {
  it('mints a 22-character code that redeems exactly once', () => {
    const s = new PairingCodeStore();
    const m = s.mint(60_000, 'phone', TOKEN);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(CODE_PATTERN.test(m.code)).toBe(true);
    expect(s.redeem(m.code, TOKEN)).toEqual({ ok: true, label: 'phone' });
    expect(s.redeem(m.code, TOKEN)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses an expired code', () => {
    let now = 1_000_000;
    const s = new PairingCodeStore(() => now);
    const m = s.mint(60_000, null, TOKEN);
    if (!m.ok) throw new Error('mint failed');
    now += 60_001;
    expect(s.redeem(m.code, TOKEN).ok).toBe(false);
  });

  it('refuses a code minted under a token that has since rotated, and consumes it', () => {
    const s = new PairingCodeStore();
    const m = s.mint(60_000, null, TOKEN);
    if (!m.ok) throw new Error('mint failed');
    expect(s.redeem(m.code, 'token-B')).toEqual({ ok: false, reason: 'invalid' });
    expect(s.redeem(m.code, TOKEN).ok).toBe(false);
  });

  it('caps live codes and mints per hour with a refusal, never a silent eviction', () => {
    let now = 0;
    const s = new PairingCodeStore(() => now);
    const codes: string[] = [];
    for (let i = 0; i < MAX_LIVE_CODES; i++) { const m = s.mint(10 * 60_000, null, TOKEN); if (m.ok) codes.push(m.code); }
    expect(s.mint(10 * 60_000, null, TOKEN)).toEqual({ ok: false, reason: 'too-many-live-codes' });
    expect(s.redeem(codes[0], TOKEN).ok).toBe(true); // the first code survived
    now += 11 * 60_000; // all codes expired, but the hourly mint budget is spent
    expect(MAX_MINTS_PER_HOUR).toBe(10);
    expect(s.mint(60_000, null, TOKEN)).toEqual({ ok: false, reason: 'too-many-mints' });
    now += 60 * 60_000;
    expect(s.mint(60_000, null, TOKEN).ok).toBe(true);
  });

  it('a valid code still redeems after the failure budget is exhausted', () => {
    const s = new PairingCodeStore();
    const m = s.mint(60_000, null, TOKEN);
    if (!m.ok) throw new Error('mint failed');
    for (let i = 0; i < MAX_FAILED_REDEEMS; i++) expect(s.redeem('x'.repeat(22), TOKEN)).toEqual({ ok: false, reason: 'invalid' });
    expect(s.redeem('y'.repeat(22), TOKEN)).toEqual({ ok: false, reason: 'too-many-attempts' });
    expect(s.redeem(m.code, TOKEN).ok).toBe(true);
  });

  it('never keeps the plaintext code', () => {
    const s = new PairingCodeStore();
    const m = s.mint(60_000, null, TOKEN);
    if (!m.ok) throw new Error('mint failed');
    const keys = [...(s as unknown as { codes: Map<string, unknown> }).codes.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain(m.code);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('helpers', () => {
  it('builds the frozen v1 link with everything in the fragment', () => {
    const link = buildPairLink('https://echo.example.dev', 'A'.repeat(22));
    expect(link).toBe(`https://instar.sh/pair#v=1&o=${encodeURIComponent('https://echo.example.dev')}&c=${'A'.repeat(22)}`);
    expect(new URL(link).search).toBe('');
  });

  it('takes the stable origin only from a named tunnel with a hostname', () => {
    expect(stableOrigin({ type: 'named', hostname: 'Echo.Example.dev' })).toBe('https://echo.example.dev');
    expect(stableOrigin({ type: 'named' })).toBeNull();
    expect(stableOrigin({ type: 'quick', hostname: 'x.trycloudflare.com' })).toBeNull();
    expect(stableOrigin(undefined)).toBeNull();
    expect(stableOrigin({ type: 'named', hostname: 'evil.com/path' })).toBeNull();
  });

  it('clamps the TTL to 1–60 minutes with a 10 minute default', () => {
    expect(codeTtlMs(undefined)).toBe(600_000);
    expect(codeTtlMs({ codeTtlMinutes: 0 })).toBe(60_000);
    expect(codeTtlMs({ codeTtlMinutes: 999 })).toBe(3_600_000);
  });

  it('cleans text to printable, single-line, bounded', () => {
    expect(cleanText('Justin\u0000’s\niPhone ')).toBe('Justin ’s iPhone');
    expect(cleanText('x'.repeat(100))).toHaveLength(60);
    expect(cleanText('   ')).toBeNull();
    expect(cleanText(42)).toBeNull();
  });

  it('answers pings with a per-process hash that depends on the nonce', () => {
    expect(pingAnswer('n'.repeat(20))).toMatch(/^[0-9a-f]{64}$/);
    expect(pingAnswer('n'.repeat(20))).not.toBe(pingAnswer('m'.repeat(20)));
  });
});
