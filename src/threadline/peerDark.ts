/**
 * peerDark — honest sender-side reporting of a send that stays queued
 * (docs/specs/a2a-single-agent-identity.md §3).
 *
 * A peer is `dark` when my own delivery ledger shows messages to it queued,
 * unconfirmed or expired for longer than `queuedDarkAfterMs` with nothing back
 * (no ack, no inbound, no `delivered` verdict) since. It is a PROXY read from my
 * ledger: it means "nothing from this peer for N h" and cannot by itself tell
 * offline from wrong-address — so every sentence here is worded to the evidence.
 *
 * This module holds the pure pieces the route, the MCP tool and the reworked
 * A2ARedeliverySentinel share: the config resolver (dev-gated, dry-run first),
 * the peer label (fingerprint prefix + clamped, HTML-escaped display name), the
 * `deliveryOutcome` sentence, and the would-raise / would-sentence audit writer
 * for `logs/a2a-peer-dark.jsonl`. No decision here gates a send.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveDevAgentGate } from '../core/devAgentGate.js';

/** Default: a peer with nothing back for 2 h is dark (below the 6 h `stale` window so the sender hears first). */
export const DEFAULT_QUEUED_DARK_AFTER_MS = 2 * 60 * 60 * 1000;
/** Default per-peer cooldown between two dark items for the same peer. */
export const DEFAULT_PEER_DARK_COOLDOWN_MS = 12 * 60 * 60 * 1000;
/** Floors so a mis-set config cannot page on every send or never page. */
export const MIN_QUEUED_DARK_AFTER_MS = 5 * 60 * 1000;
export const MIN_PEER_DARK_COOLDOWN_MS = 60 * 1000;

export interface PeerDarkNoticeConfig {
  /** Resolved via the developmentAgent gate when the config omits `enabled`. */
  enabled: boolean;
  /** Default true: would-raise / would-sentence rows are logged, no item, no sentence. */
  dryRun: boolean;
  /** The default dark threshold (§3.1). */
  queuedDarkAfterMs: number;
  /**
   * Per-peer dark thresholds, keyed by the peer's full fingerprint (lowercased).
   * A pair that normally answers in minutes can sit at 30 min while the default
   * stays 2 h. Same 5-min floor as the default.
   */
  perPeer: Record<string, { queuedDarkAfterMs: number }>;
  cooldownMs: number;
}

export interface PeerDarkNoticeRawConfig {
  enabled?: boolean;
  dryRun?: boolean;
  queuedDarkAfterMs?: number;
  perPeer?: Record<string, { queuedDarkAfterMs?: number } | undefined>;
  cooldownMs?: number;
}

/** Bound on configured per-peer entries (a config map, not a ledger). */
export const PEER_DARK_PER_PEER_MAX = 200;

function resolvePerPeer(raw: unknown): Record<string, { queuedDarkAfterMs: number }> {
  // Null-prototype: a fingerprint is peer-chosen text and must never hit an inherited key.
  const out: Record<string, { queuedDarkAfterMs: number }> = Object.create(null) as Record<string, { queuedDarkAfterMs: number }>;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  let n = 0;
  for (const [fp, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= PEER_DARK_PER_PEER_MAX) break;
    const ms = (v as { queuedDarkAfterMs?: unknown } | null | undefined)?.queuedDarkAfterMs;
    if (typeof fp !== 'string' || !fp.trim() || typeof ms !== 'number' || !Number.isFinite(ms)) continue;
    out[fp.trim().toLowerCase()] = { queuedDarkAfterMs: Math.max(MIN_QUEUED_DARK_AFTER_MS, ms) };
    n++;
  }
  return out;
}

/** The dark threshold that applies to ONE peer: its per-peer entry, else the default. */
export function queuedDarkAfterMsFor(cfg: Pick<PeerDarkNoticeConfig, 'queuedDarkAfterMs'> & { perPeer?: PeerDarkNoticeConfig['perPeer'] }, peerFp: string): number {
  const key = String(peerFp ?? '').trim().toLowerCase();
  const entry = cfg.perPeer && Object.prototype.hasOwnProperty.call(cfg.perPeer, key) ? cfg.perPeer[key] : undefined;
  return entry && typeof entry.queuedDarkAfterMs === 'number' ? entry.queuedDarkAfterMs : cfg.queuedDarkAfterMs;
}

function finiteOr(v: unknown, fallback: number, floor: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.max(floor, n);
}

/**
 * Resolve `threadline.peerDarkNotice`. `enabled` omitted ⇒ the developmentAgent
 * gate (live on a dev agent, dark on the fleet); an explicit value always wins.
 * `liveEnabled` lets a caller pass a live-config read ahead of the boot config.
 */
