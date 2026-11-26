/**
 * Refuse a downgrade after encrypted chat (docs/specs/threadline-standalone-pairing.md D6/D11,
 * rollout step 6).
 *
 * The first time a peer that is paired BY INVITE (`pairingMethod: 'invite'`, `mutual-verified`
 * here or `identity-verified` by inheritance) sends us ENCRYPTED ordinary chat, verified against
 * its pinned key, the trust profile records `encryptedSeenAt`. From then on, plaintext arriving
 * under that peer's fingerprint can only be the relay's word, and a relay that strips encryption
 * from a peer that has spoken to us encrypted is downgrading it. With the switch enforcing, that
 * plaintext is refused (never delivered, never answered). Pairing ops and credentials never set
 * the mark: they are encrypted from every version. Peers paired by SAS, and inherited pairings
 * whose record carried no method, keep the previous rule (step 5's unverified label, if on).
 *
 * The mark is one record for the whole agent: set once, merged across this agent's machines as a
 * union keeping the earliest time, removed only when the person unpairs (see
 * pairingReplicationWiring.ts and threadline-core's encryptedSeen.ts). A mark kept on one machine
 * would let the relay downgrade a peer by aiming at whichever machine takes over.
 *
 * The switch `threadline.refuseDowngrade` ships at WATCH for every agent (2026-10-20, beside
 * Justin's ruling that encryption ships on): `enabled` omitted means ON, `dryRun` omitted means
 * TRUE. Every agent records marks and counts what it would refuse; refusing needs an explicit
 * `dryRun: false`. Why not enforce by default: an invite-paired peer on an Instar release
 * older than the one that turned encryptToPinned on (or with it set off) encrypts only when
 * the relay has given it our keys this session, so it can send encrypted chat (setting the
 * mark) and later plaintext. Enforcing would refuse that peer's ordinary messages until it
 * updates. The watch counters, per peer, show whether any such peer is still out there.
 *
 *  - off (`enabled` false): nothing is recorded and nothing is refused — today's behaviour.
 *  - watch (`enabled`, `dryRun` not false): marks are recorded (and replicated); plaintext that
 *    would have been refused is counted (`wouldRefuseDowngrade`) and delivered as today.
 *  - enforce (`enabled`, `dryRun: false`): that plaintext is refused (`refusedDowngrade`).
 *
 * Rollback: set the switch to off. Marks already recorded stay in the trust profiles (they are
 * only read while the switch is on), so turning it back on resumes the same protection.
 */

import type { AgentTrustManager } from './AgentTrustManager.js';
import { invitePinnedKey } from './encryptToPinned.js';
import { classifyRelayPlaintextOperation } from './relayUnknownSenderTrust.js';

export interface RefuseDowngradeMode {
  /** `enabled` omitted ⇒ ON for every agent (marks are recorded). */
  enabled: boolean;
  /** Default TRUE: count would-refuse, deliver as today. Only an explicit `false` refuses. */
  dryRun: boolean;
}

export type RefuseDowngradeModeName = 'off' | 'watch' | 'enforce';

interface RefuseDowngradeConfigShape {
  developmentAgent?: boolean;
  threadline?: { refuseDowngrade?: { enabled?: boolean; dryRun?: boolean } };
}

/** The default when no value is set anywhere: watch, for every agent (see the header). */
export const REFUSE_DOWNGRADE_DEFAULT: Readonly<RefuseDowngradeMode> = Object.freeze({ enabled: true, dryRun: true });

/** The live mode. Read per inbound message. */
export function resolveRefuseDowngradeMode(
  live: { enabled?: boolean; dryRun?: boolean },
  config: RefuseDowngradeConfigShape,
): RefuseDowngradeMode {
  const block = config.threadline?.refuseDowngrade;
  const enabled = live.enabled ?? block?.enabled ?? REFUSE_DOWNGRADE_DEFAULT.enabled;
  // Only an explicit `false` leaves dry-run; anything else observes.
  const dryRun = (live.dryRun ?? block?.dryRun) !== false;
  return { enabled, dryRun };
}

export function refuseDowngradeModeName(mode: RefuseDowngradeMode): RefuseDowngradeModeName {
  if (!mode.enabled) return 'off';
  return mode.dryRun ? 'watch' : 'enforce';
}

