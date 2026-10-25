/**
 * The registry client â the ONLY code in this package that talks to a network.
 *
 * A registry helps people find records. The current default server is the one in
 * DEFAULT_REGISTRY below (its home may move; this constant is the only place the
 * address lives). It is never the authority: the signature is. So everything read back
 * from a registry is re-verified here, on this machine, with the same check
 * `witness verify` runs (localverify.ts), and every statement the server makes
 * that this code cannot check for itself is reported under `unverified`.
 *
 * Nothing in this module runs unless one of the four explicit CLI commands
 * (publish, lookup, get, stats) asks for it. Server contract: Dawn's
 * "Witness registry: route shapes" (2026-10-25); the server is built by Dawn.
 *
 *   POST /witness/records            { record, binding }  â 201/200 { ok, recordHash, duplicate?, registered? } | 422 { ok:false, reason }
 *   GET  /witness/records?subject=&issuer=&limit=&cursor=  â { records, bindings, revocations, next? }
 *   GET  /witness/records/:recordHash                      â one record plus its binding, or 404
 *   GET  /witness/stats                                    â { issuers, records, firstSeen }
 *
 * Requests time out, responses are capped in size, and a plain-http registry is
 * accepted only on the loopback interface (a test server), never across a network.
 */

import { bindingHash as computeBindingHash, type KeyBinding } from './binding.js';
import { verifyRecordWithBinding } from './localverify.js';
import { recordHash as computeRecordHash, type WitnessRecord } from './record.js';

export const DEFAULT_REGISTRY = 'https://witness.sagemindai.io';
export const REGISTRY_TIMEOUT_MS = 15_000;
/** A 200-record page with bindings is well under 1 MiB; anything near this is not a registry answer. */
export const REGISTRY_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const LOOKUP_MAX_LIMIT = 200;

export const UNVERIFIED_NOTE =
  'Every record above was re-verified on this machine against the binding the server supplied. ' +
  'Fields under "unverified" are the server\'s word only and were not checked.';

