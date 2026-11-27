/**
 * TopicSpawnBriefStore — remembers the prompt a topic-bound session was
 * started with through the direct spawn route (POST /sessions/spawn).
 *
 * Why: that prompt is injected straight into the new session and never
 * appears in the topic's chat history. When the session is later replaced by
 * a fresh CONTINUATION respawn (e.g. a topic-profile re-apply), the new
 * session rebuilds its context from chat history alone — so without this
 * record it sees nothing in flight and idles. The respawn path reads the
 * brief back ONLY for the exact session it replaces, then re-keys the brief
 * to the replacement. Topic sessions reuse one tmux name, so the name alone
 * cannot tell a later session apart: every spawn the orchestrator did NOT
 * start (a natural or user-driven spawn) clears the topic's brief, and an old
 * task never reaches an unrelated later session of the same topic.
 *
 * One small JSON file per topic under `<stateDir>/state/topic-spawn-briefs/`
 * (atomic tmp+rename writes). File-based state per the project convention.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export interface TopicSpawnBrief {
  topicId: number;
  /** The tmux session that was started with this brief. */
  tmuxSession: string;
  prompt: string;
  recordedAt: string;
}

/** Prompts above this size are truncated on record (the route caps at 500KB). */
export const MAX_BRIEF_CHARS = 200_000;

export class TopicSpawnBriefStore {
  private readonly dir: string;

  constructor(stateDir: string) {
    this.dir = path.join(stateDir, 'state', 'topic-spawn-briefs');
  }

  private fileFor(topicId: number): string {
    return path.join(this.dir, `${Math.trunc(topicId)}.json`);
  }

  record(topicId: number, tmuxSession: string, prompt: string, now: Date = new Date()): void {
    if (!Number.isFinite(topicId) || !tmuxSession || typeof prompt !== 'string' || prompt.length === 0) return;
    const brief: TopicSpawnBrief = {
      topicId: Math.trunc(topicId),
      tmuxSession,
      prompt: prompt.length > MAX_BRIEF_CHARS ? prompt.slice(0, MAX_BRIEF_CHARS) : prompt,
      recordedAt: now.toISOString(),
    };
    this.write(brief);
  }

  /** The topic's brief, if any (regardless of session). */
  get(topicId: number): TopicSpawnBrief | null {
    try {
      const raw = fs.readFileSync(this.fileFor(topicId), 'utf-8');
      const parsed = JSON.parse(raw) as Partial<TopicSpawnBrief>;
      if (typeof parsed.prompt !== 'string' || typeof parsed.tmuxSession !== 'string') return null;
      return {
        topicId: Number(parsed.topicId ?? topicId),
        tmuxSession: parsed.tmuxSession,
        prompt: parsed.prompt,
        recordedAt: String(parsed.recordedAt ?? ''),
      };
    } catch {
      // @silent-fallback-ok: no brief (missing or unreadable file) is the
      // normal case for topics not started through the direct spawn route.
      return null;
    }
  }

  /** The brief for THIS session of the topic — null when it belongs to another session. */
  getForSession(topicId: number, tmuxSession: string | undefined): TopicSpawnBrief | null {
    if (!tmuxSession) return null;
    const brief = this.get(topicId);
    return brief && brief.tmuxSession === tmuxSession ? brief : null;
  }

  /** Re-key the topic's brief to the session that replaced the one it belonged to. */
  rebind(topicId: number, fromSession: string, toSession: string): void {
    const brief = this.getForSession(topicId, fromSession);
    if (!brief || !toSession || fromSession === toSession) return;
    this.write({ ...brief, tmuxSession: toSession });
  }

  /** Drop the topic's brief (a new, unrelated session took over the topic). */
  clear(topicId: number): void {
    const file = this.fileFor(topicId);
    if (!fs.existsSync(file)) return;
    SafeFsExecutor.safeUnlinkSync(file, { operation: 'TopicSpawnBriefStore.clear' });
  }

  private write(brief: TopicSpawnBrief): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.fileFor(brief.topicId);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(brief));
    fs.renameSync(tmp, file);
  }
}

/**
 * The block a CONTINUATION respawn adds so the replacement session knows the
 * task it was started with. Pure — exported for tests.
 */
export function formatCarriedBriefBlock(prompt: string): string {
  return [
    `--- Original Task Brief ---`,
    `This session was restarted (for example, to apply this topic's pinned model/framework profile).`,
    `It was originally started with the brief below, which is NOT in the thread history.`,
    `Check the history above for progress already made, then continue this task unless it is already done or was stopped:`,
    ``,
    prompt,
    `--- End Original Task Brief ---`,
  ].join('\n');
}