/** In-memory counters on the authed /health (the rollout evidence). */
export interface RefuseDowngradeCounters {
  /** A mark was newly recorded on this machine (first encrypted chat from an invite peer). */
  marksRecorded: number;
  /** Watch: plaintext under a marked invite peer's fingerprint that would have been refused (delivered). */
  wouldRefuseDowngrade: number;
  /** Enforce: plaintext under a marked invite peer's fingerprint, refused. */
  refusedDowngrade: number;
  /** The trust lookup or write threw. Marking: the message went on as today. Refusing: treated
   *  as seen (fail closed while enforcing). */
  lookupErrors: number;
}

export function createRefuseDowngradeCounters(): RefuseDowngradeCounters {
  return { marksRecorded: 0, wouldRefuseDowngrade: 0, refusedDowngrade: 0, lookupErrors: 0 };
}

/** Process-wide counters (one relay client per server process). */
export const refuseDowngradeCounters: RefuseDowngradeCounters = createRefuseDowngradeCounters();

/** Tests only: zero the process-wide counters. */
export function resetRefuseDowngradeCounters(): void {
  Object.assign(refuseDowngradeCounters, createRefuseDowngradeCounters());
}

type TrustReader = Pick<AgentTrustManager, 'getProfileByFingerprint'>;
type TrustMarker = TrustReader & Pick<AgentTrustManager, 'markEncryptedSeen'>;

export interface RefuseDowngradeDeps<T> {
  trustManager: T | undefined;
  mode: () => RefuseDowngradeMode;
  counters?: RefuseDowngradeCounters;
}

/**
 * Read the live mode. A reader that throws yields the SHIPPED DEFAULT (watch), never off, so
 * marks keep being recorded and would-refuse plaintext keeps being counted (Echo, review of #2236).
 */
export function readRefuseDowngradeMode(mode: () => RefuseDowngradeMode): RefuseDowngradeMode {
  try { return mode(); } catch { return { ...REFUSE_DOWNGRADE_DEFAULT }; /* @silent-fallback-ok — an unreadable mode is the shipped default (watch), never off */ }
}
const readMode = readRefuseDowngradeMode;

/**
 * An ENCRYPTED message arrived and was verified (ThreadlineClient 'message'). Record the mark when
 * it is ordinary chat from an invite peer and the key that verified it is the PINNED key. Off:
 * nothing. Returns true when a mark was newly recorded.
 */
export function noteEncryptedChat(
  deps: RefuseDowngradeDeps<TrustMarker>,
  msg: { from: string; content?: { type?: unknown } | null; senderIdentityPub?: Buffer },
): boolean {
  const counters = deps.counters ?? refuseDowngradeCounters;
  if (!readMode(deps.mode).enabled) return false;
  if (classifyRelayPlaintextOperation(msg.content?.type) !== 'message') return false; // ordinary chat only
  try {
    const fp = String(msg.from || '').toLowerCase();
    const pinned = invitePinnedKey(deps.trustManager, fp);
    if (!pinned || !msg.senderIdentityPub || !pinned.equals(msg.senderIdentityPub)) return false;
    const before = deps.trustManager!.getProfileByFingerprint(fp)?.encryptedSeenAt;
    if (before) return false;
    const ok = deps.trustManager!.markEncryptedSeen(fp, pinned.toString('hex'));
    if (ok) counters.marksRecorded++;
    return ok;
  } catch {
    counters.lookupErrors++;
    return false;
  }
}

/**
 * Plaintext arrived under `fingerprint` (the relay's word). Should it be refused as a downgrade?
 * True only when enforcing, the operation is not a delivery ack, the fingerprint belongs to an
 * invite peer, and that peer's profile carries the encryptedSeen mark. Watch counts and returns
 * false; off returns false without reading anything.
 */
