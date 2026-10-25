import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { PasskeyIssuerSet, type IssuerMachineStatus } from '../../src/core/PasskeyIssuerSet.js';

// Spec docs/specs/agent-held-google-passkey.md §3.3 / FD21 — expected-issuer set: no TOFU, self on
// local PIN, peers only by local confirmation or a signed issuer-add; revoked ⇒ removed, other
// non-active states ⇒ refused but kept.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'passkey-issuer-set.test cleanup' }); });

function mk(status: Record<string, IssuerMachineStatus> = {}, quarantined: string[] = []) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-issuers-')); dirs.push(stateDir);
  const set = new PasskeyIssuerSet({ stateDir, selfMachineId: 'm_self',
    machineStatus: (id) => status[id] ?? (id === 'm_self' ? 'active' : 'missing'),
    quarantinePending: (id) => quarantined.includes(id) });
  return { stateDir, set, status };
}

describe('PasskeyIssuerSet', () => {
  it('starts empty (no trust-on-first-use): an unlisted machine is never trusted, even when active', () => {
    const { set } = mk({ m_peer: 'active' });
    expect(set.list()).toEqual([]);
    expect(set.verdict('m_peer')).toEqual({ trusted: false, reason: 'not-an-issuer' });
    expect(set.verdict('m_self')).toEqual({ trusted: false, reason: 'not-an-issuer' });
  });

  it("a machine's own local PIN adds itself once; peers arrive by local confirmation or a signed issuer-add", () => {
    const { set } = mk({ m_peer: 'active', m_other: 'active' });
    expect(set.addSelfOnLocalPin()).toEqual({ added: true });
    expect(set.addSelfOnLocalPin()).toEqual({ added: false });
    expect(set.add({ machineId: 'm_peer', addedVia: 'operator-confirmed' })).toEqual({ added: true });
    expect(set.add({ machineId: 'm_other', addedVia: 'issuer-add', addedByIssuer: 'm_peer' })).toEqual({ added: true });
    expect(set.peerIssuers().map((i) => [i.machineId, i.addedVia, i.addedByIssuer ?? null])).toEqual([['m_peer', 'operator-confirmed', null], ['m_other', 'issuer-add', 'm_peer']]);
    expect(set.verdict('m_self')).toEqual({ trusted: true });
    expect(set.verdict('m_peer')).toEqual({ trusted: true });
    expect(set.remove('m_other')).toEqual({ removed: true });
    expect(set.remove('m_other')).toEqual({ removed: false });
  });

  it('a REVOKED issuer is refused and lazily removed; pending/missing/unreadable/quarantined are refused but KEPT', () => {
    const { set, status } = mk({ m_rev: 'active', m_pend: 'pending', m_gone: 'missing', m_bad: 'unreadable', m_q: 'active' }, ['m_q']);
    for (const id of ['m_rev', 'm_pend', 'm_gone', 'm_bad', 'm_q']) set.add({ machineId: id, addedVia: 'operator-confirmed' });
    expect(set.verdict('m_rev')).toEqual({ trusted: true });
    status.m_rev = 'revoked';
    expect(set.verdict('m_rev')).toEqual({ trusted: false, reason: 'issuer-revoked', removed: true });
    expect(set.isListed('m_rev')).toBe(false);
    expect(set.verdict('m_rev')).toEqual({ trusted: false, reason: 'not-an-issuer' }); // stays gone even if it re-activates
    expect(set.verdict('m_pend')).toEqual({ trusted: false, reason: 'issuer-pending' });
    expect(set.verdict('m_gone')).toEqual({ trusted: false, reason: 'issuer-missing' });
    expect(set.verdict('m_bad')).toEqual({ trusted: false, reason: 'issuer-unreadable' });
    expect(set.verdict('m_q')).toEqual({ trusted: false, reason: 'issuer-quarantined' });
    expect(set.list().map((i) => i.machineId).sort()).toEqual(['m_bad', 'm_gone', 'm_pend', 'm_q']);
    // Recovery is honoured on the next check (nothing was forgotten).
    status.m_pend = 'active';
    expect(set.verdict('m_pend')).toEqual({ trusted: true });
  });

  it('a corrupt issuers file fails CLOSED (throws) rather than reading as empty', () => {
    const { stateDir, set } = mk();
    set.addSelfOnLocalPin();
    fs.writeFileSync(path.join(stateDir, 'state', 'passkey-issuers.json'), '[]');
    expect(() => set.verdict('m_self')).toThrow('passkey-issuers-unreadable');
  });
});
