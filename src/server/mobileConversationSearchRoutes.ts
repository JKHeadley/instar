/**
 * Keyword search over conversations (docs/specs/conversation-search.md) for the Instar iPhone
 * app and the dashboard:
 *
 *   GET /mobile/conversations/search?q=<text>&ref=<conversation ref>&mode=keyword&limit=<1-50>&scope=pool
 *
 * The same callers as `GET /mobile/conversations` (a phone, a browser device, or the agent's own
 * Bearer token, which reads as the owner) and the same visibility: a hit is only ever returned
 * from a conversation the caller can list, and inside an app conversation a team member sees only
 * the messages the history read would show them.
 *
 * Where the words are looked for, on this machine:
 *   - Telegram topics: the TopicMemory full-text index (FTS5, LIMIT in SQL);
 *   - app conversations: the conversation store, newest messages first, bounded;
 *   - Slack conversations: the rows the Slack history read serves (the cached log tail), bounded.
 * App and Slack text are scanned instead of indexed because the index does not hold them
 * reliably (app rows are only written with `contextBudget.enabled`; Slack rows are filed per
 * channel without the thread). A scan that stopped at its bound says so (`capped`).
 *
 * `mode` is `keyword` (the default). Meaning search is the next increment; until then any other
 * mode answers 400 `mode-unsupported`. Off switch: `mobilePairing.native.search.enabled`
 * (omitted ⇒ on wherever native conversations are on; `false` ⇒ 503 `search-off`). No LLM calls.
 */
import { Router, type Request, type Response } from 'express';
import type { InstarConfig } from '../core/types.js';
import type { MobilePairingService } from './mobilePairingRoutes.js';
import { deviceMayUse, devicePersonOf, isMobileNativeEnabled } from './mobilePairingRoutes.js';
import type { AppConversationService } from '../core/AppConversationService.js';
import type { TopicMemory } from '../memory/TopicMemory.js';
import type { RouteContext } from './routes.js';
import { isPeerUrlAllowedForCredentials } from './peerUrlGuard.js';
import { poolPeerFetch } from './poolPeerFetch.js';
import { deviceTextForRow, slackDeviceText } from '../core/appPlatformMedia.js';
import { accessRefOf, canonicalConversationRef, POSITION_ID_RE } from '../core/ConversationReadMarkers.js';
import {
  buildSnippet, ftsMatchExpression, HIGHLIGHT_CLOSE, HIGHLIGHT_OPEN, hitScore, marksFromHighlight, MAX_QUERY_CHARS,
  searchTerms, termMarks, type TextMark,
} from '../core/conversationKeywordSearch.js';

/** `mobilePairing.native.search.enabled`: omitted ⇒ on wherever native conversations are on. Read live. */
export function isConversationSearchEnabled(config: InstarConfig): boolean {
  return isMobileNativeEnabled(config) && config.mobilePairing?.native?.search?.enabled !== false;
}

export type SearchPlatform = 'app' | 'telegram' | 'slack';

/** One hit as the app receives it. */
export interface ConversationSearchHit {
  ref: string;
  platform: SearchPlatform;
  /** Slack only: the machine that holds the conversation (the history read's `machine=`). */
  machine?: string;
  title: string | null;
  /** The id the history read gives this message (app event id; Telegram `in:<n>`/`out:<n>` or its event id; Slack `slack:<ts>` or its event id). */
  messageId: string;
  at: string;
  fromUser: boolean;
  snippet: string;
  marks: TextMark[];
  /** The ranking score (higher is better), so merged pages from several machines keep one order. */
  rank: number;
}

/** One Slack row as the history read serves it. */
export interface SlackSearchRow { ts: string; text: string; fromUser: boolean; at: string; eventId?: string }

type PoolReadCtx = Pick<RouteContext, 'resolvePeerUrls' | 'recordRopeResult'> & { config: InstarConfig };

