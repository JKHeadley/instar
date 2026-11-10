/**
 * Instar Documents — the deterministic fold of a document's rows (spec §3.4).
 *
 * Any machine holding the same rows reaches the same state, whatever order they arrived in:
 *   - order is topological over `docDeps` (a row comes after every document row it had seen),
 *     ties broken by origin then seq; wall-clock time never orders rows;
 *   - visibility is decided per reader from immutable stamps only (the move as disclosure,
 *     rows concurrent with a move withheld, the team 2b rule for rows after it, place
 *     disclosures for later grantees, and a cascade so a withheld row's dependants are withheld).
 */
import { commentKeyOf, rowKeyOf, streamOf, type AnchorRef, type CommentKey, type ConversationRef, type DocRow, type RowKey, type Vector } from './rows.js';

// ── Ordering ────────────────────────────────────────────────────────────────────────────

/** Did `by` see `row`? Same stream: earlier seq. Otherwise its docDeps names the row. */
export function docSaw(by: DocRow, row: DocRow): boolean {
  const s = streamOf(row);
  if (streamOf(by) === s) return row.seq < by.seq;
  return (by.docDeps[s] ?? 0) >= row.seq;
}

const tieKey = (r: DocRow): string => `${r.origin}\u0000${r.incarnation}\u0000${String(r.seq).padStart(15, '0')}`;

/** Deterministic topological order. Rows that only conflict are ordered by origin, then seq. */
export function orderRows(rows: ReadonlyArray<DocRow>): DocRow[] {
  const unique = new Map<RowKey, DocRow>();
  for (const r of rows) if (!unique.has(rowKeyOf(r))) unique.set(rowKeyOf(r), r);
  const all = [...unique.values()].sort((a, b) => (tieKey(a) < tieKey(b) ? -1 : tieKey(a) > tieKey(b) ? 1 : 0));
  const placed: DocRow[] = [];
  const done = new Set<RowKey>();
  // O(n²) by design: documents are small, and the fold runs on one document at a time (§5.1).
  while (placed.length < all.length) {
    let progressed = false;
    for (const r of all) {
      if (done.has(rowKeyOf(r))) continue;
      const ready = all.every((o) => o === r || done.has(rowKeyOf(o)) || !docSaw(r, o));
      if (ready) { placed.push(r); done.add(rowKeyOf(r)); progressed = true; break; }
    }
    if (!progressed) {
      // A cycle can only come from inconsistent vectors; fall back to tie order for the rest.
      for (const r of all) if (!done.has(rowKeyOf(r))) { placed.push(r); done.add(rowKeyOf(r)); }
    }
  }
  return placed;
}

// ── Readers and visibility ─────────────────────────────────────────────────────────────

/** A reader's grant on the document's current place, as team 2b stamps it. */
export interface ReaderGrant { stream: string; seq: number; grantRowKey: string }

export type Reader =
  | { kind: 'owner' }
  /** The place's own audience as a whole (a confined session, or the "existing audience"). */
  | { kind: 'place' }
  /** A person reading in their own conversation: no grant involved, everything the place sees. */
  | { kind: 'own-conversation'; personKey: string }
  /** A person reading by grant: the team 2b rule applies to rows after the move. */
  | { kind: 'person'; personKey: string; grants: ReadonlyArray<ReaderGrant> };

/** Rows that depend on another row for their meaning (§3.4 cascade). */
function dependsOn(r: DocRow): CommentKey | null {
  switch (r.eventKind) {
    case 'reply': case 'comment-edit': case 'comment-reanchor': case 'resolve': case 'reopen': return r.commentKey;
    default: return null;
  }
}

function covers(heads: Vector, r: DocRow): boolean {
  return (heads[streamOf(r)] ?? 0) >= r.seq;
}

/**
 * Which rows may this reader see? Decided only from facts that never change.
 * `ordered` must be the output of `orderRows`.
 */
