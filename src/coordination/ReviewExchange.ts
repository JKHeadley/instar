/**
 * ReviewExchange — the autonomous code-review protocol (spec §7 G2.3).
 *
 * A ReviewExchange is one mutual, mandate-gated sign-off of a review artifact
 * between the two agents named in a Coordination Mandate. It is how Phase-1's
 * "code-owner review" happens WITHOUT the human relaying: the owner agent delivers
 * a review package over Threadline, the peer reviews and returns an authenticated
 * verdict, and BOTH sign-offs are checked against the mandate's `sign-code-review`
 * authority (bounds e.g. `{ artifact: 'migration-port', mutual: true }`) before
 * they are accepted. Every accepted signature carries the audit hash of the gate
 * decision that authorized it — the trail Justin reviews.
 *
 * Asymmetry, stated honestly: the peer's instance may not run this engine yet, so
 * the peer's "signature" is their authenticated Threadline verdict message
 * (Ed25519-authenticated sender → fingerprint), recorded verbatim by reference —
 * kind 'authenticated-peer-verdict'. The local agent's signature goes through the
 * local gate — kind 'mandate-gated-local'. BOTH are gate-evaluated here (named
 * party, bounds, expiry, revocation), so a stranger's verdict or an out-of-bounds
 * artifact is refused identically.
 *
 * State machine (linear, no skips):
 *   proposed → delivered → verdict-recorded → complete
 *                      ↘ changes-requested (terminal: rework = a NEW exchange)
 *
 * The review package is content-addressed: `packageSha256` is fixed at creation
 * and signatures bind to the record that carries it — a different package is a
 * different exchange. Deny-by-default is inherited: with no mandate issued, every
 * sign/verdict path denies.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { MandateGate } from './MandateGate.js';

export type ReviewExchangeState =
  | 'proposed'
  | 'delivered'
  | 'verdict-recorded'
  | 'complete'
  | 'changes-requested';

export interface ReviewSignature {
  /** The signing agent's routing fingerprint (a named party of the mandate). */
  agentFp: string;
  signedAt: string;
  /** 'mandate-gated-local' = this server's own agent, allowed by the local gate;
   *  'authenticated-peer-verdict' = the peer's sign-off, carried by their
   *  authenticated Threadline verdict message (recorded by reference). */
  kind: 'mandate-gated-local' | 'authenticated-peer-verdict';
  /** Hash of the audit entry for the gate decision that authorized this signature. */
  auditHash: string;
  /** Evidence reference — e.g. a Threadline message/thread ref for peer signatures. */
  evidence: string | null;
}

export interface PeerVerdict {
  verdict: 'approve' | 'request-changes';
  summary: string;
  /** Authenticated-source reference (Threadline message/thread id). */
  evidence: string;
  recordedAt: string;
}

export interface ReviewExchangeRecord {
  id: string;
  /** The mandate whose `sign-code-review` authority governs this exchange. */
  mandateId: string;
  /** The artifact under review — must match the authority's bounds (e.g. 'migration-port'). */
  artifact: string;
  /** Human-readable pointer to the review package (repo path or URL). */
  packageRef: string;
  /** sha256 of the package content — what the signatures bind to. Immutable. */
  packageSha256: string;
  /** [ownerFp, peerFp] — owner delivers, peer reviews. Both must be mandate parties. */
  parties: [string, string];
  state: ReviewExchangeState;
  /** Delivery evidence (e.g. Threadline message id), set by markDelivered. */
  deliveredEvidence: string | null;
  peerVerdict: PeerVerdict | null;
  signatures: ReviewSignature[];
  createdAt: string;
  updatedAt: string;
}

/** Uniform method result — gate denials and state errors come back as data, not throws. */
export type ExchangeResult =
  | { ok: true; record: ReviewExchangeRecord }
  | { ok: false; reason: string };

export interface ReviewExchangeEngineDeps {
  /** Absolute path to the exchanges JSON file. */
  filePath: string;
  /** The mandate gate — EVERY sign-off is evaluated through it. */
  gate: MandateGate;
  now?: () => number;
  /** Exchange id generator (default: random). Injected for deterministic tests. */
  genId?: () => string;
}

export interface CreateExchangeInput {
  mandateId: string;
  artifact: string;
  packageRef: string;
  packageSha256: string;
  parties: [string, string];
  id?: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

export class ReviewExchangeEngine {
  private readonly d: ReviewExchangeEngineDeps;
  constructor(deps: ReviewExchangeEngineDeps) {
    this.d = deps;
  }

  private nowIso(): string {
    return new Date(this.d.now ? this.d.now() : Date.now()).toISOString();
  }

