/**
 * Tier-1 tests for the user→agent authority-grant extension to the Coordination
 * Mandate (SECURITY-CRITICAL: this touches the signed `authProof` over a live type).
 *
 * The whole point is the security boundary:
 *   - BACKWARD-COMPAT: a NO-grant mandate canonicalizes byte-for-byte identically to
 *     a pre-extension mandate, so its existing authProof still verifies.
 *   - FORGED-GRANT TAMPER: adding a grant WITHOUT re-signing fails verification; a
 *     grant added through the issuance path (addGrants, which re-signs) verifies.
 *   - GRANT QUERY (MandateBackedGrantStore): active resolves; expired/revoked/
 *     overlong-expiry do NOT.
 *   - WIRING: SlackPermissionGate floor check allows WITH a grant, refuses WITHOUT.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MandateStore, canonicalMandate } from '../../src/coordination/MandateStore.js';
import type { Authority, UserAuthorityGrant, CoordinationMandate } from '../../src/coordination/types.js';
import { MandateBackedGrantStore } from '../../src/permissions/MandateBackedGrantStore.js';
import { SlackPermissionGate } from '../../src/permissions/SlackPermissionGate.js';
import { HeuristicIntentClassifier } from '../../src/permissions/IntentClassifier.js';
import { NullAnomalyScorer } from '../../src/permissions/AnomalyScorer.js';
import type { Principal } from '../../src/permissions/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const sign = (c: string) => `proof::${c}`;
const verifySig = (c: string, s: string) => s === `proof::${c}`;

const ECHO = 'fp-echo';
const DAWN = 'fp-dawn';
const FUTURE = '2999-01-01T00:00:00Z';
const MANDATE_EXP = '2999-06-01T00:00:00Z';
const PAST = '2000-01-01T00:00:00Z';

const FIRST_MANDATE_AUTHORITIES: Authority[] = [
  { action: 'exchange-read-credential', bounds: { credentialScope: 'read-only', onMachine: true } },
  { action: 'sign-code-review', bounds: { artifact: 'migration-port', mutual: true } },
];

describe('Mandate user→agent grants — signing & backward-compat (security-critical)', () => {
  let dir: string;
  let store: MandateStore;
  let n: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandate-grants-'));
    n = 0;
    const now = () => 1_700_000_000_000 + (n++);
    store = new MandateStore({ filePath: path.join(dir, 'mandates.json'), sign, verifySig, now, genId: () => `m-${n}` });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/mandate-user-grants.test.ts' }));

  // ── BACKWARD-COMPAT (MUST) ──

  it('a NO-grant mandate canonicalizes to the EXACT pre-extension bytes', () => {
    // This is the recorded baseline: the literal canonical bytes the OLD code produced
    // for this mandate (id/scope/agents/authorities/author/createdAt/expiresAt). If the
    // extension altered the no-grant byte sequence, existing signed mandates break.
    const authored = {
      id: 'mig-1', scope: 'feedback-migration', agents: [ECHO, DAWN] as [string, string],
      authorities: FIRST_MANDATE_AUTHORITIES, author: 'justin',
      createdAt: '2026-06-09T00:00:00.000Z', expiresAt: FUTURE,
    };
    // The OLD canonical form, computed inline exactly as the pre-extension code did.
    const stableStringify = (value: unknown): string => {
      if (value === null || typeof value !== 'object') return JSON.stringify(value);
      if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
    };
    const oldCanonical = stableStringify([
      authored.id, authored.scope, authored.agents,
      authored.authorities.map((a) => [a.action, a.bounds, a.requiresCondition ?? '']),
      authored.author, authored.createdAt, authored.expiresAt,
    ]);
    // No grants → identical bytes.
    expect(canonicalMandate(authored)).toBe(oldCanonical);
    // grants:[] (empty) → STILL identical (append-only-when-non-empty).
    expect(canonicalMandate({ ...authored, grants: [] })).toBe(oldCanonical);
    // grants:undefined → identical.
    expect(canonicalMandate({ ...authored, grants: undefined })).toBe(oldCanonical);
  });

  it('an EXISTING signed mandate (no grants field) still verifies after the extension', () => {
    // Simulate a mandate signed by the OLD code: no `grants` key on disk at all.
    const authored = {
      id: 'legacy-1', scope: 'feedback-migration', agents: [ECHO, DAWN] as [string, string],
      authorities: FIRST_MANDATE_AUTHORITIES, author: 'justin',
      createdAt: '2026-06-09T00:00:00.000Z', expiresAt: FUTURE,
    };
    const legacy: CoordinationMandate = {
      ...authored,
      revoked: null,
      authProof: sign(canonicalMandate(authored)), // signed WITHOUT any grants concept
    };
    fs.writeFileSync(path.join(dir, 'mandates.json'), JSON.stringify([legacy], null, 2));
    const loaded = store.get('legacy-1')!;
    expect('grants' in loaded).toBe(false); // proves no grants field crept in
    expect(store.verifyAuthorship(loaded)).toBe(true); // existing proof STILL valid
  });

  it('a NON-empty grant changes the canonical bytes (so the proof must cover them)', () => {
    const authored = {
      id: 'mig-1', scope: 's', agents: [ECHO, DAWN] as [string, string],
      authorities: FIRST_MANDATE_AUTHORITIES, author: 'justin', createdAt: 't', expiresAt: FUTURE,
    };
    const grant: UserAuthorityGrant = { floorAction: 'prod-deploy', grantedTo: 'U_AMIR', authorizedBy: 'justin', expiresAt: FUTURE };
    expect(canonicalMandate({ ...authored, grants: [grant] })).not.toBe(canonicalMandate(authored));
  });

  // ── FORGED-GRANT TAMPER (MUST) ──

  it('adding a grant to a signed mandate WITHOUT re-signing fails verification', () => {
    const m = store.issue({
      id: 'mig-1', scope: 'feedback-migration', agents: [ECHO, DAWN],
      authorities: FIRST_MANDATE_AUTHORITIES, author: 'justin', expiresAt: MANDATE_EXP,
    });
    expect(store.verifyAuthorship(m)).toBe(true);
    // Attacker bolts a grant onto the object but keeps the old proof.
    const forged: CoordinationMandate = {
      ...m,
      grants: [{ floorAction: 'prod-deploy', grantedTo: 'U_ATTACKER', authorizedBy: 'justin', expiresAt: MANDATE_EXP }],
    };
    expect(store.verifyAuthorship(forged)).toBe(false); // the proof no longer covers the bytes
  });

  it('a grant added through the issuance path (addGrants re-signs) verifies TRUE', () => {
    store.issue({
      id: 'mig-1', scope: 'feedback-migration', agents: [ECHO, DAWN],
      authorities: FIRST_MANDATE_AUTHORITIES, author: 'justin', expiresAt: MANDATE_EXP,
    });
    const res = store.addGrants('mig-1', [{ floorAction: 'prod-deploy', grantedTo: 'U_AMIR', authorizedBy: 'justin', expiresAt: FUTURE /* 2999-01 < MANDATE_EXP 2999-06 → within bounds */ }]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(store.verifyAuthorship(res.mandate)).toBe(true);
      expect(res.mandate.grants).toHaveLength(1);
    }
    // And the persisted copy verifies (proof survives the round-trip).
    expect(store.verifyAuthorship(store.get('mig-1')!)).toBe(true);
  });

  it('issuing a mandate WITH grants at creation verifies, and that proof covers the grants', () => {
    const m = store.issue({
      id: 'mig-1', scope: 'feedback-migration', agents: [ECHO, DAWN],
      authorities: FIRST_MANDATE_AUTHORITIES, author: 'justin', expiresAt: MANDATE_EXP,
      grants: [{ floorAction: 'prod-deploy', grantedTo: 'U_AMIR', authorizedBy: 'justin', expiresAt: MANDATE_EXP }],
    });
    expect(store.verifyAuthorship(m)).toBe(true);
    // Swap the grant's grantee → proof must break.
    const tampered: CoordinationMandate = { ...m, grants: [{ ...m.grants![0], grantedTo: 'U_ATTACKER' }] };
    expect(store.verifyAuthorship(tampered)).toBe(false);
  });

  // ── addGrants validation / expiry clamp ──

  it('addGrants rejects a grant whose expiresAt exceeds the mandate expiresAt', () => {
    // MANDATE_EXP = 2999-06-01; a grant expiring 3000 is past it → rejected.
    store.issue({ id: 'mig-1', scope: 's', agents: [ECHO, DAWN], authorities: FIRST_MANDATE_AUTHORITIES, author: 'justin', expiresAt: MANDATE_EXP });
    const res = store.addGrants('mig-1', [{ floorAction: 'prod-deploy', grantedTo: 'U_AMIR', authorizedBy: 'justin', expiresAt: '3000-01-01T00:00:00Z' /* > MANDATE_EXP */ }]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/must be <= mandate expiresAt/);
  });

  it('issue() with grants applies the SAME expiry clamp as addGrants (second-pass hardening — uniform library contract)', () => {
    // The HTTP issue route drops grants today; this guards any future caller so a
    // grant issued WITH the mandate can never outlive it.
    expect(() => store.issue({
      id: 'mig-iss-clamp', scope: 's', agents: [ECHO, DAWN], authorities: FIRST_MANDATE_AUTHORITIES,
      author: 'justin', expiresAt: MANDATE_EXP,
      grants: [{ floorAction: 'prod-deploy', grantedTo: 'U_AMIR', authorizedBy: 'justin', expiresAt: '3000-01-01T00:00:00Z' /* > MANDATE_EXP */ }],
    })).toThrow(/must be <= mandate expiresAt/);
    // a within-bounds grant at issuance is signed in and verifies.
    const ok = store.issue({
      id: 'mig-iss-ok', scope: 's', agents: [ECHO, DAWN], authorities: FIRST_MANDATE_AUTHORITIES,
      author: 'justin', expiresAt: MANDATE_EXP,
      grants: [{ floorAction: 'prod-deploy', grantedTo: 'U_AMIR', authorizedBy: 'justin', expiresAt: MANDATE_EXP }],
    });
    expect(store.verifyAuthorship(ok)).toBe(true);
    expect(ok.grants?.length).toBe(1);
  });

  it('addGrants rejects a missing / revoked mandate and a malformed grant', () => {
    expect(store.addGrants('nope', [{ floorAction: 'prod-deploy', grantedTo: 'U_A', authorizedBy: 'justin', expiresAt: MANDATE_EXP }]))
      .toEqual({ ok: false, reason: 'mandate not found' });
    store.issue({ id: 'mig-1', scope: 's', agents: [ECHO, DAWN], authorities: FIRST_MANDATE_AUTHORITIES, author: 'justin', expiresAt: MANDATE_EXP });
    store.revoke('mig-1', 'kill');
    const revRes = store.addGrants('mig-1', [{ floorAction: 'prod-deploy', grantedTo: 'U_A', authorizedBy: 'justin', expiresAt: MANDATE_EXP }]);
    expect(revRes).toEqual({ ok: false, reason: 'mandate is revoked' });
    store.issue({ id: 'mig-2', scope: 's', agents: [ECHO, DAWN], authorities: FIRST_MANDATE_AUTHORITIES, author: 'justin', expiresAt: MANDATE_EXP });
    const badRes = store.addGrants('mig-2', [{ floorAction: '', grantedTo: 'U_A', authorizedBy: 'justin', expiresAt: MANDATE_EXP } as UserAuthorityGrant]);
    expect(badRes.ok).toBe(false);
  });
});

