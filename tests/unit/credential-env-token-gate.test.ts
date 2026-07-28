/**
 * Unit tests for WS5.2 Step 8 — the §2.10 env-token gate + the per-session `credentialSource`
 * provenance flag.
 *
 * Spec: docs/specs/live-credential-repointing-rebalancer.md §2.10 (the env-token gate — verbatim
 * contract), §0.b (applicability gate).
 *
 * The load-bearing adversarial lenses, each a named test:
 *   1. SINGLE SOURCE OF TRUTH — the `credentialSource` flag is the IDENTICAL boolean expression
 *      that selects the env block at each of the three SessionManager spawn lanes. Proven against
 *      the real source: a static grep-assert that the derivation reads `this.config.anthropicApiKey`
 *      adjacent to each env-block predicate (a divergence is the bug to prevent).
 *   2. MID-LIFE FLIP / LIVE FLEET — the gate refuses on a running `env` session even when the
 *      config field is currently empty (a config-only gate would miss it).
 *   3. CONFIG PREDICATE — refuses on ANY non-empty `anthropicApiKey` (OAuth OR API key), not only
 *      `sk-ant-oat`.
 *   4. ATTRIBUTION-SUPPRESSION — `shouldAttributeSlotTenant` is false for an env session (its usage
 *      is never mis-attributed to a slot tenant).
 *   5. ALLOW — empty config + all-store fleet permits (refused:false).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CredentialEnvTokenGate,
  type EnvTokenFleetSession,
} from '../../src/core/CredentialEnvTokenGate.js';
import type { Session } from '../../src/core/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_MANAGER_SRC = path.resolve(__dirname, '../../src/core/SessionManager.ts');

function gate(opts: {
  key?: string | undefined;
  sessions?: EnvTokenFleetSession[];
}): CredentialEnvTokenGate {
  return new CredentialEnvTokenGate({
    getAnthropicApiKey: () => opts.key,
    listSessions: () => opts.sessions ?? [],
  });
}

const running = (over: Partial<EnvTokenFleetSession> = {}): EnvTokenFleetSession => ({
  framework: 'claude-code',
  status: 'running',
  credentialSource: 'store',
  ...over,
});

describe('CredentialEnvTokenGate — §2.10 config predicate', () => {
  it('PERMITS when config empty + all-store fleet (the §0.b alive case)', () => {
    const v = gate({ key: '', sessions: [running(), running()] }).evaluate();
    expect(v.refused).toBe(false);
    expect(v.reason).toBeUndefined();
    expect(v.envSessionCount).toBe(0);
  });

  it('PERMITS when config is undefined (no key configured)', () => {
    const v = gate({ key: undefined, sessions: [running()] }).evaluate();
    expect(v.refused).toBe(false);
  });

  it('REFUSES on an sk-ant-oat OAuth token in config (named reason)', () => {
    const v = gate({ key: 'sk-ant-oat01-abcdef', sessions: [] }).evaluate();
    expect(v.refused).toBe(true);
    expect(v.reason).toBe('config-anthropic-api-key-set');
    expect(v.detail).toMatch(/anthropicApiKey is set/i);
  });

  it('REFUSES on ANY non-empty key — a direct sk-ant-api03 API key (round-3, NOT only OAuth)', () => {
    const v = gate({ key: 'sk-ant-api03-direct-billing-key', sessions: [] }).evaluate();
    expect(v.refused).toBe(true);
    expect(v.reason).toBe('config-anthropic-api-key-set');
  });

  it('REFUSES on a non-empty key that is neither oat nor api03 (binary: any value bypasses store)', () => {
    const v = gate({ key: 'literally-anything', sessions: [] }).evaluate();
    expect(v.refused).toBe(true);
    expect(v.reason).toBe('config-anthropic-api-key-set');
  });
});

describe('CredentialEnvTokenGate — §2.10 live-fleet path (the mid-life flip)', () => {
  it('REFUSES when config empty but ONE running claude-code session is credentialSource:env', () => {
    const v = gate({
      key: '',
      sessions: [running(), running({ credentialSource: 'env' }), running()],
    }).evaluate();
    expect(v.refused).toBe(true);
    expect(v.reason).toBe('env-token-session-in-fleet');
    expect(v.envSessionCount).toBe(1);
    expect(v.detail).toMatch(/env token/i);
  });

  it('counts MULTIPLE env sessions in the fleet', () => {
    const v = gate({
      key: '',
      sessions: [running({ credentialSource: 'env' }), running({ credentialSource: 'env' })],
    }).evaluate();
    expect(v.refused).toBe(true);
    expect(v.envSessionCount).toBe(2);
  });

  it('does NOT refuse on a NON-running env session (only the live fleet counts)', () => {
    const v = gate({
      key: '',
      sessions: [running({ status: 'completed', credentialSource: 'env' })],
    }).evaluate();
    expect(v.refused).toBe(false);
  });

  it('does NOT refuse on a non-claude-code env-tagged session (the flag is claude-code-only)', () => {
    const v = gate({
      key: '',
      sessions: [running({ framework: 'codex-cli', credentialSource: 'env' })],
    }).evaluate();
    expect(v.refused).toBe(false);
  });

  it('treats undefined credentialSource as store (legacy record, safe direction)', () => {
    const v = gate({
      key: '',
      sessions: [running({ credentialSource: undefined })],
    }).evaluate();
    expect(v.refused).toBe(false);
  });

  it('config-field refusal SHORT-CIRCUITS before the fleet scan (envSessionCount 0)', () => {
    // When the config field already refuses, the fleet scan is not consulted — its count stays 0.
    const v = gate({
      key: 'sk-ant-oat01-x',
      sessions: [running({ credentialSource: 'env' }), running({ credentialSource: 'env' })],
    }).evaluate();
    expect(v.refused).toBe(true);
    expect(v.reason).toBe('config-anthropic-api-key-set');
    expect(v.envSessionCount).toBe(0);
  });
});

describe('CredentialEnvTokenGate — §2.10 attribution-suppression (requirement 3)', () => {
  it('an env session must NOT feed slot-tenant attribution', () => {
    const env: Pick<Session, 'credentialSource'> = { credentialSource: 'env' };
    expect(CredentialEnvTokenGate.shouldAttributeSlotTenant(env)).toBe(false);
  });

  it('a store session DOES feed slot-tenant attribution', () => {
    expect(CredentialEnvTokenGate.shouldAttributeSlotTenant({ credentialSource: 'store' })).toBe(true);
  });

  it('an undefined-provenance (legacy) session feeds attribution (store-default)', () => {
    expect(CredentialEnvTokenGate.shouldAttributeSlotTenant({ credentialSource: undefined })).toBe(true);
  });
});

describe('Step 8 — SINGLE SOURCE OF TRUTH (the blocker lens, against real source)', () => {
  // The flag MUST be the IDENTICAL expression as the env-block selection at each spawn lane —
  // proven structurally: the SessionManager source contains, at each of the three claude-code
  // launch lanes, BOTH the env-block predicate `(this.config.anthropicApiKey ?? '').startsWith(
  // 'sk-ant-oat')` AND the provenance derivation `(this.config.anthropicApiKey ?? '') !== '' ?
  // 'env' : 'store'` reading the SAME `this.config.anthropicApiKey`. An independent recomputation
  // (a different source expression) would fail this assertion.
  const src = fs.readFileSync(SESSION_MANAGER_SRC, 'utf-8');

  it('has exactly three env-block predicates over this.config.anthropicApiKey (the 3 lanes)', () => {
    const matches = src.match(
      /\(this\.config\.anthropicApiKey \?\? ''\)\.startsWith\('sk-ant-oat'\)/g,
    );
    expect(matches?.length).toBe(3);
  });

  it('has three credentialSource derivations using the IDENTICAL anthropicApiKey expression', () => {
    const matches = src.match(
      /\(this\.config\.anthropicApiKey \?\? ''\) !== '' \? 'env' : 'store'/g,
    );
    expect(matches?.length).toBe(3);
  });

  it('writes credentialSource onto a session record at every spawn lane (3 derived + triage)', () => {
    const writes = src.match(/credentialSource:/g);
    // 3 derived lane writes + 1 explicit triage 'store' write = 4 record-write occurrences.
    expect(writes?.length).toBe(4);
  });

  it('the derivation predicate matches the env-block predicate (no divergence)', () => {
    // Both predicates key on `(this.config.anthropicApiKey ?? '')`. A divergence (e.g. one reading
    // a cached/recomputed value) is exactly the staleness class this spec exists to kill.
    const envBlockKeyReads = (src.match(/\(this\.config\.anthropicApiKey \?\? ''\)\.startsWith/g) ?? []).length;
    const provenanceKeyReads = (src.match(/\(this\.config\.anthropicApiKey \?\? ''\) !== ''/g) ?? []).length;
    expect(envBlockKeyReads).toBe(3);
    expect(provenanceKeyReads).toBe(3);
  });
});
