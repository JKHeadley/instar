/**
 * Instar Documents — the service the routes call (spec §3.4–3.9).
 *
 * It turns a principal's request into rows and blobs through the store, applying `mayDoDocument`
 * on every call, and assembles what a principal may read (text, comments, versions, compare,
 * links). It never decides anything a route hasn't authenticated: routes resolve the principal
 * (device signature, session token, bearer, cookie) and the team view, and pass them in.
 */
import crypto from 'node:crypto';
import { mayDoDocument, type DocFacts, type DocOp, type Principal, type TeamView } from './access.js';
import { reanchor, makeQuote, verifyQuote, type Anchor, type Quote } from './anchor.js';
import { blobHash, listHash, newSalt, textToBlobs, type Blob } from './blobs.js';
import { chunkText } from './chunker.js';
import { diffWords, type DiffOp } from './diff.js';
import { foldDocument, latestVersion, nextLabel, versionHeads, type CommentState, type DocState, type Reader, type VersionState } from './fold.js';
import { PROJECTION_VERSION, projectText } from './projection.js';
import { WRITE_DEFAULTS, commentKeyOf, isConversationRef, isNodeRef, isUuid, rowKeyOf, type Actor, type ConversationRef, type LinkKind, type NodeRef, type Vector } from './rows.js';
import type { DocumentStore } from './store.js';

export class DocError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) { super(message ?? code); }
}
const notFound = (): DocError => new DocError(404, 'unknown-document');

/** Who is calling, resolved by the route, plus how to stamp the row it writes. */
export interface Caller {
  principal: Principal;
  actor: Actor;
  /** The team-log vector this machine decides under (head of its folded team log). */
  access: Vector;
  /** For agent sessions: the session's launch-time vector. */
  sessionAccess?: Vector;
  /** How this reader's visibility is judged (fold.ts). */
  reader: Reader;
  /** A display name for the author, shown to other readers. */
  displayName?: string;
}

export interface Limits { titleChars: number; commentBytes: number }

export class DocumentService {
  constructor(private readonly store: DocumentStore, private readonly team: TeamView, private readonly limits: Limits = { titleChars: WRITE_DEFAULTS.titleChars, commentBytes: WRITE_DEFAULTS.commentBytes }) {}

  // ── Reading ─────────────────────────────────────────────────────────────────────────

  /** The owner's full view, used for access decisions (never returned to a caller as-is). */
  private ownerState(docId: string): DocState { return foldDocument(docId, this.store.rowsOf(docId), { kind: 'owner' }); }

  facts(docId: string): DocFacts | null {
    if (!isUuid(docId)) return null;
    const s = this.ownerState(docId);
    if (!s.primary) return null;
    return {
      primary: s.primary, ownerPerson: s.ownerPerson,
      everShared: s.everSharedPrimaries.some((p) => !this.team.ownerOnly(p)) || !this.team.ownerOnly(s.primary),
      tombstoned: s.tombstoned, purged: s.purged || this.store.isPurged(docId),
    };
  }

  private require(docId: string, caller: Caller, op: DocOp): DocFacts {
    const f = this.facts(docId);
    if (!f) throw notFound();
    const d = mayDoDocument(caller.principal, f, op, this.team);
    if (!d.ok) {
      // Standing refusals that only make sense after read standing was confirmed (§3.2).
      if (d.reason === 'access-being-checked' && mayDoDocument(caller.principal, f, 'read', this.team).ok) throw new DocError(403, 'access-being-checked');
      throw notFound();
    }
    return f;
  }

  /** Metadata only: what owner-reach callers get for documents they can't read (§3.3). */
  metadata(docId: string, caller: Caller): { id: string; primary: ConversationRef; version: number | null; openComments: number; title: string | null } {
    const f = this.require(docId, caller, 'read-metadata');
    const s = this.ownerState(docId);
    const canRead = mayDoDocument(caller.principal, f, 'read', this.team).ok;
    const latest = latestVersion(s);
    const open = [...s.comments.values()].filter((c) => !c.resolved).length;
    return { id: docId, primary: f.primary, version: latest?.label ?? null, openComments: open, title: canRead ? this.textOf(docId, s.titleHash) : null };
  }

