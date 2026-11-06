/**
 * Which messaging platform a running session is bound to — the ONE derivation
 * shared by GET /sessions and the dashboard WebSocket session list.
 *
 * The dashboard's platform icon (✈️ Telegram, 💬 Slack, 🖥️ headless) reads
 * `platform` off each row. Local rows arrive over the WebSocket, which used to
 * omit the field, so every local Telegram topic rendered as headless while the
 * same topic seen from another machine (via GET /sessions?scope=pool) rendered
 * correctly (2026-10-21, topic 112490). Both surfaces now call this.
 */

import { verifiedChannelIdentity, verifiedEntityName } from '../messaging/shared/channelIdentity.js';

export interface SessionPlatformTelegram {
  getTopicForSession?: (tmuxSession: string) => number | null | undefined;
  getTopicName?: (topicId: number) => string | null | undefined;
}

export interface SessionPlatformSlack {
  getChannelForSession: (tmuxSession: string) => string | null | undefined;
  getChannelRegistry: () => Record<string, { channelName?: string } | undefined>;
}

export interface SessionPlatformInfo {
  platform: string;
  platformId?: number | string;
  platformName?: string;
}

/** Public session title; tmuxSession remains the internal routing key. */
export function sessionDisplayName(name: unknown, platform: SessionPlatformInfo): string {
  const raw = typeof name === 'string' ? name.trim() : '';
  const savedName = /(?:^|-)topic--?\d+$/i.test(raw) ? null
    : platform.platform === 'slack'
      ? verifiedChannelIdentity('slack', String(platform.platformId ?? '').split(':')[0], raw)?.name
      : verifiedEntityName(platform.platformId ?? '__session__', raw);
  if (platform.platform === 'app') return verifiedEntityName(platform.platformId ?? '__app__', platform.platformName) ?? savedName ?? 'Conversation name unavailable';
  if (platform.platform === 'telegram') {
    return verifiedChannelIdentity('telegram', platform.platformId ?? '', platform.platformName)?.name
      ?? savedName ?? 'Conversation name unavailable';
  }
  if (platform.platform === 'slack') {
    return verifiedChannelIdentity('slack', String(platform.platformId ?? '').split(':')[0], platform.platformName)?.name
      ?? savedName ?? 'Channel name unavailable';
  }
  if (/(?:^|-)topic--?\d+$/i.test(raw)) return 'Conversation name unavailable';
  return verifiedEntityName('__session__', raw) ?? 'Session name unavailable';
}

export function resolveSessionPlatform(
  tmuxSession: string,
  telegram: SessionPlatformTelegram | null | undefined,
  slack: SessionPlatformSlack | null | undefined,
): SessionPlatformInfo {
  if (telegram) {
    const topicId = telegram.getTopicForSession?.(tmuxSession);
    if (topicId && topicId > 0) {
      const info: SessionPlatformInfo = { platform: 'telegram', platformId: topicId };
      const topicName = telegram.getTopicName?.(topicId);
      const identity = verifiedChannelIdentity('telegram', topicId, topicName);
      if (identity) info.platformName = identity.name;
      return info;
    }
  }
  if (slack) {
    const channelId = slack.getChannelForSession(tmuxSession);
    if (channelId) {
      const info: SessionPlatformInfo = { platform: 'slack', platformId: channelId };
      const registry = slack.getChannelRegistry();
      const identity = verifiedChannelIdentity('slack', channelId.split(':')[0], registry[channelId]?.channelName ?? registry[channelId.split(':')[0]]?.channelName);
      if (identity) info.platformName = identity.name;
      return info;
    }
  }
  return { platform: 'headless' };
}
