/** The server must not let the shipped Apple decoder silently shorten an approval disclosure. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountPathService, appApprovalSummaryLines, proofSubject, type DeviceSnapshot } from '../../src/core/trustJourney/AccountPathService.js';
import { LocalFileTrustSink, TrustJourneyStore, type TrustChange } from '../../src/core/trustJourney/TrustJourneyStore.js';
import { proposalHashOf } from '../../src/core/TrustRaiseGuard.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// TrustApprovalData.swift takes 40 entries and 400 Swift Characters per entry. Grapheme segmentation
// models that external decoder contract; the server deliberately uses the stricter code-point bound.
const decodeLikeApple = (lines: string[]) => lines.slice(0, 40).map(line =>
  [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(line)].slice(0, 400).map(x => x.segment).join(''));
const assertLossless = (source: string[]) => {
  const output = appApprovalSummaryLines(source);
  expect(output).not.toBeNull();
  expect(output!.length).toBeLessThanOrEqual(40);
  expect(output!.every(line => Array.from(line).length <= 400)).toBe(true);
  expect(decodeLikeApple(output!)).toEqual(output);
  expect(output!.join('')).toBe(source.join('\n'));
  return output!;
};

describe('existing Apple approval disclosure representation', () => {
  it('keeps normal short summary entries unchanged', () => {
    const source = ['Change: write actions on gmail.', 'Only the described action is approved.'];
    expect(appApprovalSummaryLines(source)).toEqual(source);
    expect(decodeLikeApple(appApprovalSummaryLines(source)!)).toEqual(source);
  });
  it('preserves the end of one long line that the old decoder would lose', () => {
    const source = ['Review this exact configuration: ' + 'setting=value;'.repeat(90) + ' END-OF-DISCLOSURE'];
    expect(decodeLikeApple(source)[0]).not.toContain('END-OF-DISCLOSURE');
    expect(assertLossless(source).join('')).toContain('END-OF-DISCLOSURE');
  });
  it('preserves more than 40 original lines, including their separators', () => {
    const source = Array.from({ length: 60 }, (_, i) => `Setting ${i}: retain this complete value.`);
    expect(decodeLikeApple(source)).toHaveLength(40);
    expect(assertLossless(source).join('')).toContain('Setting 59: retain this complete value.');
  });
  it('never cuts an astral Unicode code point or drops combining text', () => {
    const source = [('😀e\u0301'.repeat(250)) + ' FINAL'];
    const output = assertLossless(source);
    expect(output.every(line => !/[\uD800-\uDBFF]$/.test(line) && !/^[\uDC00-\uDFFF]/.test(line))).toBe(true);
  });
  it('moves an intact flag, combining cluster and ZWJ family past a 399-code-point boundary', () => {
    for (const cluster of ['🇨🇦', 'e\u0301', '👨‍👩‍👧‍👦']) {
      const output = assertLossless(['x'.repeat(399) + cluster]);
      expect(output).toEqual(['x'.repeat(399), cluster]);
    }
  });
  it('refuses one indivisible cluster larger than an entry rather than visually splitting it', () => {
    expect(appApprovalSummaryLines(['a' + '\u0301'.repeat(400)])).toBeNull();
  });
  it('refuses more than 40 grapheme-safe packed chunks even below the aggregate code-point capacity', () => {
    const cluster = 'a' + '\u0301'.repeat(200);
    expect(Array.from(cluster.repeat(41)).length).toBeLessThan(16_000);
    expect(appApprovalSummaryLines([cluster.repeat(41)])).toBeNull();
  });
  it('accepts the exact single-line capacity with no loss', () => {
    const output = assertLossless(['x'.repeat(16_000)]);
    expect(output).toHaveLength(40);
    expect(output.every(line => line.length === 400)).toBe(true);
  });
  it('refuses one code point beyond representable capacity rather than truncating', () => {
    expect(appApprovalSummaryLines(['x'.repeat(16_001)])).toBeNull();
    expect(appApprovalSummaryLines(Array.from({ length: 41 }, () => 'x'.repeat(400)))).toBeNull();
  });
});

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/app-approval-disclosure-boundaries.test.ts' }); });

async function legacyRequest(summary: string[], adapter: 'device' | 'telegram' = 'device', freshSummary: string[] = summary) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-disclosure-'));
  dirs.push(dir);
  const now = new Date('2026-11-22T23:00:00Z');
  const change: TrustChange = { kind: 'trust-grant', service: 'gmail', operation: 'write', level: 'autonomous' };
  const hash = proposalHashOf(proofSubject(change));
  const store = new TrustJourneyStore(new LocalFileTrustSink(path.join(dir, 'trust-journey.jsonl')), () => now);
  const device: DeviceSnapshot = { deviceId: 'mac', name: 'Approving Mac', active: true, keyFingerprint: 'ABCD-0000-0000-0000', presenceKeyHash: 'a'.repeat(64), deviceKind: 'computer', localInstall: true };
  const apply = vi.fn(async () => ({ ok: true }));
  const service = new AccountPathService({ store, adapters: {}, ownerPlatformId: () => null, installationId: 'test', raisesOf: () => ['raise'], summarize: () => freshSummary,
    apply, cardTtlDays: () => 7, now: () => now, devices: { get: id => id === device.deviceId ? device : null, list: () => [device] } });
  expect((await service.recordDeviceAcceptance({ deviceId: 'mac', keyFingerprint: device.keyFingerprint!, presenceKeyHash: device.presenceKeyHash!, keyPolicy: 'biometryCurrentSet', disclosureHash: 'd'.repeat(64) })).status).toBe('recorded');
  await store.write('request', { requestId: 'tr-legacy', code: 'ABCDEF', proposalHash: hash, principal: 'owner', adapter, approverPlatformId: '', expiresAt: '2026-11-29T23:00:00Z', status: 'open', change, summary, cardMessageId: '', cardChatId: '' }, 'legacy-request');
  const authorization = { deviceId: 'mac', keyFingerprint: device.keyFingerprint!, host: 'localhost:4040', requestId: 'tr-legacy', proposalHash: hash, challengeId: 'verified-presence-challenge' };
  return { service, store, apply, authorization, change };
}

describe('legacy persisted disclosures remain safe at consumption', () => {
  it('ignores an oversized stored summary when the verified change has a short complete disclosure', async () => {
    const derived = ['The actual verified change'];
    const { service, apply, authorization } = await legacyRequest(['x'.repeat(16_001)], 'device', derived);
    expect(service.deviceListing()[0].summary).toEqual(derived);
    expect((await service.onPresenceApproval(authorization)).status).toBe('applied');
    expect(apply).toHaveBeenCalledTimes(1);
  });
  it('bounds the derived change even when its stored summary looks harmless', async () => {
    const { service, store, change, apply, authorization } = await legacyRequest(['A harmless cached description'], 'telegram', ['x'.repeat(16_001)]);
    expect(service.deviceListing()[0].summary.join(' ')).toContain('too large to show whole');
    expect(await service.propose(change)).toMatchObject({ status: 'too-large' });
    expect(store.request('tr-legacy')?.adapter).toBe('telegram');
    expect(await service.onPresenceApproval(authorization)).toMatchObject({ status: 'refused', reason: 'disclosure-too-large' });
    expect(apply).not.toHaveBeenCalled();
    expect(store.consumptionOf('tr-legacy')).toBeNull();
  });
  it('lists the complete representable legacy disclosure and permits its exact approval once', async () => {
    const summary = ['Exact old request: ' + 'a'.repeat(900) + ' END'];
    const { service, store, apply, authorization } = await legacyRequest(summary);
    const listed = service.deviceListing()[0];
    expect(decodeLikeApple(listed.summary).join('')).toBe(summary.join('\n'));
    expect((await service.onPresenceApproval(authorization)).status).toBe('applied');
    expect(apply).toHaveBeenCalledTimes(1);
    expect(store.consumptionOf('tr-legacy')).toBeTruthy();
  });
  it('refuses a fresh app disclosure whose indivisible cluster cannot be shown, without recording a request', async () => {
    const { service, store, change, apply } = await legacyRequest(['An earlier valid request'], 'device', ['a' + '\u0301'.repeat(400)]);
    expect(await service.propose({ ...change, service: 'calendar' })).toMatchObject({ status: 'too-large' });
    expect(store.allRequests().map(r => r.requestId)).toEqual(['tr-legacy']);
    expect(apply).not.toHaveBeenCalled();
  });
  it('re-proposing an unrenderable legacy chat request refuses before changing its carrier or expiry', async () => {
    const { service, store, change, apply } = await legacyRequest(['x'.repeat(16_001)], 'telegram');
    const before = store.request('tr-legacy')!;
    expect(await service.propose(change)).toMatchObject({ status: 'too-large' });
    expect(store.request('tr-legacy')).toMatchObject({ adapter: 'telegram', status: 'open', expiresAt: before.expiresAt, proposalHash: before.proposalHash });
    expect(store.allRequests()).toHaveLength(1);
    expect(store.consumptionOf('tr-legacy')).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });
  it('refuses an oversized legacy disclosure before consumption and leaves its request pending', async () => {
    const { service, store, apply, authorization } = await legacyRequest(['x'.repeat(16_001)]);
    expect(service.deviceListing()[0].summary.join(' ')).toContain('too large to show whole');
    expect(await service.onPresenceApproval(authorization)).toMatchObject({ status: 'refused', reason: 'disclosure-too-large' });
    expect(apply).not.toHaveBeenCalled();
    expect(store.consumptionOf('tr-legacy')).toBeNull();
    expect(store.requestConsumedOrPending('tr-legacy')).toBe(false);
    expect(store.request('tr-legacy')?.status).toBe('open');
  });
});
