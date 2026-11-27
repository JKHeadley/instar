/**
 * The old-link guarantee (docs/specs/instar-document-viewer.md §3.9b).
 *
 * While documents can serve on this agent, every NEW readable page is a document: the private
 * viewer refuses new pages (PrivateViewer.setNewViewGuard), the routes and jobs that made pages
 * make documents instead (publishAsDocument), and the tone gate is told when an outgoing message
 * still carries an old-style link (detectOldViewLink, SIGNAL ONLY). Links to existing pages keep
 * working. When documents cannot serve (switched off, no machine identity, no permanent address,
 * no owner conversation), nothing here changes anything and pages are made as before, so there is
 * always a way to share.
 */
import { isConversationRef, type ConversationRef, type Vector } from './rows.js';
import { DocError, type Caller, type DocumentService } from './service.js';
import { isDocumentsEnabled } from './gate.js';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';

export interface ReadablePageDeps {
  config: () => unknown;
  service: () => DocumentService | null;
  teamVector: () => Vector;
  /** The owner's own conversation: where a page with no better home becomes a document. */
  ownerConversation: () => ConversationRef | null;
  /** The permanent address documents open on; null when there is none. */
  linkOrigin?: () => string | null;
}

/** Why documents do or do not replace pages right now. Only `replace` changes behavior. */
export type ReplaceVerdict = 'replace' | 'documents-off' | 'no-service' | 'no-address' | 'no-owner-conversation' | 'fault';

export function replaceVerdict(d: ReadablePageDeps): ReplaceVerdict {
  if (!isDocumentsEnabled(d.config())) return 'documents-off';
  if (!d.service()) return 'no-service';
  const origin = d.linkOrigin ? d.linkOrigin() : null;
  if (!origin) return 'no-address';
  if (!d.ownerConversation()) return 'no-owner-conversation';
  return 'replace';
}

const faultsRecorded = new Set<string>();
/** The verdict, with a throw read as `fault` (pages keep working) and recorded once, so it shows in /docs/health and the evidence log. */
export function safeVerdict(d: ReadablePageDeps): ReplaceVerdict {
  try { return replaceVerdict(d); } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, 80);
    if (!faultsRecorded.has(reason) && faultsRecorded.size < 32) { faultsRecorded.add(reason); try { featureEvidence.record('documents', { kind: 'error', reason: `old-link guarantee check failed: ${reason}` }); } catch { /* @silent-fallback-ok: evidence is best-effort */ } }
    return 'fault';
  }
}

export function documentsReplaceViews(d: ReadablePageDeps): boolean {
  return safeVerdict(d) === 'replace';
}

/**
 * Whether a caller has a place a document could live (§3.9b item 3). Documents live in Telegram
 * and app conversations, so the agent itself (bearer), owner-reach and system sessions (scheduler,
 * lifeline, agent-to-agent: owner reach, no person) and any session whose place is a Telegram or
 * app place (a topic, a group, an app conversation) have one. Only a session whose place is
 * somewhere a document can't live (a Slack channel, another messaging service, or no place at all)
 * keeps making pages, so it is never left with no way to share.
 */
export function callerHasDocumentHome(session: { placeKey?: string | null; ownerReach: boolean } | null): boolean {
  if (!session || session.ownerReach) return true;
  const k = session.placeKey ?? '';
  return k.startsWith('telegram:') || k.startsWith('app:');
}

/** The agent itself, unconfined (the bearer principal POST /docs uses for the owner). */
function systemCaller(d: ReadablePageDeps): Caller {
  return { principal: { kind: 'bearer' }, actor: { type: 'agent', placeKey: 'owner-reach' }, access: d.teamVector(), reader: { kind: 'owner' } };
}

/**
 * Make a document for something the system itself writes (a triage list, a job report). It goes
 * into `preferred` when that conversation is the owner's alone, otherwise into the owner's own
 * conversation: the agent can never put a document into a shared conversation (§3.2). Returns
 * null when documents do not replace pages, so the caller makes a page as before.
 */
