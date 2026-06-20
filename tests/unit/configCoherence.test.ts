/**
 * Phase 2 #7 — startup config-coherence WARNINGS (never a reject). Proves the
 * mesh-off-while-live-transfer flag (the audit's worst-of-both state), the mesh
 * priority checks, and the single-machine / well-formed no-warning cases.
 */

import { describe, it, expect } from 'vitest';
import { checkMultiMachineConfigCoherence } from '../../src/core/configCoherence.js';

const codes = (w: { code: string }[]) => w.map((x) => x.code);

describe('Phase 2 #7 checkMultiMachineConfigCoherence', () => {
  it('flags meshTransport.enabled:false while sessionPool live-transfer (multi-machine)', () => {
    const w = checkMultiMachineConfigCoherence(
      { meshTransport: { enabled: false }, sessionPool: { enabled: true, stage: 'live-transfer' } },
      true,
    );
    expect(codes(w)).toContain('mesh-off-while-live-transfer');
  });

  it('does NOT flag on a single-machine agent (harmless no-op there)', () => {
    const w = checkMultiMachineConfigCoherence(
      { meshTransport: { enabled: false }, sessionPool: { enabled: true, stage: 'live-transfer' } },
      false, // single-machine
    );
    expect(w).toHaveLength(0);
  });

  it('does NOT flag when mesh is on (the coherent default)', () => {
    const w = checkMultiMachineConfigCoherence(
      { meshTransport: { enabled: true }, sessionPool: { enabled: true, stage: 'live-transfer' } },
      true,
    );
    expect(codes(w)).not.toContain('mesh-off-while-live-transfer');
  });

  it('flags duplicate mesh rope priorities (nondeterministic selection)', () => {
    const w = checkMultiMachineConfigCoherence(
      { meshTransport: { enabled: true, priorities: { tailscale: 10, lan: 10, cloudflare: 30 } } },
      true,
    );
    expect(codes(w)).toContain('mesh-priority-collision');
  });

  it('flags non-positive / non-integer mesh priorities', () => {
    const w = checkMultiMachineConfigCoherence(
      { meshTransport: { enabled: true, priorities: { tailscale: 0, lan: -1, cloudflare: 30 } } },
      true,
    );
    expect(codes(w)).toContain('mesh-priority-nonpositive');
  });

  it('well-formed multi-machine config → no warnings', () => {
    const w = checkMultiMachineConfigCoherence(
      { meshTransport: { enabled: true, priorities: { tailscale: 10, lan: 20, cloudflare: 30 } }, sessionPool: { enabled: true, stage: 'live-transfer' } },
      true,
    );
    expect(w).toHaveLength(0);
  });

  it('undefined config → no warnings (never throws)', () => {
    expect(checkMultiMachineConfigCoherence(undefined, true)).toHaveLength(0);
  });
});
