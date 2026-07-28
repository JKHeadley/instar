/**
 * LiveTestArtifactStore — the durable, signed, hash-chained record a user-role
 * live-test run produces, and the object the completion gate reads (spec
 * docs/specs/live-user-channel-proof-standard.md §4.4). It is the shared contract
 * between the harness (which WRITES it) and the gate (which VERIFIES it).
 *
 * Anti-hallucination (the load-bearing property): the artifact is machine-written
 * and SIGNED, so an agent cannot hand-type a "I tested it" record into its
 * transcript to buy the "done" exit. Concretely:
 *   - the artifact is canonically serialized (sorted keys) and content-hashed;
 *   - the hash is Ed25519-signed by the harness runner identity;
 *   - each machine appends ONLY to its OWN ledger segment
 *     (state/live-test-ledger.<machineId>.jsonl), hash-chained WITHIN the segment,
 *     so cross-machine replication can never fork a shared chain or raise a false
 *     broken-chain veto (§4.4, codex r4);
 *   - the gate re-reads the artifact from disk, recomputes the hash, and checks it
 *     against the ledger entry — the transcript is NEVER the evidence.
 *
 * Threat model (honest, like UnjustifiedStopGate): drift-correction, NOT a security
 * boundary against a deliberately compromised runner. The git-commit anchor (the
 * artifact + ledger are committed as part of the run) is the out-of-band check.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type RiskCategory =
  | 'happy-path'
  | 'channel-parity'
  | 'lifecycle'
  | 'permission-volatile'
  | 'failure-rollback'
  | 'concurrency'
  | 'idempotency'
  | 'regression';

export const REQUIRED_RISK_CATEGORIES: RiskCategory[] = [
  'happy-path', 'channel-parity', 'lifecycle', 'permission-volatile',
  'failure-rollback', 'concurrency', 'idempotency', 'regression',
];

/** A channel feature requires {telegram, slack}; a dashboard feature, dashboard. */
export type Surface = 'telegram' | 'slack' | 'dashboard';
export type ScenarioVerdict = 'PASS' | 'FAIL' | 'BLOCKED';
export type BlockedKind = 'platform-error' | 'platform-outage' | 'operator-waiver' | 'timeout' | 'credential-unavailable';

/** Deterministic protocol evidence captured from the real platform (§4.4). */
export interface ScenarioEvidence {
  messageIds?: string[];
  channelId?: string;
  senderId?: string;
  responderMachineId?: string;
  ownershipSnapshot?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface ScenarioRow {
  id: string;
  description: string;
  surface: Surface;
  riskCategory: RiskCategory;
  verdict: ScenarioVerdict;
  evidence?: ScenarioEvidence;
  /** Required when verdict === 'BLOCKED' — only a machine-verifiable external
   *  blocker is honored (§4.6); a bare BLOCKED counts as FAIL at the gate. */
  blockedKind?: BlockedKind;
  blockedReason?: string;
}

export interface LiveTestArtifact {
  featureId: string;
  runId: string;
  surfaces: Surface[];
  riskCategories: RiskCategory[];
  scenarios: ScenarioRow[];
  createdAt: string; // ISO
  runnerFingerprint: string;
}

export interface LedgerEntry {
  featureId: string;
  runId: string;
  contentHash: string;
  signature: string;
  signerFingerprint: string;
  surfaces: Surface[];
  riskCategories: RiskCategory[];
  createdAt: string;
  /** Hash of the PRIOR entry in THIS machine's segment (null for the first). */
  prevEntryHash: string | null;
}

/** Stable, sorted-key JSON serialization so the content hash is deterministic. */
export function canonicalize(value: unknown): string {
  const seen = new WeakSet();
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) throw new Error('canonicalize: cyclic value');
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(norm);
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = norm(o[k]);
    return out;
  };
  return JSON.stringify(norm(value));
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export interface LiveTestArtifactStoreDeps {
  stateDir: string;
  /** This machine's id — names its ledger segment (no cross-machine concurrent append). */
  machineId: string;
  /** The harness runner identity recorded in the ledger entry. */
  signerFingerprint: string;
  /** Ed25519 sign over a string → base64 signature (e.g. MachineIdentity.sign bound to the key). */
  sign: (data: string) => string;
  /** Verify a base64 signature over a string against the runner's trusted key. */
  verify: (data: string, sig: string) => boolean;
  now?: () => number;
  logger?: (m: string) => void;
}

export interface VerifyResult {
  ok: boolean;
  reason?: 'no-entry' | 'artifact-missing' | 'hash-mismatch' | 'bad-signature';
  entry?: LedgerEntry;
  artifact?: LiveTestArtifact;
}

export class LiveTestArtifactStore {
  private readonly d: LiveTestArtifactStoreDeps;

  constructor(deps: LiveTestArtifactStoreDeps) {
    this.d = deps;
  }

  private now(): number { return (this.d.now ?? Date.now)(); }
  private log(m: string): void { this.d.logger?.(`[live-test-artifact] ${m}`); }