  private readAll(): ReviewExchangeRecord[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.d.filePath, 'utf8'));
      return Array.isArray(raw) ? (raw as ReviewExchangeRecord[]) : [];
    } catch { /* @silent-fallback-ok — exchanges file may not exist yet; an empty list is the safe initial state */ return []; }
  }

  private writeAll(records: ReviewExchangeRecord[]): void {
    fs.mkdirSync(path.dirname(this.d.filePath), { recursive: true });
    fs.writeFileSync(this.d.filePath, JSON.stringify(records, null, 2));
  }

  private save(record: ReviewExchangeRecord): ReviewExchangeRecord {
    record.updatedAt = this.nowIso();
    const all = this.readAll().filter((r) => r.id !== record.id);
    all.push(record);
    this.writeAll(all);
    return record;
  }

  /** Evaluate `sign-code-review` for one party through the mandate gate. */
  private gateSignOff(record: ReviewExchangeRecord, agentFp: string) {
    return this.d.gate.evaluate({
      action: 'sign-code-review',
      params: { artifact: record.artifact, mutual: true },
      agentFp,
      mandateId: record.mandateId,
    });
  }

  /** Create a new exchange in `proposed`. Validation only — no gate call yet
   *  (creating a record delegates nothing; the sign-offs are what the mandate governs). */
  create(input: CreateExchangeInput): ExchangeResult {
    if (!SHA256_HEX.test(input.packageSha256)) {
      return { ok: false, reason: 'packageSha256 must be a 64-char lowercase sha256 hex digest' };
    }
    if (!input.artifact || !input.packageRef || !input.mandateId) {
      return { ok: false, reason: 'mandateId, artifact, and packageRef are required' };
    }
    if (!Array.isArray(input.parties) || input.parties.length !== 2 || input.parties[0] === input.parties[1]) {
      return { ok: false, reason: 'parties must be two DISTINCT agent fingerprints [ownerFp, peerFp]' };
    }
    const id = input.id ?? (this.d.genId ? this.d.genId() : `rex-${Math.random().toString(36).slice(2, 10)}`);
    if (this.get(id)) return { ok: false, reason: `exchange "${id}" already exists` };
    const now = this.nowIso();
    const record: ReviewExchangeRecord = {
      id, mandateId: input.mandateId, artifact: input.artifact,
      packageRef: input.packageRef, packageSha256: input.packageSha256,
      parties: input.parties, state: 'proposed',
      deliveredEvidence: null, peerVerdict: null, signatures: [],
      createdAt: now, updatedAt: now,
    };
    return { ok: true, record: this.save(record) };
  }

  /** proposed → delivered. Records the delivery evidence (Threadline message ref). */
  markDelivered(id: string, evidence: string): ExchangeResult {
    const record = this.get(id);
    if (!record) return { ok: false, reason: `exchange "${id}" not found` };
    if (record.state !== 'proposed') {
      return { ok: false, reason: `cannot mark delivered from state "${record.state}" (must be "proposed")` };
    }
    if (!evidence) return { ok: false, reason: 'delivery evidence is required' };
    record.state = 'delivered';
    record.deliveredEvidence = evidence;
    return { ok: true, record: this.save(record) };
  }

  /**
   * delivered → verdict-recorded | changes-requested.
   *
   * Records the PEER's authenticated verdict. An 'approve' verdict IS the peer's
   * sign-off, so it is MANDATE-GATED for the peer's fingerprint (named party,
   * bounds, expiry, revocation — a deny refuses the verdict). A 'request-changes'
   * verdict delegates nothing (it is a refusal), so it is recorded ungated — but
   * only from the exchange's named peer.
   */
  recordPeerVerdict(
    id: string,
    input: { verdict: 'approve' | 'request-changes'; summary: string; evidence: string; peerFp: string },
  ): ExchangeResult {
    const record = this.get(id);
    if (!record) return { ok: false, reason: `exchange "${id}" not found` };
    if (record.state !== 'delivered') {
      return { ok: false, reason: `cannot record a verdict from state "${record.state}" (must be "delivered")` };
    }
    if (input.peerFp !== record.parties[1]) {
      return { ok: false, reason: `agent ${input.peerFp} is not the named peer reviewer of this exchange` };
    }
    if (!input.evidence || !input.summary) {
      return { ok: false, reason: 'verdict summary and authenticated evidence ref are required' };
    }
    const verdict: PeerVerdict = {
      verdict: input.verdict, summary: input.summary,
      evidence: input.evidence, recordedAt: this.nowIso(),
    };
    if (input.verdict === 'request-changes') {
      record.state = 'changes-requested';
      record.peerVerdict = verdict;
      return { ok: true, record: this.save(record) };
    }
    // approve = the peer's sign-off → through the mandate gate.
    const decision = this.gateSignOff(record, input.peerFp);
    if (decision.decision === 'deny') {
      return { ok: false, reason: `mandate denied the peer sign-off: ${decision.reason}` };
    }
    record.state = 'verdict-recorded';
    record.peerVerdict = verdict;
    record.signatures.push({
      agentFp: input.peerFp, signedAt: this.nowIso(),
      kind: 'authenticated-peer-verdict', auditHash: decision.audit.hash,
      evidence: input.evidence,
    });
    return { ok: true, record: this.save(record) };
  }

  /**
   * verdict-recorded → complete. The OWNER's countersignature, mandate-gated for
   * the owner's fingerprint. Completion requires the mutual pair: the peer's
   * approve-signature already present + this one.
   */
  sign(id: string, agentFp: string): ExchangeResult {
    const record = this.get(id);
    if (!record) return { ok: false, reason: `exchange "${id}" not found` };
    if (record.state !== 'verdict-recorded') {
      return { ok: false, reason: `cannot sign from state "${record.state}" (must be "verdict-recorded")` };
    }
    if (agentFp !== record.parties[0]) {
      return { ok: false, reason: `agent ${agentFp} is not the named owner of this exchange` };
    }
    if (record.signatures.some((s) => s.agentFp === agentFp)) {
      return { ok: false, reason: 'owner has already signed this exchange' };
    }
    const decision = this.gateSignOff(record, agentFp);
    if (decision.decision === 'deny') {
      return { ok: false, reason: `mandate denied the owner sign-off: ${decision.reason}` };
    }
    record.signatures.push({
      agentFp, signedAt: this.nowIso(),
      kind: 'mandate-gated-local', auditHash: decision.audit.hash,
      evidence: null,
    });
    // Mutual bound satisfied: both named parties have gate-authorized signatures.
    record.state = 'complete';
    return { ok: true, record: this.save(record) };
  }

  get(id: string): ReviewExchangeRecord | undefined {
    return this.readAll().find((r) => r.id === id);
  }

  list(): ReviewExchangeRecord[] {
    return this.readAll();
  }
}
