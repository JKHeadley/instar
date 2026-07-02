/**
 * SpawnRequestManager — live max-sessions accessor & cap parity tests.
 *
 * Audit 2026-05-23, item #2: SpawnRequestManager previously captured
 * `maxSessions` at construction time. Operators who edited
 * `sessions.maxSessions` at runtime saw `/status.sessions.max` reflect
 * the new value while the spawn manager kept enforcing the old one —
 * `Session limit reached (15/10)` even though /status reported a 30 cap.
 *
 * This file pins the new contract:
 *
 *   1. A function-valued `maxSessions` is re-read on every `evaluate()`.
 *   2. `getMaxSessions()` reads live, never cached.
 *   3. Numeric `maxSessions` still works (backward compatibility).
 *   4. Non-finite / zero / negative accessor values defensively fall
 *      back to a cap of 1 — a misconfigured closure can't accidentally
 *      open the gate to unbounded spawning.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  SpawnRequestManager,
  type SpawnRequest,
  type SpawnRequestManagerConfig,
} from '../../src/messaging/SpawnRequestManager.js';
import type { Session } from '../../src/core/types.js';

function makeRequest(overrides?: Partial<SpawnRequest>): SpawnRequest {
  return {
    requester: { agent: 'agent-a', session: 'sess-1', machine: 'machine-1' },
    target: { agent: 'agent-b', machine: 'machine-2' },
    reason: 'Live-cap test',
    priority: 'medium',
    ...overrides,
  };
}

function makeSession(name: string): Session {
  return {
    id: `id-${name}`,
    name,
    tmuxSession: `proj-${name}`,
    status: 'running',
    startedAt: new Date(),
    model: 'sonnet' as any,
  } as Session;
}

function makeConfig(overrides?: Partial<SpawnRequestManagerConfig>): SpawnRequestManagerConfig {
  return {
    maxSessions: 5,
    getActiveSessions: () => [],
    spawnSession: vi.fn().mockResolvedValue('spawned'),
    cooldownMs: 1_000,
    ...overrides,
  };
}

describe('SpawnRequestManager — live max-sessions accessor', () => {
  it('reads cap live from a function accessor on each evaluate()', async () => {
    let cap = 2;
    const sessions: Session[] = [makeSession('s1'), makeSession('s2')];

    const manager = new SpawnRequestManager(
      makeConfig({
        maxSessions: () => cap,
        getActiveSessions: () => sessions,
      }),
    );

    // 2 active, cap=2, medium priority — should be denied.
    const denied = await manager.evaluate(makeRequest({ requester: { agent: 'peer-x', session: 'sess', machine: 'm' } }));
    expect(denied.approved).toBe(false);
    expect(denied.reason).toContain('Session limit reached (2/2)');

    // Operator raises cap at runtime (no construction-time rebuild).
    cap = 10;

    const allowed = await manager.evaluate(makeRequest({ requester: { agent: 'peer-y', session: 'sess', machine: 'm' } }));
    expect(allowed.approved).toBe(true);
  });

  it('still honors a numeric maxSessions for backward compatibility', async () => {
    const sessions: Session[] = [makeSession('a'), makeSession('b')];
    const manager = new SpawnRequestManager(
      makeConfig({
        maxSessions: 2,
        getActiveSessions: () => sessions,
      }),
    );

    const denied = await manager.evaluate(makeRequest({ requester: { agent: 'numeric-peer', session: 's', machine: 'm' } }));
    expect(denied.approved).toBe(false);
    expect(denied.reason).toContain('Session limit reached (2/2)');
  });

  it('exposes getMaxSessions() reading live, never cached', () => {
    let cap = 7;
    const manager = new SpawnRequestManager(makeConfig({ maxSessions: () => cap }));
    expect(manager.getMaxSessions()).toBe(7);
    cap = 12;
    expect(manager.getMaxSessions()).toBe(12);
  });

  it('clamps a non-finite or non-positive accessor value to a safe cap of 1', async () => {
    const sessions: Session[] = [makeSession('only')];

    // NaN-returning accessor: fall back to cap=1, deny because we are at the cap.
    const managerNaN = new SpawnRequestManager(
      makeConfig({
        maxSessions: () => Number.NaN,
        getActiveSessions: () => sessions,
      }),
    );
    expect(managerNaN.getMaxSessions()).toBe(1);
    const r1 = await managerNaN.evaluate(makeRequest({ requester: { agent: 'p1', session: 's', machine: 'm' } }));
    expect(r1.approved).toBe(false);

    // Zero / negative accessor: same defensive clamp to 1.
    const managerZero = new SpawnRequestManager(
      makeConfig({
        maxSessions: () => 0,
        getActiveSessions: () => sessions,
      }),
    );
    expect(managerZero.getMaxSessions()).toBe(1);
  });

  it('high-priority traffic still overrides the cap when the accessor is live', async () => {
    const sessions: Session[] = [makeSession('s1'), makeSession('s2')];
    const manager = new SpawnRequestManager(
      makeConfig({
        maxSessions: () => 2,
        getActiveSessions: () => sessions,
      }),
    );

    const highOk = await manager.evaluate(
      makeRequest({ priority: 'high', requester: { agent: 'urgent-1', session: 's', machine: 'm' } }),
    );
    expect(highOk.approved).toBe(true);

    const criticalOk = await manager.evaluate(
      makeRequest({ priority: 'critical', requester: { agent: 'urgent-2', session: 's', machine: 'm' } }),
    );
    expect(criticalOk.approved).toBe(true);
  });
});
