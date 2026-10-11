/**
 * A2A local-route signed envelope (docs/specs/a2a-local-route-signed-envelope.md, ACT-067).
 *
 * The same-machine route (`POST /messages/relay-agent`) takes the sender's
 * name from the request body on faith. This module is the proof: the sender
 * signs the envelope's canonical bytes with its Ed25519 identity key, and the
 * receiver verifies that signature against the public key IT holds for the
 * sender NAME — its registry (`{stateDir}/threadline/known-agents.json`), or,
 * when the registry has none, a key it fetched itself on first contact into a
 * process-local cache. The body never chooses the key.
 *
 * Dev-gated, dry-run first (`threadline.localRouteSignature`): `off` does not
 * look at the field; `dry-run` verifies, counts and logs, and changes nothing;
 * `enforcing` refuses an unproven envelope before anything records it.
 * Senders are not gated: they sign whenever they have an identity.
 *
 * This module writes no file. All of its state is in memory and per process.
 */

import fs from 'node:fs';
import path from 'node:path';
import { sign, verify } from './ThreadlineCrypto.js';
import { computeFingerprint } from './client/MessageEncryptor.js';
import { canonicalJSON } from '../messaging/AgentTokenManager.js';
import { resolveDevAgentGate } from '../core/devAgentGate.js';
import { listAgents } from '../core/AgentRegistry.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { IdentityManager } from './client/IdentityManager.js';
import { maybeRotateJsonl } from '../utils/jsonl-rotation.js';

/** Domain separation: a local-envelope signature verifies nowhere else, and vice versa. */
export const LOCAL_ENVELOPE_SIGNATURE_DOMAIN = 'instar-a2a-local-envelope-v1\n';
export const LOCAL_ENVELOPE_SIGNATURE_VERSION = 'v1';
const FEATURE = 'Threadline.localRouteSignature';

const MAX_KNOWN_AGENTS_BYTES = 1_000_000;
const MAX_SIGNED_BYTES = 1_000_000;
const MAX_DEPTH = 64;
const MAX_NONCE_CHARS = 256;
export const FRESH_PAST_MS = 10 * 60_000;
export const FRESH_FUTURE_MS = 2 * 60_000;
export const REPLAY_TTL_MS = 12 * 60_000;
export const REPLAY_MAX_TOTAL = 4096;
export const REPLAY_MAX_PER_SENDER = 512;
export const PROBE_TIMEOUT_MS = 2500;
export const PROBE_MAX_FAILURES = 5;
export const PROBE_MAX_NAMES = 64;
const PROBE_BASE_BACKOFF_MS = 60_000;
/** A closed name is probed again at most this often, so a run of failures never shuts a peer out for the process lifetime. */
export const PROBE_CLOSED_RETRY_MS = 60 * 60_000;
const MAX_SENDER_COUNTERS = 64;
const LOG_LIMIT_KEYS = 256;
const LOG_LIMIT_WINDOW_MS = 60_000;

// ─── Mode ───────────────────────────────────────────────────────────────────

export type LocalRouteSignatureMode = 'off' | 'dry-run' | 'enforcing';

interface ModeConfigShape {
  developmentAgent?: boolean;
  threadline?: { localRouteSignature?: { enabled?: boolean; dryRun?: boolean } };
}

/**
 * The live mode (spec §2). `enabled` omitted ⇒ the developmentAgent gate
 * decides; only an explicit `dryRun: false` leaves dry-run.
 */
export function resolveLocalRouteSignatureMode(
  live: { enabled?: boolean; dryRun?: boolean },
  config: ModeConfigShape,
): LocalRouteSignatureMode {
  const block = config.threadline?.localRouteSignature;
  if (!resolveDevAgentGate(live.enabled ?? block?.enabled, config)) return 'off';
  return (live.dryRun ?? block?.dryRun) === false ? 'enforcing' : 'dry-run';
}

// ─── Reasons ────────────────────────────────────────────────────────────────

export type LocalEnvelopeRefusalReason =
  | 'unsigned'
  | 'malformed'
  | 'stale'
  | 'wrong-recipient'
  | 'unknown-sender'
  | 'ambiguous-sender'
  | 'registry-unavailable'
  | 'fingerprint-mismatch'
  | 'signature-invalid'
  | 'replay'
  | 'replay-cache-full'
  /** The request required the proof (`X-Instar-Require-Signature`) and this receiver is not enforcing. */
  | 'not-enforcing';

