/**
 * The reconciler — spec agent-identity-continuity-on-expansion.md §3, criteria 6, 6b, 7b.
 *
 * Repairing to the WRONG identity takes the agent off the network, so the tests that matter
 * are the REFUSALS. A reconciler that decides confidently on thin evidence is the failure
 * mode; one that asks is the design.
 */
import { describe, it, expect } from 'vitest';
import {
  decideReconciliation,
  applyOperatorChoice,
  renderChoiceConfirmation,
  type IdentityCandidate,
} from '../../src/core/AgentIdentityReconciler.js';

const CANON = '63b1dbb21646e2f5f860441f6c6443ad';
const ORPHAN = 'ae6feac662480f9509c04ceb72ae2540';

const prov = (origin: 'minted-standalone' | 'received-on-join', root: string, version = '1.3.1181') => ({
  schemaVersion: 1 as const,
  origin,
  rootFingerprint: root,
  machineId: 'm_x',
  createdAt: '2026-01-01T00:00:00.000Z',
  producedBy: version,
});

describe('decideReconciliation — lineage decides only when it honestly can', () => {
  it('NO-OP when there is only one identity', () => {
    const d = decideReconciliation({ agentName: 'echo', candidates: [{ fingerprint: CANON, machineNames: ['A'] }] });
    expect(d.action).toBe('no-op');
  });

  it('REPAIRS to the attested minted-standalone root', () => {
    const candidates: IdentityCandidate[] = [
      { fingerprint: CANON, machineNames: ['Mini', 'Laptop'], provenance: prov('minted-standalone', CANON) },
      { fingerprint: ORPHAN, machineNames: ['Studio'], provenance: prov('received-on-join', CANON) },
    ];
    const d = decideReconciliation({ agentName: 'echo', candidates });
    expect(d.action).toBe('repair');
    if (d.action !== 'repair') return;
    expect(d.canonicalFingerprint).toBe(CANON);
    expect(d.repairMachines).toEqual(['Studio']);
  });

  it('ASKS THE OPERATOR for the LIVE 2026-08-19 split — no provenance anywhere', () => {
    // This is the actual case on the operator's machines: both identities predate the record.
    // Lineage cannot decide it, and the spec says so rather than inventing a tiebreak.
    const d = decideReconciliation({
      agentName: 'echo',
      candidates: [
        { fingerprint: CANON, machineNames: ['Mini', 'Laptop'], firstSeen: '2026-05-02T00:00:00Z' },
        { fingerprint: ORPHAN, machineNames: ['Studio'], firstSeen: '2026-08-19T01:40:38Z' },
      ],
    });
    expect(d.action).toBe('ask-operator');
    if (d.action !== 'ask-operator') return;
    expect(d.reason).toBe('no-attested-root');
    expect(d.candidates).toHaveLength(2);
  });

  it('ASKS when ANY candidate is unattested — a win by default is not a decision', () => {
    const d = decideReconciliation({
      agentName: 'echo',
      candidates: [
        { fingerprint: CANON, machineNames: ['Mini'], provenance: prov('minted-standalone', CANON) },
        { fingerprint: ORPHAN, machineNames: ['Studio'] }, // no record at all
      ],
    });
    expect(d.action).toBe('ask-operator');
    if (d.action === 'ask-operator') expect(d.reason).toBe('unattested-version-present');
  });

  it('ASKS when a candidate was produced by a version this build does not trust', () => {
    const d = decideReconciliation({
      agentName: 'echo',
      candidates: [
        { fingerprint: CANON, machineNames: ['Mini'], provenance: prov('minted-standalone', CANON, '1.3.1181') },
        { fingerprint: ORPHAN, machineNames: ['Studio'], provenance: prov('minted-standalone', ORPHAN, '0.9.0') },
      ],
      attestedVersions: (v) => v === '1.3.1181',
    });
    expect(d.action).toBe('ask-operator');
  });

  it('ASKS when TWO candidates each claim to be an origin', () => {
    const d = decideReconciliation({
      agentName: 'echo',
      candidates: [
        { fingerprint: CANON, machineNames: ['Mini'], provenance: prov('minted-standalone', CANON) },
        { fingerprint: ORPHAN, machineNames: ['Studio'], provenance: prov('minted-standalone', ORPHAN) },
      ],
    });
    expect(d.action).toBe('ask-operator');
    if (d.action === 'ask-operator') expect(d.reason).toBe('multiple-roots');
  });

  it('ASKS when every candidate merely RECEIVED its identity — no root present', () => {
    const d = decideReconciliation({
      agentName: 'echo',
      candidates: [
        { fingerprint: CANON, machineNames: ['A'], provenance: prov('received-on-join', CANON) },
        { fingerprint: ORPHAN, machineNames: ['B'], provenance: prov('received-on-join', ORPHAN) },
      ],
    });
    expect(d.action).toBe('ask-operator');
    if (d.action === 'ask-operator') expect(d.reason).toBe('no-attested-root');
  });

  it('does NOT let majority decide — two wrong machines cannot outvote one right one', () => {
    const d = decideReconciliation({
      agentName: 'echo',
      candidates: [
        { fingerprint: ORPHAN, machineNames: ['A', 'B', 'C'] }, // the majority
        { fingerprint: CANON, machineNames: ['D'] },
      ],
    });
    expect(d.action).toBe('ask-operator');
  });

  it('does NOT let age decide — an older identity is described, never preferred', () => {
    const d = decideReconciliation({
      agentName: 'echo',
      candidates: [
        { fingerprint: CANON, machineNames: ['A'], firstSeen: '2020-01-01T00:00:00Z' },
        { fingerprint: ORPHAN, machineNames: ['B'], firstSeen: '2026-08-19T00:00:00Z' },
      ],
    });
    expect(d.action).toBe('ask-operator');
  });

  it('describes candidates in human terms, with the machines named', () => {
    const d = decideReconciliation({
      agentName: 'echo',
      candidates: [
        { fingerprint: CANON, machineNames: ['Mini', 'Laptop'], firstSeen: '2026-05-02T00:00:00Z' },
        { fingerprint: ORPHAN, machineNames: ['Studio'], firstSeen: '2026-08-19T01:40:38Z' },
      ],
    });
    if (d.action !== 'ask-operator') throw new Error('expected ask-operator');
    expect(d.candidates[0].description).toContain('Mini and Laptop');
    expect(d.candidates[0].description).toContain('2026-05-02');
    expect(d.candidates[1].description).toContain('Studio');
  });
});

