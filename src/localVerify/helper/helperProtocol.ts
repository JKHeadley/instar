/**
 * The wire protocol between a run machine and a borrowed helper machine
 * (docs/specs/local-verify-borrowed-unit-slices.md, C and E). Shared by both sides.
 *
 * SHADOW ONLY: nothing here is ever an input to a verdict. A helper's answer is compared with the
 * run machine's own unit lane and recorded; no code path hands it to `evaluateRun`
 * (tests/unit/localVerify/borrowedGuard.test.ts asserts it).
 *
 * Every run-machine → helper request (slice, prepare, cancel, learned report) is signed with the
 * requester's machine key over the canonical body (domain `instar-lv-helper-request-v1`), in
 * addition to the Bearer token. Every helper answer to a slice is signed with the helper's key
 * (domain `instar-lv-helper-slice-v1`). The answer signature shows WHICH machine answered; it does
 * not make the untrusted run honest, and in shadow mode it does not need to.
 *
 * Pure: no I/O.
 */
import crypto from 'node:crypto';
import { canonicalJson } from '../../core/appMediaTypes.js';
import { verifyMachineSignature, type MachineKeyLookup, type MachineSignature, type MachineSigner } from '../../core/AppRecordSignatures.js';

export const HELPER_REQUEST_DOMAIN = 'instar-lv-helper-request-v1';
export const HELPER_SLICE_DOMAIN = 'instar-lv-helper-slice-v1';

/**
 * Fixed limits (spec "Fixed limits"). Values marked PRACTICE-PHASE DEFAULT are the approval's
 * fold-in 1 (Judgment Within Floors): starting values with a stated reason, re-measured by the
 * 20-run report rather than treated as settled.
 */
export const HELPER_LIMITS = Object.freeze({
  /** A request expires at most 60 s after signing… */
  requestMaxLifetimeMs: 60_000,
  /** …with 30 s tolerated for clock difference between the two machines. */
  clockToleranceMs: 30_000,
  /** A seen attemptId is refused for 10 min, across helper restarts. */
  seenAttemptMs: 10 * 60_000,
  /**
   * The owner service reads at most 4 MB of a slice result, then refuses the WHOLE result
   * (never truncates; counted `result-oversize`). Derivation: parseVitestJson caps each failure
   * message at 400 chars, so a full 10 s slice of ~50 files stays near 100 KB (the trials' largest);
   * 4 MB parses in well under 100 ms. 40x the expected maximum: an oversize result signals a fault.
   */
  resultMaxBytes: 4 * 1024 * 1024,
  /** The governor samples owner load every 2 s (the trials' interval). */
  governorPeriodMs: 2_000,
  /** Windows owner signal older than this means the helper does not run (five governor periods). */
  windowsSignalStaleMs: 10_000,
  /** Prepared trees kept: the second covers a newer `main` head arriving while the previous one is in use. */
  preparedTreesMax: 2,
  /** Host free space must cover the sandbox disk's remaining growth plus this margin. */
  hostDiskMarginBytes: 5 * 1024 * 1024 * 1024,
  /** Clean-up after every slice: kill up to 3 times, 1 s apart, then restart the sandbox. */
  cleanupKillAttempts: 3,
  cleanupKillIntervalMs: 1_000,
  /** 15 min without work stops the sandbox (a stopped VM returns all its memory). */
  idleStopMs: 15 * 60_000,
  /** Memory-pressure hold-off: 5 min, doubling per repeat within an hour, capped at 1 h. */
  holdOffStartMs: 5 * 60_000,
  holdOffMaxMs: 60 * 60_000,
  holdOffWindowMs: 60 * 60_000,
  /** PRACTICE-PHASE DEFAULT: at most 5 learned-list files per retrial request (one ordinary slice). */
  retrialMaxFiles: 5,
  /** PRACTICE-PHASE DEFAULT: a learned list over a quarter of eligible files reports the helper incompatible. */
  incompatibleShare: 0.25,
  /** PRACTICE-PHASE DEFAULT: at most 1 vitest worker per GB of sandbox memory (a unit worker is a few hundred MB). */
  workersPerGb: 1,
  /** Re-trial every 10th run of a helper. */
  retrialEveryRuns: 10,
  /** A slice request names at most this many files (a 10 s slice is ~50; bounded input). */
  maxFilesPerRequest: 400,
  /** Bounded path length of one requested file. */
  maxFileChars: 300,
  /** Run machine polls helper-status this often while a tree prepares. */
  statusPollMs: 5_000,
});