  private artifactsDir(): string { return path.join(this.d.stateDir, 'live-test-artifacts'); }
  private artifactPath(featureId: string, runId: string): string {
    const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');
    return path.join(this.artifactsDir(), safe(featureId), `${safe(runId)}.json`);
  }
  private ownSegmentPath(): string {
    const safe = this.d.machineId.replace(/[^A-Za-z0-9._-]/g, '_');
    return path.join(this.d.stateDir, `live-test-ledger.${safe}.jsonl`);
  }

  private writeFileAtomic(fp: string, data: string): void {
    const dir = path.dirname(fp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${fp}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, fp);
  }

  /** Read this machine's ledger segment (own appends only). */
  private readOwnSegment(): LedgerEntry[] {
    return this.readSegmentFile(this.ownSegmentPath());
  }

  private readSegmentFile(fp: string): LedgerEntry[] {
    try {
      if (!fs.existsSync(fp)) return [];
      return fs.readFileSync(fp, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as LedgerEntry);
    } catch {
      return []; // @silent-fallback-ok — an unreadable/corrupt segment yields no entries (not-proven), never a throw
    }
  }

  /**
   * Write a signed artifact + append its hash-chained ledger entry to THIS
   * machine's segment. Returns the ledger entry. The content hash is computed at
   * write-time over the canonical artifact; the signature is over that hash.
   */
  write(artifact: LiveTestArtifact): LedgerEntry {
    const canonical = canonicalize(artifact);
    const contentHash = sha256(canonical);
    const signature = this.d.sign(contentHash);
    this.writeFileAtomic(this.artifactPath(artifact.featureId, artifact.runId), canonical);

    const own = this.readOwnSegment();
    const prevEntryHash = own.length ? sha256(canonicalize(own[own.length - 1])) : null;
    const entry: LedgerEntry = {
      featureId: artifact.featureId,
      runId: artifact.runId,
      contentHash,
      signature,
      signerFingerprint: this.d.signerFingerprint,
      surfaces: artifact.surfaces,
      riskCategories: artifact.riskCategories,
      createdAt: artifact.createdAt,
      prevEntryHash,
    };
    fs.appendFileSync(this.ownSegmentPath(), `${JSON.stringify(entry)}\n`);
    this.log(`wrote artifact ${artifact.featureId}/${artifact.runId} (hash ${contentHash.slice(0, 12)}…, ${artifact.scenarios.length} scenarios)`);
    return entry;
  }

  /** Read the on-disk artifact for an entry (or null). */
  readArtifact(featureId: string, runId: string): LiveTestArtifact | null {
    try {
      const fp = this.artifactPath(featureId, runId);
      if (!fs.existsSync(fp)) return null;
      return JSON.parse(fs.readFileSync(fp, 'utf-8')) as LiveTestArtifact;
    } catch {
      return null; // @silent-fallback-ok — missing/corrupt artifact → null (gate treats as not-proven)
    }
  }

  /** Every ledger entry across ALL machine segments (the derived union, §10). */
  allEntries(): LedgerEntry[] {
    const out: LedgerEntry[] = [];
    try {
      for (const f of fs.readdirSync(this.d.stateDir)) {
        if (/^live-test-ledger\..+\.jsonl$/.test(f)) out.push(...this.readSegmentFile(path.join(this.d.stateDir, f)));
      }
    } catch { /* @silent-fallback-ok — no state dir → no entries */ }
    return out;
  }

  /**
   * Verify a specific {featureId, runId}: the entry exists, the artifact is on
   * disk, its recomputed content hash matches the entry (tamper check), and the
   * signature verifies. This is what the gate calls — the transcript is never the
   * evidence.
   */
  verifyEntry(featureId: string, runId: string): VerifyResult {
    const entry = this.allEntries().find((e) => e.featureId === featureId && e.runId === runId);
    if (!entry) return { ok: false, reason: 'no-entry' };
    const artifact = this.readArtifact(featureId, runId);
    if (!artifact) return { ok: false, reason: 'artifact-missing', entry };
    const recomputed = sha256(canonicalize(artifact));
    if (recomputed !== entry.contentHash) return { ok: false, reason: 'hash-mismatch', entry, artifact };
    if (!this.d.verify(entry.contentHash, entry.signature)) return { ok: false, reason: 'bad-signature', entry, artifact };
    return { ok: true, entry, artifact };
  }

  /** Verify THIS machine's segment hash-chain (a break = tamper signal, §4.4). */
  verifyOwnChain(): { ok: boolean; brokenAtIndex?: number } {
    const seg = this.readOwnSegment();
    for (let i = 1; i < seg.length; i++) {
      const expectedPrev = sha256(canonicalize(seg[i - 1]));
      if (seg[i].prevEntryHash !== expectedPrev) return { ok: false, brokenAtIndex: i };
    }
    return { ok: true };
  }

  /** The freshest VERIFIED entry for a feature across all segments (or null). */
  latestVerified(featureId: string): VerifyResult | null {
    const entries = this.allEntries()
      .filter((e) => e.featureId === featureId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    for (const e of entries) {
      const v = this.verifyEntry(e.featureId, e.runId);
      if (v.ok) return v;
    }
    return entries.length ? this.verifyEntry(entries[0].featureId, entries[0].runId) : null;
  }
}
