/**
 * SlackAdapter ↔ AmbientContributionGate wiring (considered/ambient mode, §5.2).
 *
 * Verifies the gate slots in at the mention-only-skip point of _handleMessage:
 *   - DARK default (no gate attached) → undirected channel message dropped exactly
 *     as today, no LLM call.
 *   - Directed messages (DM / @mention) are UNAFFECTED by the gate.
 *   - Ambient channel + gate says speak → undirected message is processed.
 *   - Fail-to-silence: gate says silent / errors / channel not opted-in → dropped.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SlackAdapter } from '../../src/messaging/slack/SlackAdapter.js';
import { AmbientContributionGate } from '../../src/permissions/AmbientContributionGate.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const CH = 'C_AMBIENT';
const BOT = 'U_BOT';

function fakeProvider(responder: () => string, capture?: { calls: number }): IntelligenceProvider {
  return {
    async evaluate(): Promise<string> {
      if (capture) capture.calls++;
      return responder();
    },
  };
}

/** Build an adapter in mention-only mode with reactions/user-info stubbed out. */
function harness(tmp: string) {
  const messages: string[] = [];
  const adapter = new SlackAdapter(
    {
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      authorizedUserIds: ['U_TEST'],
      workspaceMode: 'shared', // → respondMode defaults to 'mention-only'
    } as any,
    tmp,
  );
  adapter.onMessage(async (m) => { messages.push(m.content); });
  // Stub out all outbound Slack Web API touch-points so nothing hits the network.
  (adapter as any).addReaction = () => {};
  (adapter as any).removeReaction = () => {};
  (adapter as any).getUserInfo = async (id: string) => ({ id, name: id });
  (adapter as any).botUserId = BOT;
  const handle = (adapter as any)._handleMessage.bind(adapter);
  return { adapter, handle, messages };
}

const speakJson = '{"speak":true,"confidence":0.95,"contribution":"the onnxruntime-node CDN flake — gh run rerun --failed"}';
const silentJson = '{"speak":false,"confidence":0.2}';