export interface ConversationSearchRouteDeps {
  config: InstarConfig;
  pairing: MobilePairingService;
  /** Null when native conversations resolved off at boot. */
  service: AppConversationService | null;
  machineId: () => string;
  topicMemory?: () => TopicMemory | null;
  /** The Telegram topics the list shows (absent when Telegram is not configured). */
  telegramTopics?: () => Array<{ topicId: number; topicName: string | null }>;
  /** The history id of a Telegram row (`telegramRowId` of the logged row), or null when the row is not in the history tail. */
  telegramHistoryId?: (topicId: number, nativeId: number, fromUser: boolean) => string | null;
  /** This machine's Slack conversations and their history rows; null when Slack is off or its owner id is unset. */
  slack?: () => { conversations(): Array<{ id: number; title: string | null }>; history(id: number, limit: number): SlackSearchRow[] } | null;
  pool?: PoolReadCtx | null;
}

export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 50;
/** Scan bounds (newest messages first). */
export const APP_SCAN_TOTAL = 5000;
export const APP_SCAN_PER_CONVERSATION = 1000;
export const SLACK_ROWS_PER_CONVERSATION = 1000;
export const SLACK_SCAN_TOTAL = 20_000;
const APP_CONVERSATIONS_MAX = 2000;
const POOL_TIMEOUT_MS = 5000;
const MAX_POOL_BYTES = 512 * 1024;

type Principal = { kind: string };
function principalOf(req: Request): Principal {
  return ((req as unknown as { instarPrincipal?: Principal }).instarPrincipal) ?? { kind: 'token' };
}

/** What a local search found, and what it could not look at. */
export interface LocalSearchResult { results: ConversationSearchHit[]; capped: boolean; unsearched: SearchPlatform[] }

/** The access check for a canonical ref, as the list applies it (Slack is one owner-only check). */
function accessKeyOf(ref: string): string {
  return ref.startsWith('slack:') ? 'slack:' : accessRefOf(ref);
}

/** Highest rank first, newest first on a tie, then by ref and id so the order is total. */
export function compareHits(a: ConversationSearchHit, b: ConversationSearchHit): number {
  return (b.rank - a.rank) || (a.at < b.at ? 1 : a.at > b.at ? -1 : 0) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0) || (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0);
}