export class RegistryError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** Parse and vet a registry base URL. Plain http is allowed only for loopback hosts. */
export function registryBase(input?: string): URL {
  let url: URL;
  try {
    url = new URL(input ?? DEFAULT_REGISTRY);
  } catch {
    throw new RegistryError(`--registry is not a URL: ${input}`);
  }
  if (url.protocol !== 'https:') {
    const loopback = url.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname);
    if (!loopback) throw new RegistryError(`--registry must be an https URL (plain http is accepted only for localhost): ${input}`);
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new RegistryError('--registry must be a bare origin, optionally with a path prefix (no query, fragment or credentials)');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

export interface RegistryResponse {
  status: number;
  /** The parsed JSON body, or undefined when the body was not JSON. */
  json: unknown;
  /** The raw body text (bounded by maxBytes). */
  text: string;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  timeoutMs?: number;
  maxBytes?: number;
  /** For tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** One bounded HTTP request to the registry. Network and shape failures become RegistryError. */
export async function registryRequest(base: URL, route: string, options: RequestOptions = {}): Promise<RegistryResponse> {
  const timeoutMs = options.timeoutMs ?? REGISTRY_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? REGISTRY_MAX_RESPONSE_BYTES;
  const doFetch = options.fetchImpl ?? fetch;
  // Join as text, never as a relative URL: a '/' base plus '/witness/...' would otherwise
  // read as the protocol-relative '//witness/...' and point at a host called "witness".
  const url = new URL(base.pathname.replace(/\/$/, '') + route, base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: options.method ?? 'GET',
        headers: {
          accept: 'application/json',
          ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (err) {
      if (controller.signal.aborted) throw new RegistryError(`registry did not answer within ${timeoutMs} ms: ${url.origin}`);
      throw new RegistryError(`could not reach the registry at ${url.origin}: ${(err as Error).message}`);
    }
    const text = await readBounded(res, maxBytes, controller);
    let json: unknown;
    try {
      json = text.length ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

async function readBounded(res: Response, maxBytes: number, controller: AbortController): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    controller.abort();
    throw new RegistryError(`registry response too large (${declared} bytes; limit ${maxBytes})`);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        controller.abort();
        throw new RegistryError(`registry response too large (over ${maxBytes} bytes)`);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof RegistryError) throw err;
    if (controller.signal.aborted) throw new RegistryError('registry response did not finish in time');
    throw new RegistryError(`registry response could not be read: ${(err as Error).message}`);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ââ Reading records back: re-verify everything, label the rest ââââââââââ

/** One row of a lookup page as the server sends it (every field is the server's word). */
export interface ServerRecordEntry {
  recordHash?: unknown;
  record?: unknown;
  bindingHash?: unknown;
  revokedBy?: unknown;
}

export interface ServerLookupPage {
  records?: unknown;
  bindings?: unknown;
  revocations?: unknown;
  next?: unknown;
}

export type RegistryRecordStatus = 'verified' | 'expired' | 'failed';

export interface AssessedRecord {
  /** A one-line summary led by the issuer, because a lookup by subject is "what others claim". */
  line: string;
  issuer: string;
  status: RegistryRecordStatus;
  /** Present exactly when status is 'failed'. */
  reason?: string;
  /** The hash computed HERE from the record bytes; null when the record could not be hashed. */
  recordHash: string | null;
  subject?: string;
  claim?: string;
  issued_at?: string;
  valid_until?: string;
  /** The hash of a revocation that itself verified, names this record, and comes from the same issuer. */
  revokedBy?: string;
  issuerKeyCheck?: string;
  record: unknown;
  /** The server's statements about this record, exactly as sent, none of them checked. */
  unverified: { recordHash?: unknown; bindingHash?: unknown; revokedBy?: unknown; revocationRefused?: string };
}

export interface AssessedPage {
  records: AssessedRecord[];
  /** Passed through as the cursor for the next page. */
  next?: string;
  counts: Record<RegistryRecordStatus, number>;
  note: string;
}

function safeRecordHash(record: unknown): string | null {
  try {
    return computeRecordHash(record as WitnessRecord);
  } catch {
    return null;
  }
}

function bindingsMap(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** The binding the server filed under `bindingHash`, only if it really hashes to that name. */
function bindingFor(bindingHash: unknown, bindings: Record<string, unknown>): { ok: true; binding: unknown } | { ok: false; reason: string } {
  if (typeof bindingHash !== 'string') return { ok: false, reason: 'the server gave no bindingHash for this record' };
  const binding = bindings[bindingHash];
  if (binding === undefined) return { ok: false, reason: `binding ${bindingHash.slice(0, 12)} is not in the response` };
  let actual: string;
  try {
    actual = computeBindingHash(binding as KeyBinding);
  } catch {
    return { ok: false, reason: 'the binding the server supplied cannot be hashed' };
  }
  if (actual !== bindingHash) return { ok: false, reason: 'the binding does not hash to the name the server filed it under' };
  return { ok: true, binding };
}

/**
 * Re-verify one server row. The server's recordHash must match the hash computed
 * here, or the row is `failed`: a registry that mislabels a record's id would make
 * every revocation and `get` keyed on that id point at the wrong statement.
 */
export function assessRecordEntry(
  entry: ServerRecordEntry,
  bindings: Record<string, unknown>,
  revocations: ServerRecordEntry[],
  now: Date = new Date(),
): AssessedRecord {
  const record = entry.record;
  const rec = (record && typeof record === 'object' ? record : {}) as Partial<WitnessRecord>;
  const issuer = typeof rec.issuer === 'string' ? rec.issuer : '(no issuer)';
  const localHash = safeRecordHash(record);
  const unverified: AssessedRecord['unverified'] = {
    recordHash: entry.recordHash,
    bindingHash: entry.bindingHash,
    ...(entry.revokedBy !== undefined ? { revokedBy: entry.revokedBy } : {}),
  };
  const base = {
    issuer,
    recordHash: localHash,
    ...(typeof rec.subject === 'string' ? { subject: rec.subject } : {}),
    ...(typeof rec.claim === 'string' ? { claim: rec.claim } : {}),
    ...(typeof rec.issued_at === 'string' ? { issued_at: rec.issued_at } : {}),
    ...(typeof rec.valid_until === 'string' ? { valid_until: rec.valid_until } : {}),
    record,
    unverified,
  };
  const failed = (reason: string): AssessedRecord => ({ line: summaryLine({ ...base, status: 'failed', reason }), status: 'failed', reason, ...base });

  const b = bindingFor(entry.bindingHash, bindings);
  if (!b.ok) return failed(b.reason);
  const verdict = verifyRecordWithBinding(record, b.binding, now);
  if (!verdict.ok) return failed(verdict.reason);
  if (localHash === null) return failed('the record cannot be hashed');
  if (entry.recordHash !== localHash) return failed('the server\'s recordHash does not match the record');

  const status: RegistryRecordStatus = verdict.expired ? 'expired' : 'verified';
  const revocation = verifiedRevocationOf(verdict.record, localHash, revocations, bindings, now);
  const out: AssessedRecord = {
    line: '',
    status,
    ...base,
    ...(revocation.hash ? { revokedBy: revocation.hash } : {}),
    issuerKeyCheck: verdict.issuerKeyCheck,
  };
  if (!revocation.hash && entry.revokedBy !== undefined) {
    out.unverified.revocationRefused = revocation.refused ?? 'the server names a revocation that is not in the response';
  }
  out.line = summaryLine(out);
  return out;
}

/**
 * The first revocation in `revocations` that (a) verifies against its own binding,
 * (b) has claim "revoked" and names `hash`, and (c) comes from the record's issuer
 * about the same subject. A revocation the server asserts but which fails any of
 * these is NOT honoured; the reason is returned so the caller can report it.
 */
function verifiedRevocationOf(
  record: WitnessRecord,
  hash: string,
  revocations: ServerRecordEntry[],
  bindings: Record<string, unknown>,
  now: Date,
): { hash?: string; refused?: string } {
  let refused: string | undefined;
  for (const rev of revocations) {
    const r = (rev.record && typeof rev.record === 'object' ? rev.record : {}) as Partial<WitnessRecord>;
    if (r.claim !== 'revoked' || r.revokes !== hash) continue;
    const b = bindingFor(rev.bindingHash, bindings);
    if (!b.ok) { refused = `revocation: ${b.reason}`; continue; }
    const v = verifyRecordWithBinding(rev.record, b.binding, now);
    if (!v.ok) { refused = `revocation: ${v.reason}`; continue; }
    if (v.record.issuer !== record.issuer) { refused = 'revocation: not from the record\'s issuer'; continue; }
    if (v.record.subject !== record.subject) { refused = 'revocation: not about the record\'s subject'; continue; }
    const revHash = safeRecordHash(rev.record);
    if (revHash === null) { refused = 'revocation: cannot be hashed'; continue; }
    return { hash: revHash };
  }
  return { refused };
}

function summaryLine(r: Omit<AssessedRecord, 'line'>): string {
  const parts = [r.issuer, r.status];
  if (r.status === 'failed' && r.reason) parts.push(`(${r.reason})`);
  if (r.revokedBy) parts.push(`revoked-by ${r.revokedBy.slice(0, 12)}`);
  if (r.claim) parts.push(r.claim);
  if (r.subject) parts.push(`about ${r.subject}`);
  if (r.recordHash) parts.push(r.recordHash.slice(0, 12));
  return parts.join(' ');
}

/** Re-verify a whole lookup page. `next` is passed through untouched as the cursor. */
export function assessLookupPage(page: ServerLookupPage, now: Date = new Date()): AssessedPage {
  const entries = Array.isArray(page.records) ? (page.records as ServerRecordEntry[]) : [];
  const revocations = Array.isArray(page.revocations) ? (page.revocations as ServerRecordEntry[]) : [];
  const bindings = bindingsMap(page.bindings);
  const records = entries.map((e) => assessRecordEntry(e ?? {}, bindings, revocations, now));
  const counts: Record<RegistryRecordStatus, number> = { verified: 0, expired: 0, failed: 0 };
  for (const r of records) counts[r.status]++;
  return {
    records,
    ...(typeof page.next === 'string' && page.next.length ? { next: page.next } : {}),
    counts,
    note: UNVERIFIED_NOTE,
  };
}

/**
 * Re-verify a single-record answer (GET /witness/records/:hash). The server may
 * send the binding inline (`binding`) or in a `bindings` map; both are accepted.
 * The record must hash to the hash that was asked for, or it is `failed`.
 */
export function assessSingleRecord(requestedHash: string, body: unknown, now: Date = new Date()): AssessedRecord {
  const b = (body && typeof body === 'object' ? body : {}) as ServerRecordEntry & { binding?: unknown; bindings?: unknown; revocations?: unknown };
  const bindings = bindingsMap(b.bindings);
  if (b.binding !== undefined) {
    let hash: string | undefined;
    try { hash = computeBindingHash(b.binding as KeyBinding); } catch { hash = undefined; }
    if (hash) bindings[hash] = b.binding;
  }
  const entry: ServerRecordEntry = {
    recordHash: b.recordHash ?? requestedHash,
    record: b.record,
    bindingHash: b.bindingHash ?? (b.binding !== undefined ? safeBindingHash(b.binding) : undefined),
    revokedBy: b.revokedBy,
  };
  const revocations = Array.isArray(b.revocations) ? (b.revocations as ServerRecordEntry[]) : [];
  const assessed = assessRecordEntry(entry, bindings, revocations, now);
  if (assessed.status !== 'failed' && assessed.recordHash !== requestedHash) {
    const reason = 'the server returned a different record than the one asked for';
    return { ...assessed, status: 'failed', reason, line: summaryLine({ ...assessed, status: 'failed', reason }) };
  }
  return assessed;
}

function safeBindingHash(binding: unknown): string | undefined {
  try { return computeBindingHash(binding as KeyBinding); } catch { return undefined; }
}