export const SHA40_RE = /^[0-9a-f]{40}$/;
export const HELPER_ID_RE = /^[0-9a-f]{32}$/;
const MACHINE_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const FILE_RE = /^[A-Za-z0-9._@+/-]+\.test\.ts$/;

/** A slice (or, with `prepare`, a preparation) request. */
export interface HelperSliceRequest {
  kind: 'slice';
  attemptId: string;
  runAttemptId: string;
  requesterMachineId: string;
  /** The helper this request is for (signed): a request sniffed on its way to one helper is refused by another. */
  helperMachineId: string;
  headSha: string;
  files: string[];
  /** Absolute ms epoch: a laptop that slept mid-slice stops on waking. */
  deadlineAt: number;
  budgetMs: number;
  expiresAt: number;
  /** Preparation only: no files; the helper answers `preparing`. */
  prepare?: true;
  /** May name learned-list files (at most 5), bypassing only that one exclusion. */
  retrial?: true;
}

export interface HelperCancelRequest {
  kind: 'cancel';
  attemptId: string;
  runAttemptId: string;
  requesterMachineId: string;
  /** The helper this request is for (signed): a request sniffed on its way to one helper is refused by another. */
  helperMachineId: string;
  expiresAt: number;
}

/** One observation a run machine reports about a file (D, learned list). */
export interface LearnedObservation {
  file: string;
  /** `differ`: failed or skipped differently on the helper while passing locally, same run. `agree`: a retrial agreed. */
  kind: 'differ' | 'agree';
  source: 'paired' | 'dry-run';
}

export interface HelperLearnedRequest {
  kind: 'learned';
  attemptId: string;
  runAttemptId: string;
  requesterMachineId: string;
  /** The helper this request is for (signed): a request sniffed on its way to one helper is refused by another. */
  helperMachineId: string;
  headSha: string;
  expiresAt: number;
  observations: LearnedObservation[];
}

export type HelperRequest = HelperSliceRequest | HelperCancelRequest | HelperLearnedRequest;

/** A signed request on the wire: the request plus its signature. */
export type SignedHelperRequest<T extends HelperRequest = HelperRequest> = T & { sig: MachineSignature };

export interface HelperPerFile { file: string; tests: number; passed: number; failed: number; skipped: number; todo: number; ms: number }

export type HelperAnswerState =
  | 'done' | 'handed-back' | 'prep-stopped' | 'preparing' | 'busy' | 'owner-busy' | 'refused' | 'cancelled';

/** The helper's signed answer to a slice / prepare request (spec E "Answer"). */
export interface HelperSliceAnswer {
  state: HelperAnswerState;
  attemptId: string;
  runAttemptId: string;
  headSha: string;
  requestedFiles: string[];
  perFile: HelperPerFile[];
  slice: { exitCode: number | null; unhandledErrors: number; collected: boolean; vitestStartMs: number | null } | null;
  ownerCoresMax: number | null;
  handBackMs: number | null;
  prepMs: number | null;
  progress: number;
  helperVersion: string;
  reason?: HelperRefusal | string;
  /** Present when the result was refused for size (counted `result-oversize`). */
  resultOversize?: { bytesSeen: number };
  sig?: MachineSignature;
}