export function resolvePeerDarkNoticeConfig(
  config: { developmentAgent?: boolean; threadline?: { peerDarkNotice?: PeerDarkNoticeRawConfig } } | undefined,
  liveEnabled?: boolean,
): PeerDarkNoticeConfig {
  const raw = config?.threadline?.peerDarkNotice ?? {};
  const explicit = liveEnabled ?? raw.enabled;
  return {
    enabled: resolveDevAgentGate(explicit, config),
    dryRun: raw.dryRun ?? true,
    queuedDarkAfterMs: finiteOr(raw.queuedDarkAfterMs, DEFAULT_QUEUED_DARK_AFTER_MS, MIN_QUEUED_DARK_AFTER_MS),
    perPeer: resolvePerPeer(raw.perPeer),
    cooldownMs: finiteOr(raw.cooldownMs, DEFAULT_PEER_DARK_COOLDOWN_MS, MIN_PEER_DARK_COOLDOWN_MS),
  };
}

/** The `peerDark` object a send to a dark peer carries (spec §3.2). */
export interface PeerDarkReport {
  /** When the silence began: the oldest unanswered row's send time (ISO). */
  since: string | null;
  /** Rows still queued / unconfirmed / expired-unacknowledged for this peer, including this send. */
  queuedCount: number;
  /** Of those, rows the relay handed to a connection under the peer's address after queueing them, never acknowledged. */
  handedUnackedCount?: number;
  /** The earliest relay expiry among the still-queued rows (ISO), or null. */
  expiresAt: string | null;
  /**
   * From the presence map (§3.2): `true` when the peer's row says online,
   * `false` when it says offline, `null` when there is no row, my relay is not
   * connected, or no presence frame arrived within the freshness bound.
   */
  connectedNow: boolean | null;
  /**
   * WHY `connectedNow` is null — so "the peer is unknown" is never confused with
   * "my side is broken": `no-row` (the presence map has no record of this peer),
   * `relay-down` (my own relay is not connected, or there is no relay client),
   * `stale` (there is a record but nothing fresh enough to trust). Null when
   * `connectedNow` is a boolean.
   */
  connectedNowReason: ConnectedNowReason | null;
  /**
   * When this peer's presence record was last written (ISO), or null when there
   * is none. A boolean `connectedNow` is "as of" this instant, never "right now".
   */
  connectedAsOf: string | null;
}

export type ConnectedNowReason = 'no-row' | 'relay-down' | 'stale';

/** One presence read: the boolean, why it is unknown, and how old the record is. */
export interface PeerPresenceRead {
  connectedNow: boolean | null;
  connectedNowReason: ConnectedNowReason | null;
  connectedAsOf: string | null;
}

/** The read when there is no relay client at all (a standby, or relay off). */
export const PRESENCE_RELAY_DOWN: PeerPresenceRead = { connectedNow: null, connectedNowReason: 'relay-down', connectedAsOf: null };

function ageMinutes(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 60_000));
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const PEER_LABEL_NAME_MAX = 40;

/**
 * Render a peer for user-facing text: the fingerprint prefix (the authoritative
 * address) plus the display name, clamped and HTML-escaped (the name is
 * peer-supplied text and the attention hub renders HTML).
 */
export function peerLabel(peerFp: string, peerName: string | null | undefined): string {
  const prefix = (peerFp ?? '').slice(0, 12);
  const name = typeof peerName === 'string' ? peerName.replace(/[\r\n\t]+/g, ' ').trim() : '';
  if (!name || name === peerFp) return prefix || 'unknown-peer';
  const clamped = name.length > PEER_LABEL_NAME_MAX ? `${name.slice(0, PEER_LABEL_NAME_MAX - 1)}…` : name;
  return `${escapeHtml(clamped)} (${prefix})`;
}

function hoursSince(iso: string | null, nowMs: number): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.round(((nowMs - t) / 3_600_000) * 10) / 10);
}

