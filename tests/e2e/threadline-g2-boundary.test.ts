/**
 * Tier-3 E2E — G2 positive authorization boundary + holder-singularity invariant
 * (THREADLINE-SINGLE-NEGOTIATOR-SPEC.md §D-C / FD-2).
 *
 * G2 ("prose is inert") is enforced POSITIVELY, not as a negative audit that
 * rots: an irreversible-action gate may accept authorization ONLY as a typed
 * anchored artifact. This is the type/import-boundary test — it fails if an
 * enumerated irreversible-action gate consumes Threadline prose / a transcript /
 * a history summary / a ContentClassifier output as authorization, OR if the
 * AnchoredAuthorization module ever learns about prose. Plus the runtime
 * holder-singularity detector (FD-2) and a live proof that the external-operation
 * gate rejects a prose authorization for an irreversible op.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isAnchoredAuthorization,
  AnchoredAuthorizationError,
} from '../../src/coordination/AnchoredAuthorization.js';
import { detectDuplicateLiveHolders } from '../../src/threadline/NegotiatorLease.js';
import { ExternalOperationGate } from '../../src/core/ExternalOperationGate.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf-8');

let gateStateDir: string;
function makeGate(): ExternalOperationGate {
  return new ExternalOperationGate({ stateDir: gateStateDir } as never);
}

describe('G2 positive authorization boundary (D-C)', () => {
  beforeAll(() => {
    gateStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'g2-gate-'));
    fs.mkdirSync(path.join(gateStateDir, 'state'), { recursive: true });
  });
  afterAll(() => {
    SafeFsExecutor.safeRmSync(gateStateDir, { recursive: true, force: true, operation: 'tests/e2e/threadline-g2-boundary.test.ts' });
  });

  it('the AnchoredAuthorization module never imports a prose source (transcript / classifier / conversation)', () => {
    const src = read('src/coordination/AnchoredAuthorization.ts');
    // Scan only real import STATEMENTS (the doc comment names these modules on
    // purpose to explain the boundary — a greedy whole-file match would false-fail).
    const importLines = src.split('\n').filter((l) => /^\s*import\b/.test(l));
    const forbidden = ['ContentClassifier', 'ConversationStore', 'ThreadlineRouter', 'MessageEnvelope', 'ThreadlineMCPServer'];
    for (const line of importLines) {
      for (const mod of forbidden) {
        expect(line, `AnchoredAuthorization must not import ${mod}`).not.toContain(mod);
      }
    }
  });

  it('no enumerated irreversible-action gate consumes a ContentClassifier output as authorization', () => {
    // The Phase-1-in-reach gates (spec D-C). None may treat prose as evidence.
    const GATES = [
      'src/core/ExternalOperationGate.ts',
      'src/feedback-factory/cutoverReadiness.ts',
      'src/threadline/ApprovalQueue.ts',
      'src/threadline/AuthorizationPolicy.ts',
      'src/threadline/OperatorConfirmGate.ts',
    ];
    for (const g of GATES) {
      if (!fs.existsSync(path.join(root, g))) continue;
      const src = read(g);
      // A gate must not import the commitment-class signal as an authorization input.
      expect(src, `${g} must not consume ContentClassifier as authorization`).not.toContain('detectCommitmentClass');
    }
  });

  it('the external-operation gate enforces the anchored-artifact boundary in code', () => {
    const src = read('src/core/ExternalOperationGate.ts');
    expect(src).toContain('requireAnchoredAuthorization');
  });

  it('the external-operation gate REJECTS a prose authorization for an irreversible op', async () => {
    const gate = makeGate();
    await expect(gate.evaluate({
      service: 'cutover', mutability: 'delete', reversibility: 'irreversible',
      description: 'flip the production cutover', authorization: 'Dawn confirmed in chat',
    })).rejects.toThrowError(AnchoredAuthorizationError);
  });

  it('the external-operation gate ACCEPTS a typed anchored authorization for an irreversible op', async () => {
    const gate = makeGate();
    // Should not throw at the boundary (the normal risk evaluation then proceeds).
    const decision = await gate.evaluate({
      service: 'cutover', mutability: 'delete', reversibility: 'irreversible',
      description: 'flip the production cutover',
      authorization: { kind: 'mandate', id: 'M1', auditHash: 'abc123' },
    });
    expect(decision).toBeTruthy();
    expect(decision.action).toBeTruthy();
  });

  it('a prose authorization is never a valid anchored artifact', () => {
    expect(isAnchoredAuthorization('we agreed in the thread')).toBe(false);
    expect(isAnchoredAuthorization({ summary: 'go-live approved' })).toBe(false);
  });
});

describe('holder-singularity invariant (FD-2)', () => {
  it('is satisfied under the single-holder model and flags a cross-machine duplicate', () => {
    // Under the single-holder invariant, no conversation is held by two machines.
    expect(detectDuplicateLiveHolders([
      { conversationId: 'c1', machineId: 'm1' },
      { conversationId: 'c2', machineId: 'm2' },
    ])).toEqual([]);
    // A split-brain (same conversation live on two machines) is surfaced loudly.
    const dupes = detectDuplicateLiveHolders([
      { conversationId: 'c1', machineId: 'm1' },
      { conversationId: 'c1', machineId: 'm2' },
    ]);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].conversationId).toBe('c1');
  });
});