export type HelperRefusal =
  | 'unsigned' | 'requester-not-pinned' | 'signature-unknown-key' | 'signature-bad' | 'expired'
  | 'replayed' | 'tunnel' | 'not-merged' | 'merged-unknown' | 'file-missing' | 'file-not-unit'
  | 'file-ineligible' | 'retrial-too-large' | 'invalid-request' | 'paused' | 'disabled'
  | 'helper-containment-unproven' | 'host-disk-low' | 'disk-low' | 'not-prepared' | 'no-signer'
  | 'state-unwritable' | 'no-sandbox' | 'wrong-helper';

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');
const wire = (v: unknown): unknown => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

function withoutSig<T extends { sig?: unknown }>(o: T): Omit<T, 'sig'> {
  const { sig: _sig, ...rest } = o;
  return rest;
}

export function requestPayload(req: HelperRequest): string {
  return `${HELPER_REQUEST_DOMAIN}\n${sha256(canonicalJson(wire(withoutSig(req as HelperRequest & { sig?: unknown }))))}`;
}

export function answerPayload(ans: HelperSliceAnswer): string {
  return `${HELPER_SLICE_DOMAIN}\n${sha256(canonicalJson(wire(withoutSig(ans))))}`;
}

export function signHelperRequest<T extends HelperRequest>(signer: MachineSigner, req: T): SignedHelperRequest<T> {
  const s = signer.sign(requestPayload(req));
  return { ...req, sig: { machineId: s.machineId, signerKeyHash: s.signerKeyHash, sig: s.sig } };
}

export function signHelperAnswer(signer: MachineSigner, ans: HelperSliceAnswer): HelperSliceAnswer {
  const s = signer.sign(answerPayload(ans));
  return { ...ans, sig: { machineId: s.machineId, signerKeyHash: s.signerKeyHash, sig: s.sig } };
}

export function isSig(v: unknown): v is MachineSignature {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.machineId === 'string' && typeof o.signerKeyHash === 'string' && typeof o.sig === 'string'
    && o.machineId.length <= 200 && o.signerKeyHash.length <= 200 && o.sig.length <= 1024;
}

/** Why a signed helper answer must not be compared, or null when its signature holds for `helperMachineId`. */
export function verifyHelperAnswer(ans: HelperSliceAnswer, helperMachineId: string, keyLookup: MachineKeyLookup, atMs: number): 'unsigned' | 'signature-wrong-machine' | 'signature-unknown-key' | 'signature-bad' | null {
  if (!isSig(ans.sig)) return 'unsigned';
  if (ans.sig.machineId !== helperMachineId) return 'signature-wrong-machine';
  const v = verifyMachineSignature(keyLookup, ans.sig, answerPayload(ans), atMs);
  if (v === 'unknown') return 'signature-unknown-key';
  if (v === 'bad') return 'signature-bad';
  return null;
}

function isInt(v: unknown, min = 0): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
}

export function isRequestFile(f: unknown): f is string {
  return typeof f === 'string' && f.length > 0 && f.length <= HELPER_LIMITS.maxFileChars && FILE_RE.test(f)
    && !f.split('/').some((s) => s === '..' || s === '.' || s === '') && !f.startsWith('/');
}

