/**
 * Meaning search over conversations (docs/specs/conversation-search.md §4): the index sources and
 * the local search behind `GET /mobile/conversations/search?mode=meaning`.
 *
 * The sources read the same places keyword search reads (TopicMemory rows for Telegram, the app
 * conversation store, the Slack rows the history read serves), and turn each message into the
 * text the phone sees (`deviceTextForRow` / `slackDeviceText`), so a message is embedded as shown.
 *
 * The search applies EXACTLY the keyword path's visibility: the refs handed to the index are the
 * conversations the caller can list (`access.may`), and every candidate is re-read from its store
 * and, inside an app conversation, passed through `mayReadStored` before it becomes a hit.
 */
import type { ConversationSearchRouteDeps, ConversationSearchHit, LocalSearchResult, SearchPlatform } from './mobileConversationSearchRoutes.js';
import type { MobilePairingService } from './mobilePairingRoutes.js';
import { compareHits, dedupeHits, APP_SCAN_PER_CONVERSATION } from './mobileConversationSearchRoutes.js';
import { deviceTextForRow, slackDeviceText } from '../core/appPlatformMedia.js';
import { buildSnippet, termMarks } from '../core/conversationKeywordSearch.js';
import { type ConversationEmbeddingIndex, type Embedder, type IndexSource, type SourceItem } from '../memory/ConversationEmbeddingIndex.js';

/** Below this cosine similarity a neighbour is not about the query (all-MiniLM-L6-v2: unrelated text sits near 0-0.2). */
export const MIN_SIMILARITY = 0.3;
const APP_CONVERSATIONS_MAX = 2000;

/** What the route needs for meaning mode; null ⇒ 503 meaning-unavailable. */
export interface MeaningSearchDeps {
  index: ConversationEmbeddingIndex;
  embedder: Embedder;
  /** Fraction of this machine's messages the index has looked at (null when unknown). */
  coverage: () => number | null;
}

