/**
 * The wire protocol between a run machine and a borrowed helper machine, version 2
 * (docs/specs/local-verify-borrowed-slices-count.md, C and E, amending
 * docs/specs/local-verify-borrowed-unit-slices.md). Shared by both sides.
 *
 * Version 2 names a lane and two commits (`baseSha`, `headSha`) where version 1 named one commit,
 * and its answers carry the merge tree's hash and, per file, the names-and-outcomes digest and the
 * failed test names. Version 1 never shipped enabled and has no path here: its bodies fail the
 * strict parse, and its signatures fail under the version 2 domains.
 *
 * As of this stage nothing here is an input to a verdict: a helper's answer is compared with the
 * run machine's own lane and recorded (tests/unit/localVerify/borrowedGuard.test.ts asserts it).
 *
 * Every run-machine → helper request (slice, prepare, cancel, learned report) is signed with the
 * requester's machine key over the canonical body (domain `instar-lv-helper-request-v2`), in
 * addition to the Bearer token. Every helper answer to a slice is signed with the helper's key
 * (domain `instar-lv-helper-slice-v2`), and every progress answer with the same key under its own
 * domain (`instar-lv-helper-progress-v2`), so neither can be replayed as the other. A signature
 * shows WHICH machine answered; it does not make the untrusted run honest.
 *
 * Pure: no I/O.
 */
import crypto from 'node:crypto';
import { canonicalJson } from '../../core/appMediaTypes.js';
import { verifyMachineSignature, type MachineKeyLookup, type MachineSignature, type MachineSigner } from '../../core/AppRecordSignatures.js';

export const HELPER_PROTOCOL_VERSION = 2;
export const HELPER_REQUEST_DOMAIN = 'instar-lv-helper-request-v2';
export const HELPER_SLICE_DOMAIN = 'instar-lv-helper-slice-v2';
export const HELPER_PROGRESS_DOMAIN = 'instar-lv-helper-progress-v2';
export const HELPER_STATUS_DOMAIN = 'instar-lv-helper-status-v2';
export const HELPER_HERE_DOMAIN = 'instar-lv-helper-here-v2';

/**
 * Fixed limits (spec "Fixed limits"). Values marked PRACTICE-PHASE DEFAULT are the approval's
 * fold-in 1 (Judgment Within Floors): starting values with a stated reason, re-measured by the
 * practice report rather than treated as settled.
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
  /** Host free space must cover the remaining growth of the sandbox disk and of the package volume's disk, plus this margin. */
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
  /** PRACTICE-PHASE DEFAULT: at most 1 vitest worker per GB of sandbox memory (a unit worker is a few hundred MB). */
  workersPerGb: 1,
  /** A learned-list file is tried again every 10th verify this helper serves (spec D). */
  retrialEveryRuns: 10,
  /** A file joins the learned list when the helper fails it and the run machine passes it in this many comparisons in a row. */
  learnedJoinInARow: 2,
  /**
   * A slice's time budget in helper time (spec E): 60 s for integration and end-to-end, 10 s for
   * unit. Measured on the laptop: the average integration file took about 1 s, 6 took over 30 s,
   * the longest 64 s. A file longer than the budget goes alone (sliceBudget.ts).
   */
  sliceBudgetMs: Object.freeze({ unit: 10_000, integration: 60_000, e2e: 60_000 }),
  /**
   * Slices waiting on a helper at once. A quarter of the unit lane is about 20 slices and a whole
   * dry-run lane is sent a few slices at a time, so 200 is ten times the expected most; past it a
   * request is refused `queue-full` and the run machine runs those files itself.
   */
  maxQueuedSlices: 200,
  /** A prepared tree is kept until the run machine says the verify is over, or this long with no request for it (spec Build decisions). */
  treeRetentionMs: 10 * 60_000,
  /** Finished slice answers kept for the status answer (the oldest go first, audited). */
  resultsKeptMax: 500,
  /** Finished slice answers in one status answer; the reader asks again from the last sequence number. */
  statusResultsMax: 20,
  /** Bounded size of one progress line the runner passes on from the sandbox. */
  progressLineMaxBytes: 64 * 1024,
  /** Files per lane in the helper's "compared on" record (the duration records' own bound). */
  comparedFilesMax: 20_000,
  /** A slice request names at most this many files (a 10 s slice is ~50; bounded input). */
  maxFilesPerRequest: 400,
  /** Bounded path length of one requested file. */
  maxFileChars: 300,
  /** Run machine polls helper-status this often while a tree prepares. */
  statusPollMs: 5_000,
  /** An answer lists at most this many failed test names per file (spec "Build decisions"). */
  maxFailedTestNamesPerFile: 50,
  /** Bounded length of one listed test name (the import-related re-run's bound on a usable name). */
  maxTestNameChars: 300,
  /** A per-slice cancel names at most this many slices. */
  maxCancelAttemptIds: 400,
});

