/**
 * Inbound Agent-Signature Provenance classifier.
 *
 * Spec anchor: docs/specs/agent-signature-provenance.md
 *
 * Chains onto the existing `onMessageLogged` seam (the same seam Usher and
 * TopicIntentCapture use) so every inbound message is classified without
 * touching the hot message path's control flow.
 *
 * ── SIGNAL-ONLY ────────────────────────────────────────────────────────────
 * This records a verdict. It never blocks, delays, rewrites, or drops a
 * message, and it never throws into the message path — a provenance recorder
 * that can break message delivery is a worse problem than the one it solves.
 * Every failure path is swallowed after being counted.
 *
 * ── WHY A LEDGER ───────────────────────────────────────────────────────────
 * The charter requires that "raw inbound records and verifier decisions are
 * preserved as evidence". A verdict computed and discarded proves nothing
 * afterwards; the ledger is what makes the claim auditable by the operator
 * rather than assertable by me.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 * No authority. The ledger records who authored bytes, never what that author
 * may decide. See the spec's open authority question.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { verifyMessage } from './agentSignatureProvenance.js';
import type { SeenNonceStore, AspVerdict } from './agentSignatureProvenance.js';
import { FileSeenNonceStore } from './aspNonceStore.js';
import { AspKeyDirectory } from './AspKeyDirectory.js';

export interface AspInboundEntry {
  topicId: number | null;
  text: string;
  timestamp?: string;
  messageId?: number;
  senderName?: string;
  fromUser?: boolean;
}

export interface AspClassificationRecord {
  ts: string;
  topicId: number | null;
  messageId: number | null;
  classification: AspVerdict['classification'];
  reason: string | null;
  agentId: string | null;
  /** sha256 of the classified body — the record proves WHAT was judged without storing it. */
  bodyHash: string;
  bodyBytes: number;
  /** Which guards actually ran for this verdict. */
  topicBound: boolean;
  replayChecked: boolean;
}

export interface AspInboundClassifierOptions {
  /** Absolute path to the JSONL ledger. */
  ledgerPath: string;
  resolvePublicKey: (agentId: string) => Buffer | null | undefined;
  seenNonces?: SeenNonceStore;
  now?: () => number;
  /**
   * Retain only messages that carry a tag? Default true.
   *
   * Untagged operator traffic is the overwhelming majority and classifying it
   * as `human` is the expected, information-free case; writing a ledger row for
   * every one of them would bury the interesting rows and grow without bound.
   * Set false when auditing the `human` path itself.
   */
  onlyRecordTagged?: boolean;
}

export interface AspClassifierCounters {
  seen: number;
  human: number;
  agentVerified: number;
  rejected: number;
  errors: number;
  recorded: number;
  /** Entries skipped because they were explicitly OUTBOUND (this agent's own sends). */
  skippedOutbound: number;
}

const TAG_HINT = '⟦asp1 ';

/**
 * The part of a verdict the ROUTING path needs, kept in memory by message id.
 *
 * The nonce is single-use, so a message can be verified exactly ONCE — at log
 * time, before routing. Anything downstream that needs to know "was this
 * agent-signed?" must read that one verdict rather than verify again (a second
 * verify would classify the genuine message as a replay). Bounded so a busy
 * bot cannot grow it without limit; the durable ledger remains the authority.
 */
export interface AspRecentVerdict {
  classification: AspVerdict['classification'];
  agentId: string | null;
}

const RECENT_VERDICT_CAP = 1000;

function recentKey(topicId: number | null | undefined, messageId: number): string {
  return `${topicId ?? 'none'}:${messageId}`;
}

export class AspInboundClassifier {
  private readonly opts: AspInboundClassifierOptions;
  private readonly now: () => number;
  readonly counters: AspClassifierCounters = {
    seen: 0, human: 0, agentVerified: 0, rejected: 0, errors: 0, recorded: 0,
    skippedOutbound: 0,
  };
  private readonly recent = new Map<string, AspRecentVerdict>();