/** Per reason: can an identical resend ever succeed, and whose move is it. */
export const LOCAL_ENVELOPE_REASONS: Readonly<Record<LocalEnvelopeRefusalReason, { retryable: boolean; remedy: 'sender' | 'receiver' }>> = {
  'unsigned': { retryable: false, remedy: 'sender' },
  'malformed': { retryable: false, remedy: 'sender' },
  'stale': { retryable: false, remedy: 'sender' },
  'wrong-recipient': { retryable: false, remedy: 'sender' },
  'unknown-sender': { retryable: true, remedy: 'receiver' },
  'ambiguous-sender': { retryable: true, remedy: 'receiver' },
  'registry-unavailable': { retryable: true, remedy: 'receiver' },
  'fingerprint-mismatch': { retryable: false, remedy: 'sender' },
  'signature-invalid': { retryable: false, remedy: 'sender' },
  'replay': { retryable: false, remedy: 'sender' },
  'replay-cache-full': { retryable: true, remedy: 'receiver' },
  'not-enforcing': { retryable: true, remedy: 'receiver' },
};

/** A sender that must never deliver an unproven message sends this header with value `v1`. */
export const REQUIRE_SIGNATURE_HEADER = 'x-instar-require-signature';

export interface LocalEnvelopeRefusalBody {
  error: 'bad-signature';
  refused: true;
  retryable: boolean;
  remedy: 'sender' | 'receiver';
  reason: LocalEnvelopeRefusalReason;
}

/** The 401 body (no key material, no registry contents). */
export function localEnvelopeRefusalBody(reason: LocalEnvelopeRefusalReason): LocalEnvelopeRefusalBody {
  const r = LOCAL_ENVELOPE_REASONS[reason];
  return { error: 'bad-signature', refused: true, retryable: r.retryable, remedy: r.remedy, reason };
}

// ─── Counters (ONE process-level object: route, MessageRouter and drop pickup all write) ──

export interface LocalRouteSignatureCounters {
  verified: number;
  verifiedBySender: Record<string, number>;
  wouldRefuse: number;
  refused: number;
  byReason: Record<LocalEnvelopeRefusalReason, number>;
  errors: number;
  probed: number;
  probeFailed: number;
  probeClosed: number;
  dropsVerified: number;
  dropsHeld: number;
  dropsExpired: number;
  signed: number;
  signFailures: number;
  signRefusedForeignFrom: number;
  localRefused: number;
  /** Audit-log appends that failed: non-zero makes the rollout reading unknown. */
  auditWriteFailures: number;
}

function freshCounters(): LocalRouteSignatureCounters {
  const byReason = Object.fromEntries(Object.keys(LOCAL_ENVELOPE_REASONS).map(r => [r, 0])) as Record<LocalEnvelopeRefusalReason, number>;
  return {
    verified: 0, verifiedBySender: {}, wouldRefuse: 0, refused: 0, byReason, errors: 0,
    probed: 0, probeFailed: 0, probeClosed: 0,
    dropsVerified: 0, dropsHeld: 0, dropsExpired: 0,
    signed: 0, signFailures: 0, signRefusedForeignFrom: 0, localRefused: 0, auditWriteFailures: 0,
  };
}

export const localRouteSignatureCounters: LocalRouteSignatureCounters = freshCounters();
/** When this process started counting (the block's `since`). */
export let localRouteSignatureCountersSince = new Date().toISOString();

// ─── Audit log: the rollout evidence that survives restarts (spec §9) ──────

export const LOCAL_ROUTE_SIGNATURE_AUDIT_FILENAME = 'relay-agent-signature.jsonl';
const AUDIT_MAX_BYTES = 2 * 1024 * 1024;
const AUDIT_KEEP_RATIO = 0.5;

export interface LocalRouteSignatureAuditRow {
  source: 'route' | 'drop';
  mode: 'off' | 'dry-run' | 'enforcing';
  outcome: 'verified' | 'would-refuse' | 'refused' | 'held' | 'expired';
  from: string | null;
  reason?: LocalEnvelopeRefusalReason | 'error';
}

export function localRouteSignatureAuditPath(stateDir: string): string {
  return path.join(stateDir, 'logs', LOCAL_ROUTE_SIGNATURE_AUDIT_FILENAME);
}