export const SHA40_RE = /^[0-9a-f]{40}$/;
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
export const HELPER_ID_RE = /^[0-9a-f]{32}$/;
const MACHINE_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const FILE_RE = /^[A-Za-z0-9._@+/-]+\.test\.ts$/;

/** The lanes a request may name (the inventory's lane names). */
export type HelperLane = 'unit' | 'integration' | 'e2e';
export const HELPER_LANES: readonly HelperLane[] = Object.freeze(['unit', 'integration', 'e2e']);

/**
 * What a slice's results are for (spec E "Order of slices"): the check slice with known answers,
 * a slice whose passes the run machine means to use, or a slice the run machine also runs itself.
 * A helper serves them in that order.
 */
export type HelperSliceUse = 'check' | 'count' | 'compare';
export const HELPER_SLICE_USES: readonly HelperSliceUse[] = Object.freeze(['check', 'count', 'compare']);

/** A slice (or, with `prepare`, a preparation) request. */
export interface HelperSliceRequest {
  kind: 'slice';
  attemptId: string;
  runAttemptId: string;
  requesterMachineId: string;
  /** The helper this request is for (signed): a request sniffed on its way to one helper is refused by another. */
  helperMachineId: string;
  /** The lane every file of this request belongs to. */
  lane: HelperLane;
  /** The commit of `main` the verify is based on. The helper checks for itself that it is merged. */
  baseSha: string;
  /** The change's head commit, or `baseSha` itself (a main verify, a dry run). The helper tests the merge of the two. */
  headSha: string;
  files: string[];
  /** Absolute ms epoch: a laptop that slept mid-slice stops on waking. */
  deadlineAt: number;
  budgetMs: number;
  expiresAt: number;
  /** Required with files, absent on a preparation. */
  use?: HelperSliceUse;
  /** Preparation only: no files; the helper answers `preparing`. */
  prepare?: true;
  /** May name learned-list files (at most 5), bypassing only that one exclusion. Always `use: 'compare'`. */
  retrial?: true;
  /** Part of this helper's dry run: merged code only (`headSha` equals `baseSha`), never `use: 'count'`. */
  dryRun?: true;
}

export interface HelperCancelRequest {
  kind: 'cancel';
  attemptId: string;
  runAttemptId: string;
  requesterMachineId: string;
  /** The helper this request is for (signed): a request sniffed on its way to one helper is refused by another. */
  helperMachineId: string;
  expiresAt: number;
  /**
   * Per-slice cancel: stop or dequeue only these slices of the run and keep its prepared tree.
   * Absent: the whole run.
   */
  attemptIds?: string[];
  /** Whole-run cancel only: the verify is over, so the helper need not keep the run's prepared tree. */
  verifyOver?: true;
}

/**
 * What one comparison of one file showed, as the run machine reports it (spec D). Every kind is
 * about the SAME tree on both sides (the request's `treeHash`):
 *  - `helper-failed-local-passed`: the helper failed the file and the run machine's final result
 *    is a pass. Two in a row put the file on the learned list;
 *  - `digest-differs-both-pass`: both sides pass, but the names-and-outcomes digests differ (the
 *    file registers different tests on the two systems). Once is enough;
 *  - `confirmed-wrong-pass`: the run machine's final result is a failure and the helper passed.
 *    Once is enough;
 *  - `agree`: the digests are equal. It clears a first failure, takes a listed file off the list
 *    (a trial that agreed), and marks the file as compared on this helper.
 */
