/**
 * ResumeHeartbeat — the 60-second topic→transcript-id refresh tick.
 *
 * Extracted from `commands/server.ts` so the tick that production runs is the
 * tick the tests run. It gathers every topic-linked live session (Telegram
 * topics, Slack channels under their synthetic ids), pairs each with the
 * Claude session id its hooks reported AND the framework it was spawned on,
 * and hands the set to `TopicResumeMap.refreshResumeMappings`.
 *
 * The framework is load-bearing (2026-10-13 server-loop freeze): without it
 * the map checked a Claude session's id in every transcript layout, and a
 * stale Claude id walked the entire Codex rollout archive on the main thread
 * once a minute. With it, a session known to be claude-code checks Claude
 * transcripts only. A missing transcript is an honest miss: the existing
 * mapping is kept and nothing is substituted.
 */

import type { TopicResumeMap } from './TopicResumeMap.js';

export interface ResumeHeartbeatSession {
  tmuxSession: string;
  claudeSessionId?: string | null;
  framework?: string;
}

export interface ResumeHeartbeatEntry {
  sessionName: string;
  claudeSessionId?: string;
  framework?: string;
}

export interface ResumeHeartbeatDeps {
  topicResumeMap: Pick<TopicResumeMap, 'refreshResumeMappings' | 'jsonlExistsPublic'>;
  listRunningSessions: () => ResumeHeartbeatSession[];
  /** Telegram topic id → tmux session name (absent when Telegram is not configured). */
  telegramTopicSessions?: () => Iterable<[number, string]>;
  /** Slack channel registry + the channel resume writer (absent when Slack is not configured). */
  slack?: {
    getChannelRegistry: () => Record<string, { sessionName: string }>;
    saveChannelResume: (channelId: string, uuid: string, sessionName: string) => void;
    channelToSyntheticId: (channelId: string) => number;
  };
}

/** Build the heartbeat input: every topic-linked session with its id + framework. */
export function buildResumeHeartbeatInput(deps: ResumeHeartbeatDeps): Map<number, ResumeHeartbeatEntry> {
  const enriched = new Map<number, ResumeHeartbeatEntry>();
  const sessions = deps.listRunningSessions();
  const find = (name: string): ResumeHeartbeatSession | undefined => sessions.find((s) => s.tmuxSession === name);

  if (deps.telegramTopicSessions) {
    for (const [topicId, sessionName] of deps.telegramTopicSessions()) {
      const session = find(sessionName);
      enriched.set(topicId, {
        sessionName,
        claudeSessionId: session?.claudeSessionId ?? undefined,
        framework: session?.framework,
      });
    }
  }

  if (deps.slack) {
    const registry = deps.slack.getChannelRegistry();
    for (const [channelId, entry] of Object.entries(registry)) {
      const session = find(entry.sessionName);
      enriched.set(deps.slack.channelToSyntheticId(channelId), {
        sessionName: entry.sessionName,
        claudeSessionId: session?.claudeSessionId ?? undefined,
        framework: session?.framework,
      });
    }
  }
  return enriched;
}

/**
 * One heartbeat tick. Writes the Slack channel resume map for channels whose
 * session id resolves (in the session's own framework layout), then refreshes
 * the topic resume map. Errors are contained per tick — a failing tick never
 * stops the interval.
 */
export function runResumeHeartbeatTick(deps: ResumeHeartbeatDeps): Map<number, ResumeHeartbeatEntry> {
  const enriched = buildResumeHeartbeatInput(deps);

  if (deps.slack) {
    // Also save to the Slack-specific resume map so that getChannelResume()
    // finds the UUID on the next message. refreshResumeMappings only writes
    // topic-resume-map.json (keyed by synthetic numeric id), but Slack message
    // handling reads slack-channel-resume-map.json (keyed by channel id).
    // ONLY the authoritative claudeSessionId — never an mtime fallback, which
    // cross-contaminates when multiple sessions are active.
    const registry = deps.slack.getChannelRegistry();
    for (const [channelId, entry] of Object.entries(registry)) {
      const info = enriched.get(deps.slack.channelToSyntheticId(channelId));
      if (info?.claudeSessionId && deps.topicResumeMap.jsonlExistsPublic(info.claudeSessionId, info.framework)) {
        deps.slack.saveChannelResume(channelId, info.claudeSessionId, entry.sessionName);
      }
    }
  }

  deps.topicResumeMap.refreshResumeMappings(enriched);
  return enriched;
}