function isoOf(v: string): string | null {
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function hitFrom(base: Omit<ConversationSearchHit, 'snippet' | 'marks' | 'rank'>, text: string, marks: TextMark[]): ConversationSearchHit {
  const s = buildSnippet(text, marks);
  return { ...base, snippet: s.snippet, marks: s.marks, rank: hitScore(text.length, marks.length) };
}

/**
 * Search this machine. `may(accessKey)` is the caller's list visibility; `mayReadApp` the
 * per-message check inside an app conversation. `only` restricts to one canonical ref.
 */
export function searchLocal(
  deps: ConversationSearchRouteDeps,
  q: { terms: string[]; limit: number; only: string | null },
  access: { may: (accessKey: string) => boolean; mayReadApp: (key: string, m: Parameters<MobilePairingService['mayReadStored']>[2]) => boolean },
): LocalSearchResult {
  const out: ConversationSearchHit[] = [];
  const unsearched: SearchPlatform[] = [];
  let capped = false;
  const { terms, only } = q;
  if (terms.length === 0) return { results: [], capped, unsearched };
  const self = deps.machineId();
  const want = (p: SearchPlatform) => !only || only.startsWith(`${p}:`);

  // App conversations: the store, newest first, bounded.
  const svc = deps.service;
  if (svc && want('app')) {
    const keys: Array<{ key: string; title: string | null }> = [];
    if (only) {
      const key = only.slice(4);
      const c = svc.store.getConversation(key);
      if (c && svc.liveConversation(key)) keys.push({ key, title: c.title ?? null });
    } else {
      let cursor: string | null = null;
      do {
        const page = svc.store.listConversations({ limit: 200, cursor });
        for (const c of page.conversations) keys.push({ key: c.conversationKey, title: c.title ?? null });
        cursor = page.nextCursor;
      } while (cursor && keys.length < APP_CONVERSATIONS_MAX);
      if (cursor) capped = true;
    }
    let scanned = 0;
    const perConversation = only ? APP_SCAN_TOTAL : APP_SCAN_PER_CONVERSATION;
    for (const { key, title } of keys) {
      if (!access.may(key)) continue;
      if (scanned >= APP_SCAN_TOTAL) { capped = true; break; }
      let before: string | null = null;
      let here = 0;
      for (;;) {
        const page = svc.store.browseMessages(key, before, 100);
        for (const m of page.messages) {
          if (!access.mayReadApp(key, m)) continue;
          const text = typeof m.text === 'string' ? m.text : '';
          const found = termMarks(text, terms);
          if (!found.all) continue;
          const at = isoOf(m.at);
          if (!at) continue;
          out.push(hitFrom({ ref: `app:${key.toLowerCase()}`, platform: 'app', title, messageId: m.eventId, at, fromUser: m.role === 'operator' }, text, found.marks));
        }
        here += page.messages.length;
        scanned += page.messages.length;
        before = page.nextBefore;
        if (!before) break;
        if (here >= perConversation || scanned >= APP_SCAN_TOTAL) { capped = true; break; }
      }
    }
  }

  // Telegram topics: the full-text index, restricted in SQL to the topics the caller can list.
  if (deps.telegramTopics && want('telegram')) {
    const topics = new Map<number, string | null>();
    for (const t of deps.telegramTopics()) {
      if (only && only !== `telegram:${t.topicId}`) continue;
      if (access.may(`telegram:${t.topicId}`)) topics.set(t.topicId, t.topicName ?? null);
    }
    if (topics.size > 0) {
      const tm = deps.topicMemory?.() ?? null;
      const rows = tm ? tm.searchKeyword(ftsMatchExpression(terms), [...topics.keys()], Math.min(150, q.limit * 3), HIGHLIGHT_OPEN, HIGHLIGHT_CLOSE) : null;
      if (rows === null) unsearched.push('telegram');
      for (const r of rows ?? []) {
        const at = isoOf(r.timestamp);
        if (!at || !Number.isSafeInteger(r.messageId)) continue;
        const shown = deviceTextForRow(r.text);
        const parsed = marksFromHighlight(r.marked);
        // The index's own spans when the text the phone sees is the indexed text; else the word matcher.
        const marks = parsed && parsed.text === shown ? parsed.marks : termMarks(shown, terms).marks;
        const messageId = deps.telegramHistoryId?.(r.topicId, r.messageId, r.fromUser) ?? `${r.fromUser ? 'in' : 'out'}:${r.messageId}`;
        out.push(hitFrom({ ref: `telegram:${r.topicId}`, platform: 'telegram', title: topics.get(r.topicId) ?? null, messageId, at, fromUser: r.fromUser }, shown, marks));
      }
    }
  }

  // Slack: the rows the history read serves, owner-only (one check for every Slack conversation).
  if (want('slack') && access.may('slack:')) {
    const slack = deps.slack?.() ?? null;
    const onlyId = only ? /^slack:([\w-]+):(-\d+)$/.exec(only) : null;
    if (slack && (!onlyId || onlyId[1] === self)) {
      let scanned = 0;
      for (const c of slack.conversations()) {
        if (onlyId && String(c.id) !== onlyId[2]) continue;
        if (scanned >= SLACK_SCAN_TOTAL) { capped = true; break; }
        const rows = slack.history(c.id, SLACK_ROWS_PER_CONVERSATION);
        if (rows.length >= SLACK_ROWS_PER_CONVERSATION) capped = true;
        scanned += rows.length;
        for (const r of rows) {
          const shown = slackDeviceText(r.text);
          const found = termMarks(shown, terms);
          if (!found.all) continue;
          const at = isoOf(r.at);
          if (!at) continue;
          out.push(hitFrom({ ref: `slack:${self}:${c.id}`, platform: 'slack', machine: self, title: c.title, messageId: r.eventId || `slack:${r.ts}`, at, fromUser: r.fromUser }, shown, found.marks));
        }
      }
    }
  }

  out.sort(compareHits);
  return { results: dedupeHits(out).slice(0, q.limit), capped, unsearched };
}

/** The same message from two sources or machines collapses to its first (best-ranked) copy. */
export function dedupeHits(hits: ReadonlyArray<ConversationSearchHit>): ConversationSearchHit[] {
  const seen = new Set<string>();
  const out: ConversationSearchHit[] = [];
  for (const h of hits) {
    const k = `${h.ref}|${h.messageId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(h);
  }
  return out;
}

/** A peer's hit, re-validated (peer output is untrusted display data). Null when anything is off. */
export function sanitizePeerHit(raw: unknown, machineId: string): ConversationSearchHit | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return null;
  const ref = canonicalConversationRef(r.ref);
  if (!ref) return null;
  const platform = ref.split(':')[0] as SearchPlatform;
  if (r.platform !== platform) return null;
  // A peer answers only for its own Slack conversations: their ids mean nothing elsewhere.
  if (platform === 'slack' && ref.split(':')[1] !== machineId) return null;
  if (typeof r.messageId !== 'string' || !POSITION_ID_RE.test(r.messageId)) return null;
  const at = typeof r.at === 'string' && r.at.length <= 40 ? isoOf(r.at) : null;
  if (!at || typeof r.fromUser !== 'boolean') return null;
  if (typeof r.snippet !== 'string' || r.snippet.length > 400) return null;
  if (!Array.isArray(r.marks) || r.marks.length > 64) return null;
  const marks: TextMark[] = [];
  for (const m of r.marks as unknown[]) {
    const x = m as Record<string, unknown> | null;
    if (!x || !Number.isSafeInteger(x.start) || !Number.isSafeInteger(x.length)) return null;
    const start = x.start as number, length = x.length as number;
    if (start < 0 || length <= 0 || start + length > r.snippet.length) return null;
    marks.push({ start, length });
  }
  const rank = typeof r.rank === 'number' && Number.isFinite(r.rank) ? r.rank : 0;
  const title = typeof r.title === 'string' ? r.title.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 128) : null;
  return {
    ref, platform, ...(platform === 'slack' ? { machine: machineId } : {}), title, messageId: r.messageId, at, fromUser: r.fromUser,
    snippet: r.snippet, marks, rank,
  };
}

/** Ask every peer for its own (non-pool) search with the agent's token. */
async function searchPeers(ctx: PoolReadCtx, path: string): Promise<{
  results: Array<{ machineId: string; body: Record<string, unknown> }>; failed: string[];
}> {
  const results: Array<{ machineId: string; body: Record<string, unknown> }> = [];
  const failed: string[] = [];
  const peers = (ctx.resolvePeerUrls?.() ?? []).slice(0, 16);
  const allow = (ctx.config.multiMachine as { peerUrlAllowlist?: string[] } | undefined)?.peerUrlAllowlist;
  await Promise.all(peers.map(async (p) => {
    if (!isPeerUrlAllowedForCredentials({ url: p.url, kind: p.kind }, allow).ok) { failed.push(p.machineId); return; }
    try {
      const r = await poolPeerFetch(ctx.recordRopeResult ?? undefined, p, path, {
        headers: { Authorization: `Bearer ${ctx.config.authToken}`, ...(ctx.config.projectName ? { 'X-Instar-AgentId': ctx.config.projectName } : {}) },
        signal: AbortSignal.timeout(POOL_TIMEOUT_MS), redirect: 'manual',
      });
      const text = await r.text();
      if (Buffer.byteLength(text) > MAX_POOL_BYTES) { failed.push(p.machineId); return; }
      const body = JSON.parse(text) as Record<string, unknown>;
      // The conversation is not on that machine: nothing there, not a failure. Any other refusal
      // (an older machine without this route, search off there) means its messages were not searched.
      if (r.status === 404 && body.error === 'unknown-conversation') return;
      if (!r.ok) { failed.push(p.machineId); return; }
      results.push({ machineId: p.machineId, body });
    } catch { // @silent-fallback-ok — a dark peer is named in failedMachines and the answer says partial
      failed.push(p.machineId);
    }
  }));
  return { results, failed };
}

export function createConversationSearchRouter(deps: ConversationSearchRouteDeps): Router {
  const router = Router();
  router.get('/mobile/conversations/search', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!deps.pairing.enabled() || !deps.service) { res.status(503).json({ error: 'native-conversations-off', detail: 'App conversations are turned off on this agent.' }); return; }
    if (!isConversationSearchEnabled(deps.config)) { res.status(503).json({ error: 'search-off', detail: 'Searching conversations is turned off on this agent.' }); return; }
    const kind = principalOf(req).kind;
    if (kind !== 'device' && kind !== 'token') { res.status(403).json({ error: 'operator-device-required' }); return; }
    const mode = req.query.mode === undefined ? 'keyword' : req.query.mode;
    if (mode !== 'keyword') { res.status(400).json({ error: 'mode-unsupported', detail: 'Only keyword search is available on this agent.' }); return; }
    if (req.query.scope !== undefined && req.query.scope !== 'pool') { res.status(400).json({ error: 'invalid-scope' }); return; }
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (query.length < 1 || query.length > MAX_QUERY_CHARS) { res.status(400).json({ error: 'bad-query', detail: 'Type 1-200 characters to search for.' }); return; }
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(MAX_LIMIT, Math.floor(rawLimit)) : DEFAULT_LIMIT;
    let only: string | null = null;
    if (req.query.ref !== undefined) {
      only = canonicalConversationRef(req.query.ref);
      if (!only) { res.status(400).json({ error: 'bad-ref', detail: 'ref must be app:<uuid>, telegram:<topic id> or slack:<machine>:<id>.' }); return; }
    }
    const pool = req.query.scope === 'pool';
    const person = devicePersonOf(req);
    const may = (accessKey: string) => deviceMayUse(deps.pairing, req, accessKey);
    if (only) {
      if (!may(accessKeyOf(only))) { res.status(404).json({ error: 'unknown-conversation' }); return; }
      // A conversation this machine does not hold is a 404 here; a pool read asks the others too.
      if (!pool && !heldHere(deps, only)) { res.status(404).json({ error: 'unknown-conversation' }); return; }
    }
    const terms = searchTerms(query);
    let local: LocalSearchResult;
    try {
      local = searchLocal(deps, { terms, limit, only }, { may, mayReadApp: (key, m) => deps.pairing.mayReadStored(person, key, m) });
    } catch (err) {
      deps.service.deps.reportDegradation?.('AppConversations.search', err instanceof Error ? err.message : String(err));
      res.status(503).json({ error: 'search-unavailable', detail: 'Search could not read the conversations right now. Try again shortly.' });
      return;
    }
    const base = { query, mode: 'keyword' as const, ref: only };
    // A team phone reads what this machine holds (as the list does): a peer's rows cannot be judged here.
    if (!pool || person?.role === 'team' || terms.length === 0 || !deps.pool) {
      res.json({ ...base, results: local.results, partial: local.capped || local.unsearched.length > 0, failedMachines: [], capped: local.capped, unsearched: local.unsearched });
      return;
    }
    const path = `/mobile/conversations/search?mode=keyword&limit=${limit}&q=${encodeURIComponent(query)}${only ? `&ref=${encodeURIComponent(only)}` : ''}`;
    const peers = await searchPeers(deps.pool, path);
    let capped = local.capped;
    const unsearched = new Set<SearchPlatform>(local.unsearched);
    const all: ConversationSearchHit[] = [...local.results];
    for (const p of peers.results) {
      if (p.body.capped === true) capped = true;
      for (const u of Array.isArray(p.body.unsearched) ? p.body.unsearched : []) if (u === 'app' || u === 'telegram' || u === 'slack') unsearched.add(u);
      for (const raw of Array.isArray(p.body.results) ? p.body.results.slice(0, MAX_LIMIT) : []) {
        const h = sanitizePeerHit(raw, p.machineId);
        // Judged on THIS machine: an app conversation not replicated here is not shown to a phone that needs its owner record (fail closed).
        if (h && may(accessKeyOf(h.ref))) all.push(h);
      }
    }
    // Local hits sort ahead of an equal peer copy, so the dedupe keeps this machine's row.
    const ordered = all.map((h, i) => ({ h, i })).sort((a, b) => compareHits(a.h, b.h) || a.i - b.i).map((x) => x.h);
    const results = dedupeHits(ordered).slice(0, limit);
    const failedMachines = [...new Set(peers.failed)].sort();
    res.json({ ...base, results, partial: failedMachines.length > 0 || capped || unsearched.size > 0, failedMachines, capped, unsearched: [...unsearched] });
  });
  return router;
}

/** Does this machine hold the conversation a ref names? */
function heldHere(deps: ConversationSearchRouteDeps, ref: string): boolean {
  if (ref.startsWith('app:')) return !!deps.service?.liveConversation(ref.slice(4));
  if (ref.startsWith('telegram:')) return (deps.telegramTopics?.() ?? []).some((t) => `telegram:${t.topicId}` === ref);
  const m = /^slack:([\w-]+):(-\d+)$/.exec(ref);
  if (!m || m[1] !== deps.machineId()) return false;
  return (deps.slack?.()?.conversations() ?? []).some((c) => String(c.id) === m[2]);
}
