/**
 * TestWorkspacePrincipalSource — boundary + wiring tests (roadmap 0.3 prerequisite).
 *
 * The permission gate derives roles from the user registry. The 2026-07-01
 * registry rebuild removed the Slack test-cast principals, and the
 * fixture-identity guard now refuses test identities in the production registry
 * — so the scenario cast can no longer resolve. This suite proves the SEPARATE
 * test-workspace-scoped principal source resolves the cast WITHOUT touching the
 * production registry, and that every scoping / authority boundary holds on BOTH
 * sides.
 *
 * Fixture-identity note (requirement 7): these tests use clearly-fake `livetest-*`
 * ids — NEVER a real cast UID. `livetest` is a reserved fixture-marker prefix
 * (users/testIdentityMarkers.ts), so these ids are admitted by the same single
 * matcher the production guard uses to REFUSE them from users.json.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  TestWorkspacePrincipalSource,
  ChainedUserLookup,
  MAX_TEST_CAST_SEATS,
  type TestCastEntry,
} from '../../src/permissions/TestWorkspacePrincipalSource.js';
import {
  SlackPrincipalResolver,
  type UserLookup,
  type ResolvedUserRecord,
} from '../../src/permissions/SlackPrincipalResolver.js';

const TEST_WORKSPACE = 'T_LIVETEST';
const OTHER_WORKSPACE = 'T_PRODUCTION';

// Clearly-fake cast — every id carries the reserved `livetest` fixture prefix.
const CAST: TestCastEntry[] = [
  { slackUserId: 'livetest-owner', name: 'Owner Seat', orgRole: 'owner' },
  { slackUserId: 'livetest-admin', name: 'Admin Seat', orgRole: 'admin' },
  { slackUserId: 'livetest-member', name: 'Member Seat', orgRole: 'member' },
  { slackUserId: 'livetest-contrib', name: 'Contributor Seat', orgRole: 'contributor' },
];

/** A source scoped to TEST_WORKSPACE with the connected team pinned to `connectedTo`. */
function makeSource(opts: {
  connectedTo: string | null | undefined;
  testWorkspace?: boolean;
  principals?: TestCastEntry[];
}) {
  return new TestWorkspacePrincipalSource({
    workspaceId: TEST_WORKSPACE,
    testWorkspace: opts.testWorkspace ?? true,
    principals: opts.principals ?? CAST,
    getVerifiedWorkspaceId: () => opts.connectedTo,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TestWorkspacePrincipalSource — scoping boundary (both sides)', () => {
  it('matching teamId + LISTED uid → resolves the cast record with its role', () => {
    const source = makeSource({ connectedTo: TEST_WORKSPACE });
    const rec = source.resolveFromSlackUserId('livetest-owner');
    expect(rec).not.toBeNull();
    expect(rec).toMatchObject({
      id: 'test-cast:livetest-owner',
      name: 'Owner Seat',
      orgRole: 'owner',
      permissions: ['owner'],
    });
  });

  it('matching teamId + UNLISTED uid → null (falls through to unregistered guest)', () => {
    const source = makeSource({ connectedTo: TEST_WORKSPACE });
    expect(source.resolveFromSlackUserId('livetest-unlisted')).toBeNull();
  });

  it('NON-matching teamId + LISTED uid → source structurally invisible (null)', () => {
    const source = makeSource({ connectedTo: OTHER_WORKSPACE });
    // Every listed seat resolves null when the connected workspace is not the
    // sanctioned one — the cast is invisible, not a fallback/merge.
    for (const entry of CAST) {
      expect(source.resolveFromSlackUserId(entry.slackUserId)).toBeNull();
    }
  });

  it('connected team not yet verified (null) → inert (fail-closed before auth.test)', () => {
    const source = makeSource({ connectedTo: null });
    expect(source.resolveFromSlackUserId('livetest-owner')).toBeNull();
  });

  it('connected team supplier THROWS → inert (fail-closed on a broken supplier)', () => {
    const source = new TestWorkspacePrincipalSource({
      workspaceId: TEST_WORKSPACE,
      testWorkspace: true,
      principals: CAST,
      getVerifiedWorkspaceId: () => { throw new Error('auth.test failed'); },
    });
    expect(source.resolveFromSlackUserId('livetest-owner')).toBeNull();
  });
});

describe('TestWorkspacePrincipalSource — the testWorkspace self-declaration marker (req 3)', () => {
  it('missing marker → whole source disabled, ZERO seats, logged loudly, never crashes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const source = makeSource({ connectedTo: TEST_WORKSPACE, testWorkspace: false });

    expect(source.disabled).toBe(true);
    expect(source.disabledReason).toBe('missing-testWorkspace-marker');
    expect(source.size).toBe(0);
    // Even a matching workspace + a listed uid resolves null when disabled.
    expect(source.resolveFromSlackUserId('livetest-owner')).toBeNull();

    // Exactly one loud line naming the missing marker.
    const loud = warn.mock.calls.map((c) => String(c[0]));
    expect(loud.some((l) => /testWorkspace/i.test(l) && /IGNORED|ZERO|fail-closed/i.test(l))).toBe(true);
  });

  it('marker present but not literally true (e.g. undefined) → disabled (fail-closed)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const source = new TestWorkspacePrincipalSource({
      workspaceId: TEST_WORKSPACE,
      // simulate a config where the field is absent → coerced to false at wiring
      testWorkspace: undefined as unknown as boolean,
      principals: CAST,
      getVerifiedWorkspaceId: () => TEST_WORKSPACE,
    });
    expect(source.disabled).toBe(true);
    expect(source.size).toBe(0);
  });

  it('marker present (true) → source enabled, seats admitted, NOT disabled', () => {
    const source = makeSource({ connectedTo: TEST_WORKSPACE, testWorkspace: true });
    expect(source.disabled).toBe(false);
    expect(source.disabledReason).toBeUndefined();
    expect(source.size).toBe(CAST.length);
  });
});