function isoOf(v: string): string | null {
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** The index sources for this machine, built from the same dependencies the keyword search reads. */
export function conversationIndexSources(deps: ConversationSearchRouteDeps): IndexSource[] {
  const out: IndexSource[] = [];
  const tm = deps.topicMemory?.() ?? null;
  if (tm && deps.telegramTopics) {
    out.push({
      platform: 'telegram',
      page(cursor, limit) {
        const rows = tm.indexPage(cursor === null ? null : Number(cursor), limit) ?? [];
        const items: SourceItem[] = [];
        for (const r of rows) {
          const at = isoOf(r.timestamp);
          if (!at || !Number.isSafeInteger(r.messageId)) continue;
          items.push({ ref: `telegram:${r.topicId}`, key: String(r.messageId), at, fromUser: r.fromUser, text: deviceTextForRow(r.text) });
        }
        const last = rows[rows.length - 1];
        return { items, next: rows.length >= limit && last ? String(last.id) : null };
      },
      total: () => tm.totalMessages(),
    });
  }
  const svc = deps.service;
  if (svc) {
    out.push({
      platform: 'app',
      immutable: true,
      page(cursor, limit) {
        const rows = svc.store.messageIndexPage(cursor === null ? null : Number(cursor), limit);
        const items = rows.map((r) => ({ ref: r.canonicalKey.toLowerCase(), key: r.eventId, at: isoOf(r.at) ?? r.at, fromUser: false, text: null }));
        const last = rows[rows.length - 1];
        return { items, next: rows.length >= limit && last ? String(last.row) : null };
      },
      readText(it) {
        const ev = svc.store.getEvent(it.ref.slice(4), it.key);
        if (!ev || (ev.kind !== 'message' && ev.kind !== 'media-message')) return null;
        return { text: typeof ev.text === 'string' ? ev.text : '', fromUser: ev.role === 'operator' };
      },
      total: () => svc.store.liveMessageCount(),
    });
  }
  const slack = deps.slack?.() ?? null;
  if (slack) {
    const self = deps.machineId();
    const flat = (): SourceItem[] => {
      const all: SourceItem[] = [];
      for (const c of slack.conversations()) {
        for (const r of slack.history(c.id, APP_SCAN_PER_CONVERSATION)) {
          const at = isoOf(r.at);
          if (at) all.push({ ref: `slack:${self}:${c.id}`, key: r.ts, at, fromUser: r.fromUser, text: slackDeviceText(r.text) });
        }
      }
      return all.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    };
    out.push({
      platform: 'slack',
      page(cursor, limit) {
        const all = flat();
        const from = cursor === null ? 0 : Math.max(0, Number(cursor) || 0);
        const items = all.slice(from, from + limit);
        return { items, next: from + limit < all.length ? String(from + limit) : null };
      },
      total: () => flat().length,
    });
  }
  return out;
}

/**
 * Search this machine by meaning. `queryVec` is the embedded query; `terms` only mark literal
 * words in the snippet (no word is required).
 */
export function searchMeaningLocal(
  deps: ConversationSearchRouteDeps,
  meaning: MeaningSearchDeps,
  q: { queryVec: Float32Array; terms: string[]; limit: number; only: string | null },
  access: { may: (accessKey: string) => boolean; mayReadApp: (key: string, m: Parameters<MobilePairingService['mayReadStored']>[2]) => boolean },
): LocalSearchResult {
  const { only } = q;
  const unsearched: SearchPlatform[] = [];
  let capped = false;
  const self = deps.machineId();
  const want = (p: SearchPlatform) => !only || only.startsWith(`${p}:`);
  // The refs the caller can list (the keyword path's own checks), with their titles.
  const titles = new Map<string, string | null>();
  const svc = deps.service;
  if (svc && want('app')) {
    if (only) {
      const key = only.slice(4);
      const c = svc.store.getConversation(key);
      if (c && svc.liveConversation(key) && access.may(key)) titles.set(`app:${key.toLowerCase()}`, c.title ?? null);
    } else {
      let cursor: string | null = null;
      let n = 0;
      do {
        const page = svc.store.listConversations({ limit: 200, cursor });
        for (const c of page.conversations) {
          n++;
          if (access.may(c.conversationKey)) titles.set(`app:${c.conversationKey.toLowerCase()}`, c.title ?? null);
        }
        cursor = page.nextCursor;
      } while (cursor && n < APP_CONVERSATIONS_MAX);
      if (cursor) capped = true;
    }
  }
  const tm = deps.topicMemory?.() ?? null;
  if (deps.telegramTopics && want('telegram')) {
    let any = false;
    for (const t of deps.telegramTopics()) {
      if (only && only !== `telegram:${t.topicId}`) continue;
      if (access.may(`telegram:${t.topicId}`)) { titles.set(`telegram:${t.topicId}`, t.topicName ?? null); any = true; }
    }
    if (any && !tm) unsearched.push('telegram');
  }
  const slack = want('slack') && access.may('slack:') ? deps.slack?.() ?? null : null;
  const onlySlack = only ? /^slack:([\w-]+):(-\d+)$/.exec(only) : null;
  if (slack && (!onlySlack || onlySlack[1] === self)) {
    for (const c of slack.conversations()) {
      if (onlySlack && String(c.id) !== onlySlack[2]) continue;
      titles.set(`slack:${self}:${c.id}`, c.title);
    }
  }
  if (titles.size === 0) return { results: [], capped, unsearched };

  const rows = meaning.index.search(q.queryVec, [...titles.keys()], Math.min(150, q.limit * 3));
  const out: ConversationSearchHit[] = [];
  const slackRows = new Map<number, Map<string, { ts: string; text: string; fromUser: boolean; at: string; eventId?: string }>>();
  for (const row of rows) {
    if (row.similarity < MIN_SIMILARITY) break;
    const title = titles.get(row.ref) ?? null;
    let found: { text: string; at: string; fromUser: boolean; messageId: string; platform: SearchPlatform; machine?: string } | null = null;
    if (row.ref.startsWith('app:') && svc) {
      const key = row.ref.slice(4);
      const ev = svc.store.getEvent(key, row.key);
      if (ev && (ev.kind === 'message' || ev.kind === 'media-message')) {
        if (!access.mayReadApp(key, ev)) continue; // held from this reader: never a hit, never forgotten
        const at = isoOf(ev.at);
        if (at) found = { text: typeof ev.text === 'string' ? ev.text : '', at, fromUser: ev.role === 'operator', messageId: ev.eventId, platform: 'app' };
      }
    } else if (row.ref.startsWith('telegram:') && tm) {
      const topicId = Number(row.ref.slice(9));
      const nativeId = Number(row.key);
      const r = tm.messageByKey(topicId, nativeId);
      const at = r ? isoOf(r.timestamp) : null;
      if (r && at) {
        const messageId = deps.telegramHistoryId?.(topicId, nativeId, r.fromUser) ?? `${r.fromUser ? 'in' : 'out'}:${nativeId}`;
        found = { text: deviceTextForRow(r.text), at, fromUser: r.fromUser, messageId, platform: 'telegram' };
      }
    } else if (row.ref.startsWith('slack:') && slack) {
      const id = Number(row.ref.split(':')[2]);
      let byTs = slackRows.get(id);
      if (!byTs) {
        byTs = new Map(slack.history(id, APP_SCAN_PER_CONVERSATION).map((r) => [r.ts, r]));
        slackRows.set(id, byTs);
      }
      const r = byTs.get(row.key);
      const at = r ? isoOf(r.at) : null;
      if (r && at) found = { text: slackDeviceText(r.text), at, fromUser: r.fromUser, messageId: r.eventId || `slack:${r.ts}`, platform: 'slack', machine: self };
    } else {
      continue; // its store is not open here right now: not a hit, and not evidence the message is gone
    }
    if (!found) { meaning.index.forget(row.ref, row.key); continue; } // the message is gone
    // The snippet: the first literal query word when one occurs (marked), else the message start.
    const words = termMarks(found.text, q.terms).marks;
    const s = buildSnippet(found.text, words);
    out.push({
      ref: row.ref, platform: found.platform, ...(found.machine ? { machine: found.machine } : {}), title,
      messageId: found.messageId, at: found.at, fromUser: found.fromUser, snippet: s.snippet, marks: s.marks,
      rank: Math.round(row.similarity * 1e6) / 1e6,
    });
  }
  out.sort(compareHits);
  return { results: dedupeHits(out).slice(0, q.limit), capped, unsearched };
}