/**
 * Append ONE metadata-only row per verdict (never message text, a key or a
 * nonce). Mode 0600, bounded on the append path, never throws: an audit fault
 * never changes a verdict. A 24-hour reading counts rows by `ts`; a window the
 * file does not cover reads as unknown.
 */
export function appendLocalRouteSignatureAudit(stateDir: string, row: LocalRouteSignatureAuditRow, now: number = Date.now()): void {
  try {
    const logPath = localRouteSignatureAuditPath(stateDir);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    if (maybeRotateJsonl(logPath, { maxBytes: AUDIT_MAX_BYTES, keepRatio: AUDIT_KEEP_RATIO })) {
      try { fs.chmodSync(logPath, 0o600); } catch { /* best-effort */ }
    }
    const line = JSON.stringify({
      ts: new Date(now).toISOString(),
      source: row.source,
      mode: row.mode,
      outcome: row.outcome,
      from: logSafe(row.from),
      ...(row.reason ? { reason: row.reason } : {}),
    });
    fs.appendFileSync(logPath, line + '\n', { mode: 0o600 });
  } catch {
    // @silent-fallback-ok — the audit log is evidence, never a gate; the failure is counted.
    localRouteSignatureCounters.auditWriteFailures++;
  }
}

// ─── Canonical bytes ────────────────────────────────────────────────────────

/** The envelope shape this module reads. Everything else on the wire is ignored. */
export interface LocalEnvelopeLike {
  message?: unknown;
  transport?: { nonce?: unknown; timestamp?: unknown; relayChain?: unknown; originServer?: unknown; originTopicId?: unknown } | null;
  signature?: unknown;
}

function depthWithin(value: unknown, limit: number): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (limit <= 0) return false;
  for (const v of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) {
    if (!depthWithin(v, limit - 1)) return false;
  }
  return true;
}

/**
 * The exact bytes a local-envelope signature covers, or null when a bound is
 * exceeded (nesting over 64 levels, or over 1 MB serialised). The signed set
 * is JSON-round-tripped first, so the sender signs what the wire will carry
 * and the receiver canonicalises what `express.json` parsed.
 */
export function localEnvelopeSignedBytes(envelope: LocalEnvelopeLike): Buffer | null {
  const t = envelope.transport ?? {};
  // Every transport field a sender sets. hmac/hmacBy and the cross-machine
  // signature fields are added after signing and stay outside.
  const signedSet = {
    message: envelope.message,
    transport: { nonce: t.nonce, timestamp: t.timestamp, relayChain: t.relayChain, originServer: t.originServer, originTopicId: t.originTopicId },
  };
  // Depth first, so a hostile body never reaches a recursive serialiser.
  if (!depthWithin(signedSet, MAX_DEPTH)) return null;
  let wire: unknown;
  try {
    const json = JSON.stringify(signedSet);
    if (Buffer.byteLength(json, 'utf8') > MAX_SIGNED_BYTES) return null;
    wire = JSON.parse(json);
  } catch {
    return null;
  }
  return Buffer.from(LOCAL_ENVELOPE_SIGNATURE_DOMAIN + canonicalJSON(wire), 'utf8');
}

/** Sign with a raw 32-byte Ed25519 private key; base64, or null when a bound is exceeded. */
export function signLocalEnvelope(envelope: LocalEnvelopeLike, privateKey: Buffer): string | null {
  const bytes = localEnvelopeSignedBytes(envelope);
  return bytes ? sign(privateKey, bytes).toString('base64') : null;
}

function decodeSignature(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const buf = Buffer.from(value, 'base64');
  return buf.length === 64 ? buf : null;
}

/** Verify an envelope's `signature` against a raw 32-byte Ed25519 public key. */
export function verifyLocalEnvelope(envelope: LocalEnvelopeLike, publicKey: Buffer): boolean {
  const sig = decodeSignature(envelope.signature);
  if (!sig || publicKey.length !== 32) return false;
  const bytes = localEnvelopeSignedBytes(envelope);
  if (!bytes) return false;
  try { return verify(publicKey, bytes, sig); } catch { return false; }
}

// ─── Key source: the registry, by name ─────────────────────────────────────

export type RegistryKeyLookup =
  | { kind: 'found'; publicKey: Buffer }
  | { kind: 'none' }
  | { kind: 'ambiguous' }
  | { kind: 'unavailable' };