describe('TestWorkspacePrincipalSource — the partition invariant (fixture-only admission)', () => {
  it('a NON-fixture uid is refused at load (never admitted, even with the marker)', () => {
    const source = makeSource({
      connectedTo: TEST_WORKSPACE,
      principals: [
        { slackUserId: 'livetest-owner', orgRole: 'owner' }, // fixture → admitted
        { slackUserId: 'U_REAL_EMPLOYEE', orgRole: 'admin' }, // NOT a fixture → refused
      ],
    });
    expect(source.size).toBe(1);
    expect(source.resolveFromSlackUserId('U_REAL_EMPLOYEE')).toBeNull();
    expect(source.rejected).toContainEqual({ slackUserId: 'U_REAL_EMPLOYEE', reason: 'not-a-fixture-identity' });
  });

  it('an invalid orgRole is refused at load', () => {
    const source = makeSource({
      connectedTo: TEST_WORKSPACE,
      principals: [{ slackUserId: 'livetest-owner', orgRole: 'superuser' }],
    });
    expect(source.size).toBe(0);
    expect(source.rejected).toContainEqual({ slackUserId: 'livetest-owner', reason: 'invalid-role' });
  });

  it('a duplicate uid is refused (one seat per id)', () => {
    const source = makeSource({
      connectedTo: TEST_WORKSPACE,
      principals: [
        { slackUserId: 'livetest-owner', orgRole: 'owner' },
        { slackUserId: 'livetest-owner', orgRole: 'admin' },
      ],
    });
    expect(source.size).toBe(1);
    expect(source.rejected).toContainEqual({ slackUserId: 'livetest-owner', reason: 'duplicate' });
    // The FIRST valid seat wins — no silent role escalation on a re-declaration.
    expect(source.resolveFromSlackUserId('livetest-owner')?.orgRole).toBe('owner');
  });

  it('the cast cap bounds the source (it can never become a shadow registry)', () => {
    const many: TestCastEntry[] = Array.from({ length: MAX_TEST_CAST_SEATS + 3 }, (_, i) => ({
      slackUserId: `livetest-seat-${i}`,
      orgRole: 'member',
    }));
    const source = makeSource({ connectedTo: TEST_WORKSPACE, principals: many });
    expect(source.size).toBe(MAX_TEST_CAST_SEATS);
    expect(source.rejected.filter((r) => r.reason === 'cast-cap-exceeded')).toHaveLength(3);
  });

  it('a non-string workspaceId throws (a construction error, not a silent no-op)', () => {
    expect(() => new TestWorkspacePrincipalSource({
      workspaceId: '',
      testWorkspace: true,
      principals: CAST,
      getVerifiedWorkspaceId: () => TEST_WORKSPACE,
    })).toThrow(/workspaceId/);
  });

  it('a whitespace-padded workspaceId is stored TRIMMED (no permanently-inert cast from a stray space)', () => {
    // Slack's own team_id never carries whitespace — a padded config value must
    // still match the verified connected id (second-pass review note).
    const source = new TestWorkspacePrincipalSource({
      workspaceId: `  ${TEST_WORKSPACE} `,
      testWorkspace: true,
      principals: CAST,
      getVerifiedWorkspaceId: () => TEST_WORKSPACE,
    });
    expect(source.resolveFromSlackUserId('livetest-owner')?.orgRole).toBe('owner');
  });
});

describe('ChainedUserLookup — production-registry-first precedence', () => {
  it('production record WINS over a cast record for the same uid (no shadowing/escalation)', () => {
    const productionRec: ResolvedUserRecord = { id: 'u-real', name: 'Real', permissions: ['member'], orgRole: 'member' };
    const production: UserLookup = {
      resolveFromSlackUserId: (id) => (id === 'livetest-owner' ? productionRec : null),
    };
    const cast = makeSource({ connectedTo: TEST_WORKSPACE });
    const chain = new ChainedUserLookup([production, cast]);
    // Production is consulted first — its record wins even though the cast has
    // an 'owner' seat for the same id.
    expect(chain.resolveFromSlackUserId('livetest-owner')).toBe(productionRec);
  });

  it('cast is the FALLBACK when production does not know the uid', () => {
    const production: UserLookup = { resolveFromSlackUserId: () => null };
    const cast = makeSource({ connectedTo: TEST_WORKSPACE });
    const chain = new ChainedUserLookup([production, cast]);
    expect(chain.resolveFromSlackUserId('livetest-admin')?.orgRole).toBe('admin');
  });

  it('a THROWING source is skipped — resolution never breaks the message path', () => {
    const boom: UserLookup = { resolveFromSlackUserId: () => { throw new Error('registry read failed'); } };
    const cast = makeSource({ connectedTo: TEST_WORKSPACE });
    const chain = new ChainedUserLookup([boom, cast]);
    expect(chain.resolveFromSlackUserId('livetest-member')?.orgRole).toBe('member');
  });
});