/** Parse a signed request body: exactly the fields of one request kind plus `sig`. Null when malformed. */
export function parseHelperRequest(body: unknown, expectKind: HelperRequest['kind']): SignedHelperRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.kind !== expectKind) return null;
  const common = ['kind', 'attemptId', 'runAttemptId', 'requesterMachineId', 'helperMachineId', 'expiresAt', 'sig'];
  const allowed: Record<HelperRequest['kind'], string[]> = {
    slice: [...common, 'headSha', 'files', 'deadlineAt', 'budgetMs', 'prepare', 'retrial'],
    cancel: common,
    learned: [...common, 'headSha', 'observations'],
  };
  if (Object.keys(b).some((k) => !allowed[expectKind].includes(k))) return null;
  if (typeof b.attemptId !== 'string' || !HELPER_ID_RE.test(b.attemptId)) return null;
  if (typeof b.runAttemptId !== 'string' || !HELPER_ID_RE.test(b.runAttemptId)) return null;
  if (typeof b.requesterMachineId !== 'string' || !MACHINE_ID_RE.test(b.requesterMachineId)) return null;
  if (typeof b.helperMachineId !== 'string' || !MACHINE_ID_RE.test(b.helperMachineId)) return null;
  if (!isInt(b.expiresAt, 1)) return null;
  // `sig` presence is checked by admission (an unsigned body is the `unsigned` refusal, not invalid).
  if (b.sig !== undefined && !isSig(b.sig)) return null;
  if (expectKind === 'slice') {
    if (typeof b.headSha !== 'string' || !SHA40_RE.test(b.headSha)) return null;
    if (!Array.isArray(b.files) || b.files.length > HELPER_LIMITS.maxFilesPerRequest || !b.files.every(isRequestFile)) return null;
    if (new Set(b.files).size !== b.files.length) return null;
    if (!isInt(b.deadlineAt, 1) || !isInt(b.budgetMs, 1)) return null;
    if (b.prepare !== undefined && b.prepare !== true) return null;
    if (b.retrial !== undefined && b.retrial !== true) return null;
    if (b.prepare === true && (b.files.length !== 0 || b.retrial === true)) return null;
    if (b.prepare !== true && b.files.length === 0) return null;
  }
  if (expectKind === 'learned') {
    if (typeof b.headSha !== 'string' || !SHA40_RE.test(b.headSha)) return null;
    if (!Array.isArray(b.observations) || b.observations.length > HELPER_LIMITS.maxFilesPerRequest) return null;
    for (const o of b.observations) {
      const x = o as Record<string, unknown> | null;
      if (!x || typeof x !== 'object' || Object.keys(x).some((k) => !['file', 'kind', 'source'].includes(k))) return null;
      if (!isRequestFile(x.file) || (x.kind !== 'differ' && x.kind !== 'agree') || (x.source !== 'paired' && x.source !== 'dry-run')) return null;
    }
  }
  return b as unknown as SignedHelperRequest;
}

/** Bound and shape-check a helper answer received by a run machine. Null when malformed (→ `invalid-answer`). */
export function parseHelperAnswer(v: unknown): HelperSliceAnswer | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const a = v as Record<string, unknown>;
  const states: HelperAnswerState[] = ['done', 'handed-back', 'prep-stopped', 'preparing', 'busy', 'owner-busy', 'refused', 'cancelled'];
  if (typeof a.state !== 'string' || !states.includes(a.state as HelperAnswerState)) return null;
  if (typeof a.attemptId !== 'string' || typeof a.runAttemptId !== 'string' || typeof a.headSha !== 'string') return null;
  if (!Array.isArray(a.requestedFiles) || !a.requestedFiles.every((f) => typeof f === 'string')) return null;
  if (!Array.isArray(a.perFile) || a.perFile.length > HELPER_LIMITS.maxFilesPerRequest) return null;
  for (const p of a.perFile) {
    const x = p as Record<string, unknown> | null;
    if (!x || typeof x.file !== 'string' || !['tests', 'passed', 'failed', 'skipped', 'todo', 'ms'].every((k) => isInt(x[k]))) return null;
  }
  if (a.slice !== null && a.slice !== undefined) {
    const s = a.slice as Record<string, unknown>;
    if (typeof s !== 'object' || !(s.exitCode === null || Number.isSafeInteger(s.exitCode)) || !isInt(s.unhandledErrors) || typeof s.collected !== 'boolean'
      || !(s.vitestStartMs === null || isInt(s.vitestStartMs))) return null;
  }
  if (typeof a.helperVersion !== 'string' || a.helperVersion.length > 200) return null;
  if (typeof a.progress !== 'number' || !Number.isFinite(a.progress)) return null;
  return a as unknown as HelperSliceAnswer;
}

/** The counts of one per-file entry, as the comparison reads them. */
export function perFileCounts(p: HelperPerFile): { passed: number; failed: number; skipped: number; todo: number } {
  return { passed: p.passed, failed: p.failed, skipped: p.skipped, todo: p.todo };
}
