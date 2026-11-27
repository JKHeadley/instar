/** Read-only session titles from the conversation that owns them, shared by
 * the app HTTP list and dashboard WebSocket list. Adapter reverse bindings are
 * caches, not the lifetime of a conversation's name. */
import fs from 'node:fs';
import path from 'node:path';
import { verifiedEntityName, verifiedChannelIdentity } from '../messaging/shared/channelIdentity.js';
import { resolveSessionPlatform, sessionDisplayName, type SessionPlatformInfo, type SessionPlatformSlack, type SessionPlatformTelegram } from './sessionPlatform.js';

interface TelegramRegistry {
  topicToSession?: Record<string, string>;
  topicToName?: Record<string, string>;
}
export interface SessionPresentationInput {
  name?: unknown;
  tmuxSession: string;
  telegramTopicId?: number;
  slackChannelId?: string;
  jobSlug?: string;
}
export interface SessionPresentationSources {
  stateDir?: string;
  telegram?: SessionPlatformTelegram | null;
  slack?: SessionPlatformSlack | null;
  telegramRegistry?: TelegramRegistry;
  topicMemory?: { getTopicMeta: (id: number) => { topicName?: string | null } | null } | null;
  conversationRegistry?: { resolve: (id: number) => { platform: string; conversationKey?: string; channelId?: string; threadTs?: string | null; label?: string } | null } | null;
  appConversations?: {
    channels?: { getChannelForSession: (name: string) => string | null };
    store: { getConversation: (key: string) => { title?: string | null } | null };
  } | null;
  scheduler?: { getJobs?: () => Array<{ slug: string; name: string }> } | null;
}

/** Snapshot the small durable binding registry ONCE per listing, not per row.
 * No writes or remote calls; records survive adapter restart and unbinding. */
export function createSessionPresentationResolver(sources: SessionPresentationSources) {
  let registry = sources.telegramRegistry;
  if (!registry && sources.stateDir) {
    try {
      // whole-file-sync-read-ok: small existing topic binding registry, once per list
      registry = JSON.parse(fs.readFileSync(path.join(sources.stateDir, 'topic-session-registry.json'), 'utf8'));
    } catch { /* @silent-fallback-ok — absent/corrupt registry: use the other durable sources below */ }
  }
  const topicForSession = new Map(Object.entries(registry?.topicToSession ?? {}).map(([id, tmux]) => [tmux, Number(id)]));
  const jobs = new Map(read(() => sources.scheduler?.getJobs?.())?.map(job => [job.slug, job.name]) ?? []);

  return (session: SessionPresentationInput): SessionPlatformInfo & { name: string } => {
    let platform = read(() => resolveSessionPlatform(session.tmuxSession, sources.telegram, sources.slack)) ?? { platform: 'headless' };
    const legacyTopic = /(?:^|-)topic-(-?\d+)$/.exec(session.tmuxSession);
    const appAlias = read(() => sources.appConversations?.channels?.getChannelForSession(session.tmuxSession));
    const id = session.telegramTopicId ?? topicForSession.get(session.tmuxSession)
      ?? (appAlias && /^-\d+$/.test(appAlias) ? Number(appAlias) : undefined)
      ?? (legacyTopic ? Number(legacyTopic[1]) : undefined);
    // This legacy field also holds NEGATIVE Slack/app aliases. Those MUST be
    // resolved through the conversation registry, never labelled Telegram.
    const conversation = id !== undefined && id < 0 ? read(() => sources.conversationRegistry?.resolve(id)) : null;
    const appKey = conversation?.platform === 'app' ? conversation.conversationKey : undefined;
    if (appKey) {
      const title = verifiedEntityName(appKey, read(() => sources.appConversations?.store.getConversation(appKey))?.title);
      platform = { platform: 'app', platformId: appKey, ...(title ? { platformName: title } : {}) };
    } else if (conversation?.platform === 'slack' || session.slackChannelId) {
      const channel = conversation?.channelId ?? session.slackChannelId!;
      const routingKey = conversation?.threadTs ? `${channel}:${conversation.threadTs}` : channel;
      const entries = read(() => sources.slack?.getChannelRegistry());
      const title = verifiedChannelIdentity('slack', channel, entries?.[routingKey]?.channelName)?.name
        ?? verifiedChannelIdentity('slack', channel, entries?.[channel]?.channelName)?.name
        ?? verifiedChannelIdentity('slack', channel, conversation?.label)?.name;
      platform = { platform: 'slack', platformId: routingKey, ...(title ? { platformName: title } : {}) };
    } else if (Number.isSafeInteger(id) && id! > 0) {
      platform = { platform: 'telegram', platformId: id };
    }
    if (platform.platform === 'telegram') {
      const topicId = Number(platform.platformId);
      const title = verifiedEntityName(topicId, read(() => sources.telegram?.getTopicName?.(topicId)))
        ?? verifiedEntityName(topicId, registry?.topicToName?.[String(topicId)])
        ?? verifiedEntityName(topicId, read(() => sources.topicMemory?.getTopicMeta(topicId))?.topicName);
      if (title) platform.platformName = title;
    }
    const jobTitle = session.jobSlug ? verifiedEntityName('__job__', jobs.get(session.jobSlug)) : null;
    // Jobs have their own durable definition even when they post into a topic.
    // All list consumers prefer platformName, so carry the same chosen title.
    const name = jobTitle ?? sessionDisplayName(session.name, platform);
    return { ...platform, ...(jobTitle ? { platformName: jobTitle } : {}), name };
  };
}

/** Display reads must survive an unavailable cache/store so another durable
 * source (or the saved session title) can still supply the name. */
function read<T>(lookup: () => T): T | null {
  try { return lookup(); }
  catch { return null; } // @silent-fallback-ok — read-only display lookup; other sources remain authoritative
}
