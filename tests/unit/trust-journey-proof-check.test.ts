/**
 * Trust-journey section 6 "Checked at load" and the durable change log: a hand-edited or unproven
 * raise is restored to the committed level; a proven raise and every restriction stay.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AdaptiveTrust } from '../../src/core/AdaptiveTrust.js';
import { LocalFileTrustSink, TrustJourneyStore } from '../../src/core/trustJourney/TrustJourneyStore.js';
import { checkTrustProfileAgainstLog, TrustChangeLogWriter } from '../../src/core/trustJourney/proofCheck.js';
import { issueOperatorProofForTesting } from '../../src/core/TrustRaiseGuard.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let dir: string;
const storeFile = () => path.join(dir, 'tj.jsonl');
const profileFile = () => path.join(dir, 'state', 'trust-profile.json');

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tj-proof-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/trust-journey-proof-check.test.ts' }); });

function wired() {
  const store = new TrustJourneyStore(new LocalFileTrustSink(storeFile()));
  const trust = new AdaptiveTrust({ stateDir: dir });
  const writer = new TrustChangeLogWriter(store);
  trust.setChangeObserver(writer.observe);
  return { store, trust, writer };
}

function handEdit(service: string, op: string, level: string) {
  const p = JSON.parse(fs.readFileSync(profileFile(), 'utf8'));
  p.services[service].operations[op].level = level;
  fs.writeFileSync(profileFile(), JSON.stringify(p));
}

describe('proof check at load', () => {
  it('a hand edit wider than the committed log is restored, and the narrowing it reverses stays', async () => {
    const a = wired();
    a.trust.grantTrust('gmail', 'write', 'approve-always', 'ask me first');
    expect(await a.writer.drain()).toBe(true);
    handEdit('gmail', 'write', 'autonomous');
    const b = wired();
    expect(b.trust.getTrustLevel('gmail', 'write').level).toBe('autonomous');
    const narrowed = checkTrustProfileAgainstLog(b.trust, b.store);
    expect(narrowed).toEqual([{ key: 'gmail.write', from: 'autonomous', to: 'approve-always', why: 'the stored level is wider than the last committed change' }]);
    expect(b.trust.getTrustLevel('gmail', 'write').level).toBe('approve-always');
  });

  it('a raise logged without a recorded consumption is restored to where it came from', async () => {
    const a = wired();
    a.trust.grantTrust('gmail', 'write', 'approve-always', 'ask');
    // A proof whose consumption was never recorded (a forged or lost approval).
    a.trust.grantTrust('gmail', 'write', 'autonomous', 'x', issueOperatorProofForTesting({ kind: 'trust-grant', service: 'gmail', operation: 'write', level: 'autonomous' }));
    expect(await a.writer.drain()).toBe(true);
    const b = wired();
    expect(checkTrustProfileAgainstLog(b.trust, b.store)[0]?.to).toBe('approve-always');
  });

  it('a raise with its recorded consumption stays', async () => {
    const a = wired();
    a.trust.grantTrust('gmail', 'write', 'approve-always', 'ask');
    await a.store.write('consumption', { consumptionId: 'test-receipt', requestId: 'r', receiptId: 'rc', acceptanceId: 'a', proposalHash: 'h', principal: 'owner' });
    a.trust.grantTrust('gmail', 'write', 'autonomous', 'x', issueOperatorProofForTesting({ kind: 'trust-grant', service: 'gmail', operation: 'write', level: 'autonomous' }));
    expect(await a.writer.drain()).toBe(true);
    const b = wired();
    expect(checkTrustProfileAgainstLog(b.trust, b.store)).toEqual([]);
    expect(b.trust.getTrustLevel('gmail', 'write').level).toBe('autonomous');
  });

  it('a level with no logged history (from before the log) is left as it is', () => {
    fs.mkdirSync(path.dirname(profileFile()), { recursive: true });
    fs.writeFileSync(profileFile(), JSON.stringify({ services: { slack: { service: 'slack', operations: { write: { level: 'log', source: 'user-explicit', changedAt: new Date().toISOString() } }, history: {} } }, global: {} }));
    const b = wired();
    expect(checkTrustProfileAgainstLog(b.trust, b.store)).toEqual([]);
  });

  it('a record from a newer build is unreadable: that key falls back to asking', async () => {
    const a = wired();
    a.trust.grantTrust('gmail', 'write', 'approve-always', 'ask');
    await a.writer.drain();
    await a.store.write('change', { changeId: 'n', key: 'gmail.write', from: 'approve-always', to: 'autonomous', direction: 'raise', source: 'x', minReader: 2 });
    handEdit('gmail', 'write', 'autonomous');
    const b = wired();
    expect(b.store.unreadable).toBe(1);
    expect(checkTrustProfileAgainstLog(b.trust, b.store)[0]?.to).toBe('approve-always');
  });
});
