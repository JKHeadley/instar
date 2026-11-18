/**
 * Instar Documents — a document's decision state, derived from its folded rows
 * (docs/specs/document-decisions.md §3.1–3.3). Pure and deterministic: every machine holding the
 * same rows derives the same state, whatever order they arrived in.
 *
 *   - The open ask is the newest ask (fold order) the agent has not withdrawn.
 *   - The current answer on an ask is its LAST decision row in fold order (fold order is
 *     topological over docDeps, ties by origin then seq, so it is the same everywhere).
 *   - `supersedes` is checked when an answer is written (no blind overwrite); here it only
 *     detects answers that crossed (two answers written without seeing each other).
 *   - Approve closes the ask for the owner (no new prompt on later versions); Decline keeps it
 *     open and the owner decides again once the agent writes a new version.
 */
import crypto from 'node:crypto';
import type { DocState, DecisionRowState, AskState, VersionState } from './fold.js';
import { latestVersion, versionHeads } from './fold.js';

export interface DecisionView {
  ask: AskState | null;
  /** The ask's current answer, or null. */
  current: DecisionRowState | null;
  /** The answer is for the document's latest version. */
  currentOnLatest: boolean;
  /** Two answers on this ask were written without seeing each other: the owner should confirm. */
  crossed: boolean;
  /** A version exists that the current answer's row had not seen (written at the same time elsewhere). */
  concurrentVersion: VersionState | null;
  /** The owner has something to decide right now (Needs-you, the push, the page's buttons). */
  needsOwner: boolean;
  /** An answer may be written now (the ask is not withdrawn). */
  answerable: boolean;
  /** The current answer's delivered message request id, when recorded. */
  delivered: string | null;
}

function parseRowKey(k: string): { stream: string; seq: number } | null {
  const i = k.lastIndexOf('#');
  if (i <= 0) return null;
  const seq = Number(k.slice(i + 1));
  return Number.isSafeInteger(seq) ? { stream: k.slice(0, i), seq } : null;
}

/** Did a row with this docDeps (written on `stream` at `seq`) see the row with key `rowKey`? */
function saw(d: { docDeps: Readonly<Record<string, number>>; stream: string; seq: number }, rowKey: string): boolean {
  const p = parseRowKey(rowKey);
  if (!p) return true;
  if (p.stream === d.stream) return p.seq < d.seq;
  return (d.docDeps[p.stream] ?? 0) >= p.seq;
}

export function decisionView(s: DocState): DecisionView {
  // The newest ask in fold order is the one in force; if it is closed there is no open ask. An older
  // ask never comes back (replaced is permanent), even when the newest is withdrawn.
  let newest: AskState | null = null;
  for (const a of s.asks.values()) newest = a; // Map keeps fold order
  const ask = newest && !newest.closed ? newest : null;
  const latest = latestVersion(s);
  const empty: DecisionView = { ask, current: null, currentOnLatest: false, crossed: false, concurrentVersion: null, needsOwner: false, answerable: false, delivered: null };
  if (!ask) return empty;
  const rows = s.decisions.filter((d) => d.askId === ask!.askId);
  const current = rows.length ? rows[rows.length - 1] : null;
  // Crossed: another answer on this ask that the current answer's row had not seen and that nothing
  // supersedes. An answer written after seeing every other answer clears it on every machine.
  const superseded = new Set(rows.map((d) => d.supersedes).filter((x): x is string => !!x));
  const crossed = !!current && rows.some((d) => d !== current && !superseded.has(d.rowKey) && !saw(current, d.rowKey));
  const currentOnLatest = !!current && !!latest && current.onVersion === latest.versionId;
  let concurrentVersion: VersionState | null = null;
  if (current) {
    for (const v of s.versions.values()) {
      if (v.pruned || v.versionId === current.onVersion) continue;
      // Concurrent, not merely later: a version the answer had not seen whose label is not past the
      // answered one's (a later revision builds on it and gets a higher label).
      const answered = s.versions.get(current.onVersion);
      if (!saw(current, v.rowKey) && (!answered || v.label <= answered.label)) { concurrentVersion = v; break; }
    }
  }
  const approved = current?.verdict === 'approve';
  // The owner decides when there is no answer yet, or the answer was a Decline on an older version.
  // Crossed answers also need the owner: one is shown, and the owner confirms (§3.2).
  const needsOwner = !!latest && versionHeads(s).length <= 1 && (!current || crossed || (!approved && !currentOnLatest));
  return {
    ask, current, currentOnLatest, crossed, concurrentVersion, needsOwner, answerable: true,
    delivered: current ? s.delivered.get(current.rowKey) ?? null : null,
  };
}

/**
 * The chat request id the owner's message about a decision is first sent with (§3.4): derived from
 * the decision row, so any retry or a reinstalled app re-derives the same id and the chat route's
 * request record makes it exactly-once. The time part is the row's own time (the chat routes accept
 * an id for 24 hours); a `uuid v4`-shaped tail from sha256(rowKey) (the form both routes accept).
 */
export function decisionMessageRequestId(rowKey: string, receivedAt: string): string | null {
  const t = Date.parse(receivedAt);
  if (!Number.isFinite(t) || t <= 0) return null;
  const h = crypto.createHash('sha256').update(`doc-decision\n${rowKey}`).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  const uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  return `${String(Math.floor(t)).padStart(13, '0')}-${uuid}`;
}

/**
 * Does a finished chat request record say the message was delivered (§3.4)? Both chat routes
 * finish refusals and stop-check interceptions with status 200 too, so only these outcomes count.
 */
export function chatRecordDelivered(status: number, body: unknown): boolean {
  if (status !== 200 || !body || typeof body !== 'object') return false;
  const b = body as { ok?: unknown; outcome?: unknown; deliveryState?: unknown };
  if (b.ok === false) return false;
  if (b.outcome === 'forwarded') return true;
  if (b.deliveryState !== undefined && b.deliveryState !== 'delivered') return false;
  return b.outcome === 'delivered' || b.outcome === 'deduped' || b.outcome === 'a2a-handled';
}
