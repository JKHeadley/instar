/**
 * SlackMrkdwnFormatter wire-up tests (roadmap 0.1) — wiring integrity.
 *
 * Verifies the REAL SlackAdapter delegates every user-visible outbound path
 * (send / sendToChannel / updateMessage / postEphemeral) through the real
 * formatter funnel (formattedApiCall → applySlackFormatter), that the config
 * rollback ('legacy-passthrough') restores byte-for-byte behavior, that the
 * per-call opt-out works end-to-end through sendToChannel's options, and that
 * Block Kit sends are never touched.
 *
 * Mirrors tests/unit/telegram-format-wireup.test.ts: the API client transport
 * is stubbed BELOW the funnel (capture params, no network), so what we assert
 * is exactly what would hit the Slack Web API.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SlackAdapter } from '../../src/messaging/slack/SlackAdapter.js';
import type { SlackConfig } from '../../src/messaging/slack/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmp: string | null = null;

afterEach(() => {
  if (tmp) {
    SafeFsExecutor.safeRmSync(tmp, {
      recursive: true,
      force: true,
      operation: 'tests/unit/slack-mrkdwn-wireup.test.ts',
    });
    tmp = null;
  }
});

function makeAdapter(configOverrides: Partial<SlackConfig> = {}) {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-mrkdwn-wireup-'));
  const adapter = new SlackAdapter(
    {
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      authorizedUserIds: ['U_TEST'],
      workspaceMode: 'dedicated',
      ...configOverrides,
    } as SlackConfig,
    tmp,
  );
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  // Stub the transport UNDER the formatting funnel — the funnel itself
  // (formattedApiCall → applySlackFormatter) is the real production code.
  (adapter as unknown as { apiClient: unknown }).apiClient = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return { ok: true, ts: '1700000001.000001' };
    },
  };
  return { adapter, calls };
}

describe('SlackAdapter → formatter wiring integrity', () => {
  it('sendToChannel delegates to the REAL formatter (GFM in, mrkdwn out at the API boundary)', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.sendToChannel('C123', '**bold** and [docs](https://example.com)');
    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe('chat.postMessage');
    // Real conversion happened — not a no-op, not a stub.
    expect(calls[0].params.text).toBe('*bold* and <https://example.com|docs>');
  });

  it('send() (OutgoingMessage path) formats each chunk', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.send({
      userId: 'U_TEST',
      content: '# Update\n\n- **done**',
      channel: { type: 'slack', identifier: 'C123' },
    });
    expect(calls.length).toBe(1);
    expect(calls[0].params.text).toBe('*Update*\n\n• *done*');
  });

  it('updateMessage formats through the same funnel', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.updateMessage('C123', '1700000000.000001', '**edited**');
    expect(calls[0].method).toBe('chat.update');
    expect(calls[0].params.text).toBe('*edited*');
  });

  it('postEphemeral formats through the same funnel', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.postEphemeral('C123', 'U_TEST', '**private** note');
    expect(calls[0].method).toBe('chat.postEphemeral');
    expect(calls[0].params.text).toBe('*private* note');
  });

  it('sendBlocks passes Block Kit payloads through untouched', async () => {
    const { adapter, calls } = makeAdapter();
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: '*authored*' } }];
    await adapter.sendBlocks('C123', blocks, '**fallback**');
    expect(calls[0].params.blocks).toEqual(blocks);
    // Fallback text untouched — blocks callers author their payloads deliberately.
    expect(calls[0].params.text).toBe('**fallback**');
  });

  it("config rollback formatMode:'legacy-passthrough' restores byte-for-byte sends", async () => {
    const { adapter, calls } = makeAdapter({ formatMode: 'legacy-passthrough' });
    const raw = '**untouched** [x](https://y.z) & <raw>';
    await adapter.sendToChannel('C123', raw);
    expect(calls[0].params.text).toBe(raw);
  });

  it('per-call opt-out via sendToChannel options wins over the default-ON config', async () => {
    const { adapter, calls } = makeAdapter();
    const mrkdwn = '*already mrkdwn* with <https://x.co|link>';
    await adapter.sendToChannel('C123', mrkdwn, { formatMode: 'legacy-passthrough' });
    expect(calls[0].params.text).toBe(mrkdwn);
    // The internal flag never reaches the Slack API.
    expect('_formatMode' in calls[0].params).toBe(false);
  });

  it('thread routing still works through the funnel (thread_ts preserved)', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.sendToChannel('C123', '**t**', { thread_ts: '1700000000.000100' });
    expect(calls[0].params.thread_ts).toBe('1700000000.000100');
    expect(calls[0].params.text).toBe('*t*');
  });

  it('routing-key sends (channel:thread) format AND thread correctly', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.sendToChannel('C123:1700000000.000200', '**via key**');
    expect(calls[0].params.channel).toBe('C123');
    expect(calls[0].params.thread_ts).toBe('1700000000.000200');
    expect(calls[0].params.text).toBe('*via key*');
  });
});