export type LearnedObservationKind = 'helper-failed-local-passed' | 'digest-differs-both-pass' | 'confirmed-wrong-pass' | 'agree';
export const LEARNED_OBSERVATION_KINDS: readonly LearnedObservationKind[] = Object.freeze(['helper-failed-local-passed', 'digest-differs-both-pass', 'confirmed-wrong-pass', 'agree']);

export interface LearnedObservation {
  file: string;
  kind: LearnedObservationKind;
}

export interface HelperLearnedRequest {
  kind: 'learned';
  attemptId: string;
  runAttemptId: string;
  requesterMachineId: string;
  /** The helper this request is for (signed): a request sniffed on its way to one helper is refused by another. */
  helperMachineId: string;
  /** The merge tree both sides ran: the comparisons are about this tree and no other. */
  treeHash: string;
  expiresAt: number;
  observations: LearnedObservation[];
}

/**
 * The helper's signed "I am here" (spec F "Asking the helper"): sent to its one pinned run machine
 * when the helper wakes, so a run machine that had slowed its asking asks again on the next verify.
 * It carries nothing but who and when.
 */
export interface HelperHereRequest {
  kind: 'here';
  helperMachineId: string;
  /** The run machine it is for (signed): another machine refuses it. */
  runMachineId: string;
  /** Why it is sent: the service started, the owner resumed it, or the machine woke from sleep. */
  why: 'start' | 'resume' | 'wake';
  at: number;
  expiresAt: number;
  runnerVersion: string;
  sig?: MachineSignature;
}

export type HelperRequest = HelperSliceRequest | HelperCancelRequest | HelperLearnedRequest;

/** A signed request on the wire: the request plus its signature. */
export type SignedHelperRequest<T extends HelperRequest = HelperRequest> = T & { sig: MachineSignature };

/** One file's result in an answer. `tests` is always `passed + failed + skipped + todo`. */
export interface HelperPerFile {
  file: string;
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
  ms: number;
  /**
   * The file's names-and-outcomes digest (`outcomeDigest` in ../laneReport.ts: every test's full
   * name paired with passed / failed / skipped / todo, duplicates kept, order-independent), or
   * null when the helper's report did not contain the file.
   */
  digest: string | null;
  /**
   * Full names of the file's failed tests, in report order: at most 50, each 1 to 300 characters.
   * A failed test with a longer or empty name, or beyond the 50th, is not listed, so
   * `failedTests.length < failed` discloses it.
   */
  failedTests: string[];
}

export type HelperAnswerState =
  | 'done' | 'handed-back' | 'prep-stopped' | 'preparing' | 'queued' | 'busy' | 'owner-busy' | 'refused' | 'cancelled';
const ANSWER_STATES: readonly HelperAnswerState[] = Object.freeze(['done', 'handed-back', 'prep-stopped', 'preparing', 'queued', 'busy', 'owner-busy', 'refused', 'cancelled']);

/** Slice-level facts: the run's exit, its unhandled errors, whether every file was collected, vitest's start-up time. */
export interface HelperSliceFacts { exitCode: number | null; unhandledErrors: number; collected: boolean; vitestStartMs: number | null }

