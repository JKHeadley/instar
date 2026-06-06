/**
 * Unit tests — Principal-Coherence seam (Know Your Principal / Caroline
 * identity-bleed standard, security build increment 3).
 *
 * The observe-only outbound check (routes.ts → observePrincipalCoherence) feeds
 * `TopicOperatorStore.asVerifiedOperator(topicId)` straight into
 * `evaluatePrincipalCoherence(text, operator)`. These two modules are unit-tested
 * in isolation elsewhere; THIS test locks the CONTRACT between them — the exact
 * seam the wiring depends on — so a future change to either side that breaks the
 * other is caught here, with both sides of the decision boundary exercised:
 *   - an attribution to the BOUND operator's name           → no finding
 *   - an attribution to an OUTSIDER (the Caroline failure)   → finding
 *   - an UNBOUND topic (null operator)                       → finding (unverifiable)
 *   - a credential/mandate kind                              → BLOCK verdict
 *   - prose with no operator-role attribution                → no finding
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TopicOperatorStore } from '../../src/users/TopicOperatorStore.js';
import { evaluatePrincipalCoherence } from '../../src/core/PrincipalGuard.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-seam-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/principal-coherence-operator-seam.test.ts' }); });

describe('Principal-Coherence seam — store.asVerifiedOperator → evaluatePrincipalCoherence', () => {
  it('an attribution to the BOUND operator resolves and produces NO finding', () => {
    const store = new TopicOperatorStore(dir);
    store.setOperator(701, { platform: 'telegram', uid: '55501', displayName: 'Justin' });
    const operator = store.asVerifiedOperator(701);

    const findings = evaluatePrincipalCoherence('Justin approved the plan, so I shipped it.', operator);
    expect(findings).toHaveLength(0);
  });

  it('an attribution to an OUTSIDER produces a finding (the Caroline failure)', () => {
    const store = new TopicOperatorStore(dir);
    store.setOperator(702, { platform: 'telegram', uid: '55502', displayName: 'Justin' });
    const operator = store.asVerifiedOperator(702);

    const findings = evaluatePrincipalCoherence('Caroline approved the migration.', operator);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].attribution.principal).toBe('caroline');
    expect(findings[0].verdict).toBe('warn'); // approval kind → warn
  });

  it('an UNBOUND topic yields a null operator and the attribution is unverifiable', () => {
    const store = new TopicOperatorStore(dir);
    const operator = store.asVerifiedOperator(703); // never bound
    expect(operator).toBeNull();

    const findings = evaluatePrincipalCoherence('Mandate (Caroline) authorized this.', operator);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].attribution.principal).toBe('caroline');
    // mandate kind → block verdict (recorded by observe mode, never enforced)
    expect(findings[0].verdict).toBe('block');
    expect(findings[0].reason).toContain('no bound operator');
  });

  it('a credential attribution to an outsider carries a BLOCK verdict through the seam', () => {
    const store = new TopicOperatorStore(dir);
    store.setOperator(704, { platform: 'telegram', uid: '55504', displayName: 'Justin' });
    const operator = store.asVerifiedOperator(704);

    const findings = evaluatePrincipalCoherence('Caroline dropped a token for the deploy.', operator);
    const cred = findings.find((f) => f.attribution.kind === 'credential');
    expect(cred).toBeTruthy();
    expect(cred!.verdict).toBe('block');
  });

  it('prose with no operator-role attribution produces no finding even when unbound', () => {
    const store = new TopicOperatorStore(dir);
    const operator = store.asVerifiedOperator(705);
    const findings = evaluatePrincipalCoherence('I built the feature and ran the tests; everything is green.', operator);
    expect(findings).toHaveLength(0);
  });
});