function shortIso(iso: string | null): string {
  if (!iso) return 'unknown';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 'unknown' : new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The connectivity clause (§3.2), worded to the evidence — never "nothing will arrive". */
export function connectedNowClause(
  label: string,
  connectedNow: boolean | null,
  detail: { reason?: ConnectedNowReason | null; asOf?: string | null; nowMs?: number } = {},
): string {
  const mins = ageMinutes(detail.asOf, detail.nowMs ?? Date.now());
  const asOf = mins === null ? '' : ` (as of ${mins} min ago)`;
  if (connectedNow === false) {
    return `${label} is not connected to the relay right now${asOf} — it may be offline, or listening under a different address`;
  }
  if (connectedNow === true) {
    return `${label} IS connected to the relay${asOf} but has not acknowledged anything — it may be listening under a different address, or not reading`;
  }
  const why = detail.reason === 'relay-down'
    ? ' (my own relay connection is down)'
    : detail.reason === 'stale'
      ? ` (my last presence record for it is ${mins === null ? 'too old' : `${mins} min old`})`
      : detail.reason === 'no-row'
        ? ' (the relay has given me no presence record for it)'
        : '';
  return `whether ${label} is connected right now is unknown${why}`;
}

/**
 * The `deliveryOutcome` sentence for a send to a dark peer (spec §3.2):
 * "no acknowledgement from <peer> for N h; this and K other messages are still
 * queued (oldest expires T)" + the connectivity clause.
 */
export function buildPeerDarkSentence(
  report: PeerDarkReport,
  peer: { peerFp: string; peerName?: string | null },
  nowMs: number = Date.now(),
): string {
  const label = peerLabel(peer.peerFp, peer.peerName);
  const h = hoursSince(report.since, nowMs);
  const others = Math.max(0, report.queuedCount - 1);
  const queuedPart = others === 0
    ? 'this message is still queued'
    : `this and ${others} other message${others === 1 ? '' : 's'} are still queued`;
  const expiry = report.expiresAt ? ` (oldest expires ${shortIso(report.expiresAt)})` : '';
  return `no acknowledgement from ${label} for ${h} h; ${queuedPart}${expiry}${handedClause(report.handedUnackedCount)}; ${connectedNowClause(label, report.connectedNow, { reason: report.connectedNowReason, asOf: report.connectedAsOf, nowMs })}.`;
}

/**
 * Names the rows a relay queue flush handed to a connection under the peer's
 * address with no acknowledgement after — they are not "queued" any more, and
 * calling them that would be a false statement.
 */
function handedClause(handed: number | undefined): string {
  const n = typeof handed === 'number' && handed > 0 ? Math.floor(handed) : 0;
  if (n === 0) return '';
  return ` — ${n} of these ${n === 1 ? 'was' : 'were'} handed to a connection under its address and never acknowledged`;
}

/** Attention-item body for the per-peer dark item (spec §3.2). */
export function buildPeerDarkItemBody(
  peer: { peerFp: string; peerName?: string | null },
  queuedCount: number,
  since: string | null,
  handedUnackedCount?: number,
): string {
  const label = peerLabel(peer.peerFp, peer.peerName);
  return `Messages to ${label} are stuck: ${queuedCount} queued since ${shortIso(since)}, none acknowledged${handedClause(handedUnackedCount)}. ${label} may be offline, or listening under a different address.`;
}

/** Resolve line for the per-peer dark item (spec §3.2 iv). */
export function buildPeerDarkResolveLine(
  peer: { peerFp: string; peerName?: string | null },
  expiredUnacknowledged: number,
): string {
  const label = peerLabel(peer.peerFp, peer.peerName);
  return `${label} is back; ${expiredUnacknowledged} message${expiredUnacknowledged === 1 ? '' : 's'} from the dark window expired unacknowledged — resend what still matters.`;
}

/** Deterministic item ids (spec §3.2 iii — no episode stamp). */
export function peerDarkItemId(agentId: string, peerFp: string): string {
  return `a2a-peer-dark:${agentId}:${peerFp}`;
}
export function relayUnreachableItemId(agentId: string): string {
  return `a2a-relay-unreachable:${agentId}`;
}

/** One audit row in `logs/a2a-peer-dark.jsonl` (fingerprints, counts, timings — never bodies). */
export interface PeerDarkAuditRow {
  ts: string;
  kind:
    | 'would-raise' | 'raised' | 'would-resolve' | 'resolved'
    | 'would-sentence' | 'sentence'
    | 'would-raise-aggregate' | 'raised-aggregate' | 'resolved-aggregate'
    | 'heal' | 'skipped' | 'pool-cleared' | 'cooldown' | 'superseded' | 'error';
  peerFp?: string;
  queuedCount?: number;
  darkSince?: string | null;
  connectedNow?: boolean | null;
  connectedNowReason?: ConnectedNowReason | null;
  connectedAsOf?: string | null;
  reason?: string;
  itemId?: string;
  expiredUnacknowledged?: number;
  peers?: number;
  messages?: number;
  relayState?: string;
  dryRun?: boolean;
  [k: string]: unknown;
}

export const PEER_DARK_AUDIT_MAX_BYTES = 4 * 1024 * 1024;

/** Append-only JSONL writer with a one-generation rotation; never throws. */
export function createPeerDarkAuditWriter(auditPath: string, log?: (line: string) => void): (row: PeerDarkAuditRow) => void {
  return (row) => {
    try {
      fs.mkdirSync(path.dirname(auditPath), { recursive: true });
      let size = 0;
      try { size = fs.statSync(auditPath).size; } catch { /* @silent-fallback-ok: no file yet = size 0 */ }
      if (size > PEER_DARK_AUDIT_MAX_BYTES) fs.renameSync(auditPath, `${auditPath}.1`);
      fs.appendFileSync(auditPath, JSON.stringify(row) + '\n');
    } catch (err) {
      // @silent-fallback-ok: an audit append must never break a send or a sweep; logged.
      log?.(`[a2a-peer-dark] audit append failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  };
}

export function resolvePeerDarkAuditPath(stateDir: string): string {
  return path.join(stateDir, 'logs', 'a2a-peer-dark.jsonl');
}