/** The helper's signed answer to a slice / prepare request (spec E "Answer"). */
export interface HelperSliceAnswer {
  state: HelperAnswerState;
  attemptId: string;
  runAttemptId: string;
  lane: HelperLane;
  baseSha: string;
  headSha: string;
  /**
   * The hash of the merge tree the helper built from `baseSha` and `headSha` and ran, or null when
   * it has not built one (a refusal, a preparation still running). A run machine uses a result only
   * when this equals its own merge tree's hash.
   */
  treeHash: string | null;
  requestedFiles: string[];
  perFile: HelperPerFile[];
  slice: HelperSliceFacts | null;
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

/**
 * The helper's signed progress answer for the slice it is running (spec E "Progress"): the files
 * finished so far. Results taken from it are provisional until the slice's last signed answer
 * repeats them (`finalContradictsProgress`).
 */
export interface HelperProgressAnswer {
  kind: 'progress';
  attemptId: string;
  runAttemptId: string;
  lane: HelperLane;
  treeHash: string;
  /** Rises with every progress answer of one slice; a reader keeps only a higher one. */
  seq: number;
  files: HelperPerFile[];
  /** The slice's unhandled errors so far. */
  unhandledErrors: number;
  helperVersion: string;
  sig?: MachineSignature;
}

export type HelperRefusal =
  | 'unsigned' | 'requester-not-pinned' | 'signature-unknown-key' | 'signature-bad' | 'expired'
  | 'replayed' | 'tunnel'
  // C item 1: `baseSha` is not reachable from main; GitHub could not say; GitHub limited the request.
  | 'base-not-merged' | 'merged-unknown' | 'merged-rate-limited'
  // C item 2, one reason per way a head is not ours: no pull request lists it; the pull request's
  // head repository is another repository (a fork); the pull request is closed; the commit is in a
  // pull request but is no longer its head; the head repository is gone; GitHub unreachable; limited.
  | 'head-not-ours' | 'head-fork' | 'head-pr-closed' | 'head-moved' | 'head-repo-missing' | 'head-unknown' | 'head-rate-limited'
  // C item 3: no dry-run record of this lane on the current image; the driver cannot name its image.
  | 'dry-run-not-done' | 'image-identity-unknown'
  // C items 4 and 5: the merge conflicts; the tree carries its own `node_modules`; the install inputs differ from `baseSha`'s.
  | 'merge-conflict' | 'tree-has-node-modules' | 'install-inputs-changed'
  // The package volume (its own disk beside the sandbox image) is not there.
  | 'package-volume-missing'
  // E: more slices waiting than the helper holds; a slice budget above the lane's.
  | 'queue-full' | 'budget-over-limit'
  | 'file-missing' | 'file-wrong-lane' | 'check-not-fixture'
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

export function progressPayload(p: HelperProgressAnswer): string {
  return `${HELPER_PROGRESS_DOMAIN}\n${sha256(canonicalJson(wire(withoutSig(p))))}`;
}

export function signHelperRequest<T extends HelperRequest>(signer: MachineSigner, req: T): SignedHelperRequest<T> {
  const s = signer.sign(requestPayload(req));
  return { ...req, sig: { machineId: s.machineId, signerKeyHash: s.signerKeyHash, sig: s.sig } };
}

export function signHelperAnswer(signer: MachineSigner, ans: HelperSliceAnswer): HelperSliceAnswer {
  const s = signer.sign(answerPayload(ans));
  return { ...ans, sig: { machineId: s.machineId, signerKeyHash: s.signerKeyHash, sig: s.sig } };
}

/**
 * The status answer's signed payload: the whole body without its signature. `at` is the helper's
 * clock when it answered; a reader refuses one older than a request's lifetime.
 */
export function statusPayload(body: Record<string, unknown>): string {
  return `${HELPER_STATUS_DOMAIN}\n${sha256(canonicalJson(wire(withoutSig(body as { sig?: unknown }))))}`;
}

export function signHelperStatus<T extends Record<string, unknown>>(signer: MachineSigner, body: T): T & { sig: MachineSignature } {
  const s = signer.sign(statusPayload(body));
  return { ...body, sig: { machineId: s.machineId, signerKeyHash: s.signerKeyHash, sig: s.sig } };
}

export function herePayload(h: HelperHereRequest): string {
  return `${HELPER_HERE_DOMAIN}\n${sha256(canonicalJson(wire(withoutSig(h))))}`;
}

export function signHelperHere(signer: MachineSigner, h: HelperHereRequest): HelperHereRequest {
  const s = signer.sign(herePayload(h));
  return { ...h, sig: { machineId: s.machineId, signerKeyHash: s.signerKeyHash, sig: s.sig } };
}

export function signHelperProgress(signer: MachineSigner, p: HelperProgressAnswer): HelperProgressAnswer {
  const s = signer.sign(progressPayload(p));
  return { ...p, sig: { machineId: s.machineId, signerKeyHash: s.signerKeyHash, sig: s.sig } };
}

export function isSig(v: unknown): v is MachineSignature {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.machineId === 'string' && typeof o.signerKeyHash === 'string' && typeof o.sig === 'string'
    && o.machineId.length <= 200 && o.signerKeyHash.length <= 200 && o.sig.length <= 1024;
}

export type AnswerSignatureRefusal = 'unsigned' | 'signature-wrong-machine' | 'signature-unknown-key' | 'signature-bad';

function verifySigned(sig: unknown, payload: string, helperMachineId: string, keyLookup: MachineKeyLookup, atMs: number): AnswerSignatureRefusal | null {
  if (!isSig(sig)) return 'unsigned';
  if (sig.machineId !== helperMachineId) return 'signature-wrong-machine';
  const v = verifyMachineSignature(keyLookup, sig, payload, atMs);
  if (v === 'unknown') return 'signature-unknown-key';
  if (v === 'bad') return 'signature-bad';
  return null;
}

/** Why a signed helper answer must not be compared, or null when its signature holds for `helperMachineId`. */
export function verifyHelperAnswer(ans: HelperSliceAnswer, helperMachineId: string, keyLookup: MachineKeyLookup, atMs: number): AnswerSignatureRefusal | null {
  return verifySigned(ans.sig, answerPayload(ans), helperMachineId, keyLookup, atMs);
}

/**
 * Why a status answer must not be read: its signature does not hold for `helperMachineId`, or its
 * `at` is missing or further from `atMs` than a request's lifetime plus the clock tolerance (an
 * old status replayed).
 */
export function verifyHelperStatus(body: Record<string, unknown>, helperMachineId: string, keyLookup: MachineKeyLookup, atMs: number): AnswerSignatureRefusal | 'stale' | null {
  const why = verifySigned(body.sig, statusPayload(body), helperMachineId, keyLookup, atMs);
  if (why) return why;
  const at = body.at;
  if (typeof at !== 'number' || !Number.isFinite(at) || Math.abs(atMs - at) > HELPER_LIMITS.requestMaxLifetimeMs + HELPER_LIMITS.clockToleranceMs) return 'stale';
  return null;
}

/** Why an "I am here" must not be acted on, or null when it is this helper's, for this run machine, and fresh. */
export function verifyHelperHere(h: HelperHereRequest, helperMachineId: string, runMachineId: string, keyLookup: MachineKeyLookup, atMs: number): AnswerSignatureRefusal | 'wrong-run-machine' | 'expired' | null {
  const why = verifySigned(h.sig, herePayload(h), helperMachineId, keyLookup, atMs);
  if (why) return why;
  if (h.helperMachineId !== helperMachineId || h.runMachineId !== runMachineId) return 'wrong-run-machine';
  if (atMs > h.expiresAt + HELPER_LIMITS.clockToleranceMs || h.expiresAt - h.at > HELPER_LIMITS.requestMaxLifetimeMs) return 'expired';
  return null;
}

/** Shape-check an "I am here" body: exactly its fields. Null when malformed. */
export function parseHelperHere(v: unknown): HelperHereRequest | null {
  if (!isPlainObject(v) || !onlyKeys(v, ['kind', 'helperMachineId', 'runMachineId', 'why', 'at', 'expiresAt', 'runnerVersion', 'sig'])) return null;
  if (v.kind !== 'here') return null;
  if (typeof v.helperMachineId !== 'string' || !MACHINE_ID_RE.test(v.helperMachineId)) return null;
  if (typeof v.runMachineId !== 'string' || !MACHINE_ID_RE.test(v.runMachineId)) return null;
  if (v.why !== 'start' && v.why !== 'resume' && v.why !== 'wake') return null;
  if (!isInt(v.at, 1) || !isInt(v.expiresAt, 1)) return null;
  if (typeof v.runnerVersion !== 'string' || v.runnerVersion.length > 200) return null;
  if (v.sig !== undefined && !isSig(v.sig)) return null;
  return v as unknown as HelperHereRequest;
}

/** Why a signed progress answer must not be read, or null when its signature holds for `helperMachineId`. */
export function verifyHelperProgress(p: HelperProgressAnswer, helperMachineId: string, keyLookup: MachineKeyLookup, atMs: number): AnswerSignatureRefusal | null {
  return verifySigned(p.sig, progressPayload(p), helperMachineId, keyLookup, atMs);
}

function isInt(v: unknown, min = 0): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(o).every((k) => allowed.includes(k));
const isSha40 = (v: unknown): v is string => typeof v === 'string' && SHA40_RE.test(v);
const isHelperId = (v: unknown): v is string => typeof v === 'string' && HELPER_ID_RE.test(v);
const isLane = (v: unknown): v is HelperLane => typeof v === 'string' && (HELPER_LANES as readonly string[]).includes(v);

export function isRequestFile(f: unknown): f is string {
  return typeof f === 'string' && f.length > 0 && f.length <= HELPER_LIMITS.maxFileChars && FILE_RE.test(f)
    && !f.split('/').some((s) => s === '..' || s === '.' || s === '') && !f.startsWith('/');
}

/**
 * Parse a signed request body: exactly the fields of one request kind plus `sig`. Null when
 * malformed. A version 1 slice or learned body (one commit, no lane) is malformed here.
 */
export function parseHelperRequest(body: unknown, expectKind: HelperRequest['kind']): SignedHelperRequest | null {
  if (!isPlainObject(body)) return null;
  const b = body;
  if (b.kind !== expectKind) return null;
  const common = ['kind', 'attemptId', 'runAttemptId', 'requesterMachineId', 'helperMachineId', 'expiresAt', 'sig'];
  const allowed: Record<HelperRequest['kind'], string[]> = {
    slice: [...common, 'lane', 'baseSha', 'headSha', 'files', 'deadlineAt', 'budgetMs', 'use', 'prepare', 'retrial', 'dryRun'],
    cancel: [...common, 'attemptIds', 'verifyOver'],
    learned: [...common, 'treeHash', 'observations'],
  };
  if (!onlyKeys(b, allowed[expectKind])) return null;
  if (!isHelperId(b.attemptId)) return null;
  if (!isHelperId(b.runAttemptId)) return null;
  if (typeof b.requesterMachineId !== 'string' || !MACHINE_ID_RE.test(b.requesterMachineId)) return null;
  if (typeof b.helperMachineId !== 'string' || !MACHINE_ID_RE.test(b.helperMachineId)) return null;
  if (!isInt(b.expiresAt, 1)) return null;
  // `sig` presence is checked by admission (an unsigned body is the `unsigned` refusal, not invalid).
  if (b.sig !== undefined && !isSig(b.sig)) return null;
  if (expectKind === 'slice') {
    if (!isLane(b.lane)) return null;
    if (!isSha40(b.baseSha) || !isSha40(b.headSha)) return null;
    if (!Array.isArray(b.files) || b.files.length > HELPER_LIMITS.maxFilesPerRequest || !b.files.every(isRequestFile)) return null;
    if (new Set(b.files).size !== b.files.length) return null;
    if (!isInt(b.deadlineAt, 1) || !isInt(b.budgetMs, 1)) return null;
    if (b.prepare !== undefined && b.prepare !== true) return null;
    if (b.retrial !== undefined && b.retrial !== true) return null;
    if (b.dryRun !== undefined && b.dryRun !== true) return null;
    if (b.use !== undefined && !(typeof b.use === 'string' && (HELPER_SLICE_USES as readonly string[]).includes(b.use))) return null;
    if (b.prepare === true && (b.files.length !== 0 || b.retrial === true || b.use !== undefined)) return null;
    if (b.prepare !== true && (b.files.length === 0 || b.use === undefined)) return null;
    // A trial of a learned-list file is always compare-only: the run machine runs the file too.
    if (b.retrial === true && b.use !== 'compare') return null;
    // A dry run is on merged code, and nothing from it is ever counted.
    if (b.dryRun === true && (b.baseSha !== b.headSha || b.use === 'count')) return null;
  }
  if (expectKind === 'cancel') {
    if (b.verifyOver !== undefined && b.verifyOver !== true) return null;
    if (b.attemptIds !== undefined) {
      if (!Array.isArray(b.attemptIds) || b.attemptIds.length === 0 || b.attemptIds.length > HELPER_LIMITS.maxCancelAttemptIds || !b.attemptIds.every(isHelperId)) return null;
      if (new Set(b.attemptIds).size !== b.attemptIds.length) return null;
      // "The verify is over" is about the whole run, never about some of its slices.
      if (b.verifyOver === true) return null;
    }
  }
  if (expectKind === 'learned') {
    if (!isSha40(b.treeHash)) return null;
    if (!Array.isArray(b.observations) || b.observations.length > HELPER_LIMITS.maxFilesPerRequest) return null;
    const seenFiles = new Set<string>();
    for (const o of b.observations) {
      const x = o as Record<string, unknown> | null;
      if (!x || typeof x !== 'object' || Array.isArray(x) || Object.keys(x).some((k) => k !== 'file' && k !== 'kind')) return null;
      if (!isRequestFile(x.file) || typeof x.kind !== 'string' || !(LEARNED_OBSERVATION_KINDS as readonly string[]).includes(x.kind)) return null;
      // One comparison of one file per request: two kinds for one file would contradict each other.
      if (seenFiles.has(x.file)) return null;
      seenFiles.add(x.file);
    }
  }
  return b as unknown as SignedHelperRequest;
}

const PER_FILE_KEYS = ['file', 'tests', 'passed', 'failed', 'skipped', 'todo', 'ms', 'digest', 'failedTests'];

/** One per-file entry, strictly: exactly its keys, counts that add up, a digest or null, bounded failed names. */
export function isHelperPerFile(v: unknown): v is HelperPerFile {
  if (!isPlainObject(v) || !onlyKeys(v, PER_FILE_KEYS)) return false;
  if (!isRequestFile(v.file)) return false;
  if (!['tests', 'passed', 'failed', 'skipped', 'todo', 'ms'].every((k) => isInt(v[k]))) return false;
  if (v.tests !== (v.passed as number) + (v.failed as number) + (v.skipped as number) + (v.todo as number)) return false;
  if (!(v.digest === null || (typeof v.digest === 'string' && SHA256_HEX_RE.test(v.digest)))) return false;
  if (!Array.isArray(v.failedTests) || v.failedTests.length > HELPER_LIMITS.maxFailedTestNamesPerFile || v.failedTests.length > (v.failed as number)) return false;
  return v.failedTests.every((n) => typeof n === 'string' && n.length >= 1 && n.length <= HELPER_LIMITS.maxTestNameChars);
}

function perFileList(v: unknown): v is HelperPerFile[] {
  if (!Array.isArray(v) || v.length > HELPER_LIMITS.maxFilesPerRequest || !v.every(isHelperPerFile)) return false;
  return new Set(v.map((p) => p.file)).size === v.length;
}

const ANSWER_KEYS = [
  'state', 'attemptId', 'runAttemptId', 'lane', 'baseSha', 'headSha', 'treeHash', 'requestedFiles', 'perFile', 'slice',
  'ownerCoresMax', 'handBackMs', 'prepMs', 'progress', 'helperVersion', 'reason', 'resultOversize', 'sig',
];
const SLICE_KEYS = ['exitCode', 'unhandledErrors', 'collected', 'vitestStartMs'];
const nullOrInt = (v: unknown): boolean => v === null || isInt(v);

/**
 * Bound and shape-check a helper answer received by a run machine: exactly the answer's fields,
 * every one of the expected type. Null when malformed (→ `invalid-answer`). A helper's bare
 * refusal body (`{ state: 'refused', reason }`) is not an answer and parses as null; its reader
 * takes the reason from the body.
 */
export function parseHelperAnswer(v: unknown): HelperSliceAnswer | null {
  if (!isPlainObject(v) || !onlyKeys(v, ANSWER_KEYS)) return null;
  const a = v;
  if (typeof a.state !== 'string' || !(ANSWER_STATES as readonly string[]).includes(a.state)) return null;
  if (!isHelperId(a.attemptId) || !isHelperId(a.runAttemptId)) return null;
  if (!isLane(a.lane) || !isSha40(a.baseSha) || !isSha40(a.headSha)) return null;
  if (!(a.treeHash === null || isSha40(a.treeHash))) return null;
  if (!Array.isArray(a.requestedFiles) || a.requestedFiles.length > HELPER_LIMITS.maxFilesPerRequest || !a.requestedFiles.every(isRequestFile)) return null;
  if (!perFileList(a.perFile)) return null;
  if (a.slice !== null) {
    if (!isPlainObject(a.slice) || !onlyKeys(a.slice, SLICE_KEYS)) return null;
    const s = a.slice;
    if (!(s.exitCode === null || Number.isSafeInteger(s.exitCode)) || !isInt(s.unhandledErrors) || typeof s.collected !== 'boolean' || !nullOrInt(s.vitestStartMs)) return null;
  }
  if (!(a.ownerCoresMax === null || (typeof a.ownerCoresMax === 'number' && Number.isFinite(a.ownerCoresMax) && a.ownerCoresMax >= 0))) return null;
  if (!nullOrInt(a.handBackMs) || !nullOrInt(a.prepMs)) return null;
  if (typeof a.helperVersion !== 'string' || a.helperVersion.length > 200) return null;
  if (typeof a.progress !== 'number' || !Number.isFinite(a.progress)) return null;
  if (a.reason !== undefined && (typeof a.reason !== 'string' || a.reason.length > 200)) return null;
  if (a.resultOversize !== undefined) {
    if (!isPlainObject(a.resultOversize) || !onlyKeys(a.resultOversize, ['bytesSeen']) || !isInt(a.resultOversize.bytesSeen)) return null;
  }
  if (a.sig !== undefined && !isSig(a.sig)) return null;
  return a as unknown as HelperSliceAnswer;
}

const PROGRESS_KEYS = ['kind', 'attemptId', 'runAttemptId', 'lane', 'treeHash', 'seq', 'files', 'unhandledErrors', 'helperVersion', 'sig'];

/** Bound and shape-check a progress answer, as strictly as a slice answer. Null when malformed. */
export function parseHelperProgress(v: unknown): HelperProgressAnswer | null {
  if (!isPlainObject(v) || !onlyKeys(v, PROGRESS_KEYS)) return null;
  if (v.kind !== 'progress') return null;
  if (!isHelperId(v.attemptId) || !isHelperId(v.runAttemptId)) return null;
  if (!isLane(v.lane) || !isSha40(v.treeHash)) return null;
  if (!isInt(v.seq) || !isInt(v.unhandledErrors)) return null;
  if (!perFileList(v.files)) return null;
  if (typeof v.helperVersion !== 'string' || v.helperVersion.length > 200) return null;
  if (v.sig !== undefined && !isSig(v.sig)) return null;
  return v as unknown as HelperProgressAnswer;
}

/** Whether a newer progress answer may replace an older one: the same slice and tree, and a higher sequence number. */
export function progressSupersedes(prev: HelperProgressAnswer, next: HelperProgressAnswer): boolean {
  return next.attemptId === prev.attemptId && next.runAttemptId === prev.runAttemptId && next.lane === prev.lane
    && next.treeHash === prev.treeHash && next.seq > prev.seq;
}

/** Whether two entries report the same result for one file: the four counts and the digest (time is not a result). */
export function samePerFileResult(a: HelperPerFile, b: HelperPerFile): boolean {
  return a.file === b.file && a.passed === b.passed && a.failed === b.failed && a.skipped === b.skipped && a.todo === b.todo && a.digest === b.digest;
}

/**
 * The first file whose result in a slice's last signed answer (final or hand-back) is missing or
 * differs from what progress reported, or null when the last answer repeats every one (spec E:
 * "a last answer that contradicts earlier progress is an invalid answer").
 */
export function finalContradictsProgress(progressFiles: readonly HelperPerFile[], last: HelperSliceAnswer): string | null {
  const byFile = new Map(last.perFile.map((p) => [p.file, p]));
  for (const p of progressFiles) {
    const f = byFile.get(p.file);
    if (!f || !samePerFileResult(p, f)) return p.file;
  }
  return null;
}

/** The counts of one per-file entry, as the comparison reads them. */
export function perFileCounts(p: HelperPerFile): { passed: number; failed: number; skipped: number; todo: number } {
  return { passed: p.passed, failed: p.failed, skipped: p.skipped, todo: p.todo };
}
