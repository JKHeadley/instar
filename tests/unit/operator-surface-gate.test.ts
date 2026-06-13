/**
 * Operator-Surface Quality review gate — the pure decision logic
 * (docs/STANDARDS-REGISTRY.md → "Operator-Surface Quality", CMT-1434).
 *
 * The instar-dev pre-commit gate (scripts/instar-dev-precommit.js) blocks a
 * commit touching an operator surface unless the side-effects artifact answers
 * the operator-surface-quality question in writing. The detection lives in
 * scripts/lib/operator-surface.mjs so both sides of each boundary are pinned by
 * tests (Testing Integrity → semantic correctness), and a WIRING-INTEGRITY test
 * proves the gate is actually CALLED in the precommit (not a no-op) at both the
 * Tier-1 and Tier-2 pass sites.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isOperatorSurfaceFile,
  artifactAddressesOperatorSurfaceQuality,
  isAuthorizationSurfaceFile,
  artifactAddressesAgentProposesApproves,
} from '../../scripts/lib/operator-surface.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRECOMMIT = fs.readFileSync(
  path.resolve(__dirname, '../../scripts/instar-dev-precommit.js'),
  'utf-8',
);
const TEMPLATE = fs.readFileSync(
  path.resolve(__dirname, '../../skills/instar-dev/templates/side-effects-artifact.md'),
  'utf-8',
);

describe('isOperatorSurfaceFile — what counts as an operator surface', () => {
  it('YES: dashboard renderer + markup files', () => {
    expect(isOperatorSurfaceFile('dashboard/mandates.js')).toBe(true);
    expect(isOperatorSurfaceFile('dashboard/index.html')).toBe(true);
    expect(isOperatorSurfaceFile('dashboard/process-health.js')).toBe(true);
  });

  it('YES: approval pages / one-time-approval links / secret-drop forms', () => {
    expect(isOperatorSurfaceFile('src/server/approval-page.ts')).toBe(true);
    expect(isOperatorSurfaceFile('dashboard/operator-approval.js')).toBe(true);
    expect(isOperatorSurfaceFile('public/secret-drop.html')).toBe(true);
  });

  it('NO: non-surface code, docs, and the surface’s own test/spec guards', () => {
    expect(isOperatorSurfaceFile('src/core/SessionManager.ts')).toBe(false);
    expect(isOperatorSurfaceFile('docs/STANDARDS-REGISTRY.md')).toBe(false);
    expect(isOperatorSurfaceFile('dashboard/styles.css')).toBe(false); // not a renderer/markup
    expect(isOperatorSurfaceFile('tests/unit/dashboard-mandateGrantForm.test.ts')).toBe(false);
    expect(isOperatorSurfaceFile('dashboard/mandates.test.js')).toBe(false); // a guard, not the surface
    expect(isOperatorSurfaceFile('')).toBe(false);
    expect(isOperatorSurfaceFile(undefined as unknown as string)).toBe(false);
  });
});

describe('artifactAddressesOperatorSurfaceQuality — both sides of the boundary', () => {
  it('YES when the artifact carries the §6b operator-surface-quality section', () => {
    expect(artifactAddressesOperatorSurfaceQuality(
      '## 6b. Operator-surface quality\n\n1. Leads with the primary action? Yes — the grant form renders open.',
    )).toBe(true);
    // case-insensitive + hyphen/space tolerant
    expect(artifactAddressesOperatorSurfaceQuality('Operator Surface Quality: n/a')).toBe(true);
  });

  it('NO when the artifact never engages the question', () => {
    expect(artifactAddressesOperatorSurfaceQuality(
      '## 6. External surfaces\nNo external surface changes.',
    )).toBe(false);
    expect(artifactAddressesOperatorSurfaceQuality('')).toBe(false);
    expect(artifactAddressesOperatorSurfaceQuality(undefined as unknown as string)).toBe(false);
  });
});

describe('isAuthorizationSurfaceFile — the authorization/approval subset', () => {
  it('YES: mandate/grant/authorization-request/approval renderers + forms', () => {
    expect(isAuthorizationSurfaceFile('dashboard/mandates.js')).toBe(true);
    expect(isAuthorizationSurfaceFile('src/server/authorization-request-page.ts')).toBe(true);
    expect(isAuthorizationSurfaceFile('dashboard/grant-form.html')).toBe(true);
    expect(isAuthorizationSurfaceFile('dashboard/operator-approval.js')).toBe(true);
  });
  it('NO: a generic dashboard file with no authorization role, and test/spec guards', () => {
    expect(isAuthorizationSurfaceFile('dashboard/process-health.js')).toBe(false);
    expect(isAuthorizationSurfaceFile('dashboard/mandates.test.js')).toBe(false);
    expect(isAuthorizationSurfaceFile('src/core/SessionManager.ts')).toBe(false);
    expect(isAuthorizationSurfaceFile('')).toBe(false);
  });
});

describe('artifactAddressesAgentProposesApproves — both sides of the boundary', () => {
  it('YES when the artifact engages the agent-proposes/operator-approves question', () => {
    expect(artifactAddressesAgentProposesApproves(
      'Agent Proposes, Operator Approves: the operator approves a server-authored card, never authors.',
    )).toBe(true);
    expect(artifactAddressesAgentProposesApproves('agent-proposes operator-approves: n/a')).toBe(true);
  });
  it('NO when the artifact never engages it', () => {
    expect(artifactAddressesAgentProposesApproves('## 6b. Operator-surface quality\nleads with the action.')).toBe(false);
    expect(artifactAddressesAgentProposesApproves('')).toBe(false);
    expect(artifactAddressesAgentProposesApproves(undefined as unknown as string)).toBe(false);
  });
});

describe('wiring integrity — the gate is actually called, not a no-op', () => {
  it('the precommit defines assertOperatorSurfaceQuality and uses the shared lib predicates', () => {
    expect(PRECOMMIT).toContain('function assertOperatorSurfaceQuality(');
    expect(PRECOMMIT).toContain("from './lib/operator-surface.mjs'");
    expect(PRECOMMIT).toContain('isOperatorSurfaceFile');
    expect(PRECOMMIT).toContain('artifactAddressesOperatorSurfaceQuality');
  });

  it('the precommit also wires the agent-proposes/operator-approves authorization-surface gate', () => {
    expect(PRECOMMIT).toContain('isAuthorizationSurfaceFile');
    expect(PRECOMMIT).toContain('artifactAddressesAgentProposesApproves');
  });

  it('the gate is invoked on BOTH pass paths (Tier-1 lite AND Tier-2 full)', () => {
    const calls = PRECOMMIT.match(/assertOperatorSurfaceQuality\(staged,/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('the side-effects template seeds the §6b question the gate looks for', () => {
    expect(TEMPLATE).toContain('Operator-surface quality');
    expect(artifactAddressesOperatorSurfaceQuality(TEMPLATE)).toBe(true);
  });
});
