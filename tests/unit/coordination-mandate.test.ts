/**
 * Tier-1 tests for the Coordination Mandate enforcement engine (spec §4).
 *
 * Covers BOTH sides of every boundary: store authorship (valid + forged + revoke-
 * doesn't-break-proof), the hash-chained audit (intact + tamper-detected), the
 * conditions registry (true/false/unregistered/compound/throwing), and the gate's
 * full ordered deny ladder + the allow paths — each decision audited. Plus
 * deny-by-default (empty store denies everything).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MandateStore, canonicalMandate } from '../../src/coordination/MandateStore.js';
import { MandateAudit } from '../../src/coordination/MandateAudit.js';
import { ConditionsRegistry } from '../../src/coordination/conditions.js';
import { MandateGate, paramsSatisfyBounds } from '../../src/coordination/MandateGate.js';
import type { Authority } from '../../src/coordination/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const sign = (c: string) => `proof::${c}`;
const verifySig = (c: string, s: string) => s === `proof::${c}`;

const ECHO = 'fp-echo';
const DAWN = 'fp-dawn';
const FUTURE = '2999-01-01T00:00:00Z';
const PAST = '2000-01-01T00:00:00Z';

// Justin's A/A/B first mandate: 2 authorities, NO execute-cutover, no condition.
const FIRST_MANDATE_AUTHORITIES: Authority[] = [
  { action: 'exchange-read-credential', bounds: { credentialScope: 'read-only', onMachine: true } },
  { action: 'sign-code-review', bounds: { artifact: 'migration-port', mutual: true } },
];

describe('Coordination Mandate enforcement (spec §4)', () => {
  let dir: string;
  let store: MandateStore;
  let audit: MandateAudit;
  let conditions: ConditionsRegistry;
  let gate: MandateGate;
  let n: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandate-'));
    n = 0;
    const now = () => 1_700_000_000_000 + (n++);
    store = new MandateStore({ filePath: path.join(dir, 'mandates.json'), sign, verifySig, now, genId: () => `m-${n}` });
    audit = new MandateAudit({ filePath: path.join(dir, 'audit.jsonl'), now });
    conditions = new ConditionsRegistry();
    gate = new MandateGate({ store, conditions, audit, now });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/coordination-mandate.test.ts' }));

  function issueFirstMandate(over: Partial<Parameters<MandateStore['issue']>[0]> = {}) {
    return store.issue({
      id: 'mig-1', scope: 'feedback-migration', agents: [ECHO, DAWN],
      authorities: FIRST_MANDATE_AUTHORITIES, author: 'justin', expiresAt: FUTURE, ...over,
    });
  }

  // ── MandateStore: authorship ──

  it('issues a mandate whose authorship proof verifies', () => {
    const m = issueFirstMandate();
    expect(store.verifyAuthorship(m)).toBe(true);
  });

  it('rejects authorship when an AUTHORED field is tampered', () => {
    const m = issueFirstMandate();
    const widened = { ...m, authorities: [...m.authorities, { action: 'execute-cutover', bounds: {} }] };
    expect(store.verifyAuthorship(widened)).toBe(false); // T2: widening breaks the proof
    const reparty = { ...m, agents: [ECHO, 'fp-attacker'] as [string, string] };
    expect(store.verifyAuthorship(reparty)).toBe(false);
  });

  it('revocation does NOT break the authorship proof (revoked excluded from proof)', () => {
    issueFirstMandate();
    const revoked = store.revoke('mig-1', 'operator kill-switch')!;
    expect(revoked.revoked?.reason).toBe('operator kill-switch');
    expect(store.verifyAuthorship(revoked)).toBe(true);
    // idempotent
    const again = store.revoke('mig-1', 'second');
    expect(again!.revoked?.reason).toBe('operator kill-switch');
  });

  it('canonicalMandate is key-order stable', () => {
    const a = canonicalMandate({ id: 'x', scope: 's', agents: [ECHO, DAWN], authorities: [{ action: 'a', bounds: { b: 1, a: 2 } }], author: 'justin', createdAt: 't', expiresAt: FUTURE });
    const b = canonicalMandate({ id: 'x', scope: 's', agents: [ECHO, DAWN], authorities: [{ action: 'a', bounds: { a: 2, b: 1 } }], author: 'justin', createdAt: 't', expiresAt: FUTURE });
    expect(a).toBe(b);
  });

  // ── MandateAudit: hash chain ──

  it('chains audit entries and verifyChain passes when intact', () => {
    issueFirstMandate();
    gate.evaluate({ action: 'sign-code-review', params: { artifact: 'migration-port', mutual: true }, agentFp: ECHO, mandateId: 'mig-1' });
    gate.evaluate({ action: 'unknown', params: {}, agentFp: ECHO, mandateId: 'mig-1' });
    expect(audit.all().length).toBe(2);
    expect(audit.verifyChain()).toEqual({ ok: true });
  });

  it('verifyChain detects a tampered audit entry', () => {
    issueFirstMandate();
    gate.evaluate({ action: 'sign-code-review', params: { artifact: 'migration-port', mutual: true }, agentFp: ECHO, mandateId: 'mig-1' });
    gate.evaluate({ action: 'sign-code-review', params: { artifact: 'migration-port', mutual: true }, agentFp: ECHO, mandateId: 'mig-1' });
    const file = path.join(dir, 'audit.jsonl');
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    rows[0].decision = 'deny'; // flip a recorded decision
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const res = audit.verifyChain();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.brokenAt).toBe(0);
  });

  // ── ConditionsRegistry ──

  it('evaluates registered conditions, denies unknown + compound + throwing (deny-safe)', () => {
    conditions.register('green', () => true).register('red', () => false).register('boom', () => { throw new Error('x'); });
    expect(conditions.evaluate('green')).toBe(true);
    expect(conditions.evaluate('red')).toBe(false);
    expect(conditions.evaluate('unregistered')).toBe(false);          // deny-safe
    expect(conditions.evaluate('green+red')).toBe(false);             // AND
    expect(conditions.evaluate('green+green')).toBe(true);
    expect(conditions.evaluate('boom')).toBe(false);                  // throw → false
    expect(conditions.evaluate('')).toBe(false);
  });

  // ── MandateGate: the deny ladder + allow ──

  it('DENY-BY-DEFAULT: empty store denies every action', () => {
    const r = gate.evaluate({ action: 'sign-code-review', params: {}, agentFp: ECHO, mandateId: 'nope' });
    expect(r.decision).toBe('deny');
    expect(r.reason).toMatch(/not found/);
    expect(audit.all()[0].decision).toBe('deny'); // audited
  });

  it('denies when authorship is invalid', () => {
    const m = issueFirstMandate();
    // Corrupt the persisted proof.
    const file = path.join(dir, 'mandates.json');
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    arr[0].authProof = 'forged';
    fs.writeFileSync(file, JSON.stringify(arr));
    const r = gate.evaluate({ action: 'sign-code-review', params: { artifact: 'migration-port', mutual: true }, agentFp: ECHO, mandateId: m.id });
    expect(r.decision).toBe('deny');
    expect(r.reason).toMatch(/authorship/);
  });

  it('denies an expired mandate', () => {
    issueFirstMandate({ expiresAt: PAST });
    const r = gate.evaluate({ action: 'sign-code-review', params: { artifact: 'migration-port', mutual: true }, agentFp: ECHO, mandateId: 'mig-1' });
    expect(r.decision).toBe('deny');
    expect(r.reason).toMatch(/expired/);
  });

  it('denies a revoked mandate', () => {
    issueFirstMandate();
    store.revoke('mig-1', 'kill');
    const r = gate.evaluate({ action: 'sign-code-review', params: { artifact: 'migration-port', mutual: true }, agentFp: ECHO, mandateId: 'mig-1' });
    expect(r.decision).toBe('deny');
    expect(r.reason).toMatch(/revoked/);
  });

  it('denies an agent that is not a named party', () => {
    issueFirstMandate();
    const r = gate.evaluate({ action: 'sign-code-review', params: { artifact: 'migration-port', mutual: true }, agentFp: 'fp-stranger', mandateId: 'mig-1' });
    expect(r.decision).toBe('deny');
    expect(r.reason).toMatch(/not a named party/);
  });

  it('denies an action not granted by the mandate (execute-cutover is NOT in the first mandate)', () => {
    issueFirstMandate();
    const r = gate.evaluate({ action: 'execute-cutover', params: {}, agentFp: ECHO, mandateId: 'mig-1' });
    expect(r.decision).toBe('deny');
    expect(r.reason).toMatch(/no authority for action/);
  });

  it('denies when params exceed the authority bounds', () => {
    issueFirstMandate();
    const r = gate.evaluate({ action: 'exchange-read-credential', params: { credentialScope: 'read-write', onMachine: true }, agentFp: ECHO, mandateId: 'mig-1' });
    expect(r.decision).toBe('deny');
    expect(r.reason).toMatch(/exceed the bounds/);
  });

  it('ALLOWS an in-bounds action by a named party under a valid mandate', () => {
    issueFirstMandate();
    const r = gate.evaluate({ action: 'exchange-read-credential', params: { credentialScope: 'read-only', onMachine: true, extra: 'ok' }, agentFp: DAWN, mandateId: 'mig-1' });
    expect(r.decision).toBe('allow');
    expect(r.conditionResult).toBeNull();
    expect(audit.all().some((e) => e.decision === 'allow')).toBe(true);
  });

  it('a conditioned authority denies when the condition is unmet and allows when met', () => {
    let parityGreen = false;
    conditions.register('parity-zero-divergence', () => parityGreen);
    store.issue({
      id: 'mig-2', scope: 'feedback-migration', agents: [ECHO, DAWN], author: 'justin', expiresAt: FUTURE,
      authorities: [{ action: 'execute-cutover', bounds: {}, requiresCondition: 'parity-zero-divergence' }],
    });
    const denied = gate.evaluate({ action: 'execute-cutover', params: {}, agentFp: ECHO, mandateId: 'mig-2' });
    expect(denied.decision).toBe('deny');
    expect(denied.conditionResult).toBe(false);

    parityGreen = true;
    const allowed = gate.evaluate({ action: 'execute-cutover', params: {}, agentFp: ECHO, mandateId: 'mig-2' });
    expect(allowed.decision).toBe('allow');
    expect(allowed.conditionResult).toBe(true);
  });

  // ── bounds helper ──

  it('paramsSatisfyBounds: every bound key must match; extra params are allowed', () => {
    expect(paramsSatisfyBounds({ a: 1, b: 2 }, { a: 1 })).toBe(true);
    expect(paramsSatisfyBounds({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(paramsSatisfyBounds({ a: 'read-write' }, { a: 'read-only' })).toBe(false);
    expect(paramsSatisfyBounds({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } })).toBe(true); // order-insensitive
  });
});