  /** The document as this caller may see it: latest visible complete version, its text. */
  read(docId: string, caller: Caller, versionId?: string): { id: string; title: string | null; version: VersionState | null; markdown: string | null; heads: VersionState[]; state: DocState } {
    this.require(docId, caller, 'read');
    const s = foldDocument(docId, this.store.rowsOf(docId), caller.reader);
    const v = versionId ? s.versions.get(versionId) ?? null : latestVersion(s);
    const markdown = v ? this.versionText(docId, v) : null;
    return { id: docId, title: this.textOf(docId, s.titleHash), version: v, markdown, heads: versionHeads(s), state: s };
  }

  /** Comments with quotes, re-anchored onto the latest version, for the agent and the page. */
  comments(docId: string, caller: Caller, status: 'open' | 'resolved' | 'all' = 'open'): Array<{
    key: string; author: string; quote: string | null; body: string | null; anchorState: 'ok' | 'edited' | 'orphaned'; start?: number; end?: number;
    resolved: boolean; replies: Array<{ author: string; body: string | null }>; onVersion: string;
  }> {
    const r = this.read(docId, caller);
    const latest = r.version;
    const latestText = latest && r.markdown !== null ? projectText(r.markdown, latest.projectionVersion).text : null;
    const out = [];
    for (const c of r.state.comments.values()) {
      if (status === 'open' && c.resolved) continue;
      if (status === 'resolved' && !c.resolved) continue;
      out.push({ ...this.placeComment(docId, r.state, c, latest, latestText), key: c.key, author: c.author, body: this.textOf(docId, c.revisions[c.revisions.length - 1].bodyHash), resolved: c.resolved, replies: c.replies.map((x) => ({ author: x.author, body: this.textOf(docId, x.bodyHash) })), onVersion: c.onVersion });
    }
    return out;
  }

  private placeComment(docId: string, s: DocState, c: CommentState, latest: VersionState | null, latestText: string | null): { quote: string | null; anchorState: 'ok' | 'edited' | 'orphaned'; start?: number; end?: number } {
    const anchorBlob = this.store.getBlob(docId, c.anchor.anchorHash);
    const quote = anchorBlob ? (JSON.parse(anchorBlob.text) as Quote) : null;
    if (!quote) return { quote: null, anchorState: 'orphaned' };
    if (!latest || latestText === null || latest.versionId === c.onVersion) return { quote: quote.exact, anchorState: 'ok', start: c.anchor.start, end: c.anchor.end };
    const onV = s.versions.get(c.onVersion);
    const oldMd = onV ? this.versionText(docId, onV) : null;
    if (oldMd === null || !onV) return { quote: quote.exact, anchorState: 'orphaned' };
    const oldText = projectText(oldMd, onV.projectionVersion).text;
    const anchor: Anchor = { quote, start: c.anchor.start, end: c.anchor.end };
    const res = reanchor(oldText, latestText, anchor);
    return { quote: res.exact ?? quote.exact, anchorState: res.state, start: res.start, end: res.end };
  }

  /** Word-level compare of two versions (§3.5). */
  compare(docId: string, caller: Caller, from: string, to: string): { ops: DiffOp[]; truncated: boolean } {
    const r = this.read(docId, caller);
    const a = r.state.versions.get(from); const b = r.state.versions.get(to);
    if (!a || !b) throw new DocError(404, 'unknown-version');
    const ta = this.versionText(docId, a); const tb = this.versionText(docId, b);
    if (ta === null || tb === null) throw new DocError(409, 'version-text-unavailable', 'This version\'s text was removed or is still arriving.');
    return diffWords(projectText(ta, a.projectionVersion).text, projectText(tb, b.projectionVersion).text);
  }