/** One parsed read of the registry, shareable across several lookups (drop pickup). */
export type RegistrySnapshot = { ok: true; agents: Array<{ name?: unknown; publicKey?: unknown }> } | { ok: false };

export function readRegistrySnapshot(stateDir: string): RegistrySnapshot {
  const filePath = path.join(stateDir, 'threadline', 'known-agents.json');
  try {
    if (!fs.existsSync(filePath)) return { ok: true, agents: [] };
    if (fs.statSync(filePath).size > MAX_KNOWN_AGENTS_BYTES) return { ok: false };
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return { ok: true, agents: Array.isArray(data?.agents) ? data.agents : [] };
  } catch {
    return { ok: false };
  }
}

function usableKeyHex(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;
}

/**
 * The ONE key the registry holds for a sender name: exactly one distinct
 * 64-hex key under the name (case-insensitive), not also held under another
 * name. The entry's stored `fingerprint` field is never read.
 */
export function lookupRegistryKeyByName(snapshot: RegistrySnapshot, name: string): RegistryKeyLookup {
  if (!snapshot.ok) return { kind: 'unavailable' };
  const lower = name.toLowerCase();
  const mine = new Set<string>();
  const others = new Set<string>();
  for (const a of snapshot.agents) {
    if (!a || typeof a.name !== 'string') continue;
    const key = usableKeyHex(a.publicKey);
    if (!key) continue;
    (a.name.toLowerCase() === lower ? mine : others).add(key);
  }
  if (mine.size === 0) return { kind: 'none' };
  if (mine.size > 1) return { kind: 'ambiguous' };
  const [key] = [...mine];
  if (others.has(key)) return { kind: 'ambiguous' };
  return { kind: 'found', publicKey: Buffer.from(key, 'hex') };
}

/** Does the registry hold this key under a name other than `name`? */
export function registryHoldsKeyUnderOtherName(snapshot: RegistrySnapshot, name: string, publicKey: Buffer): boolean {
  if (!snapshot.ok) return false;
  const lower = name.toLowerCase();
  const hex = publicKey.toString('hex');
  return snapshot.agents.some(a => !!a && typeof a.name === 'string' && a.name.toLowerCase() !== lower && usableKeyHex(a.publicKey) === hex);
}

// ─── First contact: fetch a missing key into memory ────────────────────────

type ProbeResult = { kind: 'key'; publicKey: Buffer } | { kind: 'none' } | { kind: 'ambiguous' };

interface ProbeEntry {
  failures: number;
  nextAttemptAt: number;
  closed: boolean;
  inFlight: Promise<ProbeResult> | null;
}

export interface FirstContactDeps {
  /** Running AgentRegistry entries (name + port). */
  listRunning: () => Array<{ name: string; port: number }>;
  /** GET the peer's /threadline/health; resolves the parsed JSON or throws. */
  fetchHealth: (port: number, timeoutMs: number) => Promise<unknown>;
  now: () => number;
  report: (reason: string, impact: string) => void;
}