  constructor(opts: AspInboundClassifierOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Classify one inbound entry. Returns the verdict for callers that want it;
   * returns null only when classification could not run at all.
   *
   * NEVER throws.
   */
  classify(entry: AspInboundEntry): AspVerdict | null {
    try {
      if (typeof entry?.text !== 'string' || entry.text === '') return null;

      // INBOUND ONLY. The seam this chains onto (`onMessageLogged`) carries BOTH
      // directions, and `fromUser` is how they are told apart: true for a message
      // that arrived, false for one this agent sent.
      //
      // Classifying our own sends put ledger rows about outbound traffic into an
      // audit trail whose entire question is "did this arrive from the operator or
      // from an agent". Skipping is also what the class name has always claimed.
      //
      // Explicit `false` only: an ABSENT flag still classifies, so a caller that
      // does not supply it silently loses nothing. Fails toward recording.
      if (entry.fromUser === false) {
        this.counters.skippedOutbound += 1;
        return null;
      }

      this.counters.seen += 1;

      const verdict = verifyMessage({
        raw: entry.text,
        expectedTopicId: entry.topicId ?? undefined,
        resolvePublicKey: this.opts.resolvePublicKey,
        seenNonces: this.opts.seenNonces,
        nowSeconds: Math.floor(this.now() / 1000),
      });

      if (verdict.classification === 'human') this.counters.human += 1;
      else if (verdict.classification === 'agent-verified') this.counters.agentVerified += 1;
      else this.counters.rejected += 1;

      this.remember(entry, verdict);

      const tagged = entry.text.includes(TAG_HINT);
      const onlyTagged = this.opts.onlyRecordTagged ?? true;
      if (!onlyTagged || tagged) this.record(entry, verdict);

      return verdict;
    } catch {
      /* @silent-fallback-ok: SIGNAL-ONLY BY DESIGN. A provenance recorder that can throw into
         the message path is a worse problem than the one it solves, so every failure is counted
         (counters.errors, readable by the caller) and swallowed. Tested explicitly:
         'does not throw when the resolver throws' + 'the chained handler never throws either'. */
      this.counters.errors += 1;
      return null;
    }
  }

  /** Convenience: a handler that can be chained onto `onMessageLogged`. */
  handler(): (entry: AspInboundEntry) => void {
    return (entry: AspInboundEntry) => {
      this.classify(entry);
    };
  }

  /**
   * The verdict recorded for one inbound message, by (topic, message id) —
   * for the routing path, which runs AFTER log-time classification and must
   * not verify again. `null` when the message was never classified here
   * (no id, evicted, or arrived before this process started).
   */
  verdictFor(topicId: number | null | undefined, messageId: number | null | undefined): AspRecentVerdict | null {
    if (typeof messageId !== 'number' || !Number.isFinite(messageId)) return null;
    return this.recent.get(recentKey(topicId, messageId)) ?? null;
  }

  private remember(entry: AspInboundEntry, verdict: AspVerdict): void {
    if (typeof entry.messageId !== 'number' || !Number.isFinite(entry.messageId)) return;
    const key = recentKey(entry.topicId, entry.messageId);
    this.recent.delete(key);
    this.recent.set(key, {
      classification: verdict.classification,
      agentId: 'agentId' in verdict ? verdict.agentId ?? null : null,
    });
    while (this.recent.size > RECENT_VERDICT_CAP) {
      const oldest = this.recent.keys().next().value;
      if (oldest === undefined) break;
      this.recent.delete(oldest);
    }
  }

  private record(entry: AspInboundEntry, verdict: AspVerdict): void {
    try {
      const row: AspClassificationRecord = {
        ts: new Date(this.now()).toISOString(),
        topicId: entry.topicId ?? null,
        messageId: entry.messageId ?? null,
        classification: verdict.classification,
        reason: 'reason' in verdict ? verdict.reason : null,
        agentId: 'agentId' in verdict ? verdict.agentId ?? null : null,
        bodyHash: sha256(verdict.body),
        bodyBytes: Buffer.byteLength(verdict.body, 'utf8'),
        topicBound: entry.topicId !== null && entry.topicId !== undefined,
        replayChecked: Boolean(this.opts.seenNonces),
      };
      fs.mkdirSync(path.dirname(this.opts.ledgerPath), { recursive: true });
      fs.appendFileSync(this.opts.ledgerPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      this.counters.recorded += 1;
    } catch {
      /* @silent-fallback-ok: ledger write failure must not break delivery NOR lose the verdict's
         effect — classification already succeeded and its counter is incremented. Surfaced via
         counters.errors; tested by 'does not throw when the ledger path is unwritable'. */
      this.counters.errors += 1;
    }
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * Build a classifier wired to this agent's identity and durable stores.
 *
 * Returns null when the agent has no canonical identity — with no public key
 * there is nothing to verify against, and a classifier that rejected every
 * signed message for want of a key would be worse than silence.
 *
 * NEVER throws: a construction failure yields null, because a provenance
 * recorder must not be able to stop the messaging stack from coming up.
 *
 * Only the PUBLIC key is read (no decryption), so an encrypted identity needs
 * no passphrase here — this path verifies, it never signs.
 */
export function buildAspInboundClassifier(
  stateDir: string,
  agentId: string
): AspInboundClassifier | null {
  try {
    const identityPath = path.join(stateDir, 'identity.json');
    if (!fs.existsSync(identityPath)) return null;

    const raw = JSON.parse(fs.readFileSync(identityPath, 'utf8')) as { publicKey?: string };
    if (typeof raw?.publicKey !== 'string') return null;
    const publicKey = Buffer.from(raw.publicKey, 'base64');
    if (publicKey.length !== 32) return null;

    let seenNonces: FileSeenNonceStore | undefined;
    try {
      seenNonces = new FileSeenNonceStore({ filePath: path.join(stateDir, 'asp-nonces.json') });
    } catch {
      /* @silent-fallback-ok: the store itself throws LOUDLY on damage (see aspNonceStore); this
         catch converts that into an HONEST DEGRADATION rather than a dead messaging stack —
         classification continues and every recorded row carries replayChecked:false, so the
         missing guard is visible in the data instead of being implied present. */
      seenNonces = undefined;
    }

    // Resolve peers too, not just self — otherwise every other agent's signed
    // message classifies `unknown-agent`, which is safe but useless. The
    // directory keeps self authoritative so a discovery file cannot displace us.
    const directory = new AspKeyDirectory({ stateDir, selfAgentId: agentId });

    return new AspInboundClassifier({
      ledgerPath: path.join(stateDir, 'asp-classifications.jsonl'),
      resolvePublicKey: directory.resolver(),
      seenNonces,
      // The re-read join needs a durable verdict for BOTH sides. Absence is
      // UNRESOLVED, never an implicit human classification.
      onlyRecordTagged: false,
    });
  } catch {
    /* @silent-fallback-ok: construction failure yields null so a provenance recorder can never
       prevent the messaging stack from coming up. The caller logs the null case; a null
       classifier simply means no verdicts are recorded, never a blocked message. */
    return null;
  }
}
