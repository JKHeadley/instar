/**
 * Tier-1 tests for LiveTestGate (spec §4): the deterministic completion veto.
 * Covers BOTH sides of every decision boundary (Testing Integrity): user-facing vs
 * internal, declared vs classifier-detected (hard veto vs soft nudge — Signal vs.
 * Authority), artifact present vs absent vs incomplete, and the dry-run→warn→veto
 * mode ladder (computes the decision but only `veto` mode actually blocks).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { LiveTestArtifactStore, type LiveTestArtifact, type Surface, type RiskCategory } from '../../src/core/LiveTestArtifactStore.js';
import { LiveTestGate, looksUserFacing } from '../../src/core/LiveTestGate.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const sign = (data: string) => crypto.sign(null, Buffer.from(data), privateKey).toString('base64');
const verify = (data: string, sig: string) => crypto.verify(null, Buffer.from(data), publicKey, Buffer.from(sig, 'base64'));

/** A fully-satisfying artifact: telegram+slack, load-bearing categories PASS. */
function goodArtifact(featureId: string): LiveTestArtifact {
  const cats: RiskCategory[] = ['happy-path', 'channel-parity'];
  const surfaces: Surface[] = ['telegram', 'slack'];
  return {
    featureId, runId: `run-${featureId}`, surfaces, riskCategories: cats,
    scenarios: [
      { id: 'h-tg', description: 'happy telegram', surface: 'telegram', riskCategory: 'happy-path', verdict: 'PASS' },
      { id: 'h-sl', description: 'happy slack', surface: 'slack', riskCategory: 'happy-path', verdict: 'PASS' },
      { id: 'parity', description: 'tg vs slack agree', surface: 'slack', riskCategory: 'channel-parity', verdict: 'PASS' },
    ],
    createdAt: '2026-06-15T20:00:00.000Z', runnerFingerprint: 'fp',
  };
}

describe('LiveTestGate', () => {
  let dir: string;
  let store: LiveTestArtifactStore;
  let gate: LiveTestGate;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
    store = new LiveTestArtifactStore({ stateDir: dir, machineId: 'm', signerFingerprint: 'fp', sign, verify });
    gate = new LiveTestGate(store);
  });
  afterEach(() => { try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: "live-test-cleanup" }); } catch { /* */ } });

  it('classifier: detects user-facing keywords, ignores internal goals', () => {
    expect(looksUserFacing('fix the cross-machine transfer reply')).toBe(true);
    expect(looksUserFacing('refactor the quota arithmetic helper')).toBe(false);
  });

  it('not user-facing (undeclared + classifier negative) → allow', () => {
    const r = gate.evaluate({ featureId: 'f', goalText: 'optimize the token ledger sqlite index', mode: 'veto' });
    expect(r.outcome).toBe('allow');
    expect(r.blocks).toBe(false);
  });

  it('declared userFacing:false → allow (gate honors the objective declaration)', () => {
    const r = gate.evaluate({ featureId: 'f', userFacing: false, goalText: 'change the telegram reply path', mode: 'veto' });
    expect(r.outcome).toBe('allow');
  });

  it('declared userFacing:true + NO artifact → HARD veto (blocks in veto mode)', () => {
    const r = gate.evaluate({ featureId: 'transfer', userFacing: true, goalText: 'move the seat', mode: 'veto' });
    expect(r.outcome).toBe('veto');
    expect(r.blocks).toBe(true);
    expect(r.reason).toContain('no verified live-test artifact');
  });

  it('undeclared but classifier-positive + NO artifact → soft NUDGE, not a hard veto (Signal vs Authority)', () => {
    const r = gate.evaluate({ featureId: 'transfer', goalText: 'fix the cross-machine transfer reply', mode: 'veto' });
    expect(r.outcome).toBe('nudge');
    expect(r.wouldBlock).toBe(true);
  });

  it('user-facing + verified complete artifact → allow', () => {
    store.write(goodArtifact('transfer'));
    const r = gate.evaluate({ featureId: 'transfer', userFacing: true, goalText: 'move the seat', mode: 'veto' });
    expect(r.outcome).toBe('allow');
    expect(r.blocks).toBe(false);
  });

  it('artifact missing a required surface (slack) → veto', () => {
    const a = goodArtifact('transfer');
    a.surfaces = ['telegram']; // slack absent
    store.write(a);
    const r = gate.evaluate({ featureId: 'transfer', userFacing: true, goalText: 'move the seat', mode: 'veto' });
    expect(r.outcome).toBe('veto');
    expect(r.reason).toContain('missing required surface "slack"');
  });

  it('artifact with a FAIL in a load-bearing category → veto', () => {
    const a = goodArtifact('transfer');
    a.scenarios.push({ id: 'bad', description: 'broke', surface: 'telegram', riskCategory: 'happy-path', verdict: 'FAIL' });
    store.write(a);
    const r = gate.evaluate({ featureId: 'transfer', userFacing: true, goalText: 'x', mode: 'veto' });
    expect(r.outcome).toBe('veto');
    expect(r.reason).toContain('FAIL');
  });

  it('a bare BLOCKED in a load-bearing category counts as not-proven → veto', () => {
    const a = goodArtifact('transfer');
    // Replace the happy-path slack PASS with a bare BLOCKED (no real blocker kind).
    a.scenarios = a.scenarios.filter((s) => s.id !== 'h-sl');
    a.scenarios.push({ id: 'h-sl', description: 'happy slack', surface: 'slack', riskCategory: 'happy-path', verdict: 'BLOCKED' });
    store.write(a);
    // happy-path still has the telegram PASS, so it passes; but add a channel-parity-only BLOCKED case:
    const a2 = goodArtifact('feat2');
    a2.scenarios = a2.scenarios.filter((s) => s.riskCategory !== 'channel-parity');
    a2.scenarios.push({ id: 'p', description: 'parity blocked', surface: 'slack', riskCategory: 'channel-parity', verdict: 'BLOCKED' });
    store.write(a2);
    const r = gate.evaluate({ featureId: 'feat2', userFacing: true, goalText: 'x', mode: 'veto' });
    expect(r.outcome).toBe('veto'); // channel-parity has no PASS
  });

  it('mode ladder: dry-run and warn COMPUTE the veto but do NOT block; only veto blocks', () => {
    const base = { featureId: 'transfer', userFacing: true as const, goalText: 'move the seat' };
    const dry = gate.evaluate({ ...base, mode: 'dry-run' });
    expect(dry.outcome).toBe('veto');
    expect(dry.wouldBlock).toBe(true);
    expect(dry.blocks).toBe(false); // dry-run never actually stops the run

    const warn = gate.evaluate({ ...base, mode: 'warn' });
    expect(warn.blocks).toBe(false);

    const veto = gate.evaluate({ ...base, mode: 'veto' });
    expect(veto.blocks).toBe(true);
  });

  it('a tampered artifact (hash mismatch) is treated as not-proven → veto', () => {
    store.write(goodArtifact('transfer'));
    // Corrupt the artifact on disk after signing.
    const fp = path.join(dir, 'live-test-artifacts', 'transfer', 'run-transfer.json');
    const obj = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    obj.scenarios[0].verdict = 'FORGED';
    fs.writeFileSync(fp, JSON.stringify(obj));
    const r = gate.evaluate({ featureId: 'transfer', userFacing: true, goalText: 'x', mode: 'veto' });
    expect(r.outcome).toBe('veto'); // latestVerified fails → not-proven
  });
});
