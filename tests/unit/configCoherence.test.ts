/**
 * Phase 2 #7 — startup config-coherence WARNINGS (never a reject). Proves the
 * mesh-off-while-live-transfer flag (the audit's worst-of-both state), the mesh
 * priority checks, and the single-machine / well-formed no-warning cases.
 *
 * mesh-coherence-live-state-honesty:
 *   Fix (c) — the priority check validates the REAL FLAT keys
 *     (priorityTailscale/Lan/Cloudflare), NOT the dead `.priorities` dict.
 *   Fix (b) — checkMeshLiveStateCoherence compares config-intent vs live state.
 */

import { describe, it, expect } from 'vitest';
import {
  checkMultiMachineConfigCoherence,
  checkMeshLiveStateCoherence,
  type MeshLiveState,
} from '../../src/core/configCoherence.js';

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

  // ── Fix (c): the REAL flat priority keys ──────────────────────────────────
  it('flags duplicate flat mesh rope priorities (collision → nondeterministic)', () => {
    const w = checkMultiMachineConfigCoherence(
      { meshTransport: { enabled: true, priorityTailscale: 10, priorityLan: 10, priorityCloudflare: 30 } },
      true,
    );
    expect(codes(w)).toContain('mesh-priority-collision');
  });

  it('flags a zero (non-positive) flat priority', () => {
    const w = checkMultiMachineConfigCoherence(
      { meshTransport: { enabled: true, priorityTailscale: 0, priorityLan: 20, priorityCloudflare: 30 } },
      true,
    );
    expect(codes(w)).toContain('mesh-priority-nonpositive');
  });

  it('flags a negative flat priority', () => {
    const w = checkMultiMachineConfigCoherence(
      { meshTransport: { enabled: true, priorityTailscale: 10, priorityLan: -1, priorityCloudflare: 30 } },
      true,
    );
    expect(codes(w)).toContain('mesh-priority-nonpositive');
  });

  it('flags a non-integer (float) flat priority', () => {
    const w = checkMultiMachineConfigCoherence(
      { meshTransport: { enabled: true, priorityTailscale: 1.5, priorityLan: 20, priorityCloudflare: 30 } },
      true,
    );
    expect(codes(w)).toContain('mesh-priority-nonpositive');
  });

  it('flags a non-finite (Infinity) flat priority', () => {
    const w = checkMultiMachineConfigCoherence(
      { meshTransport: { enabled: true, priorityTailscale: Infinity, priorityLan: 20, priorityCloudflare: 30 } },
      true,
    );
    expect(codes(w)).toContain('mesh-priority-nonpositive');
  });

  it('the shipped default (10/20/30) → no priority warning', () => {
    const w = checkMultiMachineConfigCoherence(
      { meshTransport: { enabled: true, priorityTailscale: 10, priorityLan: 20, priorityCloudflare: 30 }, sessionPool: { enabled: true, stage: 'live-transfer' } },
      true,
    );
    expect(w).toHaveLength(0);
  });

  it('a single defined flat priority → no warning (cannot collide, is positive)', () => {
    const w = checkMultiMachineConfigCoherence(
      { meshTransport: { enabled: true, priorityLan: 20 } },
      true,
    );
    expect(codes(w)).not.toContain('mesh-priority-collision');
    expect(codes(w)).not.toContain('mesh-priority-nonpositive');
  });

  it('dead-code removal: a config carrying an old-style `priorities` dict produces no warning from it', () => {
    // The `.priorities` dict is gone — only the flat keys are validated. A stray dict on the
    // RESOLVED config (cast — it is not a field of the retyped MultiMachineLike, which is the
    // compile-time proof the phantom cannot be reintroduced) is simply ignored.
    const cfg = {
      meshTransport: { enabled: true, priorities: { tailscale: 10, lan: 10 } },
    } as unknown as Parameters<typeof checkMultiMachineConfigCoherence>[0];
    const w = checkMultiMachineConfigCoherence(cfg, true);
    expect(codes(w)).not.toContain('mesh-priority-collision');
    expect(codes(w)).not.toContain('mesh-priority-nonpositive');
  });

  it('undefined config → no warnings (never throws)', () => {
    expect(checkMultiMachineConfigCoherence(undefined, true)).toHaveLength(0);
  });
});