export function publishAsDocument(d: ReadablePageDeps, title: string, markdown: string, preferred?: ConversationRef | null, opts: { onlyPreferred?: boolean } = {}): { id: string; url: string; primary: ConversationRef } | null {
  if (!documentsReplaceViews(d)) return null;
  const svc = d.service()!;
  const origin = d.linkOrigin!()!;
  const caller = systemCaller(d);
  const owner = d.ownerConversation()!;
  const tryIn = (primary: ConversationRef) => ({ ...svc.create(caller, { title, markdown, primary, createdFrom: primary }), primary });
  let out: { id: string; versionId: string; primary: ConversationRef };
  if (preferred && isConversationRef(preferred) && preferred !== owner) {
    try { out = tryIn(preferred); } catch (err) {
      // Any refusal of the preferred conversation (shared, unknown to the team record yet, ...) falls
      // back to the owner's own; with onlyPreferred the caller gets null and links nothing.
      if (!(err instanceof DocError)) throw err;
      if (opts.onlyPreferred) return null;
      out = tryIn(owner);
    }
  } else {
    if (opts.onlyPreferred && preferred !== owner) return null;
    out = tryIn(owner);
  }
  return { id: out.id, url: `${origin}/docs/${out.id}`, primary: out.primary };
}

/** The current link to a system document that still exists, or null (deleted, or documents not replacing pages). */
export function systemDocumentLink(d: ReadablePageDeps, id: string): string | null {
  if (!documentsReplaceViews(d)) return null;
  try {
    const f = d.service()!.facts(id) as { tombstoned?: boolean; purged?: boolean } | null;
    if (!f || f.tombstoned || f.purged) return null;
    return `${d.linkOrigin!()!}/docs/${id}`;
  } catch { return null; /* @silent-fallback-ok: an unreadable record is treated as gone and the list is made again */ }
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** A link to an old-style page: any address whose path is /view/<uuid>, with an optional query. */
const OLD_VIEW_LINK = new RegExp(String.raw`(https?://([^\s/?#]+))?/view/(${UUID})(\?[^\s)>\]]*)?`, 'gi');
const SCAN_LIMIT = 16_000;
const SIG = /[?&]sig=([0-9a-f]{64})\b/i;

/** Whose page a link is, decided from facts, never guessed: its signature or its host. */
export type OldViewOwnership = 'this-agent' | 'unknown';

export interface OldViewLinkSignal {
  detected: boolean;
  /** The address (up to the page id, signature removed, bounded to 160 chars) of the link `ownership` describes: the first owned link, else the first link. */
  match?: string;
  /** `this-agent` when any link's signature verifies with this agent's key, or its host is one of this agent's own. */
  ownership?: OldViewOwnership;
}

/**
 * SIGNAL ONLY, no I/O: old-style page links in an outgoing message (first 16,000 characters).
 * Ownership is decided deterministically: `sigValid(path, sig)` checks a link's signature with this
 * agent's key, and `ownHosts` are this machine's own addresses. The judge never has to guess.
 */
export function detectOldViewLink(text: string, facts: { sigValid?: (viewPath: string, sig: string) => boolean; ownHosts?: string[] } = {}): OldViewLinkSignal {
  const t = String(text ?? '').slice(0, SCAN_LIMIT);
  const own = new Set((facts.ownHosts ?? []).map((h) => h.toLowerCase()));
  let first: string | undefined;
  let owned: string | undefined;
  for (const m of t.matchAll(OLD_VIEW_LINK)) {
    const addr = m[0].replace(/\?.*$/, '').slice(0, 160);
    if (first === undefined) first = addr;
    // Host without userinfo or port, so http://localhost:4040 matches localhost.
    const host = (m[2] ?? '').toLowerCase().replace(/^.*@/, '').replace(/:\d+$/, '');
    const sig = SIG.exec(m[4] ?? '')?.[1];
    // A bare /view/<id> path (at the start or after a space or bracket) is relative to this agent's own
    // server; one glued to other text is part of some other address, whose owner is unknown.
    const before = m.index ? t[m.index - 1] : '';
    const bare = !m[1] && (before === '' || /[\s(<[\]"'`]/.test(before));
    let mine = bare || (!!m[1] && own.has(host));
    if (!mine && sig && facts.sigValid) { try { mine = facts.sigValid(`/view/${m[3].toLowerCase()}`, sig.toLowerCase()); } catch { mine = false; /* @silent-fallback-ok: an unverifiable signature stays unknown */ } }
    if (mine) { owned = addr; break; }
  }
  // The match and its ownership always describe the same link: an owned link when there is one.
  if (first === undefined) return { detected: false };
  return owned !== undefined ? { detected: true, match: owned, ownership: 'this-agent' } : { detected: true, match: first, ownership: 'unknown' };
}