  // ── Writing ─────────────────────────────────────────────────────────────────────────

  /** Create a document in a conversation; the caller's own conversation by default (§3.9). */
  create(caller: Caller, input: { title: string; markdown: string; primary: ConversationRef; createdFrom?: NodeRef; ownerPerson?: string }): { id: string; versionId: string } {
    if (!isConversationRef(input.primary)) throw new DocError(400, 'bad-primary');
    if (caller.principal.kind === 'agent' && !caller.principal.ownerReach && !this.team.sessionInPlace(caller.principal.placeKey, input.primary)) throw new DocError(409, 'primary-wider-than-caller');
    if ((caller.principal.kind === 'bearer' || (caller.principal.kind === 'agent' && caller.principal.ownerReach)) && !this.team.ownerOnly(input.primary)) {
      throw new DocError(409, 'primary-wider-than-caller', 'Only your phone can put a document into a shared conversation.');
    }
    if (caller.principal.kind === 'pin-session' || caller.principal.kind === 'msp') throw new DocError(403, 'not-allowed');
    const title = this.cleanTitle(input.title);
    const id = crypto.randomUUID();
    const docSalt = newSalt();
    const saltHash = this.store.putBlob(id, { salt: newSalt(), text: docSalt })!;
    const titleHash = this.putText(id, title);
    const createdRow = this.store.append(id, {
      eventKind: 'created', titleHash, ownerPerson: input.ownerPerson ?? 'owner', primary: input.primary,
      createdFrom: input.createdFrom && isNodeRef(input.createdFrom) ? input.createdFrom : input.primary, docSaltHash: saltHash,
    }, this.header(caller, null));
    const versionId = this.writeVersion(id, caller, rowKeyOf(createdRow), docSalt, input.markdown, [], undefined, []);
    return { id, versionId };
  }

  /** Write a new version (§3.5): content-defined chunks under the document's salt. */
  revise(docId: string, caller: Caller, input: { markdown: string; note?: string; addresses?: string[]; parents?: string[] }): { versionId: string; label: number } {
    this.require(docId, caller, 'revise');
    const s = this.ownerState(docId);
    const docSalt = this.docSalt(docId, s);
    const parents = input.parents?.filter((p) => s.versions.has(p)) ?? versionHeads(s).map((v) => v.versionId);
    const versionId = this.writeVersion(docId, caller, s.primaryRowKey, docSalt, input.markdown, parents, input.note, input.addresses ?? []);
    return { versionId, label: this.ownerState(docId).versions.get(versionId)!.label };
  }

  private writeVersion(docId: string, caller: Caller, primaryRow: string | null, docSalt: string, markdown: string, parents: string[], note: string | undefined, addresses: string[]): string {
    const s = this.ownerState(docId);
    const chunks = chunkText(markdown);
    const hashes = chunks.map((text) => this.store.putBlob(docId, { salt: docSalt, text })!);
    const versionId = crypto.randomUUID();
    const header = this.header(caller, primaryRow);
    this.store.append(docId, {
      eventKind: 'version', versionId, label: nextLabel(s, parents), parents,
      contentHash: crypto.createHash('sha256').update(markdown, 'utf8').digest('hex'), projectionVersion: PROJECTION_VERSION, chunks: hashes.length,
      ...(note ? { noteHash: this.putText(docId, note) } : {}),
      ...(addresses.length ? { addressesHash: this.putList(docId, addresses) } : {}),
    }, header);
    hashes.forEach((payloadHash, index) => this.store.append(docId, { eventKind: 'version-chunk', versionId, index, payloadHash }, header));
    if (addresses.length && caller.actor.type === 'agent') {
      this.store.append(docId, { eventKind: 'addressed', commentKeysHash: this.putList(docId, addresses), versionId }, header);
    }
    return versionId;
  }