// ── Fix (b): live-state drift, both directions ───────────────────────────────
describe('mesh-coherence-live-state-honesty checkMeshLiveStateCoherence', () => {
  const on = { meshTransport: { enabled: true } };
  const off = { meshTransport: { enabled: false } };

  it('b.1: config off + live boundHost 0.0.0.0 → mesh-config-off-but-live-on', () => {
    const w = checkMeshLiveStateCoherence(off, true, { boundHost: '0.0.0.0' });
    expect(codes(w)).toContain('mesh-config-off-but-live-on');
  });

  it('b.1: config off + live boundHost :: (IPv6 wildcard) → fires (both wildcards are wide)', () => {
    const w = checkMeshLiveStateCoherence(off, true, { boundHost: '::' });
    expect(codes(w)).toContain('mesh-config-off-but-live-on');
  });

  it('b.1 R2-M10 regression: config off + live boundHost 192.168.1.50 (bindHost override) MUST fire, and renders the specific host', () => {
    const w = checkMeshLiveStateCoherence(off, true, { boundHost: '192.168.1.50' });
    expect(codes(w)).toContain('mesh-config-off-but-live-on');
    const msg = w.find((x) => x.code === 'mesh-config-off-but-live-on')!.message;
    expect(msg).toContain('192.168.1.50'); // operator-config-derived, safe to show
  });

  it('b.1: config off + live boundHost 127.0.0.1 but STALE self-entry → no warning (self-entry alone must NOT fire)', () => {
    const w = checkMeshLiveStateCoherence(off, true, {
      boundHost: '127.0.0.1',
      selfEndpoints: [{ kind: 'tailscale', url: 'http://100.1.2.3:4040' }],
    });
    expect(codes(w)).not.toContain('mesh-config-off-but-live-on');
  });

  it('b.1: config off + wide bind + self-entry present → fires with corroboration clause (count only)', () => {
    const w = checkMeshLiveStateCoherence(off, true, {
      boundHost: '0.0.0.0',
      selfEndpoints: [{ kind: 'tailscale', url: 'http://100.1.2.3:4040' }],
    });
    const msg = w.find((x) => x.code === 'mesh-config-off-but-live-on')!.message;
    expect(msg).toContain('1 mesh endpoint(s)');
  });

  it('b.1: config off + loopback bind + no endpoints → no warning (disable HAS taken effect)', () => {
    const w = checkMeshLiveStateCoherence(off, true, { boundHost: '127.0.0.1', selfEndpoints: [] });
    expect(w).toHaveLength(0);
  });

  it('b.2: config on + no endpoints + uptime BELOW grace → no warning (boot-warmup suppression)', () => {
    const w = checkMeshLiveStateCoherence(on, true, { selfEndpoints: [], uptimeMs: 5_000 });
    expect(codes(w)).not.toContain('mesh-config-on-but-live-inert');
  });

  it('b.2: config on + no endpoints + uptime PAST grace → mesh-config-on-but-live-inert (never suppressed forever)', () => {
    const w = checkMeshLiveStateCoherence(on, true, { selfEndpoints: [], uptimeMs: 130_000 });
    expect(codes(w)).toContain('mesh-config-on-but-live-inert');
  });

  it('b.2: config on + endpoints present (any uptime) → no warning (on and advertising)', () => {
    const w = checkMeshLiveStateCoherence(on, true, {
      selfEndpoints: [{ kind: 'lan', url: 'http://192.168.1.5:4040' }],
      uptimeMs: 999_000,
    });
    expect(codes(w)).not.toContain('mesh-config-on-but-live-inert');
  });

  it('R2-M2 warmupGraceMs param override: 90s ≥ 60s override fires; same inputs with default const does not', () => {
    const inputs: MeshLiveState = { selfEndpoints: [], uptimeMs: 90_000 };
    const withOverride = checkMeshLiveStateCoherence(on, true, inputs, 60_000);
    expect(codes(withOverride)).toContain('mesh-config-on-but-live-inert');
    const withDefault = checkMeshLiveStateCoherence(on, true, inputs); // 120s const
    expect(codes(withDefault)).not.toContain('mesh-config-on-but-live-inert');
  });

  it('single-machine no-op: isMultiMachine false → [] regardless of live state', () => {
    expect(checkMeshLiveStateCoherence(off, false, { boundHost: '0.0.0.0' })).toHaveLength(0);
  });

  it('mm undefined → [] (never throws)', () => {
    expect(checkMeshLiveStateCoherence(undefined, true, { boundHost: '0.0.0.0' })).toHaveLength(0);
  });

  it('NO-LEAK invariant: a hostile self-entry url is NEVER rendered in the warning (presence only)', () => {
    const w = checkMeshLiveStateCoherence(off, true, {
      boundHost: '0.0.0.0',
      selfEndpoints: [{ kind: 'tailscale', url: 'http://EVILHOST:9/INJECT<script>' }],
    });
    const msg = w.find((x) => x.code === 'mesh-config-off-but-live-on')!.message;
    expect(msg).not.toContain('EVILHOST');
    expect(msg).not.toContain('INJECT');
    expect(msg).not.toContain('<script>');
    // The payload lives in `url` (a free string), NOT in `kind` (a typed union), so a
    // hostile-string kind would not type-check; url is the realistic peer-controlled vector.
    expect(msg).toContain('1 mesh endpoint(s)'); // count + local host only
    expect(msg).toContain('0.0.0.0');
  });
});
