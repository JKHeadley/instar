/**
 * messageLinks — build a link that opens one message (or the card or conversation holding an ask)
 * on the person's phone, and sort the links a message carries by kind
 * (docs/specs/waiting-on-you-links.md §1).
 *
 * Pure, no I/O, no decisions about any message. Every builder either returns a link that will
 * really open or says plainly why it cannot (`ok: false` with a reason); it never guesses a shape.
 */
import { consolePageUrl } from '../server/dashboardPaths.js';
import { isCardId } from './WorkCardStore.js';
import { ISSUES_TOPIC_OFFSET, isIssuesTopicId } from '../messaging/telegramTopicSpace.js';

export type MessageLinkRefusal =
  | 'invalid-input'
  | 'chat-not-linkable'
  | 'workspace-pending'
  | 'workspace-unsupported';

export type MessageLinkResult = { ok: true; url: string } | { ok: false; reason: MessageLinkRefusal };

const POSITIVE_INT = /^[1-9]\d{0,15}$/;

function positiveInt(v: unknown): number | null {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  return POSITIVE_INT.test(s) ? Number(s) : null;
}

/** The `<n>` of a supergroup chat id `-100<n>`, or null for any chat that has no message links. */
function supergroupInternalId(chatId: unknown): string | null {
  return /^-100(\d{1,15})$/.exec(String(chatId ?? '').trim())?.[1] ?? null;
}

/**
 * A Telegram message link. Only supergroups (chat ids `-100<n>`) have shareable message links:
 * `https://t.me/c/<n>/<threadId>/<messageId>` inside a forum topic, `https://t.me/c/<n>/<messageId>`
 * for the General topic (thread 1, or no topic). A private chat or basic group has none.
 * A topic in the separate Issues group (an internal id above ISSUES_TOPIC_OFFSET) lives in
 * `issuesChatId` with thread id `topicId - ISSUES_TOPIC_OFFSET`; the General rule applies after
 * that subtraction.
 * The link opens only for a member of the chat, which the person always is.
 */
export function telegramMessageLink(input: {
  chatId: string | number | undefined | null;
  issuesChatId?: string | number | undefined | null;
  topicId?: number | string | null;
  messageId: number | string;
}): MessageLinkResult {
  const messageId = positiveInt(input.messageId);
  if (messageId === null) return { ok: false, reason: 'invalid-input' };
  let topicId: number | null = null;
  if (input.topicId !== undefined && input.topicId !== null && input.topicId !== '') {
    topicId = positiveInt(input.topicId);
    if (topicId === null) return { ok: false, reason: 'invalid-input' };
  }
  let chat = input.chatId;
  let threadId = topicId;
  if (topicId !== null && isIssuesTopicId(topicId)) {
    chat = input.issuesChatId;
    threadId = topicId - ISSUES_TOPIC_OFFSET;
  }
  const internal = supergroupInternalId(chat);
  if (!internal) return { ok: false, reason: 'chat-not-linkable' };
  if (threadId === null || threadId === 1) return { ok: true, url: `https://t.me/c/${internal}/${messageId}` };
  return { ok: true, url: `https://t.me/c/${internal}/${threadId}/${messageId}` };
}

const SLACK_CHANNEL = /^[CDG][A-Z0-9]{2,30}$/;
const SLACK_TS = /^\d{9,11}\.\d{6}$/;

/** True for a Slack workspace address as `auth.test` returns it (`https://<team>.slack.com/`). */
export function isSlackWorkspaceUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /^[a-z0-9-]+(\.enterprise)?\.slack\.com$/i.test(u.hostname) && (u.pathname === '/' || u.pathname === '');
  } catch {
    return false; // @silent-fallback-ok — an unparseable address is simply not a workspace URL
  }
}

/**
 * A Slack permalink, in Slack's documented shape: `<workspace>/archives/<channel>/p<ts without the dot>`,
 * plus `?thread_ts=<threadTs>&cid=<channel>` for a reply inside a thread.
 * `workspace-pending`: the adapter has not read its workspace address yet (retry later).
 * `workspace-unsupported`: the address is not a `slack.com` one (for example GovSlack).
 */
