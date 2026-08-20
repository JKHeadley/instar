/**
 * The divergence detector — spec agent-identity-continuity-on-expansion.md §4, criterion 7.
 *
 * The load-bearing behaviour is NOT "spots a split". It is that `cannot-tell` never renders as
 * agreement: the live incident went four days unreported, and a detector that reports quiet as
 * healthy would have gone on not reporting it.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateDivergence,
  divergenceNotice,
  type MachineIdentityObservation,
} from '../../src/core/AgentIdentityDivergenceDetector.js';

const m = (name: string, fp: string | null, reason?: string): MachineIdentityObservation => ({
  machineId: `m_${name}`,
  machineName: name,
  publishedFingerprint: fp,
  ...(reason ? { unreachableReason: reason } : {}),
});

const CANON = '63b1dbb21646e2f5f860441f6c6443ad';
const ORPHAN = 'ae6feac662480f9509c04ceb72ae2540';

describe('evaluateDivergence', () => {
  it('DISAGREE: reproduces the live 2026-08-19 split', () => {
    const v = evaluateDivergence({
      agentName: 'echo',
      observations: [m('Mini', CANON), m('Laptop', CANON), m('Studio', ORPHAN)],
    });
    expect(v.state).toBe('disagree');
    expect(v.shouldNotify).toBe(true);
    expect(v.fingerprints).toHaveLength(2);
    expect(v.byFingerprint[CANON]).toEqual(['Mini', 'Laptop']);
    expect(v.byFingerprint[ORPHAN]).toEqual(['Studio']);
  });

  it('AGREE: all machines publishing one identity does not notify', () => {
    const v = evaluateDivergence({ agentName: 'echo', observations: [m('Mini', CANON), m('Laptop', CANON)] });
    expect(v.state).toBe('agree');
    expect(v.shouldNotify).toBe(false);
  });

  it('CANNOT-TELL, not agree, when only one machine could be read', () => {
    // The failure this whole detector exists to prevent: absence of evidence rendered as
    // evidence of absence. One machine agreeing with itself proves nothing.
    const v = evaluateDivergence({
      agentName: 'echo',
      observations: [m('Studio', ORPHAN), m('Mini', null, 'offline'), m('Laptop', null, 'timeout')],
    });
    expect(v.state).toBe('cannot-tell');
    expect(v.shouldNotify).toBe(false);
  });

  it('CANNOT-TELL when nothing at all could be read', () => {
    const v = evaluateDivergence({ agentName: 'echo', observations: [m('Mini', null, 'offline')] });
    expect(v.state).toBe('cannot-tell');
  });

  it('an unreachable machine is REPORTED even when the readable ones agree', () => {
    // "Two agree and one is unreachable" must not render identically to "all three agree".
    const v = evaluateDivergence({
      agentName: 'echo',
      observations: [m('Mini', CANON), m('Laptop', CANON), m('Studio', null, 'offline')],
    });
    expect(v.state).toBe('agree');
    expect(v.unreadable).toEqual([{ machineId: 'm_Studio', machineName: 'Studio', reason: 'offline' }]);
  });

  it('names a reason for every unreadable machine, defaulting to unknown rather than omitting', () => {
    const v = evaluateDivergence({ agentName: 'echo', observations: [m('A', CANON), m('B', CANON), m('C', null)] });
    expect(v.unreadable[0].reason).toBe('unknown');
  });

  it('the episode key is stable across machines and boots — one notice, not one per boot', () => {
    const fromStudio = evaluateDivergence({ agentName: 'echo', observations: [m('Studio', ORPHAN), m('Mini', CANON)] });
    const fromMini = evaluateDivergence({ agentName: 'echo', observations: [m('Mini', CANON), m('Studio', ORPHAN)] });
    expect(fromStudio.episodeKey).toBe(fromMini.episodeKey);
    expect(fromStudio.episodeKey).toBeTruthy();
  });

  it('a CHANGED split is a NEW episode — the operator is told the situation moved', () => {
    const before = evaluateDivergence({ agentName: 'echo', observations: [m('A', CANON), m('B', ORPHAN)] });
    const after = evaluateDivergence({ agentName: 'echo', observations: [m('A', CANON), m('B', 'c'.repeat(32))] });
    expect(before.episodeKey).not.toBe(after.episodeKey);
  });

  it('a different AGENT with the same fingerprints is a different episode', () => {
    const a = evaluateDivergence({ agentName: 'echo', observations: [m('A', CANON), m('B', ORPHAN)] });
    const b = evaluateDivergence({ agentName: 'codey', observations: [m('A', CANON), m('B', ORPHAN)] });
    expect(a.episodeKey).not.toBe(b.episodeKey);
  });

  it('agree and cannot-tell carry no episode key — only a real split opens an episode', () => {
    expect(evaluateDivergence({ agentName: 'echo', observations: [m('A', CANON), m('B', CANON)] }).episodeKey).toBeNull();
    expect(evaluateDivergence({ agentName: 'echo', observations: [m('A', CANON)] }).episodeKey).toBeNull();
  });

  it('three-way splits are reported in full, not reduced to a pair', () => {
    const v = evaluateDivergence({
      agentName: 'echo',
      observations: [m('A', CANON), m('B', ORPHAN), m('C', 'd'.repeat(32))],
    });
    expect(v.state).toBe('disagree');
    expect(v.fingerprints).toHaveLength(3);
  });
});

describe('divergenceNotice — what the operator reads', () => {
  const v = evaluateDivergence({
    agentName: 'echo',
    observations: [m('Mini', CANON), m('Laptop', CANON), m('Studio', ORPHAN)],
  });

  it('leads with machines, not hex, and states the consequence', () => {
    const n = divergenceNotice(v, 'echo');
    expect(n.title).toContain('more than one identity');
    expect(n.body).toContain('Mini, Laptop');
    expect(n.body).toContain('Studio');
    expect(n.body.toLowerCase()).toContain("won't verify");
  });

  it('shows fingerprints only as short supporting detail, never in full', () => {
    const n = divergenceNotice(v, 'echo');
    expect(n.body).not.toContain(CANON); // never the full 32-char string
    expect(n.body).toContain(CANON.slice(0, 8));
  });

  it('says nothing is changed automatically, and why', () => {
    const n = divergenceNotice(v, 'echo');
    expect(n.body).toMatch(/nothing is changed|one decision from you/i);
    expect(n.body).toMatch(/off the network/i);
  });

  it('reports unreachable machines as unknown rather than letting them read as agreement', () => {
    const withGap = evaluateDivergence({
      agentName: 'echo',
      observations: [m('Mini', CANON), m('Studio', ORPHAN), m('Laptop', null, 'offline')],
    });
    const n = divergenceNotice(withGap, 'echo');
    expect(n.body).toContain("Couldn't check");
    expect(n.body).toContain('unknown, not agreement');
  });
});
