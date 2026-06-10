/**
 * Full-pipeline integration test for the test-as-self-for-Slack demonstration
 * (Pillar 4, §8.4). Unlike the gate-direct harness, this drives the scenario rows
 * through the REAL inbound chokepoint — SlackAdapter._handleMessage — with synthetic
 * inbound messages carrying each cast member's verified slackUserId, exactly as a
 * real Slack event would flow. It asserts BOTH:
 *   - the observer/gate produced the expected verdict, AND
 *   - the matching decision-ledger (audit) entry landed.
 *
 * This is the "verified, not narrated" property exercised through the production
 * message path (not just the gate unit). Credential-free: no Slack tokens, synthetic
 * verified slackUserIds only.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SlackAdapter } from '../../src/messaging/slack/SlackAdapter.js';
import { SlackPermissionObserver } from '../../src/permissions/SlackPermissionObserver.js';
import { SlackPrincipalResolver } from '../../src/permissions/SlackPrincipalResolver.js';
import { PermissionDecisionLedger } from '../../src/permissions/PermissionDecisionLedger.js';
import {
  CAST,
  SCENARIOS,
  CastUserLookup,
  buildSliceZeroGate,
} from '../../src/permissions/testing/SlackScenarioHarness.js';

const CAST_IDS = Object.values(CAST)
  .map((p) => p.slackUserId)
  .filter((x): x is string => !!x);

function createAdapter(stateDir: string, observer: SlackPermissionObserver): SlackAdapter {
  const adapter = new SlackAdapter(
    {
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      // Every cast id (incl. the unregistered outsider) must be AUTHORIZED to even
      // reach the gate — the documented A1.3 gotcha: an unregistered user reaches the
      // `unregistered` verdict only when they're in authorizedUserIds. The gate then
      // refuses on registration, which is the point.
      authorizedUserIds: CAST_IDS,
      workspaceMode: 'dedicated',
    } as never,
    stateDir,
  );
  adapter.onMessage(async () => {});
  adapter.setPermissionObserver(observer);
  return adapter;
}

describe('test-as-self-for-Slack — full pipeline through SlackAdapter._handleMessage', () => {
  let tmp: string;
  let observer: SlackPermissionObserver;
  let ledger: PermissionDecisionLedger;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-pipeline-'));
    ledger = new PermissionDecisionLedger(tmp);
    observer = new SlackPermissionObserver({
      resolver: new SlackPrincipalResolver(new CastUserLookup()),
      gate: buildSliceZeroGate(),
      ledger,
    });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/integration/slack-permission-pipeline.test.ts' });
  });

  it('drives EVERY scenario row through _handleMessage and lands its audit entry', async () => {
    const adapter = createAdapter(tmp, observer);
    const handle = (adapter as never as { _handleMessage: (e: Record<string, unknown>) => Promise<void> })._handleMessage.bind(adapter);

    let ts = 1;
    for (const s of SCENARIOS) {
      const slackUserId = s.principal.slackUserId!;
      // Directed rows arrive as a DM (channel id starts with 'D' → _handleMessage marks
      // it directed); the one undirected row (overheard) arrives in a public channel
      // with no @mention, so _handleMessage marks it directed:false — matching §6.9.
      const channel = s.directed ? `D_${slackUserId}` : `C_PUBLIC`;
      await handle({ user: slackUserId, text: s.text, channel, ts: String(ts++) });
    }

    const rows = ledger.readRecent(1000);
    // One audit entry per scenario row — the demonstration is recorded, not narrated.
    expect(rows.length).toBe(SCENARIOS.length);

    for (const s of SCENARIOS) {
      const entry = rows.find(
        (e) =>
          e.slackUserId === s.principal.slackUserId &&
          e.decision === s.expectedDecision &&
          e.basis === s.expectedBasis,
      );
      expect(entry, `missing audit entry for ${s.id} (${s.expectedDecision}/${s.expectedBasis})`).toBeDefined();
      // Observe-only through the live path (Slice 0 default).
      expect(entry!.enforced).toBe(false);
    }
  });

  it('the unregistered outsider is refused on registration through the live path', async () => {
    const adapter = createAdapter(tmp, observer);
    const handle = (adapter as never as { _handleMessage: (e: Record<string, unknown>) => Promise<void> })._handleMessage.bind(adapter);
    await handle({ user: CAST.outsiderOmar.slackUserId, text: 'summarize the standup', channel: `D_${CAST.outsiderOmar.slackUserId}`, ts: '99' });

    const rows = ledger.readRecent();
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe('refuse');
    expect(rows[0].basis).toBe('unregistered');
    expect(rows[0].registered).toBe(false);
  });

  it('the granted member reaches the floor action through the live path (floor-granted)', async () => {
    const adapter = createAdapter(tmp, observer);
    const handle = (adapter as never as { _handleMessage: (e: Record<string, unknown>) => Promise<void> })._handleMessage.bind(adapter);
    await handle({ user: CAST.grantedGrace.slackUserId, text: 'deploy the build to prod', channel: `D_${CAST.grantedGrace.slackUserId}`, ts: '100' });

    const rows = ledger.readRecent();
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe('allow');
    expect(rows[0].basis).toBe('floor-granted');
    expect(rows[0].floorAction).toBe('prod-deploy');
  });
});
