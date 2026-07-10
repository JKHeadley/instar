/**
 * Tier-3 — token-coverage INVENTORY over every protected self-action sink
 * (companion §13 Tier 3; spec CX4-4).
 *
 * Enumerates every retrofitted emit SINK and asserts:
 *  (a) each sink module pins its expected controller identity MODULE-SIDE —
 *      the literal controllerId appears in its consumeAdmissionToken call
 *      (a token minted for controller X is rejected at a sink for Y even when
 *      the callsite presents Y consistently);
 *  (b) the runtime consume is the AUTHORITY: each sink identity REJECTS a
 *      missing / invalid / wrong-controller / replayed token at runtime in
 *      enforce mode (the compile-time AdmissionToken type is defense-in-depth
 *      a cast can evade — the runtime consume cannot be);
 *  (c) the DUAL-USE principal surfaces (the operator kill routes) are
 *      accommodated: routes.ts carries the privileged principalAdmit stamp,
 *      and the principal-surface allowlist matches the dual-use sink list.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  initSelfActionGovernor,
  resetSelfActionGovernorModuleForTest,
} from '../../src/monitoring/selfaction/governor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { resetAnchorForTest } from '../../src/monitoring/selfaction/anchor.js';
// eslint-disable-next-line import/no-relative-packages
import { PRINCIPAL_SURFACE_ALLOWLIST } from '../../scripts/lint-emit-without-admit.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * THE INVENTORY — every protected sink shipped in Increment B's retrofit set
 * (the five registry-modeled controllers; further emit sites join as they are
 * retrofitted — this table is the ratchet they extend).
 */
const SINK_INVENTORY: ReadonlyArray<{ controllerId: string; sinkModule: string }> = [
  { controllerId: 'age-kill-backoff', sinkModule: 'src/core/SessionManager.ts' },
  { controllerId: 'proactive-swap-monitor', sinkModule: 'src/core/ProactiveSwapMonitor.ts' },
  { controllerId: 'promise-beacon-notify', sinkModule: 'src/monitoring/PromiseBeacon.ts' },
  { controllerId: 'liveness-heartbeat', sinkModule: 'src/monitoring/PromiseBeacon.ts' },
  { controllerId: 'external-hog-kill-breaker', sinkModule: 'src/monitoring/ExternalHogScanTick.ts' },
];

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sag-sink-'));
  resetSelfActionGovernorModuleForTest();
  resetAnchorForTest();
});

afterEach(() => {
  resetSelfActionGovernorModuleForTest();
  resetAnchorForTest();
  SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/self-action-token-coverage.test.ts' });
});

describe('sink identity is pinned MODULE-SIDE (static half)', () => {
  for (const { controllerId, sinkModule } of SINK_INVENTORY) {
    it(`${sinkModule} pins '${controllerId}' as a literal in its consume call`, () => {
      const src = fs.readFileSync(path.join(ROOT, sinkModule), 'utf-8');
      // The sink consumes with the LITERAL id — never a variable the caller
      // could substitute (identity bound at registration + sink, not caller
      // choice).
      const re = new RegExp(String.raw`consumeAdmissionToken\([^)]*?['"]${controllerId}['"]`, 's');
      expect(re.test(src), `expected a consumeAdmissionToken(..., '${controllerId}') pin in ${sinkModule}`).toBe(true);
    });
  }

  it('every sink module also carries the matching @self-action-controller marker', () => {
    for (const { controllerId, sinkModule } of SINK_INVENTORY) {
      const src = fs.readFileSync(path.join(ROOT, sinkModule), 'utf-8');
      expect(src).toContain(`@self-action-controller: ${controllerId}`);
    }
  });
});

describe('runtime consume is the AUTHORITY (dynamic half)', () => {
  it('every inventoried sink identity rejects missing/invalid/wrong-controller/replayed tokens in enforce mode', () => {
    const classes: Record<string, unknown> = {};
    for (const { controllerId } of SINK_INVENTORY) classes[controllerId] = { mode: 'enforce' };
    const gov = initSelfActionGovernor({
      stateDir: tmp,
      readEmergencyDisable: () => false,
      readClassesConfig: () => classes,
    });
    for (const { controllerId } of SINK_INVENTORY) {
      // Missing token → reject (proceed=false under enforce).
      const missing = gov.consumeToken(null, controllerId);
      expect(missing.valid, controllerId).toBe(false);
      expect(missing.proceed, controllerId).toBe(false);
      // Forged token id → reject.
      const forged = gov.consumeToken({ id: 'sag-forged-000' }, controllerId);
      expect(forged.valid, controllerId).toBe(false);
      expect(forged.proceed, controllerId).toBe(false);
    }
    // Wrong-controller: a token minted for A is rejected at sink B even when
    // presented consistently (consistency ≠ authenticity).
    const hA = gov.for('age-kill-backoff');
    const a = hA.admitSync({ key: 'session:s1', classId: 'session', keyIsVolatile: false });
    expect(a.outcome).toBe('allow');
    const tokenA = a.outcome === 'allow' ? a.token : null;
    const atB = gov.consumeToken(tokenA, 'external-hog-kill-breaker');
    expect(atB.valid).toBe(false);
    expect(atB.proceed).toBe(false);
    // Replay: consume once OK, second time rejected.
    const ok = gov.consumeToken(tokenA, 'age-kill-backoff');
    expect(ok.valid).toBe(true);
    const replay = gov.consumeToken(tokenA, 'age-kill-backoff');
    expect(replay.valid).toBe(false);
    expect(replay.proceed).toBe(false);
  });
});

describe('dual-use principal surfaces (FD13 accommodation)', () => {
  it('the operator kill routes carry the privileged principalAdmit stamp (PIN-distinguishable from bare Bearer)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'server', 'routes.ts'), 'utf-8');
    expect(src).toContain("principalAdmit('dashboard-pin-session'");
    expect(src).toContain('x-instar-principal-pin');
    // Both dual-use kill surfaces route through the provenance helper
    // (the arrow-decl itself is `= (req...` — the two matches are the CALLS).
    expect(src.match(/recordPrincipalKillProvenance\(/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it('the lint principal-surface enumeration matches the dual-use sink list', () => {
    // The dual-use entry surfaces: the routes module (DELETE /sessions/:id +
    // POST /sessions/:name/remote-close). The governor module + types are
    // self-scope. Nothing else may import the privileged API.
    expect(PRINCIPAL_SURFACE_ALLOWLIST.has('src/server/routes.ts')).toBe(true);
    const nonSelf = [...PRINCIPAL_SURFACE_ALLOWLIST].filter((f) => !String(f).includes('selfaction/'));
    expect(nonSelf).toEqual(['src/server/routes.ts']);
  });
});