export function slackMessageLink(input: { workspaceUrl: string | null | undefined; channel: string; ts: string; threadTs?: string | null }): MessageLinkResult {
  if (!SLACK_CHANNEL.test(String(input.channel ?? '')) || !SLACK_TS.test(String(input.ts ?? ''))) return { ok: false, reason: 'invalid-input' };
  if (input.threadTs && !SLACK_TS.test(String(input.threadTs))) return { ok: false, reason: 'invalid-input' };
  if (!input.workspaceUrl) return { ok: false, reason: 'workspace-pending' };
  if (!isSlackWorkspaceUrl(input.workspaceUrl)) return { ok: false, reason: 'workspace-unsupported' };
  const base = input.workspaceUrl.replace(/\/+$/, '');
  const url = `${base}/archives/${input.channel}/p${input.ts.replace('.', '')}`;
  if (input.threadTs && input.threadTs !== input.ts) {
    return { ok: true, url: `${url}?thread_ts=${input.threadTs}&cid=${input.channel}` };
  }
  return { ok: true, url };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A console link to an app conversation (the console's own `#/work/chats?c=app:<uuid>` route,
 * dashboard/console/chats-model.js). It opens the conversation at its newest messages; the
 * console has no per-message anchor. Accepts `app:<uuid>` or the bare uuid.
 */
export function appConversationLink(origin: string, conversationKey: string): MessageLinkResult {
  const id = String(conversationKey ?? '').trim().toLowerCase().replace(/^app:/, '');
  if (!UUID.test(id) || !origin) return { ok: false, reason: 'invalid-input' };
  return { ok: true, url: consolePageUrl(origin, `#/work/chats?c=${encodeURIComponent(`app:${id}`)}`) };
}

/** A console link to a Work Board card (the console's own `#/work/board?card=<id>` route). */
export function workCardLink(origin: string, cardId: string): MessageLinkResult {
  const id = String(cardId ?? '').trim();
  if (!isCardId(id) || !origin) return { ok: false, reason: 'invalid-input' };
  return { ok: true, url: consolePageUrl(origin, `#/work/board?card=${encodeURIComponent(id)}`) };
}

export interface AskLinkCounts { message: number; card: number; conversation: number; localOnly: number; other: number }

export interface AskLinkScan {
  counts: AskLinkCounts;
  /** Internal topic id and message id of this agent's Telegram message links, distinct, in order of appearance. */
  telegramRefs: Array<{ topicId: number | null; messageId: number; issues?: boolean }>;
  /** Card ids of the card links, with the origin each was on, distinct, in order of appearance. */
  cardRefs: Array<{ cardId: string; origin: string }>;
}

/**
 * Sort the web links in a message by kind — deterministic facts rendered to the B26 judge as
 * data. Each link has exactly one kind. `localOnly`: any link to this machine only (a phone
 * cannot open it), whatever its route; `message`: a `t.me/c/<this agent's chat>/…` link (main or
 * Issues group) or a Slack permalink; `card`: a console link to a Work Board card;
 * `conversation`: a console link to a conversation; everything else (another chat's `t.me/c`
 * link included) is `other`. A kind says what shape a link has, never that it points at the right ask.
 */
export function classifyAskLinks(text: string, opts: { telegramChatId?: string | number | null; telegramIssuesChatId?: string | number | null } = {}): AskLinkScan {
  const counts: AskLinkCounts = { message: 0, card: 0, conversation: 0, localOnly: 0, other: 0 };
  const telegramRefs: AskLinkScan['telegramRefs'] = [];
  const cardRefs: AskLinkScan['cardRefs'] = [];
  const seenRefs = new Set<string>();
  // bounded-input-reviewed: an outbound message is far below this; the counts are a hint the judge reads beside the full text, never the decision input on their own.
  const links = String(text ?? '').slice(0, 20_000).match(/\bhttps?:\/\/[^\s)>\]"'`|<]+/gi) ?? [];
  const main = supergroupInternalId(opts.telegramChatId);
  const issues = supergroupInternalId(opts.telegramIssuesChatId);
  for (const found of links) {
    // A link written mid-sentence or inside emphasis drags its punctuation along
    // ("…/138/146." or "**…/146**"); that is not part of the address.
    const raw = found.replace(/[.,;:!?*_~]+$/, '');
    let u: URL;
    try { u = new URL(raw); } catch { counts.other++; continue; } // @silent-fallback-ok — an unparseable link is counted as "other"
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') { counts.localOnly++; continue; }
    if (host === 't.me') {
      const m = /^\/c\/(\d{1,15})\/(\d{1,16})(?:\/(\d{1,16}))?\/?$/.exec(u.pathname);
      const inIssues = !!m && !!issues && m[1] === issues;
      if (m && ((main && m[1] === main) || inIssues)) {
        counts.message++;
        const thread = m[3] ? Number(m[2]) : null;
        const messageId = Number(m[3] ?? m[2]);
        const topicId = thread === null ? null : inIssues ? ISSUES_TOPIC_OFFSET + thread : thread;
        const key = `${topicId ?? (inIssues ? '*issues' : '*')}:${messageId}`;
        if (!seenRefs.has(key)) { seenRefs.add(key); telegramRefs.push(inIssues ? { topicId, messageId, issues: true } : { topicId, messageId }); }
        continue;
      }
      counts.other++;
      continue;
    }
    if (/(^|\.)slack\.com$/.test(host) && /^\/archives\/[CDG][A-Z0-9]+\/p\d{15,17}\/?$/.test(u.pathname)) { counts.message++; continue; }
    if (u.hash.startsWith('#/work/board?card=')) {
      counts.card++;
      let id = '';
      try { id = decodeURIComponent(u.hash.slice('#/work/board?card='.length).split('&')[0]); } catch { id = ''; } // @silent-fallback-ok — a malformed card id is left unlisted; the link is still counted
      const key = `card:${u.origin}:${id}`;
      if (isCardId(id) && !seenRefs.has(key)) { seenRefs.add(key); cardRefs.push({ cardId: id, origin: u.origin }); }
      continue;
    }
    if (u.hash.startsWith('#/work/chats?c=')) { counts.conversation++; continue; }
    counts.other++;
  }
  return { counts, telegramRefs, cardRefs };
}