export function visibleRows(ordered: ReadonlyArray<DocRow>, reader: Reader): Set<RowKey> {
  const keys = new Set<RowKey>();
  if (reader.kind === 'owner') { for (const r of ordered) keys.add(rowKeyOf(r)); return keys; }

  // The current primary is the last primary-set in order (or `created`).
  let currentPrimaryRow: DocRow | null = null;
  for (const r of ordered) if (r.eventKind === 'created' || r.eventKind === 'primary-set') currentPrimaryRow = r;
  if (!currentPrimaryRow) return keys;
  const currentKey = rowKeyOf(currentPrimaryRow);
  const disclosed = currentPrimaryRow.eventKind === 'primary-set' ? currentPrimaryRow.docDepsSigned : null;

  // Step 1: what the place's existing audience sees. Rows the owner's signed move discloses are
  // visible to the whole new audience without the 2b check (the move IS their disclosure).
  const placeVisible = new Set<RowKey>();
  const disclosedByMove = new Set<RowKey>();
  for (const r of ordered) {
    const k = rowKeyOf(r);
    const underCurrent = k === currentKey || r.primaryRow === currentKey
      || (currentPrimaryRow.eventKind === 'created' && r.primaryRow === null);
    // Rows before the move are visible only as far as the owner's signed disclosure names them;
    // rows authorised under an older primary and not named are concurrent with the move: withheld.
    const movedIn = disclosed !== null && (k === currentKey || covers(disclosed, r));
    if (movedIn) disclosedByMove.add(k);
    if (underCurrent || movedIn) placeVisible.add(k);
  }

  // Step 2: narrow to this reader (team 2b rule + place disclosures).
  let base = placeVisible;
  if (reader.kind === 'person') {
    const disclosures = ordered.filter((r) => r.eventKind === 'place-disclosure' && placeVisible.has(rowKeyOf(r)));
    base = new Set<RowKey>();
    for (const r of ordered) {
      const k = rowKeyOf(r);
      if (!placeVisible.has(k)) continue;
      if (disclosedByMove.has(k)) { base.add(k); continue; }
      if (r.actor.type === 'person' && r.actor.personKey === reader.personKey) { base.add(k); continue; }
      const stamp = r.actor.type === 'agent' ? (r.sessionAccess ?? r.access) : r.access;
      const knew = reader.grants.some((g) => (stamp[g.stream] ?? 0) >= g.seq);
      const disclosedToGrant = disclosures.some((d) => d.eventKind === 'place-disclosure'
        && reader.grants.some((g) => g.grantRowKey === d.grantRow) && covers(d.heads, r));
      if (knew || disclosedToGrant) base.add(k);
    }
  }

  // Step 3: cascade — a withheld comment withholds everything that depends on it.
  const commentRow = new Map<CommentKey, RowKey>();
  for (const r of ordered) if (r.eventKind === 'comment') commentRow.set(commentKeyOf(authorKeyOf(r), r.commentId), rowKeyOf(r));
  for (const r of ordered) {
    const k = rowKeyOf(r);
    if (!base.has(k)) continue;
    const dep = dependsOn(r);
    if (dep !== null) {
      const parent = commentRow.get(dep);
      if (!parent || !base.has(parent)) continue;
    }
    keys.add(k);
  }
  return keys;
}

export function authorKeyOf(r: DocRow): string {
  switch (r.actor.type) {
    case 'person': return r.actor.personKey;
    case 'owner-phone': return 'owner';
    // Agent rows from different places must never collide on comment keys.
    case 'agent': return `agent.${r.actor.placeKey.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)}`;
    default: return 'machine';
  }
}

// ── State ──────────────────────────────────────────────────────────────────────────────

export interface VersionState {
  versionId: string;
  label: number;
  parents: string[];
  contentHash: string;
  projectionVersion: number;
  chunkCount: number;
  chunks: Array<string | undefined>;
  noteHash?: string;
  addressesHash?: string;
  author: string;
  rowKey: RowKey;
  pruned: boolean;
}

export interface CommentState {
  key: CommentKey;
  author: string;
  anchor: AnchorRef;
  onVersion: string;
  /** Body revisions, oldest first: the comment row, then each edit. */
  revisions: Array<{ bodyHash: string; rowKey: RowKey }>;
  replies: Array<{ replyId: string; author: string; bodyHash: string; rowKey: RowKey }>;
  resolved: boolean;
  addressedIn: string[];
  rowKey: RowKey;
}

export interface DocState {
  docId: string;
  titleHash: string | null;
  ownerPerson: string;
  primary: ConversationRef | null;
  primaryRowKey: RowKey | null;
  createdFrom: string | null;
  everSharedPrimaries: ConversationRef[];
  versions: Map<string, VersionState>;
  /** Version ids in fold order; `latest` is the last complete, unpruned one. */
  versionOrder: string[];
  comments: Map<CommentKey, CommentState>;
  links: Map<string, { to: string; kind: string; reasonHash?: string }>;
  sends: Array<{ batchId: string; coveredHash: string; author: string; primaryRow: RowKey; rowKey: RowKey }>;
  tombstoned: boolean;
  purged: boolean;
  docSaltHash: string | null;
}

export function emptyState(docId: string): DocState {
  return {
    docId, titleHash: null, ownerPerson: 'owner', primary: null, primaryRowKey: null, createdFrom: null,
    everSharedPrimaries: [], versions: new Map(), versionOrder: [], comments: new Map(), links: new Map(),
    sends: [], tombstoned: false, purged: false, docSaltHash: null,
  };
}

/**
 * Fold the rows this reader may see into state. Rows must already be structurally valid,
 * signature-checked and standing-checked (store.ts does that on ingest).
 */
export function foldDocument(docId: string, rows: ReadonlyArray<DocRow>, reader: Reader): DocState {
  const ordered = orderRows(rows.filter((r) => r.docId === docId));
  const visible = visibleRows(ordered, reader);
  const s = emptyState(docId);
  for (const r of ordered) {
    if (!visible.has(rowKeyOf(r))) continue;
    applyRow(s, r);
  }
  return s;
}

