/**
 * Wiring-integrity + observer end-to-end tests for the Slack org permission system.
 *
 * Testing Integrity Standard: prove the gate is ACTUALLY CALLED from the adapter
 * (not a no-op), and that the resolver→gate→ledger composition records a real verdict.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SlackAdapter } from '../../src/messaging/slack/SlackAdapter.js';
import { SlackPermissionObserver, type ObserveInput } from '../../src/permissions/SlackPermissionObserver.js';
import { SlackPrincipalResolver, type UserLookup } from '../../src/permissions/SlackPrincipalResolver.js';
import { PermissionDecisionLedger } from '../../src/permissions/PermissionDecisionLedger.js';
import { buildSliceZeroGate } from '../../src/permissions/testing/SlackScenarioHarness.js';

function createAdapter(stateDir: string) {
  const adapter = new SlackAdapter(
    {
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      authorizedUserIds: ['U_TEST'],
      workspaceMode: 'dedicated',
    } as any,
    stateDir,
  );
  adapter.onMessage(async () => {});
  return adapter;
}

describe('SlackAdapter ↔ permission observer wiring', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-wire-'));
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/slack-permission-wiring.test.ts' });
  });

  it('calls the observer for an authorized inbound message (not a no-op)', async () => {
    const calls: ObserveInput[] = [];
    const fakeObserver = {
      observe: async (input: ObserveInput) => {
        calls.push(input);
        return null;
      },
      enforcing: false,
    };
    const adapter = createAdapter(tmp);
    adapter.setPermissionObserver(fakeObserver as unknown as SlackPermissionObserver);

    const handle = (adapter as any)._handleMessage.bind(adapter);
    await handle({ user: 'U_TEST', text: 'deploy to prod', channel: 'C_TEST', ts: '1.1' });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      slackUserId: 'U_TEST',
      text: 'deploy to prod',
      channel: 'C_TEST',
      directed: false, // not a DM, not @-mentioned → overheard
    });
  });

  it('marks a DM / mention as directed', async () => {
    const calls: ObserveInput[] = [];
    const fakeObserver = { observe: async (i: ObserveInput) => { calls.push(i); return null; }, enforcing: false };
    const adapter = createAdapter(tmp);
    adapter.setPermissionObserver(fakeObserver as unknown as SlackPermissionObserver);
    const handle = (adapter as any)._handleMessage.bind(adapter);
    await handle({ user: 'U_TEST', text: 'deploy to prod', channel: 'D_TEST', ts: '2.1' }); // DM
    expect(calls[0].directed).toBe(true);
  });

  it('does not throw when no observer is set (default path)', async () => {
    const adapter = createAdapter(tmp);
    const handle = (adapter as any)._handleMessage.bind(adapter);
    await expect(handle({ user: 'U_TEST', text: 'hi', channel: 'C_TEST', ts: '3.1' })).resolves.not.toThrow();
  });
});

describe('SlackPermissionObserver end-to-end (resolver → gate → ledger)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-obs-'));
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/slack-permission-wiring.test.ts' });
  });

  const lookup: UserLookup = {
    resolveFromSlackUserId: (id) => (id === 'U_MAYA' ? { id: 'u-maya', name: 'Maya', permissions: ['member'] } : null),
  };

  it('records a real verdict to the ledger and returns it (observe-only, enforced=false)', async () => {
    const ledger = new PermissionDecisionLedger(tmp);
    const observer = new SlackPermissionObserver({
      resolver: new SlackPrincipalResolver(lookup),
      gate: buildSliceZeroGate(),
      ledger,
    });

    const verdict = await observer.observe({
      slackUserId: 'U_MAYA',
      text: 'deploy to prod',
      directed: true,
      channel: 'C1',
    });

    expect(verdict?.decision).toBe('refuse');
    expect(verdict?.basis).toBe('floor-no-grant');
    expect(observer.enforcing).toBe(false);

    const rows = ledger.readRecent();
    expect(rows).toHaveLength(1);
    expect(rows[0].basis).toBe('floor-no-grant');
    expect(rows[0].slackUserId).toBe('U_MAYA');
    expect(rows[0].enforced).toBe(false);
  });

  it('resolves an unknown sender to an unregistered guest and refuses', async () => {
    const ledger = new PermissionDecisionLedger(tmp);
    const observer = new SlackPermissionObserver({
      resolver: new SlackPrincipalResolver(lookup),
      gate: buildSliceZeroGate(),
      ledger,
    });
    const verdict = await observer.observe({ slackUserId: 'U_GHOST', text: 'summarize the thread', directed: true });
    expect(verdict?.decision).toBe('refuse');
    expect(verdict?.basis).toBe('unregistered');
  });
});