describe('MandateBackedGrantStore.activeGrant — grant query (both sides)', () => {
  let dir: string;
  let store: MandateStore;
  let grantStore: MandateBackedGrantStore;
  let n: number;
  const T0 = 1_700_000_000_000;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandate-grantq-'));
    n = 0;
    const now = () => T0 + (n++);
    store = new MandateStore({ filePath: path.join(dir, 'mandates.json'), sign, verifySig, now, genId: () => `m-${n}` });
    grantStore = new MandateBackedGrantStore({ store });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/mandate-user-grants.test.ts' }));

  // mandate expiry far in the future (ms); grant within it
  const MANDATE_EXP_ISO = new Date(T0 + 30 * 24 * 3600_000).toISOString(); // +30d
  const GRANT_EXP_ISO = new Date(T0 + 7 * 24 * 3600_000).toISOString();    // +7d
  const NOW = T0 + 1000;

  function issueWithGrant(g: Partial<UserAuthorityGrant> = {}, mandateExp = MANDATE_EXP_ISO) {
    store.issue({
      id: 'mig-1', scope: 'feedback-migration', agents: [ECHO, DAWN],
      authorities: FIRST_MANDATE_AUTHORITIES, author: 'justin', expiresAt: mandateExp,
      grants: [{ floorAction: 'prod-deploy', grantedTo: 'U_AMIR', authorizedBy: 'justin', expiresAt: GRANT_EXP_ISO, ...g }],
    });
  }

  it('resolves an active grant for the right user + scope', () => {
    issueWithGrant();
    const g = grantStore.activeGrant('U_AMIR', 'prod-deploy', NOW);
    expect(g).toBeDefined();
    expect(g!.grantedTo).toBe('U_AMIR');
    expect(g!.authorizedBy).toBe('justin');
    expect(g!.scope).toBe('prod-deploy');
    expect(g!.expiresAt).toBe(Date.parse(GRANT_EXP_ISO)); // grant earlier than mandate → grant wins
  });

  it('returns undefined for the wrong user or the wrong scope', () => {
    issueWithGrant();
    expect(grantStore.activeGrant('U_OTHER', 'prod-deploy', NOW)).toBeUndefined();
    expect(grantStore.activeGrant('U_AMIR', 'money-movement', NOW)).toBeUndefined();
  });

  it('does NOT resolve an expired grant (now past grant.expiresAt)', () => {
    issueWithGrant();
    const afterGrant = Date.parse(GRANT_EXP_ISO) + 1;
    expect(grantStore.activeGrant('U_AMIR', 'prod-deploy', afterGrant)).toBeUndefined();
  });

  it('does NOT resolve grants on a REVOKED mandate', () => {
    issueWithGrant();
    store.revoke('mig-1', 'kill');
    expect(grantStore.activeGrant('U_AMIR', 'prod-deploy', NOW)).toBeUndefined();
  });

  it('does NOT resolve grants on an EXPIRED mandate (even if the grant itself is unexpired)', () => {
    // Mandate expires +1d; grant expires +7d — but addGrants forbids that, so build it
    // on-disk directly to prove the query-side clamp is independent of the issuance clamp.
    const mandateExp = new Date(T0 + 1 * 24 * 3600_000).toISOString();
    const grant: UserAuthorityGrant = { floorAction: 'prod-deploy', grantedTo: 'U_AMIR', authorizedBy: 'justin', expiresAt: GRANT_EXP_ISO };
    const authored = {
      id: 'mig-1', scope: 's', agents: [ECHO, DAWN] as [string, string],
      authorities: FIRST_MANDATE_AUTHORITIES, author: 'justin', createdAt: new Date(T0).toISOString(),
      expiresAt: mandateExp, grants: [grant],
    };
    const onDisk: CoordinationMandate = { ...authored, revoked: null, authProof: sign(canonicalMandate(authored)) };
    fs.writeFileSync(path.join(dir, 'mandates.json'), JSON.stringify([onDisk], null, 2));
    const afterMandate = Date.parse(mandateExp) + 1;
    expect(grantStore.activeGrant('U_AMIR', 'prod-deploy', afterMandate)).toBeUndefined();
  });

  it('clamps the effective expiry to the mandate when the mandate ends first', () => {
    // grant +30d, mandate +7d (on-disk so we can force grant > mandate)
    const mandateExp = new Date(T0 + 7 * 24 * 3600_000).toISOString();
    const grantExp = new Date(T0 + 30 * 24 * 3600_000).toISOString();
    const grant: UserAuthorityGrant = { floorAction: 'prod-deploy', grantedTo: 'U_AMIR', authorizedBy: 'justin', expiresAt: grantExp };
    const authored = {
      id: 'mig-1', scope: 's', agents: [ECHO, DAWN] as [string, string],
      authorities: FIRST_MANDATE_AUTHORITIES, author: 'justin', createdAt: new Date(T0).toISOString(),
      expiresAt: mandateExp, grants: [grant],
    };
    const onDisk: CoordinationMandate = { ...authored, revoked: null, authProof: sign(canonicalMandate(authored)) };
    fs.writeFileSync(path.join(dir, 'mandates.json'), JSON.stringify([onDisk], null, 2));
    const g = grantStore.activeGrant('U_AMIR', 'prod-deploy', NOW);
    expect(g).toBeDefined();
    expect(g!.expiresAt).toBe(Date.parse(mandateExp)); // clamped to mandate, not the longer grant
  });

  it('does NOT resolve grants on a mandate whose authorship proof is invalid', () => {
    issueWithGrant();
    // Corrupt the proof on disk.
    const file = path.join(dir, 'mandates.json');
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    arr[0].authProof = 'forged';
    fs.writeFileSync(file, JSON.stringify(arr));
    expect(grantStore.activeGrant('U_AMIR', 'prod-deploy', NOW)).toBeUndefined();
  });

  it('empty inputs and an empty store → undefined (deny-by-default)', () => {
    expect(grantStore.activeGrant('', 'prod-deploy', NOW)).toBeUndefined();
    expect(grantStore.activeGrant('U_AMIR', '', NOW)).toBeUndefined();
    expect(grantStore.activeGrant('U_AMIR', 'prod-deploy', NOW)).toBeUndefined(); // empty store
  });
});

