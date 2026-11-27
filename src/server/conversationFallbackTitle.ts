/**
 * A title for a Telegram topic that has no stored name.
 *
 * Telegram gives no way to ask for a topic's name, so a machine that lost its topic registry (the
 * 19-20 November 2026 Studio rebuild lost about sixty) showed "Name not available yet" until someone
 * spoke in each topic. A topic bound to a project already has a title the owner recognises: the
 * Chief of Staff's project title (its initiative title, conversation name, or the lead of its goal).
 * That title is used only where no verified name exists; a stored name always wins, and the title
 * is never written back as the topic's name.
 */
import { isVerifiedChannelName } from '../messaging/shared/channelIdentity.js';

export interface ProjectTitleRow { conversationKey: string; title?: string | null; goal?: string | null }

const PLACEHOLDER_TITLES = new Set(['untitled project']);

/** topicId → project title, for every bound Telegram project with a usable title. */
export function projectTitlesByTopic(rows: ReadonlyArray<ProjectTitleRow> | null | undefined): Map<number, string> {
  const out = new Map<number, string>();
  for (const r of rows ?? []) {
    const m = r && typeof r.conversationKey === 'string' ? /^telegram:(\d+)$/.exec(r.conversationKey) : null;
    if (!m) continue;
    const id = Number(m[1]);
    const title = typeof r.title === 'string' ? r.title.replace(/\s+/g, ' ').trim() : '';
    if (!title || PLACEHOLDER_TITLES.has(title.toLowerCase()) || !isVerifiedChannelName('telegram', id, title)) continue;
    out.set(id, title.slice(0, 120));
  }
  return out;
}

/** The name to show: the stored name when it is a real one, else the project title, else null. */
export function topicDisplayName(topicId: number, storedName: unknown, projectTitles: ReadonlyMap<number, string>): string | null {
  if (isVerifiedChannelName('telegram', topicId, storedName)) return (storedName as string).trim();
  return projectTitles.get(topicId) ?? null;
}
