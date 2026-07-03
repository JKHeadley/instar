/**
 * Integration (Tier 2): the test-workspace principal source through the REAL
 * inbound chokepoint — SlackAdapter._handleMessage (roadmap 0.3 prerequisite).
 *
 * The unit suite (tests/unit/slack-test-workspace-principal-source.test.ts)
 * proves the source's boundaries in isolation. THIS suite proves the production
 * COMPOSITION — exactly how src/commands/server.ts wires it:
 *
 *   productionLookup ──┐
 *                      ├─ ChainedUserLookup ─ SlackPrincipalResolver ─ observer
 *   TestWorkspace ─────┘         (gate → PermissionDecisionLedger)
 *   PrincipalSource (getVerifiedWorkspaceId ← adapter.getConnectedTeamId())
 *
 * — driven by synthetic inbound Slack events through the SAME method a real
 * Socket-Mode event reaches, and asserted against the durable decision ledger.
 * The headline row is the exact 2026-07-01 regression this feature fixes
 * (fp-review row 29): the owner seat must resolve `owner, registered:true`
 * through the LIVE message path — and must resolve as an unregistered guest the
 * moment the adapter is connected to any other workspace (the scoping proof).
 *
 * The verified connected team id is simulated by assigning the same private
 * field `SlackAdapter.start()` sets from Slack's `auth.test` response — the test
 * never fakes a different mechanism than production uses. Credential-free: no
 * Slack tokens, fixture-marker (`livetest-*`) ids only (never a real cast UID).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SlackAdapter } from '../../src/messaging/slack/SlackAdapter.js';
import { SlackPermissionObserver } from '../../src/permissions/SlackPermissionObserver.js';
import { SlackPrincipalResolver, type UserLookup, type ResolvedUserRecord } from '../../src/permissions/SlackPrincipalResolver.js';
import { PermissionDecisionLedger } from '../../src/permissions/PermissionDecisionLedger.js';
import {
  TestWorkspacePrincipalSource,
  ChainedUserLookup,
  type TestCastEntry,
} from '../../src/permissions/TestWorkspacePrincipalSource.js';
import { buildSliceZeroGate } from '../../src/permissions/testing/SlackScenarioHarness.js';

const TEST_TEAM = 'T_LIVETEST';
const PROD_TEAM = 'T_SOME_PRODUCTION_WORKSPACE';

// Fixture-marker cast only (`livetest` is a reserved fixture prefix in
// users/testIdentityMarkers.ts) — the partition invariant admits nothing else.
const CAST: TestCastEntry[] = [
  { slackUserId: 'livetest-owner', name: 'Owner Seat', orgRole: 'owner' },
  { slackUserId: 'livetest-member', name: 'Member Seat', orgRole: 'member' },
];
const CAST_IDS = CAST.map((c) => c.slackUserId);

// A benign, non-urgent owner ask that lands allow/within-authority for a
// registered owner (scenario row 1's text) and refuse/unregistered for a guest.
const OWNER_ASK = 'push the hotfix to prod when CI is green';

type HandleFn = (e: Record<string, unknown>) => Promise<void>;

function buildPipeline(opts: {
  stateDir: string;
  /** Production-registry stand-in consulted FIRST (server.ts order). */
  production?: UserLookup;
}) {
  const adapter = new SlackAdapter(
    {
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      // Cast ids must be AUTHORIZED to even reach the gate (the documented A1.3
      // gotcha — an unauthorized sender never produces a decision row).
      authorizedUserIds: [...CAST_IDS, 'livetest-stranger'],
      workspaceMode: 'dedicated',
    } as never,
    opts.stateDir,
  );
  adapter.onMessage(async () => {});

  const production: UserLookup = opts.production ?? { resolveFromSlackUserId: () => null };
  // EXACTLY the server.ts composition: the scope supplier reads the adapter's
  // VERIFIED connected team id — config alone is never the scope authority.
  const source = new TestWorkspacePrincipalSource({
    workspaceId: TEST_TEAM,
    testWorkspace: true,
    principals: CAST,
    getVerifiedWorkspaceId: () => adapter.getConnectedTeamId(),
  });
  const ledger = new PermissionDecisionLedger(opts.stateDir);
  const observer = new SlackPermissionObserver({
    resolver: new SlackPrincipalResolver(new ChainedUserLookup([production, source])),
    gate: buildSliceZeroGate(),
    ledger,
  });
  adapter.setPermissionObserver(observer);

  const handle = (adapter as never as { _handleMessage: HandleFn })._handleMessage.bind(adapter);
  /** Simulate the verified `auth.test` capture — the SAME private field start() sets. */
  const setVerifiedTeam = (teamId: string | null) => {
    (adapter as unknown as { connectedTeamId: string | null }).connectedTeamId = teamId;
  };
  return { adapter, handle, ledger, setVerifiedTeam };
}

