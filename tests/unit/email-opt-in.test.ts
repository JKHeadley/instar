/**
 * docs/specs/backup-email-sending.md, double opt-in: a six-digit code bound to the recipient, five attempts that
 * survive a restart, a 30-minute expiry (never past 24 hours), and the proof-mail bounds to an unconfirmed address
 * (three a day, twenty in all).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { EmailOptInStore, OPT_IN_MAX_ATTEMPTS, PROOF_MAILS_PER_DAY, PROOF_MAILS_TOTAL } from '../../src/email/emailOptIn.js';

let dir: string;
let now: number;
const mk = (expiryMs?: number) => new EmailOptInStore({ stateDir: dir, machineId: 'm_a', macKey: 'machine-key', now: () => now, expiryMs });

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-optin-')); now = Date.parse('2026-11-08T12:00:00Z'); });
afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/email-opt-in.test.ts' }));

describe('the opt-in code', () => {
  it('confirms the recipient on the right code, once', () => {
    const s = mk();
    const { code } = s.mint('rh1');
    expect(code).toMatch(/^\d{6}$/);
    expect(s.awaitingCode('rh1')).toBe(true);
    expect(s.check('rh1', ` ${code.slice(0, 3)} ${code.slice(3)} `)).toBe('ok');
    expect(s.isConfirmed('rh1')).toBe(true);
    expect(s.isConfirmed('rh2')).toBe(false);
    expect(s.check('rh1', code)).toBe('none');
  });
  it('stores only a keyed hash of the code', () => {
    const { code } = mk().mint('rh1');
    expect(fs.readFileSync(path.join(dir, 'state', 'email-opt-in.json'), 'utf8')).not.toContain(code);
  });
  it('five wrong entries void the nonce, and the count survives a restart', () => {
    const { code } = mk().mint('rh1');
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < OPT_IN_MAX_ATTEMPTS - 1; i++) expect(mk().check('rh1', wrong)).toBe('wrong');
    expect(mk().check('rh1', wrong)).toBe('locked');
    expect(mk().check('rh1', code)).toBe('locked');
    expect(mk().isConfirmed('rh1')).toBe(false);
  });
  it('expires after 30 minutes by default, and never later than 24 hours', () => {
    const s = mk();
    const { code } = s.mint('rh1');
    now += 31 * 60_000;
    expect(s.check('rh1', code)).toBe('expired');
    const long = mk(7 * 24 * 60 * 60_000);
    const { expiresAt } = long.mint('rh1');
    expect(expiresAt - now).toBe(24 * 60 * 60_000);
  });
  it('a code minted for one address does not confirm another', () => {
    const s = mk();
    const { code } = s.mint('rh1');
    expect(s.check('rh2', code)).toBe('recipient-changed');
  });
});

describe('proof mails to an unconfirmed address', () => {
  it('three a day', () => {
    const s = mk();
    for (let i = 0; i < PROOF_MAILS_PER_DAY; i++) { expect(s.mayMail('rh1', '2026-11-08')).toBe(true); s.countMail('rh1', '2026-11-08'); }
    expect(s.mayMail('rh1', '2026-11-08')).toBe(false);
    expect(s.mayMail('rh1', '2026-11-09')).toBe(true);
  });
  it('twenty in all, until a new address', () => {
    const s = mk();
    for (let d = 1; d <= 7; d++) for (let i = 0; i < 3; i++) if (s.mayMail('rh1', `2026-11-${String(d).padStart(2, '0')}`)) s.countMail('rh1', `2026-11-${String(d).padStart(2, '0')}`);
    expect(s.mailsSent('rh1', '2026-11-07').total).toBe(PROOF_MAILS_TOTAL);
    expect(s.mayMail('rh1', '2026-11-20')).toBe(false);
    expect(s.mayMail('rh2', '2026-11-20')).toBe(true);
  });
});

describe('proof results', () => {
  it('are kept by credential version, with a try count', () => {
    const s = mk();
    s.recordProof('v1', { result: 'unknown', at: now });
    s.recordProof('v1', { result: 'pass', at: now, delivery: 'delivered' });
    expect(s.proof('v1')).toMatchObject({ result: 'pass', delivery: 'delivered', tries: 2 });
    expect(s.proof('v2')).toBeNull();
    s.clear();
    expect(s.proof('v1')).toBeNull();
  });
});