function applyRow(s: DocState, r: DocRow): void {
  const k = rowKeyOf(r);
  const author = authorKeyOf(r);
  switch (r.eventKind) {
    case 'created':
      if (s.primaryRowKey) return; // one created row per document; later ones are ignored
      s.titleHash = r.titleHash; s.ownerPerson = r.ownerPerson; s.primary = r.primary; s.primaryRowKey = k;
      s.createdFrom = r.createdFrom; s.docSaltHash = r.docSaltHash; return;
    case 'primary-set':
      if (s.primary && !s.everSharedPrimaries.includes(s.primary)) s.everSharedPrimaries.push(s.primary);
      s.primary = r.primary; s.primaryRowKey = k; return;
    case 'version': {
      if (s.versions.has(r.versionId)) return;
      s.versions.set(r.versionId, {
        versionId: r.versionId, label: r.label, parents: r.parents, contentHash: r.contentHash,
        projectionVersion: r.projectionVersion, chunkCount: r.chunks, chunks: new Array(r.chunks).fill(undefined),
        noteHash: r.noteHash, addressesHash: r.addressesHash, author, rowKey: k, pruned: false,
      });
      s.versionOrder.push(r.versionId);
      return;
    }
    case 'version-chunk': {
      const v = s.versions.get(r.versionId);
      if (v && r.index < v.chunkCount && v.chunks[r.index] === undefined) v.chunks[r.index] = r.payloadHash;
      return;
    }
    case 'comment': {
      const key = commentKeyOf(author, r.commentId);
      if (s.comments.has(key)) return;
      s.comments.set(key, { key, author, anchor: r.anchor, onVersion: r.onVersion, revisions: [{ bodyHash: r.bodyHash, rowKey: k }], replies: [], resolved: false, addressedIn: [], rowKey: k });
      return;
    }
    case 'comment-edit': {
      const c = s.comments.get(r.commentKey);
      if (c && c.author === author) c.revisions.push({ bodyHash: r.bodyHash, rowKey: k });
      return;
    }
    case 'comment-reanchor': {
      const c = s.comments.get(r.commentKey);
      if (c && c.author === author) { c.anchor = r.anchor; c.onVersion = r.onVersion; }
      return;
    }
    case 'reply': {
      const c = s.comments.get(r.commentKey);
      if (c && !c.replies.some((x) => x.replyId === r.replyId)) c.replies.push({ replyId: r.replyId, author, bodyHash: r.bodyHash, rowKey: k });
      return;
    }
    case 'resolve': case 'reopen': {
      const c = s.comments.get(r.commentKey);
      if (!c) return;
      const allowed = author === c.author || author === 'owner' || author === s.ownerPerson;
      if (allowed) c.resolved = r.eventKind === 'resolve';
      return;
    }
    case 'addressed': return; // the comment list lives in a blob; the store resolves it (addressedIn)
    case 'send':
      if (!s.sends.some((x) => x.batchId === r.batchId)) s.sends.push({ batchId: r.batchId, coveredHash: r.coveredHash, author, primaryRow: r.primaryRow, rowKey: k });
      return;
    case 'link': s.links.set(`${r.kind}|${r.to}`, { to: r.to, kind: r.kind, reasonHash: r.reasonHash }); return;
    case 'unlink': s.links.delete(`${r.kind}|${r.to}`); return;
    case 'title': s.titleHash = r.titleHash; return;
    case 'tombstone': s.tombstoned = true; return;
    case 'purge': s.purged = true; return;
    case 'prune': for (const id of r.versionIds) { const v = s.versions.get(id); if (v) v.pruned = true; } return;
    case 'place-disclosure': case 'device-seen': return;
  }
}

/** A version is shown only when every chunk is held and its hash matches (checked by the store). */
export function isComplete(v: VersionState): boolean {
  return !v.pruned && v.chunks.every((c) => c !== undefined);
}

/** The latest complete version: the last in fold order. */
export function latestVersion(s: DocState): VersionState | null {
  for (let i = s.versionOrder.length - 1; i >= 0; i--) {
    const v = s.versions.get(s.versionOrder[i])!;
    if (isComplete(v)) return v;
  }
  return null;
}

/** Concurrent heads: versions no other version names as a parent (§3.4 "edits at the same time"). */
export function versionHeads(s: DocState): VersionState[] {
  const parents = new Set<string>();
  for (const v of s.versions.values()) for (const p of v.parents) parents.add(p);
  return [...s.versions.values()].filter((v) => !parents.has(v.versionId) && !v.pruned);
}

/** The stable label for a new version: one more than the highest label it descends from (§3.4). */
export function nextLabel(s: DocState, parents: ReadonlyArray<string>): number {
  let max = 0;
  for (const p of parents) max = Math.max(max, s.versions.get(p)?.label ?? 0);
  if (parents.length === 0) for (const v of s.versions.values()) max = Math.max(max, v.label);
  return max + 1;
}