  /** Comment on a passage. The quote is cut from the version's projection, never sent by the page (§3.5). */
  comment(docId: string, caller: Caller, input: { commentId?: string; onVersion: string; start: number; end: number; body: string }): { key: string } {
    this.require(docId, caller, 'comment');
    this.checkBody(input.body);
    const s = this.ownerState(docId);
    const v = s.versions.get(input.onVersion);
    const md = v ? this.versionText(docId, v) : null;
    if (!v || md === null) throw new DocError(404, 'unknown-version');
    const text = projectText(md, v.projectionVersion).text;
    if (!(input.start >= 0 && input.end > input.start && input.end <= text.length)) throw new DocError(422, 'quote-not-in-document');
    const quote = makeQuote(text, input.start, input.end);
    const placed = verifyQuote(text, quote, input.start, input.end);
    if (!placed) throw new DocError(422, 'quote-not-in-document');
    const commentId = input.commentId && isUuid(input.commentId) ? input.commentId : crypto.randomUUID();
    const anchorHash = this.putText(docId, JSON.stringify(quote));
    const header = this.header(caller, s.primaryRowKey);
    this.store.append(docId, {
      eventKind: 'comment', commentId, onVersion: input.onVersion, bodyHash: this.putText(docId, input.body),
      anchor: { anchorHash, start: placed.start, end: placed.end, blockHint: '' },
    }, header);
    return { key: commentKeyOf(this.authorKey(caller), commentId) };
  }

  reply(docId: string, caller: Caller, commentKey: string, body: string): { replyId: string } {
    this.require(docId, caller, 'reply');
    this.checkBody(body);
    const s = foldDocument(docId, this.store.rowsOf(docId), caller.reader);
    if (!s.comments.has(commentKey)) throw new DocError(404, 'unknown-comment');
    const replyId = crypto.randomUUID();
    this.store.append(docId, { eventKind: 'reply', commentKey, replyId, bodyHash: this.putText(docId, body) }, this.header(caller, this.ownerState(docId).primaryRowKey));
    return { replyId };
  }

  resolve(docId: string, caller: Caller, commentKey: string, resolved: boolean): void {
    const s = foldDocument(docId, this.store.rowsOf(docId), caller.reader);
    const c = s.comments.get(commentKey);
    if (!c) throw new DocError(404, 'unknown-comment');
    const own = c.author === this.authorKey(caller);
    this.require(docId, caller, own ? 'resolve-own' : 'resolve-any');
    this.store.append(docId, { eventKind: resolved ? 'resolve' : 'reopen', commentKey }, this.header(caller, this.ownerState(docId).primaryRowKey));
  }

  /** Record which comments a Send message covered (§3.8; the message itself goes through chat). */
  recordSend(docId: string, caller: Caller, input: { batchId: string; messageRequestId: string }): { covered: string[] } {
    this.require(docId, caller, 'send');
    const s = foldDocument(docId, this.store.rowsOf(docId), caller.reader);
    const author = this.authorKey(caller);
    const covered = [...s.comments.values()].filter((c) => c.author === author && !c.resolved).map((c) => `${c.key}@${c.revisions[c.revisions.length - 1].rowKey}`);
    this.store.append(docId, { eventKind: 'send', batchId: input.batchId, coveredHash: this.putList(docId, covered), primaryRow: s.primaryRowKey!, messageRequestId: input.messageRequestId }, this.header(caller, s.primaryRowKey));
    return { covered };
  }

  link(docId: string, caller: Caller, input: { to: NodeRef; kind: LinkKind; reason?: string }, targetVisible: (to: NodeRef) => boolean): void {
    this.require(docId, caller, 'link');
    if (!isNodeRef(input.to) || !targetVisible(input.to)) throw notFound();
    this.store.append(docId, { eventKind: 'link', to: input.to, kind: input.kind, ...(input.reason ? { reasonHash: this.putText(docId, input.reason.slice(0, WRITE_DEFAULTS.reasonChars)) } : {}) }, this.header(caller, this.ownerState(docId).primaryRowKey));
  }