describe('test-cast principal source through SlackAdapter._handleMessage (Tier 2)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-testcast-pipeline-'));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/integration/slack-testcast-principal-pipeline.test.ts' });
  });

  it('FEATURE IS ALIVE: in the verified test workspace the owner seat resolves owner/registered through the LIVE path (the row-29 regression)', async () => {
    const { handle, ledger, setVerifiedTeam } = buildPipeline({ stateDir: tmp });
    setVerifiedTeam(TEST_TEAM);

    await handle({ user: 'livetest-owner', text: OWNER_ASK, channel: 'D_OWNER', ts: '1' });

    const rows = ledger.readRecent();
    expect(rows).toHaveLength(1);
    // The exact check the fp-review's re-provision checklist prescribes before
    // any enforce flip: the owner seat is `owner, registered:true` — not the
    // `guest, registered:false` that row 29 recorded after the registry rebuild.
    expect(rows[0]).toMatchObject({
      slackUserId: 'livetest-owner',
      role: 'owner',
      registered: true,
      decision: 'allow',
      basis: 'within-authority',
      enforced: false, // observe-only stays observe-only — no flag flipped here
    });
    expect(rows[0].userId).toBe('test-cast:livetest-owner');
  });

  it('SCOPE BOUNDARY: connected to a DIFFERENT workspace, the same seat is an unregistered guest through the LIVE path', async () => {
    const { handle, ledger, setVerifiedTeam } = buildPipeline({ stateDir: tmp });
    setVerifiedTeam(PROD_TEAM); // verified connection is NOT the sanctioned test workspace

    await handle({ user: 'livetest-owner', text: OWNER_ASK, channel: 'D_OWNER', ts: '2' });

    const rows = ledger.readRecent();
    expect(rows).toHaveLength(1);
    // The cast is structurally invisible outside its workspace — the seat gets
    // production's default treatment (refused on registration, tier ≥ 1).
    expect(rows[0]).toMatchObject({
      slackUserId: 'livetest-owner',
      role: 'guest',
      registered: false,
      decision: 'refuse',
      basis: 'unregistered',
    });
  });

  it('FAIL-CLOSED PRE-VERIFICATION: before auth.test verifies the connection, the cast is inert through the LIVE path', async () => {
    const { handle, ledger } = buildPipeline({ stateDir: tmp });
    // adapter.start() never ran → getConnectedTeamId() is null (production truth,
    // not a test contrivance) — the cast must not resolve on config alone.
    await handle({ user: 'livetest-owner', text: OWNER_ASK, channel: 'D_OWNER', ts: '3' });

    const rows = ledger.readRecent();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: 'guest', registered: false, basis: 'unregistered' });
  });

  it('UNLISTED uid in the verified test workspace stays an unregistered guest (no blanket workspace grant)', async () => {
    const { handle, ledger, setVerifiedTeam } = buildPipeline({ stateDir: tmp });
    setVerifiedTeam(TEST_TEAM);

    await handle({ user: 'livetest-stranger', text: OWNER_ASK, channel: 'D_STRANGER', ts: '4' });

    const rows = ledger.readRecent();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ slackUserId: 'livetest-stranger', role: 'guest', registered: false, basis: 'unregistered' });
  });

  it('PRODUCTION PRECEDENCE: a production-registry record beats the cast for the same uid through the LIVE path', async () => {
    const productionRec: ResolvedUserRecord = { id: 'u-prod-real', name: 'Real Record', permissions: ['member'], orgRole: 'member' };
    const production: UserLookup = {
      resolveFromSlackUserId: (id) => (id === 'livetest-owner' ? productionRec : null),
    };
    const { handle, ledger, setVerifiedTeam } = buildPipeline({ stateDir: tmp, production });
    setVerifiedTeam(TEST_TEAM);

    // The cast lists this uid as OWNER, but production says MEMBER — production
    // wins, so the member's prod-deploy ask is refused at the role floor (no
    // cast-driven role escalation is possible, even inside the test workspace).
    await handle({ user: 'livetest-owner', text: OWNER_ASK, channel: 'D_OWNER', ts: '5' });

    const rows = ledger.readRecent();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: 'member',
      registered: true,
      userId: 'u-prod-real',
      decision: 'refuse',
      basis: 'floor-no-grant',
    });
  });
});
