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
  // Anchor on the onMessage handler region (the handler runs ~200 lines, so the
  // window must reach past the spawn/register block at the end of it).
  const handlerStart = SERVER_TS.indexOf('slackAdapter.onMessage(async (message)');
  const handlerEnd = SERVER_TS.indexOf('await slackAdapter.start();', handlerStart);
  const handlerBlock = SERVER_TS.slice(handlerStart, handlerEnd > handlerStart ? handlerEnd : handlerStart + 14000);

  it('the handler computes a routingKey from resolveRoutingKey', () => {
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
  const block = ROUTES_TS.slice(start, start + 1600);
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