const defaultFirstContactDeps: FirstContactDeps = {
  listRunning: () => listAgents({ status: 'running' }).map(a => ({ name: a.name, port: a.port })),
  fetchHealth: async (port, timeoutMs) => {
    const res = await fetch(`http://localhost:${port}/threadline/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`health ${res.status}`);
    return res.json();
  },
  now: () => Date.now(),
  report: (reason, impact) => {
    DegradationReporter.getInstance().report({
      feature: FEATURE,
      primary: 'Verify a same-machine sender against the key held for its name',
      fallback: 'The sender stays unproven on the local route',
      reason,
      impact,
    });
  },
};

/** The process-local first-contact cache + probe ladder (spec §3). */
export class FirstContactKeys {
  private readonly keys = new Map<string, Buffer>();
  private readonly probes = new Map<string, ProbeEntry>();
  constructor(private readonly deps: FirstContactDeps = defaultFirstContactDeps) {}

  get size(): number { return this.keys.size; }
  get(name: string): Buffer | null { return this.keys.get(name.toLowerCase()) ?? null; }

  /** Does the cache hold this key under a name other than `name`? */
  holdsKeyUnderOtherName(name: string, publicKey: Buffer): boolean {
    const lower = name.toLowerCase();
    for (const [n, k] of this.keys) if (n !== lower && k.equals(publicKey)) return true;
    return false;
  }

  /**
   * The key for a name the registry holds none for: the cached one, else one
   * bounded probe. The cache records what the name's registered port
   * ADVERTISED; the envelope's signature is what proves the sender holds it.
   * Never replaces a key it holds. The probe runs BEFORE the signature can be
   * checked (there is no key yet), so any signed-looking envelope under an
   * unknown name can spend a probe; that is why a closed name reopens.
   */
  async resolve(name: string, allowProbe = true): Promise<ProbeResult> {
    const lower = name.toLowerCase();
    const cached = this.keys.get(lower);
    if (cached) return { kind: 'key', publicKey: cached };
    if (!allowProbe) return { kind: 'none' };

    const existing = this.probes.get(lower);
    if (existing?.inFlight) return existing.inFlight;
    if (existing && this.deps.now() < existing.nextAttemptAt) return { kind: 'none' };

    let running: Array<{ name: string; port: number }>;
    try { running = this.deps.listRunning().filter(a => typeof a.name === 'string' && a.name.toLowerCase() === lower); } catch { return { kind: 'none' }; }
    if (running.length === 0) return { kind: 'none' };
    if (running.length > 1) return { kind: 'ambiguous' };
    if (!existing && this.probes.size >= PROBE_MAX_NAMES) return { kind: 'none' };

    const entry: ProbeEntry = existing ?? { failures: 0, nextAttemptAt: 0, closed: false, inFlight: null };
    this.probes.set(lower, entry);
    entry.inFlight = this.probe(lower, running[0].port, entry).finally(() => { entry.inFlight = null; });
    return entry.inFlight;
  }

  private async probe(lower: string, port: number, entry: ProbeEntry): Promise<ProbeResult> {
    localRouteSignatureCounters.probed++;
    let key: Buffer | null = null;
    try {
      const h = await this.deps.fetchHealth(port, PROBE_TIMEOUT_MS) as { protocol?: unknown; identityPub?: unknown; agent?: unknown; fingerprint?: unknown } | null;
      const hex = usableKeyHex(h?.identityPub);
      if (h && h.protocol === 'threadline' && hex && typeof h.agent === 'string' && h.agent.toLowerCase() === lower) {
        const candidate = Buffer.from(hex, 'hex');
        const fpOk = h.fingerprint === undefined || h.fingerprint === null
          || (typeof h.fingerprint === 'string' && h.fingerprint.toLowerCase() === computeFingerprint(candidate));
        if (fpOk) key = candidate;
      }
    } catch { /* a failed probe — charged below */ }

    // One key answering for two names (a cloned agent home): a FAILED probe,
    // so the ladder applies and a colliding name is not probed per message.
    const collides = !!key && this.holdsKeyUnderOtherName(lower, key);
    if (key && !collides) {
      // Single-flight: no other probe ran for this name. A held key is never replaced.
      if (!this.keys.has(lower)) {
        this.keys.set(lower, key);
        console.log(`[relay-agent-signature] first-contact key for ${logSafe(lower)} fp=${computeFingerprint(key).slice(0, 12)}`);
      }
      this.probes.delete(lower);
      return { kind: 'key', publicKey: this.keys.get(lower)! };
    }
    localRouteSignatureCounters.probeFailed++;
    entry.failures++;
    entry.nextAttemptAt = this.deps.now() + (entry.failures >= PROBE_MAX_FAILURES
      ? PROBE_CLOSED_RETRY_MS
      : PROBE_BASE_BACKOFF_MS * 2 ** (entry.failures - 1));
    if (entry.failures >= PROBE_MAX_FAILURES && !entry.closed) {
      // Closed: one probe an hour from here on, and ONE report for the process.
      entry.closed = true;
      localRouteSignatureCounters.probeClosed++;
      try {
        this.deps.report(
          `first-contact key fetch for same-machine sender "${logSafe(lower)}" failed ${PROBE_MAX_FAILURES} times`,
          'Its local-route messages stay unproven (refused when enforcing) until a later hourly retry succeeds or threadline_discover records its key',
        );
      } catch { /* reporting never affects the verdict */ }
    }
    return collides ? { kind: 'ambiguous' } : { kind: 'none' };
  }
}

// ─── Replay cache ───────────────────────────────────────────────────────────

/** (proven fingerprint, nonce) → expiry. Refuses at a bound; never evicts a live entry. */
export class ReplayCache {
  private readonly bySender = new Map<string, Map<string, number>>();
  private total = 0;

  get size(): number { return this.total; }

  private sweep(now: number): void {
    for (const [fp, nonces] of this.bySender) {
      for (const [nonce, exp] of nonces) {
        if (exp <= now) { nonces.delete(nonce); this.total--; }
      }
      if (nonces.size === 0) this.bySender.delete(fp);
    }
  }

  /** Record a verified envelope's nonce, or say why it cannot be admitted. */
  check(fingerprint: string, nonce: string, now: number): 'ok' | 'replay' | 'replay-cache-full' {
    let nonces = this.bySender.get(fingerprint);
    const seen = nonces?.get(nonce);
    if (seen !== undefined && seen > now) return 'replay';
    if (this.total >= REPLAY_MAX_TOTAL || (nonces?.size ?? 0) >= REPLAY_MAX_PER_SENDER) {
      this.sweep(now);
      nonces = this.bySender.get(fingerprint);
    }
    if (this.total >= REPLAY_MAX_TOTAL || (nonces?.size ?? 0) >= REPLAY_MAX_PER_SENDER) {
      // The bound doing its job: counted by the caller (byReason), not a degradation.
      return 'replay-cache-full';
    }
    if (!nonces) { nonces = new Map(); this.bySender.set(fingerprint, nonces); }
    if (!nonces.has(nonce)) this.total++;
    nonces.set(nonce, now + REPLAY_TTL_MS);
    return 'ok';
  }
}

// ─── The verdict ────────────────────────────────────────────────────────────

export type LocalEnvelopeVerdict =
  | { ok: true; fingerprint: string; senderName: string }
  | { ok: false; reason: LocalEnvelopeRefusalReason; senderName: string | null };

export interface LocalEnvelopeVerifier {
  firstContact: FirstContactKeys;
  replay: ReplayCache;
}

export function createLocalEnvelopeVerifier(deps?: Partial<FirstContactDeps>): LocalEnvelopeVerifier {
  const merged: FirstContactDeps = {
    listRunning: deps?.listRunning ?? defaultFirstContactDeps.listRunning,
    fetchHealth: deps?.fetchHealth ?? defaultFirstContactDeps.fetchHealth,
    now: deps?.now ?? defaultFirstContactDeps.now,
    report: deps?.report ?? defaultFirstContactDeps.report,
  };
  return { firstContact: new FirstContactKeys(merged), replay: new ReplayCache() };
}

/** The process-level verifier the route and drop pickup share. */
export const localEnvelopeVerifier: LocalEnvelopeVerifier = createLocalEnvelopeVerifier();

export interface VerifyOptions {
  stateDir: string;
  /** This agent's name; `message.to.agent` must equal it. */
  selfName: string;
  now?: number;
  /** Drop pickup: a drop is old by nature — skip the freshness bound and the replay cache. */
  offline?: boolean;
  /** Drop pickup: one registry read for the whole pass. */
  registry?: RegistrySnapshot;
  /** Drop pickup's boot pass: peers are not listening yet — never probe. Default true. */
  allowProbe?: boolean;
  verifier?: LocalEnvelopeVerifier;
}

/**
 * The receiver's verdict on one local envelope (spec §3–§5). Cheap checks run
 * first with no I/O, so unsigned traffic never reads the registry or probes.
 */
export async function verifyLocalRouteEnvelope(envelope: LocalEnvelopeLike, opts: VerifyOptions): Promise<LocalEnvelopeVerdict> {
  const v = opts.verifier ?? localEnvelopeVerifier;
  const now = opts.now ?? Date.now();
  const msg = (envelope?.message ?? null) as { from?: { agent?: unknown; fingerprint?: unknown }; to?: { agent?: unknown } } | null;
  const rawName = msg?.from?.agent;
  const senderName = typeof rawName === 'string' && rawName.length > 0 ? rawName : null;
  const fail = (reason: LocalEnvelopeRefusalReason): LocalEnvelopeVerdict => ({ ok: false, reason, senderName });

  if (envelope?.signature === undefined || envelope.signature === null) return fail('unsigned');
  const transport = envelope.transport ?? null;
  const nonce = transport?.nonce;
  const timestamp = transport?.timestamp;
  if (!decodeSignature(envelope.signature) || !senderName
    || typeof nonce !== 'string' || nonce.length === 0 || nonce.length > MAX_NONCE_CHARS
    || typeof timestamp !== 'string'
    || !localEnvelopeSignedBytes(envelope)) {
    return fail('malformed');
  }
  const to = msg?.to?.agent;
  if (typeof to !== 'string' || to.toLowerCase() !== opts.selfName.toLowerCase()) return fail('wrong-recipient');
  if (!opts.offline) {
    const at = Date.parse(timestamp);
    if (!Number.isFinite(at) || at < now - FRESH_PAST_MS || at > now + FRESH_FUTURE_MS) return fail('stale');
  }

  const snapshot = opts.registry ?? readRegistrySnapshot(opts.stateDir);
  const lookup = lookupRegistryKeyByName(snapshot, senderName);
  if (lookup.kind === 'unavailable') return fail('registry-unavailable');
  if (lookup.kind === 'ambiguous') return fail('ambiguous-sender');
  let publicKey: Buffer;
  if (lookup.kind === 'found') {
    publicKey = lookup.publicKey;
  } else {
    const fc = await v.firstContact.resolve(senderName, opts.allowProbe !== false);
    if (fc.kind === 'ambiguous') return fail('ambiguous-sender');
    if (fc.kind === 'none') return fail('unknown-sender');
    publicKey = fc.publicKey;
    if (registryHoldsKeyUnderOtherName(snapshot, senderName, publicKey)) return fail('ambiguous-sender');
  }
  // One key under two names, across both sources.
  if (v.firstContact.holdsKeyUnderOtherName(senderName, publicKey)) return fail('ambiguous-sender');

  const fingerprint = computeFingerprint(publicKey);
  const claimed = msg?.from?.fingerprint;
  if (claimed !== undefined && claimed !== null && (typeof claimed !== 'string' || claimed.toLowerCase() !== fingerprint)) {
    return fail('fingerprint-mismatch');
  }
  // A bad signature changes nothing: it evicts no key, triggers no probe and
  // does not count against the name, so a forgery cannot lock the sender out.
  if (!verifyLocalEnvelope(envelope, publicKey)) return fail('signature-invalid');
  if (!opts.offline) {
    const r = v.replay.check(fingerprint, nonce, now);
    if (r !== 'ok') return fail(r);
  }
  return { ok: true, fingerprint, senderName };
}

/** Record a route verdict on the counters and in the audit log (never throws). */
export function countLocalEnvelopeVerdict(mode: LocalRouteSignatureMode, verdict: LocalEnvelopeVerdict, stateDir?: string): void {
  const c = localRouteSignatureCounters;
  if (verdict.ok) {
    c.verified++;
    const key = logSafe(verdict.senderName.toLowerCase());
    if (key in c.verifiedBySender || Object.keys(c.verifiedBySender).length < MAX_SENDER_COUNTERS) {
      c.verifiedBySender[key] = (c.verifiedBySender[key] ?? 0) + 1;
    }
  } else {
    if (mode === 'enforcing' || verdict.reason === 'not-enforcing') c.refused++; else c.wouldRefuse++;
    c.byReason[verdict.reason] = (c.byReason[verdict.reason] ?? 0) + 1;
  }
  if (stateDir) {
    appendLocalRouteSignatureAudit(stateDir, {
      source: 'route',
      mode,
      outcome: verdict.ok ? 'verified' : (mode === 'enforcing' || verdict.reason === 'not-enforcing') ? 'refused' : 'would-refuse',
      from: verdict.senderName,
      ...(verdict.ok ? {} : { reason: verdict.reason }),
    });
  }
}

// ─── Log line ───────────────────────────────────────────────────────────────

/** Peer-supplied text is never logged raw: printable ASCII only, bounded. */
export function logSafe(value: string | null): string {
  return (value ?? '').replace(/[^\x21-\x7e]/g, '?').slice(0, 48) || 'unknown';
}

const logLimiter = new Map<string, number>();

/**
 * The server-log line for a non-passing verdict, or null when one was already
 * written for this (name, reason) in the last minute. The limiter holds at
 * most 256 keys; past that, lines share one bucket.
 */
export function localEnvelopeRefusalLogLine(
  kind: 'would-refuse' | 'refuse',
  senderName: string | null,
  reason: LocalEnvelopeRefusalReason,
  now: number = Date.now(),
): string | null {
  const name = logSafe(senderName);
  let key = `${name}|${reason}`;
  if (!logLimiter.has(key) && logLimiter.size >= LOG_LIMIT_KEYS) {
    for (const [k, at] of logLimiter) if (now - at >= LOG_LIMIT_WINDOW_MS) logLimiter.delete(k);
    if (logLimiter.size >= LOG_LIMIT_KEYS) key = '*overflow*';
  }
  const last = logLimiter.get(key);
  if (last !== undefined && now - last < LOG_LIMIT_WINDOW_MS) return null;
  logLimiter.set(key, now);
  return `[relay-agent-signature] ${kind} from=${name} reason=${reason}`;
}

// ─── Sender side ────────────────────────────────────────────────────────────

/** An outbound signer: the base64 signature, or null when this agent cannot sign the envelope. */
export type LocalEnvelopeSigner = (envelope: LocalEnvelopeLike) => string | null;

let noIdentityReported = false;

/**
 * Build a signer over an identity reader (consulted per call: an identity
 * provisioned after boot is picked up; a locked one yields null). The signer
 * never lends this agent's signature to another name: `message.from.agent`
 * must equal `localAgent`.
 */
export function createLocalEnvelopeSigner(
  localAgent: string,
  readIdentity: () => { privateKey: Buffer } | null,
  report: (reason: string, impact: string) => void = defaultFirstContactDeps.report,
): LocalEnvelopeSigner {
  return (envelope) => {
    const c = localRouteSignatureCounters;
    const from = (envelope?.message as { from?: { agent?: unknown } } | undefined)?.from?.agent;
    if (typeof from !== 'string' || from.toLowerCase() !== localAgent.toLowerCase()) {
      c.signRefusedForeignFrom++;
      return null;
    }
    let sig: string | null = null;
    try {
      const id = readIdentity();
      if (id?.privateKey && id.privateKey.length === 32) sig = signLocalEnvelope(envelope, id.privateKey);
      else if (!noIdentityReported) {
        noIdentityReported = true;
        try {
          report(
            'no usable agent identity to sign same-machine envelopes (none on disk, or locked)',
            'Local-route sends leave unsigned; a peer that enforces the signature refuses them',
          );
        } catch { /* reporting never affects the send */ }
      }
    } catch { /* counted below */ }
    if (sig) c.signed++; else c.signFailures++;
    return sig;
  };
}

/**
 * THE production signer: over the agent's Threadline identity (the key
 * `/threadline/health` publishes as `identityPub`) — never the machine
 * identity, which is a different key. `server.ts`, the relay-send name path
 * and the tests all build their signer here.
 */
export function createAgentLocalEnvelopeSigner(localAgent: string, stateDir: string): LocalEnvelopeSigner {
  // A fresh reader per sign: IdentityManager caches the first identity it
  // loads, and /threadline/health builds a fresh one per request — a cached
  // signer would keep signing with a key the agent no longer advertises.
  return createLocalEnvelopeSigner(localAgent, () => new IdentityManager(stateDir).get());
}

/**
 * Does this request REQUIRE the proof? Any non-empty X-Instar-Require-Signature
 * value is a requirement; one this receiver cannot meet (a version other than
 * the one it implements, or any value while not enforcing) must be refused.
 */
export function requiresUnmetSignature(header: string | string[] | undefined, mode: LocalRouteSignatureMode): boolean {
  const tokens = (Array.isArray(header) ? header.join(',') : header ?? '').split(',').map(t => t.trim()).filter(Boolean);
  if (tokens.length === 0) return false;
  return mode !== 'enforcing' || tokens.some(t => t !== LOCAL_ENVELOPE_SIGNATURE_VERSION);
}

/** Can this agent sign right now? (Evaluated at read time for /health.) */
export function localEnvelopeSignerAvailable(stateDir: string): boolean {
  try { return new IdentityManager(stateDir).get() !== null; } catch { return false; }
}

/** Test seam: reset every piece of process-level state in this module. */
export function resetLocalRouteSignatureStateForTests(): void {
  Object.assign(localRouteSignatureCounters, freshCounters());
  localRouteSignatureCountersSince = new Date().toISOString();
  logLimiter.clear();
  noIdentityReported = false;
  const fresh = createLocalEnvelopeVerifier();
  localEnvelopeVerifier.firstContact = fresh.firstContact;
  localEnvelopeVerifier.replay = fresh.replay;
}