describe('applyOperatorChoice — bound to the set actually shown', () => {
  const candidates = [
    { fingerprint: CANON, description: 'The identity used by Mini and Laptop', machineNames: ['Mini', 'Laptop'] },
    { fingerprint: ORPHAN, description: 'The identity used by Studio', machineNames: ['Studio'] },
  ];

  it('accepts a choice from the offered set and names what gets repaired', () => {
    const r = applyOperatorChoice({ candidates, chosenFingerprint: CANON });
    expect(r.accepted).toBe(true);
    if (r.accepted) expect(r.repairMachines).toEqual(['Studio']);
  });

  it('REFUSES a fingerprint that was never on offer — never interprets it', () => {
    const r = applyOperatorChoice({ candidates, chosenFingerprint: 'f'.repeat(32) });
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toBe('not-a-candidate');
  });

  it('treats no answer as CANCELLED, changing nothing', () => {
    const r = applyOperatorChoice({ candidates, chosenFingerprint: null });
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toBe('cancelled');
  });
});

describe('renderChoiceConfirmation — the plain restatement, not a bare yes', () => {
  it('states what changes, that it is reversible, and what does NOT change', () => {
    const text = renderChoiceConfirmation({
      agentName: 'echo',
      chosen: { fingerprint: CANON, description: 'The identity used by Mini and Laptop', machineNames: ['Mini', 'Laptop'] },
      losing: [{ fingerprint: ORPHAN, description: 'The identity used by Studio', machineNames: ['Studio'] }],
    });
    expect(text).toContain('Studio');
    expect(text.toLowerCase()).toContain('reversible');
    expect(text.toLowerCase()).toContain('backup');
    // The honest limits must be in the confirmation, not only in the spec.
    expect(text.toLowerCase()).toContain('stays registered on the relay');
    expect(text.toLowerCase()).toContain('machine keys');
  });
});