describe('Wiring: SlackPrincipalResolver actually consults the source (real construction path)', () => {
  // This mirrors EXACTLY how src/commands/server.ts composes principal resolution:
  //   productionLookup → ChainedUserLookup([production, testCastSource]) → SlackPrincipalResolver
  const production: UserLookup = { resolveFromSlackUserId: () => null }; // no Slack ids in the prod registry

  it('a cast seat resolves to a REGISTERED principal with the seat role (matching workspace)', () => {
    const cast = makeSource({ connectedTo: TEST_WORKSPACE });
    const resolver = new SlackPrincipalResolver(new ChainedUserLookup([production, cast]));

    const owner = resolver.resolve('livetest-owner', 'Owner Display');
    expect(owner).toMatchObject({ slackUserId: 'livetest-owner', role: 'owner', registered: true });
    expect(owner.userId).toBe('test-cast:livetest-owner');

    const contrib = resolver.resolve('livetest-contrib');
    expect(contrib).toMatchObject({ role: 'contributor', registered: true });
  });

  it('an UNLISTED uid in the test workspace resolves to an unregistered guest', () => {
    const cast = makeSource({ connectedTo: TEST_WORKSPACE });
    const resolver = new SlackPrincipalResolver(new ChainedUserLookup([production, cast]));
    const guest = resolver.resolve('livetest-stranger', 'Stranger');
    expect(guest).toMatchObject({ role: 'guest', registered: false, userId: null });
  });

  it('production behavior is BYTE-IDENTICAL when the connected workspace is not the test one', () => {
    // Baseline: resolver with NO cast at all (file-absent → today's behavior).
    const baseline = new SlackPrincipalResolver(production);
    // Same resolver but chained with a cast whose adapter is connected ELSEWHERE.
    const castElsewhere = makeSource({ connectedTo: OTHER_WORKSPACE });
    const withInvisibleCast = new SlackPrincipalResolver(new ChainedUserLookup([production, castElsewhere]));

    for (const id of ['livetest-owner', 'livetest-admin', 'someone-else']) {
      expect(withInvisibleCast.resolve(id)).toEqual(baseline.resolve(id));
    }
  });

  it('a DISABLED cast (missing marker) is byte-identical to no cast at all', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const baseline = new SlackPrincipalResolver(production); // file-absent baseline
    const disabledCast = makeSource({ connectedTo: TEST_WORKSPACE, testWorkspace: false });
    const withDisabledCast = new SlackPrincipalResolver(new ChainedUserLookup([production, disabledCast]));

    for (const id of ['livetest-owner', 'livetest-member', 'anyone']) {
      expect(withDisabledCast.resolve(id)).toEqual(baseline.resolve(id));
    }
  });
});

describe('Scope of authority (KYP): the source feeds ROLE RESOLUTION ONLY', () => {
  it('exposes ONLY the UserLookup read contract — no write/registry/operator surface', () => {
    const source = makeSource({ connectedTo: TEST_WORKSPACE });
    // The read contract it is allowed to satisfy:
    expect(typeof source.resolveFromSlackUserId).toBe('function');
    // It must NOT carry any user-registry WRITE surface…
    for (const method of ['addUser', 'saveUser', 'setOperator', 'register', 'upsert', 'writeUsers', 'save']) {
      expect((source as unknown as Record<string, unknown>)[method]).toBeUndefined();
    }
    // …nor any inbound-sender-authorization / operator-binding surface.
    for (const method of ['isAuthorized', 'resolveFromTelegram', 'getOperator', 'validateSender', 'bindOperator']) {
      expect((source as unknown as Record<string, unknown>)[method]).toBeUndefined();
    }
  });

  it('resolving takes NO constructor state dir and performs NO filesystem writes by construction', () => {
    // The source is constructed from in-memory config only (workspaceId + principals
    // + a supplier fn) — it has no stateDir, no fs handle, so it structurally
    // cannot create/modify users.json or any operator-binding file.
    const source = makeSource({ connectedTo: TEST_WORKSPACE });
    // Resolve a bunch; the returned records are plain data, namespaced so they can
    // never be mistaken for a real registry id (which is what operator binding /
    // sender validation key on).
    const rec = source.resolveFromSlackUserId('livetest-owner');
    expect(rec?.id.startsWith('test-cast:')).toBe(true);
    // No throw, no side effects — resolution is a pure map read behind the scope gate.
    expect(() => source.resolveFromSlackUserId('livetest-owner')).not.toThrow();
  });
});
