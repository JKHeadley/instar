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
import type { SlackConfig, SlackMessage } from '../../src/messaging/slack/types.js';
import { RingBuffer } from '../../src/messaging/slack/RingBuffer.js';
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

  it('keeps a mention of someone outside the conversation literal unless explicitly listed', async () => {
    const { adapter, calls } = makeAdapter(); // the stub reports no members
    await adapter.sendToChannel('C123', 'Thanks <@U0C62ABNDK8>');
    await adapter.sendToChannel('C123', 'Thanks <@U0C62ABNDK8>', { nativeReferences: ['U0C62ABNDK8'] });
    const posts = calls.filter((c) => c.method === 'chat.postMessage');
    expect(posts[0].params.text).toBe('Thanks &lt;@U0C62ABNDK8&gt;');
    expect(posts[1].params.text).toBe('Thanks <@U0C62ABNDK8>');
    expect(posts[1].params).not.toHaveProperty('_nativeReferences');
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

/**
 * Participant mentions (default on): a `<@U…>` the agent writes is sent active
 * when that id is a human participant of the target conversation, and literal
 * otherwise. The Slack transport is stubbed with a member list and users.info.
 */
describe('SlackAdapter → participant mentions', () => {
  const HUMAN = 'U0C62ABNDK8';
  const OUTSIDER = 'U0APWL48281';
  const BOT = 'U0BOTUSER01';
  const LEFT = 'U0DEACTIV01';

  function makeParticipantAdapter(opts: {
    members?: string[] | 'fail';
    usersFail?: string[];
    noBotField?: string[];
    membersDelayMs?: number;
  } = {}) {
    const { adapter } = makeAdapter();
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    (adapter as unknown as { apiClient: unknown }).apiClient = {
      call: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === 'conversations.members') {
          if (opts.membersDelayMs) await new Promise((r) => setTimeout(r, opts.membersDelayMs));
          if (opts.members === 'fail') throw new Error('missing_scope');
          return { ok: true, members: opts.members ?? [HUMAN, BOT, LEFT] };
        }
        if (method === 'users.info') {
          const id = String(params.user);
          if (opts.usersFail?.includes(id)) throw new Error('user_not_found');
          if (opts.noBotField?.includes(id)) return { ok: true, user: { id, name: id.toLowerCase() } };
          return { ok: true, user: { id, name: id.toLowerCase(), is_bot: id === BOT, deleted: id === LEFT } };
        }
        return { ok: true, ts: '1700000001.000001' };
      },
    };
    const posts = () => calls.filter((c) => c.method === 'chat.postMessage');
    return { adapter, calls, posts };
  }

  it('activates a human member mention with no flag (the reported case)', async () => {
    const { adapter, posts } = makeParticipantAdapter();
    await adapter.sendToChannel('C123', `<@${HUMAN}> Justin passed on your note about the mailing address`);
    expect(posts()[0].params.text).toBe(`<@${HUMAN}> Justin passed on your note about the mailing address`);
    expect(posts()[0].params).not.toHaveProperty('_participantUserIds');
  });

  it('keeps a non-member, a bot member and a deactivated member literal', async () => {
    const { adapter, posts } = makeParticipantAdapter();
    await adapter.sendToChannel('C123', `<@${HUMAN}> <@${OUTSIDER}> <@${BOT}> <@${LEFT}>`);
    expect(posts()[0].params.text).toBe(`<@${HUMAN}> &lt;@${OUTSIDER}&gt; &lt;@${BOT}&gt; &lt;@${LEFT}&gt;`);
  });

  it('keeps broadcasts and code literal even when the mentioned person is a member', async () => {
    const { adapter, posts } = makeParticipantAdapter();
    await adapter.sendToChannel('C123', `<!channel> <!here> \`<@${HUMAN}>\``);
    expect(posts()[0].params.text).toBe(`&lt;!channel&gt; &lt;!here&gt; \`&lt;@${HUMAN}&gt;\``);
  });

  it('fails closed (literal) when the member list cannot be read, and still sends', async () => {
    const { adapter, posts } = makeParticipantAdapter({ members: 'fail' });
    await adapter.sendToChannel('C123', `Thanks <@${HUMAN}>`);
    expect(posts()).toHaveLength(1);
    expect(posts()[0].params.text).toBe(`Thanks &lt;@${HUMAN}&gt;`);
  });

  it('fails closed for one id whose users.info fails, without affecting others', async () => {
    const { adapter, posts } = makeParticipantAdapter({ members: [HUMAN, OUTSIDER], usersFail: [OUTSIDER] });
    await adapter.sendToChannel('C123', `<@${HUMAN}> <@${OUTSIDER}>`);
    expect(posts()[0].params.text).toBe(`<@${HUMAN}> &lt;@${OUTSIDER}&gt;`);
  });

  it('never holds a send past the lookup timeout', async () => {
    const { adapter, posts } = makeParticipantAdapter({ membersDelayMs: 4000 });
    const started = Date.now();
    await adapter.sendToChannel('C123', `Thanks <@${HUMAN}>`);
    expect(Date.now() - started).toBeLessThan(3500);
    expect(posts()[0].params.text).toBe(`Thanks &lt;@${HUMAN}&gt;`);
  }, 10_000);

  it('the explicit list still activates someone outside the conversation', async () => {
    const { adapter, posts } = makeParticipantAdapter();
    await adapter.sendToChannel('C123', `<@${OUTSIDER}>`, { nativeReferences: [OUTSIDER] });
    expect(posts()[0].params.text).toBe(`<@${OUTSIDER}>`);
  });

  it('caches the member list and user kinds between sends', async () => {
    const { adapter, calls } = makeParticipantAdapter();
    await adapter.sendToChannel('C123', `Hi <@${HUMAN}>`);
    await adapter.sendToChannel('C123', `Again <@${HUMAN}>`);
    expect(calls.filter((c) => c.method === 'conversations.members')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'users.info')).toHaveLength(1);
  });

  it('makes no lookup for a message without a person mention', async () => {
    const { adapter, calls } = makeParticipantAdapter();
    await adapter.sendToChannel('C123', '**plain** reply');
    expect(calls.map((c) => c.method)).toEqual(['chat.postMessage']);
  });

  it('counts someone who posted in the thread as a participant without a member read', async () => {
    const { adapter, calls, posts } = makeParticipantAdapter({ members: [] });
    const buf = new RingBuffer<SlackMessage>(50);
    buf.push({ ts: '1700000000.000300', thread_ts: '1700000000.000100', user: HUMAN, text: 'hi', channel: 'C123' });
    (adapter as unknown as { channelHistory: Map<string, RingBuffer<SlackMessage>> }).channelHistory.set('C123', buf);
    await adapter.sendToChannel('C123', `Thanks <@${HUMAN}>`, { thread_ts: '1700000000.000100' });
    expect(posts()[0].params.text).toBe(`Thanks <@${HUMAN}>`);
    expect(calls.filter((c) => c.method === 'conversations.members')).toHaveLength(0);
  });

  it('a users.info answer without is_bot stays literal', async () => {
    const { adapter, posts } = makeParticipantAdapter({ members: [HUMAN], noBotField: [HUMAN] });
    await adapter.sendToChannel('C123', `<@${HUMAN}>`);
    expect(posts()[0].params.text).toBe(`&lt;@${HUMAN}&gt;`);
  });

  it('an older name-only cache entry is looked up again before a tag goes live', async () => {
    const { adapter, calls, posts } = makeParticipantAdapter({ members: [HUMAN] });
    (adapter as unknown as { userCache: Map<string, { name: string; fetchedAt: number }> }).userCache
      .set(HUMAN, { name: 'cached name', fetchedAt: Date.now() });
    await adapter.sendToChannel('C123', `<@${HUMAN}>`);
    expect(calls.filter((c) => c.method === 'users.info')).toHaveLength(1);
    expect(posts()[0].params.text).toBe(`<@${HUMAN}>`);
  });

  it('Slackbot stays literal and a W… member id is tagged', async () => {
    const W = 'W0C62ABNDK8';
    const { adapter, posts } = makeParticipantAdapter({ members: ['USLACKBOT', W] });
    await adapter.sendToChannel('C123', `<@USLACKBOT> <@${W}>`);
    expect(posts()[0].params.text).toBe(`&lt;@USLACKBOT&gt; <@${W}>`);
  });

  it('concurrent sends to an uncached conversation share one member read', async () => {
    const { adapter, calls } = makeParticipantAdapter({ membersDelayMs: 50 });
    await Promise.all([adapter.sendToChannel('C123', `a <@${HUMAN}>`), adapter.sendToChannel('C123', `b <@${HUMAN}>`)]);
    expect(calls.filter((c) => c.method === 'conversations.members')).toHaveLength(1);
  });

  it('legacy-passthrough sends make no lookup', async () => {
    const { adapter, calls } = makeParticipantAdapter();
    await adapter.sendToChannel('C123', `<@${HUMAN}>`, { formatMode: 'legacy-passthrough' });
    expect(calls.map((c) => c.method)).toEqual(['chat.postMessage']);
  });
});
