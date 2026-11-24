/**
 * Work front doors, stage 2b (docs/specs/work-front-doors.md §3): the pure links between the Chief of Staff,
 * the work board and the conversation graph. AgentServer wires these to the live stores; tests drive them
 * directly. Read-only: nothing here writes a graph event, a card or a binding.
 */
import { nodeKey, type ConversationRef } from './conversationGraph.js';

/**
 * A Chief of Staff conversation key ("telegram:<topic>" or "app:<key>") as a conversation-graph ref.
 * Telegram needs the agent's chat id; any other kind (e.g. Slack) has no ref here yet and is skipped by callers.
 */
export function cosConversationRef(key: string, telegramChatId: string): ConversationRef | null {
  const t = /^telegram:(\d+)$/.exec(key);
  if (t && telegramChatId) return { kind: 'conversation', platform: 'telegram', chatId: telegramChatId, topicId: Number(t[1]) };
  const a = /^app:([A-Za-z0-9_.:-]{1,200})$/.exec(key);
  if (a) return { kind: 'conversation', platform: 'app', conversationKey: a[1] };
  return null;
}

/** The slice of the work board this needs (WorkBoardService satisfies it). */
export interface BoardCardsReader {
  cardIds(): string[];
  view(id: string): { status: string; card: { created: boolean; projectKey: string | null; conversationKey: string } } | null;
}

/**
 * Each open card's own conversation and its project's conversation (spec §3.2), for the read model's
 * proposed list. Done, archived and removed cards drop off; a card with no project, or a project key with no
 * graph ref, is left out.
 */
export function cardPlacementsFromBoard(board: BoardCardsReader, telegramChatId: string, mayPresent: (conversationKey: string) => boolean = () => true): Array<{ card: ConversationRef; project: ConversationRef }> {
  const out: Array<{ card: ConversationRef; project: ConversationRef }> = [];
  for (const id of board.cardIds()) {
    const v = board.view(id);
    if (!v || !v.card.created || !v.card.projectKey || !mayPresent(v.card.conversationKey)) continue;
    if (v.status === 'done' || v.status === 'archived' || v.status === 'removed') continue;
    const project = cosConversationRef(v.card.projectKey, telegramChatId);
    if (!project) continue;
    out.push({ card: { kind: 'conversation', platform: 'app', conversationKey: v.card.conversationKey }, project });
  }
  return out;
}

/** The slice of the Chief of Staff loop this needs. */
export interface ProjectsReader {
  projectsSummary(): Array<{ conversationKey: string; title: string }>;
  tree(): Map<string, { conversationKey: string; parentConversationKey: string | null }>;
}

/** Each bound project as a ready-made Conversations suggestion: its conversation and its tree children. */
export function projectSuggestionSources(loop: ProjectsReader, telegramChatId: string): Array<{ key: string; ref: ConversationRef; title: string; children: Array<{ key: string; ref: ConversationRef; title: string }> }> {
  const tree = loop.tree();
  const out: Array<{ key: string; ref: ConversationRef; title: string; children: Array<{ key: string; ref: ConversationRef; title: string }> }> = [];
  for (const p of loop.projectsSummary()) {
    const ref = cosConversationRef(p.conversationKey, telegramChatId);
    if (!ref) continue;
    const children: Array<{ key: string; ref: ConversationRef; title: string }> = [];
    for (const n of tree.values()) {
      if (n.parentConversationKey !== p.conversationKey) continue;
      const c = cosConversationRef(n.conversationKey, telegramChatId);
      if (c) children.push({ key: nodeKey(c), ref: c, title: 'Conversation' });
    }
    out.push({ key: nodeKey(ref), ref, title: p.title, children });
  }
  return out;
}