  /** Documents whose primary is this conversation, filtered to what the caller may see (§3.7). */
  listForConversation(ref: ConversationRef, caller: Caller): Array<{ id: string; title: string | null; version: number | null; openComments: number }> {
    const out = [];
    for (const id of this.store.docIds()) {
      const f = this.facts(id);
      if (!f || f.primary !== ref) continue;
      if (!mayDoDocument(caller.principal, f, 'read-metadata', this.team).ok) continue;
      const m = this.metadata(id, caller);
      out.push({ id, title: m.title, version: m.version, openComments: m.openComments });
    }
    return out.sort((a, b) => b.openComments - a.openComments);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────────────

  private header(caller: Caller, primaryRow: string | null) {
    return { actor: caller.actor, access: caller.access, primaryRow, ...(caller.sessionAccess ? { sessionAccess: caller.sessionAccess } : {}) };
  }

  private authorKey(caller: Caller): string {
    const a = caller.actor;
    if (a.type === 'person') return a.personKey;
    if (a.type === 'owner-phone') return 'owner';
    if (a.type === 'agent') return `agent.${a.placeKey.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)}`;
    return 'machine';
  }

  private cleanTitle(t: string): string {
    // eslint-disable-next-line no-control-regex
    const clean = String(t ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (!clean) throw new DocError(400, 'title-required');
    if ([...clean].length > this.limits.titleChars) throw new DocError(400, 'title-too-long', `Titles are at most ${this.limits.titleChars} characters.`);
    return clean;
  }

  private checkBody(body: string): void {
    if (typeof body !== 'string' || !body.trim()) throw new DocError(400, 'body-required');
    if (Buffer.byteLength(body, 'utf8') > this.limits.commentBytes) throw new DocError(400, 'comment-too-long', 'This comment is too long. Split it into two.');
  }

  /** Store text under a fresh salt; returns the hash (or a list hash for multi-blob text). */
  private putText(docId: string, text: string): string {
    const blobs = textToBlobs(text, newSalt());
    if (blobs.length === 1) return this.store.putBlob(docId, blobs[0])!;
    const hashes = blobs.map((b) => this.store.putBlob(docId, b)!);
    return this.store.putBlob(docId, { salt: newSalt(), text: JSON.stringify({ parts: hashes }) })!;
  }

  private putList(docId: string, items: string[]): string { return this.putText(docId, JSON.stringify(items)); }

  private textOf(docId: string, hash: string | null | undefined): string | null {
    if (!hash) return null;
    const b = this.store.getBlob(docId, hash);
    if (!b) return null;
    if (b.text.startsWith('{"parts":')) {
      try {
        const parts = (JSON.parse(b.text) as { parts: string[] }).parts.map((h) => this.store.getBlob(docId, h)?.text);
        return parts.every((p) => p !== undefined) ? parts.join('') : null;
      } catch { return b.text; } // @silent-fallback-ok — text that only looks like a parts index is plain text
    }
    return b.text;
  }

  private docSalt(docId: string, s: DocState): string {
    const b = s.docSaltHash ? this.store.getBlob(docId, s.docSaltHash) : null;
    if (!b) throw new DocError(409, 'document-key-unavailable', 'This document\'s text was removed or is still arriving.');
    return b.text;
  }

  /** A version's markdown, only when every chunk is present and the content hash matches. */
  private versionText(docId: string, v: VersionState): string | null {
    if (v.pruned) return null;
    const parts: string[] = [];
    for (const h of v.chunks) {
      if (!h) return null;
      const b = this.store.getBlob(docId, h);
      if (!b) return null;
      parts.push(b.text);
    }
    const md = parts.join('');
    return crypto.createHash('sha256').update(md, 'utf8').digest('hex') === v.contentHash ? md : null;
  }
}

export { blobHash, listHash };
export type { Blob };
