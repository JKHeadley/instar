/**
 * Wiring integrity: thread→session routing is actually CONSULTED in the live
 * message path — not a dead helper. These source-level assertions guard the
 * exact callsites that make the feature real (the Testing Integrity "wiring"
 * tier), so a future refactor that drops the routing-key plumbing fails CI.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';

const SERVER_TS = fs.readFileSync('src/commands/server.ts', 'utf-8');
const SESSION_MANAGER_TS = fs.readFileSync('src/core/SessionManager.ts', 'utf-8');
const ADAPTER_TS = fs.readFileSync('src/messaging/slack/SlackAdapter.ts', 'utf-8');
const ROUTES_TS = fs.readFileSync('src/server/routes.ts', 'utf-8');
const TYPES_TS = fs.readFileSync('src/messaging/slack/types.ts', 'utf-8');
const REPLY_SH = fs.readFileSync('src/templates/scripts/slack-reply.sh', 'utf-8');
const MIGRATOR_TS = fs.readFileSync('src/core/PostUpdateMigrator.ts', 'utf-8');

describe('thread→session: adapter API surface exists', () => {
  it('SlackAdapter exposes resolveRoutingKey / parseRoutingKey / isThreadRoutingKey / isThreadRoutingEnabled', () => {
    expect(ADAPTER_TS).toContain('resolveRoutingKey(');
    expect(ADAPTER_TS).toContain('parseRoutingKey(');
    expect(ADAPTER_TS).toContain('isThreadRoutingKey(');
    expect(ADAPTER_TS).toContain('isThreadRoutingEnabled(');
  });

  it('SlackConfig declares the opt-in threadSessions block', () => {
    expect(TYPES_TS).toContain('threadSessions?');
    expect(TYPES_TS).toContain('enabledChannelIds');
    expect(TYPES_TS).toContain('allChannels');
  });

  it('sendToChannel parses a routing key (PresenceProxy/standby relay safety)', () => {
    const start = ADAPTER_TS.indexOf('async sendToChannel(');
    expect(start).toBeGreaterThan(-1);
    const block = ADAPTER_TS.slice(start, start + 600);
    expect(block).toContain('parseRoutingKey');
  });
});

describe('thread→session: the live message path consults the routing key', () => {
  // Anchor on the shared slackInboundDispatch function — the actual channel→session
  // dispatch body (WS1.1 split it out of the onMessage closure so the owner-side
  // mesh bridge can replay it). The window reaches past the spawn/register block.
  const handlerStart = SERVER_TS.indexOf('const slackInboundDispatch = async (message');
  const handlerEnd = SERVER_TS.indexOf('_slackInboundDispatch = slackInboundDispatch;', handlerStart);
  const handlerBlock = SERVER_TS.slice(handlerStart, handlerEnd > handlerStart ? handlerEnd : handlerStart + 14000);

  it('the dispatch computes a routingKey from resolveRoutingKey', () => {
    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerBlock).toContain('slackAdapter!.resolveRoutingKey(channelId, threadTs, messageTs)');
  });

  it('the session lookup uses the routing key, not the bare channelId', () => {
    expect(handlerBlock).toContain('getSessionForChannel(routingKey)');
  });

  it('the resume map is consulted + cleared on the routing key', () => {
    expect(handlerBlock).toContain('getChannelResume(routingKey)');
    expect(handlerBlock).toContain('removeChannelResume(routingKey)');
  });

  it('the new session is registered on the routing key', () => {
    expect(handlerBlock).toContain('registerChannelSession(');
    expect(handlerBlock).toContain('routingKey,');
  });

  it('a thread session passes slackThreadTs through to spawn', () => {
    expect(handlerBlock).toContain('slackThreadTs: replyThreadTs');
  });

  it('the channel id (raw) is still used for the Slack reply target + spawn channel binding', () => {
    expect(handlerBlock).toContain('slackChannelId: channelId');
  });
});

describe('WS1.1 Slack dispatch-to-owner: inbound consults pool placement', () => {
  // The onMessage handler (distinct from slackInboundDispatch) must route the
  // inbound message through the SessionRouter BEFORE local dispatch — the exact
  // fix for "a Slack channel pinned to a peer machine still injected locally".
  const onMsgStart = SERVER_TS.indexOf('slackAdapter.onMessage(async (message)');
  const onMsgEnd = SERVER_TS.indexOf('await slackAdapter.start();', onMsgStart);
  const onMsgBlock = SERVER_TS.slice(onMsgStart, onMsgEnd > onMsgStart ? onMsgEnd : onMsgStart + 6000);

  it('the onMessage handler exists and reaches slackInboundDispatch only after routing', () => {
    expect(onMsgStart).toBeGreaterThan(-1);
    expect(onMsgBlock).toContain('await slackInboundDispatch(message)');
  });

  it('the handler consults the SessionRouter on the routing key (not bare channelId)', () => {
    expect(onMsgBlock).toContain('_sessionRouter');
    expect(onMsgBlock).toContain('_sessionRouter.route(');
    expect(onMsgBlock).toContain('sessionKey: routingKey');
  });

  it('the handler short-circuits local dispatch when the owner is a remote machine', () => {
    expect(onMsgBlock).toContain('isRemotelyHandled(outcome, _meshSelfId)');
  });

  it('routing is gated behind the pool stage so dark = byte-identical local dispatch', () => {
    expect(onMsgBlock).toContain("_sessionPoolStage() !== 'dark'");
  });

  it('the owner-side mesh bridge replays a forwarded Slack key through the shared dispatch', () => {
    // onAccepted: a non-numeric forwarded session key is a Slack conversation
    // owned by THIS machine → reconstruct the Message and replay it.
    const acceptStart = SERVER_TS.indexOf('onAccepted: (cmd) => {');
    expect(acceptStart).toBeGreaterThan(-1);
    const acceptBlock = SERVER_TS.slice(acceptStart, acceptStart + 4000);
    expect(acceptBlock).toContain('_slackInboundDispatch');
    // Slack keys are non-numeric; Telegram topic keys are pure numbers.
    expect(acceptBlock).toContain('isSlackSessionKey(slackKey)');
    expect(acceptBlock).toContain('reconstructSlackMessage(');
  });
});

describe('thread→session: SessionManager carries the thread_ts', () => {
  it('spawnInteractiveSession accepts a slackThreadTs option', () => {
    expect(SESSION_MANAGER_TS).toContain('slackThreadTs?: string');
  });
  it('the thread_ts is set as INSTAR_SLACK_THREAD_TS on the tmux session', () => {
    expect(SESSION_MANAGER_TS).toContain('INSTAR_SLACK_THREAD_TS');
  });
  it('the resume-failed fallback propagates slackThreadTs', () => {
    expect(SESSION_MANAGER_TS).toContain('slackThreadTs: options.slackThreadTs');
  });
});

describe('thread→session: reply route resolves the routing key for promise tracking', () => {
  const start = ROUTES_TS.indexOf("router.post('/slack/reply/:channelId'");
  // 2400-char window: the route gained the messageKind threading block
  // (outbound-jargon-filepath-gap §2.2 cross-channel single-sourcing), which
  // pushed the resolveRoutingKey call past the previous 1600-char bound.
  const block = ROUTES_TS.slice(start, start + 2400);
  it('the reply route resolves the routing key when a thread_ts is present', () => {
    expect(start).toBeGreaterThan(-1);
    expect(block).toContain('resolveRoutingKey(channelId, thread_ts');
  });
});

describe('thread→session: slack-reply.sh supports the optional thread_ts arg + migration', () => {
  it('the template recognizes a 2nd positional thread_ts (timestamp regex)', () => {
    expect(REPLY_SH).toContain('THREAD_TS');
    expect(REPLY_SH).toContain('^[0-9]+\\.[0-9]+$');
    expect(REPLY_SH).toContain('thread_ts');
  });
  it('the template carries the feature marker the migrator keys on', () => {
    expect(REPLY_SH).toContain('slack-reply-feature: thread-ts-arg');
  });
  it('the migrator refreshes a deployed-but-stale slack-reply.sh lacking the feature marker', () => {
    expect(MIGRATOR_TS).toContain('slack-reply-feature: thread-ts-arg');
    expect(MIGRATOR_TS).toContain('featureMarker');
  });
});
