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

export function resolveSessionPlatform(
  tmuxSession: string,
  telegram: SessionPlatformTelegram | null | undefined,
  slack: SessionPlatformSlack | null | undefined,
): SessionPlatformInfo {
  if (telegram) {
    const topicId = telegram.getTopicForSession?.(tmuxSession);
    if (topicId) {
      const info: SessionPlatformInfo = { platform: 'telegram', platformId: topicId };
      const topicName = telegram.getTopicName?.(topicId);
      if (topicName && !/^topic-\d+$/.test(topicName)) info.platformName = topicName;
      return info;
    }
  }
  if (slack) {
    const channelId = slack.getChannelForSession(tmuxSession);
    if (channelId) {
      const info: SessionPlatformInfo = { platform: 'slack', platformId: channelId };
      const registry = slack.getChannelRegistry();
      if (registry[channelId]?.channelName) info.platformName = registry[channelId]!.channelName;
      return info;
    }
  }
  return { platform: 'headless' };
}
