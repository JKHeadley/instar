import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { PasskeyNonceLedger, REVOKE_NONCE_RETENTION_MS } from '../../src/core/PasskeyNonceLedger.js';

// Spec docs/specs/agent-held-google-passkey.md §3.2 — received/applied/dismissed states, the revoke
// cutoff stored with `received`, re-signed-copy dedupe, and retention (revokes ≥ 60 days).

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'passkey-nonce-ledger.test cleanup' }); });
const T0 = Date.parse('2026-09-23T00:00:00Z');
const mk = () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-nonces-')); dirs.push(stateDir);
  let now = T0;
  const ledger = new PasskeyNonceLedger({ stateDir, now: () => now });
  return { stateDir, ledger, tick: (ms: number) => { now += ms; } };
};
const exp = (ms: number) => new Date(T0 + ms).toISOString();

describe('PasskeyNonceLedger', () => {
  it('records a nonce once (a second receive is a replay), stores the revoke cutoff with it, and flips to applied', () => {
    const { ledger } = mk();
    expect(ledger.receive({ nonce: 'n1', op: 'revoke', cellKey: 'a@x@m', issuerMachineId: 'm_op', expiresAt: exp(900_000), appliedCutoffSeq: 3 })).toEqual({ recorded: true });
    expect(ledger.get('n1')).toMatchObject({ state: 'received', appliedCutoffSeq: 3, op: 'revoke' });
    const again = ledger.receive({ nonce: 'n1', op: 'revoke', cellKey: 'a@x@m', issuerMachineId: 'm_op', expiresAt: exp(900_000), appliedCutoffSeq: 99 });
    expect(again.recorded).toBe(false);
    expect(again.existing?.appliedCutoffSeq).toBe(3); // the stored cutoff wins over a replay's claim
    expect(ledger.receivedRevokes().map((r) => r.nonce)).toEqual(['n1']);
    expect(ledger.markApplied('n1')).toBe(true);
    expect(ledger.get('n1')?.state).toBe('applied');
    expect(ledger.receivedRevokes()).toEqual([]);
    expect(ledger.markApplied('missing')).toBe(false);
  });

  it('a re-signed revoke naming the nonce it replaces is deduplicated on that nonce', () => {
    const { ledger } = mk();
    ledger.receive({ nonce: 'orig', op: 'revoke', cellKey: 'a@x@m', issuerMachineId: 'm_old', expiresAt: exp(900_000), appliedCutoffSeq: null });
    const resigned = ledger.receive({ nonce: 'new', op: 'revoke', cellKey: 'a@x@m', issuerMachineId: 'm_new', expiresAt: exp(900_000), replacesNonce: 'orig' });
    expect(resigned.recorded).toBe(false);
    expect(resigned.existing?.nonce).toBe('orig');
  });

  it('dismissal is recorded (so re-delivery never re-raises it) and cannot undo an applied op', () => {
    const { ledger } = mk();
    ledger.receive({ nonce: 'r1', op: 'revoke', cellKey: 'a@x@m', issuerMachineId: 'm_untrusted', expiresAt: exp(900_000) });
    expect(ledger.dismiss('r1')).toBe(true);
    expect(ledger.get('r1')?.state).toBe('dismissed');
    ledger.receive({ nonce: 'g1', op: 'grant', cellKey: 'a@x@m', issuerMachineId: 'm_op', expiresAt: exp(900_000) });
    ledger.markApplied('g1');
    expect(ledger.dismiss('g1')).toBe(false);
  });

  it('prunes ordinary nonces after expiry + skew and revoke nonces only after 60 days', () => {
    const { ledger, tick } = mk();
    ledger.receive({ nonce: 'g', op: 'grant', cellKey: 'a@x@m', issuerMachineId: 'm', expiresAt: exp(900_000) });
    ledger.receive({ nonce: 'r', op: 'revoke', cellKey: 'a@x@m', issuerMachineId: 'm', expiresAt: exp(900_000) });
    tick(900_000 + 120_000 - 1);
    expect(ledger.prune()).toBe(0);
    tick(2);
    expect(ledger.prune()).toBe(1);
    expect(ledger.has('g')).toBe(false);
    expect(ledger.has('r')).toBe(true);
    tick(REVOKE_NONCE_RETENTION_MS);
    expect(ledger.prune()).toBe(1);
    expect(ledger.has('r')).toBe(false);
  });

  it('a corrupt ledger fails CLOSED (throws) so an unknown nonce is never mistaken for a fresh one', () => {
    const { stateDir, ledger } = mk();
    ledger.receive({ nonce: 'n', op: 'grant', cellKey: 'a@x@m', issuerMachineId: 'm', expiresAt: exp(1) });
    fs.writeFileSync(path.join(stateDir, 'state', 'passkey-nonces.json'), 'nope');
    expect(() => ledger.get('n')).toThrow('passkey-nonces-unreadable');
  });
});