export function shouldRefuseDowngradedPlaintext(
  deps: RefuseDowngradeDeps<TrustReader>,
  fingerprint: string,
  wireType: unknown,
): boolean {
  const counters = deps.counters ?? refuseDowngradeCounters;
  const mode = readMode(deps.mode);
  if (!mode.enabled) return false;
  if (classifyRelayPlaintextOperation(wireType) === 'ack') return false;
  let marked: boolean;
  try {
    const fp = String(fingerprint || '').toLowerCase();
    marked = !!invitePinnedKey(deps.trustManager, fp) && !!deps.trustManager!.getProfileByFingerprint(fp)?.encryptedSeenAt;
  } catch {
    // The spec's decision table: the mark cannot be read → treat the peer as seen (fail closed).
    // We cannot tell which peer is pinned, so while enforcing, plaintext is refused until the
    // trust store answers again; watching, it is counted and delivered.
    counters.lookupErrors++;
    marked = true;
  }
  if (!marked) return false;
  if (mode.dryRun) {
    counters.wouldRefuseDowngrade++;
    return false;
  }
  counters.refusedDowngrade++;
  return true;
}

// ── Loud refusal (Echo's review, 2026-10-20) ────────────────────────────────────────────────
// A refused message must never vanish silently: the receiving agent logs it with a named reason
// and a remedy, keeps a per-peer record on the authed /health, surfaces it through the
// degradation channel, and — where it can — tells the SENDER, encrypted to the sender's pinned
// key, so a real peer on older software learns its message was not delivered and why.

/** The stable machine name of the refusal reason. */
export const DOWNGRADE_REFUSAL_REASON = 'plaintext-from-peer-that-sent-encrypted' as const;

/** What happened, in plain words (for logs, /health and the degradation report). */
export const DOWNGRADE_REFUSAL_EXPLANATION =
  'An unencrypted message claiming to be from an agent you paired with was not delivered, because that agent has sent you encrypted messages before. An unencrypted message in its name could have been written or changed by the relay.';

/** What to do about it, in plain words. */
export const DOWNGRADE_REFUSAL_REMEDY =
  'If that agent really sent it, its software is not encrypting every message to agents it paired with: it should update (Instar encrypts all of them from this release on) and send the message again. If it did not send it, nothing needs doing: the refusal is the protection working.';

/** The fixed notice sent back to the sender, encrypted to its pinned key. A server constant — never peer text. */
export const DOWNGRADE_REFUSAL_NOTICE =
  '[automatic notice] I did not deliver an unencrypted message that arrived in your name, because you have sent me encrypted messages before and an unencrypted one could have been changed by the relay. If you sent it, please update your Threadline software so that it encrypts every message to agents you paired with, then send it again. If you did not send it, someone tried to speak as you; nothing else is needed.';

/** At most one notice per peer per this interval (a forging relay must not turn us into a sender). */
export const DOWNGRADE_NOTICE_MIN_INTERVAL_MS = 60 * 60_000;
const DOWNGRADE_REFUSAL_MAX_PEERS = 256;

export interface DowngradeRefusalRecord {
  fingerprint: string;
  count: number;
  firstAt: string;
  lastAt: string;
  reason: typeof DOWNGRADE_REFUSAL_REASON;
  explanation: string;
  remedy: string;
  /** Notices sent back to the sender (encrypted to its pinned key). */
  noticesSent: number;
  /** Notices that could not be sent (no pinned key, not connected, send threw). */
  noticeFailures: number;
  lastNoticeAt?: string;
}

export interface DowngradeRefusalLog {
  /** Record one refusal; returns the record and whether a notice to the sender is due. */
  record(fingerprint: string): { record: DowngradeRefusalRecord; noticeDue: boolean };
  /** Record the outcome of a notice attempt. */
  noteNotice(fingerprint: string, sent: boolean): void;
  /** Every peer with a refusal this process, newest first. */
  snapshot(): DowngradeRefusalRecord[];
  reset(): void;
}