describe('SlackPermissionGate wiring — floor allowed WITH grant, refused WITHOUT', () => {
  let dir: string;
  let store: MandateStore;
  let grantStore: MandateBackedGrantStore;
  let n: number;
  const T0 = 1_700_000_000_000;

  const principal = (over: Partial<Principal>): Principal => ({
    userId: 'u-amir', name: 'Amir', slackUserId: 'U_AMIR', role: 'admin', registered: true, ...over,
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandate-gatewire-'));
    n = 0;
    const now = () => T0 + (n++);
    store = new MandateStore({ filePath: path.join(dir, 'mandates.json'), sign, verifySig, now, genId: () => `m-${n}` });
    grantStore = new MandateBackedGrantStore({ store });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/mandate-user-grants.test.ts' }));

  const MANDATE_EXP_ISO = new Date(T0 + 30 * 24 * 3600_000).toISOString();
  const GRANT_EXP_ISO = new Date(T0 + 7 * 24 * 3600_000).toISOString();

  function gate(now: number) {
    return new SlackPermissionGate({
      classifier: new HeuristicIntentClassifier(),
      anomalyScorer: new NullAnomalyScorer(),
      grants: grantStore,
      now: () => now,
    });
  }

  it('refuses a floor action for a non-owner WITHOUT a grant (floor-no-grant)', async () => {
    const v = await gate(T0 + 1000).evaluate({ principal: principal({}), text: 'deploy to prod', directed: true });
    expect(v.decision).toBe('refuse');
    expect(v.basis).toBe('floor-no-grant');
  });

  it('ALLOWS a floor action for that same non-owner WITH a valid mandate-backed grant', async () => {
    store.issue({
      id: 'mig-1', scope: 'feedback-migration', agents: [ECHO, DAWN],
      authorities: FIRST_MANDATE_AUTHORITIES, author: 'justin', expiresAt: MANDATE_EXP_ISO,
      grants: [{ floorAction: 'prod-deploy', grantedTo: 'U_AMIR', authorizedBy: 'justin', expiresAt: GRANT_EXP_ISO }],
    });
    const v = await gate(T0 + 1000).evaluate({ principal: principal({}), text: 'deploy to prod', directed: true });
    expect(v.decision).toBe('allow');
    expect(v.basis).toBe('floor-granted');
  });

  it('refuses again once the grant has expired (the grant is time-boxed)', async () => {
    store.issue({
      id: 'mig-1', scope: 'feedback-migration', agents: [ECHO, DAWN],
      authorities: FIRST_MANDATE_AUTHORITIES, author: 'justin', expiresAt: MANDATE_EXP_ISO,
      grants: [{ floorAction: 'prod-deploy', grantedTo: 'U_AMIR', authorizedBy: 'justin', expiresAt: GRANT_EXP_ISO }],
    });
    const afterGrant = Date.parse(GRANT_EXP_ISO) + 1;
    const v = await gate(afterGrant).evaluate({ principal: principal({}), text: 'deploy to prod', directed: true });
    expect(v.decision).toBe('refuse');
    expect(v.basis).toBe('floor-no-grant');
  });
});