describe('SlackAdapter ambient gate wiring', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-ambient-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/slack-ambient-gate-wiring.test.ts' }); });

  it('DARK default (no gate): undirected channel message is dropped, exactly as today', async () => {
    const { handle, messages } = harness(tmp);
    await handle({ user: 'U_TEST', text: 'just chatting, no mention', channel: CH, ts: '1.1' });
    expect(messages).toHaveLength(0); // dropped — mention-only behavior preserved
  });

  it('directed message (DM) is UNAFFECTED by the gate — still processed', async () => {
    const { adapter, handle, messages } = harness(tmp);
    // Attach a gate that would say silent; a DM must NOT consult it and must process.
    const cap = { calls: 0 };
    adapter.setAmbientGate(new AmbientContributionGate({
      config: { enabledChannelIds: ['D_TEST'] },
      intelligence: fakeProvider(() => silentJson, cap),
    }));
    await handle({ user: 'U_TEST', text: 'hey', channel: 'D_TEST', ts: '2.1' });
    expect(messages).toHaveLength(1); // directed → processed
    expect(cap.calls).toBe(0); // the gate is never consulted for a directed message
  });

  it('directed message (@mention) is UNAFFECTED by the gate — still processed', async () => {
    const { adapter, handle, messages } = harness(tmp);
    const cap = { calls: 0 };
    adapter.setAmbientGate(new AmbientContributionGate({
      config: { enabledChannelIds: [CH] },
      intelligence: fakeProvider(() => silentJson, cap),
    }));
    await handle({ user: 'U_TEST', text: `<@${BOT}> please help`, channel: CH, ts: '3.1' });
    expect(messages).toHaveLength(1); // @mention is directed → processed
    expect(cap.calls).toBe(0); // gate not consulted for a directed message
  });

  it('ambient channel + gate says SPEAK → undirected message is processed', async () => {
    const { adapter, handle, messages } = harness(tmp);
    adapter.setAmbientGate(new AmbientContributionGate({
      config: { enabledChannelIds: [CH], maxProactivePerChannel: 1 },
      intelligence: fakeProvider(() => speakJson),
    }));
    await handle({ user: 'U_TEST', text: 'CI keeps failing on onnxruntime-node', channel: CH, ts: '4.1' });
    expect(messages).toHaveLength(1); // gate cleared → processed as if directed
  });

  it('ambient channel + gate says SILENT → undirected message is dropped', async () => {
    const { adapter, handle, messages } = harness(tmp);
    adapter.setAmbientGate(new AmbientContributionGate({
      config: { enabledChannelIds: [CH] },
      intelligence: fakeProvider(() => silentJson),
    }));
    await handle({ user: 'U_TEST', text: 'lunch plans?', channel: CH, ts: '5.1' });
    expect(messages).toHaveLength(0); // gate declined → dropped
  });

  it('gate attached but channel NOT opted in → dropped, no LLM call', async () => {
    const { adapter, handle, messages } = harness(tmp);
    const cap = { calls: 0 };
    adapter.setAmbientGate(new AmbientContributionGate({
      config: { enabledChannelIds: ['C_OTHER'] },
      intelligence: fakeProvider(() => speakJson, cap),
    }));
    await handle({ user: 'U_TEST', text: 'overheard chatter', channel: CH, ts: '6.1' });
    expect(messages).toHaveLength(0);
    expect(cap.calls).toBe(0);
  });

  it('FAIL-TO-SILENCE: gate LLM throws → undirected message is dropped (no over-speak)', async () => {
    const { adapter, handle, messages } = harness(tmp);
    adapter.setAmbientGate(new AmbientContributionGate({
      config: { enabledChannelIds: [CH] },
      intelligence: fakeProvider(() => { throw new Error('provider down'); }),
    }));
    await handle({ user: 'U_TEST', text: 'should you jump in?', channel: CH, ts: '7.1' });
    expect(messages).toHaveLength(0); // errored gate stays silent
  });

  it('FAIL-TO-SILENCE: rate-limit exhausted → second undirected message dropped', async () => {
    const { adapter, handle, messages } = harness(tmp);
    adapter.setAmbientGate(new AmbientContributionGate({
      config: { enabledChannelIds: [CH], maxProactivePerChannel: 1, windowMs: 60_000 },
      intelligence: fakeProvider(() => speakJson),
    }));
    await handle({ user: 'U_TEST', text: 'first flake note', channel: CH, ts: '8.1' });
    await handle({ user: 'U_TEST', text: 'second flake note', channel: CH, ts: '8.2' });
    expect(messages).toHaveLength(1); // only the first proactive turn processed
  });

  it('unauthorized user is rejected BEFORE the gate (gate never consulted)', async () => {
    const { adapter, handle, messages } = harness(tmp);
    const cap = { calls: 0 };
    (adapter as any).postEphemeral = async () => {};
    adapter.setAmbientGate(new AmbientContributionGate({
      config: { enabledChannelIds: [CH] },
      intelligence: fakeProvider(() => speakJson, cap),
    }));
    await handle({ user: 'U_STRANGER', text: 'CI flake', channel: CH, ts: '9.1' });
    expect(messages).toHaveLength(0);
    expect(cap.calls).toBe(0); // AuthGate fails closed before ambient logic
  });

  // ── Cleanup #2: getAmbientStats() passthrough (observability surface) ──
  it('getAmbientStats() returns null when no gate is attached (DARK default)', () => {
    const { adapter } = harness(tmp);
    expect(adapter.getAmbientStats()).toBeNull();
  });

  it('getAmbientStats() surfaces the live aggregate after the gate processes messages', async () => {
    const { adapter, handle } = harness(tmp);
    adapter.setAmbientGate(new AmbientContributionGate({
      config: { enabledChannelIds: [CH] },
      intelligence: fakeProvider(() => silentJson), // a wrongful-silence candidate
    }));
    await handle({ user: 'U_TEST', text: 'overheard chatter', channel: CH, ts: '10.1' });
    const stats = adapter.getAmbientStats();
    expect(stats).not.toBeNull();
    const ch = stats!.channels.find(c => c.channelId === CH)!;
    expect(ch.evaluated).toBe(1);
    expect(ch.silent).toBe(1); // the silence is now measurable
  });
});