export function createDowngradeRefusalLog(opts: { now?: () => number; noticeIntervalMs?: number; maxPeers?: number } = {}): DowngradeRefusalLog {
  const now = opts.now ?? Date.now;
  const interval = opts.noticeIntervalMs ?? DOWNGRADE_NOTICE_MIN_INTERVAL_MS;
  const maxPeers = opts.maxPeers ?? DOWNGRADE_REFUSAL_MAX_PEERS;
  const records = new Map<string, DowngradeRefusalRecord>();
  const lastNoticeMs = new Map<string, number>();
  return {
    record(fingerprint) {
      const fp = String(fingerprint || '').toLowerCase();
      const t = now();
      const iso = new Date(t).toISOString();
      let rec = records.get(fp);
      if (!rec) {
        if (records.size >= maxPeers) {
          // Bounded: drop the peer refused longest ago.
          let oldest: string | null = null;
          for (const [k, v] of records) if (oldest === null || v.lastAt < records.get(oldest)!.lastAt) oldest = k;
          if (oldest !== null) { records.delete(oldest); lastNoticeMs.delete(oldest); }
        }
        rec = {
          fingerprint: fp, count: 0, firstAt: iso, lastAt: iso, reason: DOWNGRADE_REFUSAL_REASON,
          explanation: DOWNGRADE_REFUSAL_EXPLANATION, remedy: DOWNGRADE_REFUSAL_REMEDY, noticesSent: 0, noticeFailures: 0,
        };
        records.set(fp, rec);
      }
      rec.count++;
      rec.lastAt = iso;
      const last = lastNoticeMs.get(fp);
      const noticeDue = last === undefined || t - last >= interval;
      if (noticeDue) lastNoticeMs.set(fp, t);
      return { record: rec, noticeDue };
    },
    noteNotice(fingerprint, sent) {
      const rec = records.get(String(fingerprint || '').toLowerCase());
      if (!rec) return;
      if (sent) { rec.noticesSent++; rec.lastNoticeAt = new Date(now()).toISOString(); } else rec.noticeFailures++;
    },
    snapshot() {
      return [...records.values()].map((r) => ({ ...r })).sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
    },
    reset() { records.clear(); lastNoticeMs.clear(); },
  };
}

/** Process-wide refusal log (one relay client per server process), on the authed /health. */
export const downgradeRefusals: DowngradeRefusalLog = createDowngradeRefusalLog();

/** Tests only: clear the process-wide refusal log. */
export function resetDowngradeRefusals(): void {
  downgradeRefusals.reset();
}

/**
 * Make a refusal loud. Call it exactly where shouldRefuseDowngradedPlaintext returned true.
 * Logs the named reason and remedy, records the peer, reports through `report` (the degradation
 * channel) when a notice is due, and sends the fixed notice back to the sender ENCRYPTED to its
 * pinned key when one is due and the key is known. Never throws: a refusal that cannot be made
 * loud is still a refusal.
 */
export function reportDowngradeRefusal(
  deps: {
    trustManager: TrustReader | undefined;
    log?: DowngradeRefusalLog;
    warn?: (line: string) => void;
    report?: (r: { reason: string; impact: string }) => void;
    /** Send `text` to `fingerprint` encrypted to `pinnedIdentityPubHex`. Throws on failure. */
    sendNotice?: (fingerprint: string, pinnedIdentityPubHex: string, text: string) => void;
  },
  fingerprint: string,
): DowngradeRefusalRecord | null {
  try {
    const log = deps.log ?? downgradeRefusals;
    const fp = String(fingerprint || '').toLowerCase();
    const { record, noticeDue } = log.record(fp);
    (deps.warn ?? console.warn)(
      `Threadline: refused plaintext from ${fp.slice(0, 12)} [${DOWNGRADE_REFUSAL_REASON}] (refusal ${record.count} from this agent). ${DOWNGRADE_REFUSAL_EXPLANATION} Remedy: ${DOWNGRADE_REFUSAL_REMEDY}`,
    );
    if (!noticeDue) return record;
    try {
      deps.report?.({ reason: `${DOWNGRADE_REFUSAL_REASON} from ${fp.slice(0, 12)}`, impact: `${DOWNGRADE_REFUSAL_EXPLANATION} ${DOWNGRADE_REFUSAL_REMEDY}` });
    } catch { /* @silent-fallback-ok — the warn line above already carries it */ }
    let sent = false;
    try {
      const pinned = invitePinnedKey(deps.trustManager, fp);
      if (pinned && deps.sendNotice) {
        deps.sendNotice(fp, pinned.toString('hex'), DOWNGRADE_REFUSAL_NOTICE);
        sent = true;
      }
    } catch { /* counted below as a notice failure */ }
    log.noteNotice(fp, sent);
    return record;
  } catch {
    return null; // @silent-fallback-ok — the refusal itself already happened; loudness is best effort
  }
}
