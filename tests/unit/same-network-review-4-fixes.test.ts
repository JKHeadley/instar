/**
 * Identity A4/A5, GPT review 4 (docs/specs/identity-security-piece3e-same-network-first-phone.md):
 *  1. the document decision root refuses a non-document DECIDING phone, but a Telegram-approved home phone
 *     may stand in an ordinary phone's approval chain (it approved that phone);
 *  2. a ceremony credential's counted wrong tries are never forgotten while the credential is still usable;
 *  3. the signing window closes a few seconds before the phone's pending expiry, and the setup ends then
 *     even if the phone never asks again.
 * The queued close and the live pending check at the number run over HTTP in
 * tests/integration/same-network-review-3-lifecycle.test.ts.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { documentDecisionRootOf } from '../../src/server/documentDecisionRoot.js';
import type { DeviceRecord } from '../../src/core/MobileDeviceKeys.js';
import { ceremonyCredentialPath, mintCeremonyCredential, spendCeremonyCredential } from '../../src/core/ceremonyCredential.js';
import { PhoneSetupStore, PHONE_SETUP_SIGN_MARGIN_MS, signDeadline } from '../../src/server/phoneSetupRoutes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/same-network-review-4-fixes.test.ts' }); });

describe('1. the document decision root', () => {
  const rec = (over: Partial<DeviceRecord> & { id: string }): DeviceRecord => ({ deviceName: 'p', label: null, pairedAt: '', status: 'active', publicKey: 'k', presenceKey: 'pk', host: 'agent.example.ts.net', approvedVia: 'telegram-dm', ...over });
  const devices: Record<string, DeviceRecord> = {
    home: rec({ id: 'home', host: 'echo-pc.local:24040', addressKind: 'same-network', approvedVia: 'telegram-dm' }),
    child: rec({ id: 'child', approvedVia: 'owner-phone', approvedBy: 'home' }),
    atComputer: rec({ id: 'atComputer', host: 'echo-pc.local:24040', addressKind: 'same-network', admission: 'at-computer', approvedVia: 'at-computer' }),
    plain: rec({ id: 'plain' }),
  };
  const root = (id: string) => documentDecisionRootOf({ device: (x) => devices[x] ?? null, activeOwnerPhone: () => true, agentHasTelegramOwner: () => true }, id);

  it('a home-address or at-computer phone never decides', () => {
    expect(root('home')).toBeNull();
    expect(root('atComputer')).toBeNull();
  });
  it('an ordinary phone approved by a Telegram-approved home phone keeps its Telegram root', () => {
    expect(root('child')).toBe('telegram');
    expect(root('plain')).toBe('telegram');
  });
});

describe('2. a ceremony credential\'s count is kept while the credential is usable', () => {
  it('a wrong try whose count cannot be written and whose removal fails leaves the credential refused, even with the right value', () => {
    const d = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'icc4-'));
    dirs.push(d);
    const opts = { scope: 'phone-setup' as const, machineId: 'm_self' };
    const { credential } = mintCeremonyCredential(d, opts);
    // A storage fault: every rename fails (the count's write, and the claim that would remove the credential).
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); });
    try {
      expect(spendCeremonyCredential(d, 'icc1_wrong', opts)).toEqual({ ok: false, reason: 'wrong' });
    } finally { spy.mockRestore(); }
    // Still at its path (nothing could move it), but never usable again in this process.
    expect(fs.existsSync(ceremonyCredentialPath(d))).toBe(true);
    expect(spendCeremonyCredential(d, credential, opts)).toEqual({ ok: false, reason: 'wrong' });
    // With storage back, that refusal removed it.
    expect(fs.existsSync(ceremonyCredentialPath(d))).toBe(false);
  });
});

describe('3. the signing window and the setup end together, before the phone\'s pending expiry', () => {
  it('ends at the deadline without the phone asking, a few seconds before the registry expires it', () => {
    const clock = { t: 9_000_000 };
    const s = new PhoneSetupStore(() => clock.t);
    const a = s.create({ code: 'C', address: 'home', host: 'a-b.local:5000', kind: 'same-network', spkiHash: 'H', approval: 'computer' });
    const phoneExpiresAt = clock.t + 30 * 60_000;
    const n = s.attachPhone(a.id, { id: 'dev-1', deviceName: 'p', fingerprint: 'f', expiresAt: new Date(phoneExpiresAt).toISOString() }, 'kh')!;
    clock.t += 25 * 60_000;
    expect(s.typeNumber(a.id, n)).toBe('ok');
    const deadline = signDeadline(s.get(a.id)!)!;
    expect(deadline).toBe(phoneExpiresAt - PHONE_SETUP_SIGN_MARGIN_MS);
    expect(s.get(a.id)!.expiresAt).toBe(deadline);
    clock.t = deadline + 1;
    // No activation call: the setup itself reads ended.
    expect(s.get(a.id)).toMatchObject({ state: 'ended', endedReason: 'sign-window-passed' });
    expect(s.anyOpen()).toBe(false);
  });
});
