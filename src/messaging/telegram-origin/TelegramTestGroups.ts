// Spec: docs/specs/telegram-test-groups.md. Typed, narrow operations that let the
// browser broker make, list and remove Telegram forum groups for live proofs.
// Authority is a marker in the group title, half of it a keyed tag only this
// agent can issue, verified against a live read of the account. The local file
// is an audit log, never the delete authority. Every limit here is a scope limit
// on the operator's real account: fail closed.
import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, writeFile, truncate } from 'node:fs/promises';
import path from 'node:path';
import { parseMarkers } from '../../core/attribution/marker.js';
import type { TelegramBrowserDriver } from './BrowserTypes.js';

export const TEST_GROUP_PREFIX = 'Instar test - ';
export const TEST_GROUP_LIVE_CAP = 5;
export const TEST_GROUP_UNVERIFIED_CAP = 20;
export const TEST_GROUP_DAILY_CREATES = 10;
export const TEST_GROUP_LIST_BOUND = 100;
export const TEST_GROUP_EVALUATION_MS = 20_000;
export const TEST_GROUP_OPERATION_MS = 45_000;
export const TEST_GROUP_CREATE_MIN_MS = 22_000;
export const TEST_GROUP_READ_CACHE_MS = 15_000;
export const TEST_GROUP_READ_SPACING_MS = 5_000;
export const TEST_GROUP_READS_PER_HOUR = 60;
export const TEST_GROUP_GRANT_MAX_MS = 30 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const AUDIT_ROTATE_BYTES = 2 * 1024 * 1024;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** Caller title: the exact prefix, then a closed alphabet Telegram does not rewrite. */
const CALLER_TITLE = /^Instar test - [A-Za-z0-9][A-Za-z0-9 ._:#()/-]{0,95}$/;
const MARKER = /^itg-[a-z2-7]{10}$/;
const MARKED_TITLE = /^Instar test - .{1,112} \[(itg-[a-z2-7]{10})\]$/;
const DIGITS = /^[1-9][0-9]{0,19}$/;

// ── Grant ────────────────────────────────────────────────────────────────

export interface TestGroupBot { readonly username: string; readonly userId: string }
export interface TestGroupGrant {
  readonly profileId: string; readonly accountId: string;
  readonly bots: readonly TestGroupBot[]; readonly decisionRef: string; readonly expiresAt: number;
}

/** An agent-held grant from the Telegram messaging config. Malformed, broad, expired
 * or over-long reads as null, which only switches create off. */
export function readTestGroupGrant(origin: unknown, now: number): TestGroupGrant | null {
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) return null;
  const value = (origin as { testGroups?: unknown }).testGroups;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const grant = value as Record<string, unknown>;
  const keys = ['profileId', 'accountId', 'bots', 'decisionRef', 'expiresAt'];
  if (Object.keys(grant).length !== keys.length || keys.some(key => !Object.hasOwn(grant, key)) ||
    typeof grant.profileId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(grant.profileId) ||
    typeof grant.accountId !== 'string' || !DIGITS.test(grant.accountId) ||
    typeof grant.decisionRef !== 'string' || grant.decisionRef.length > 300 ||
    typeof grant.expiresAt !== 'string' || !Array.isArray(grant.bots) || grant.bots.length < 1 || grant.bots.length > 8) return null;
  // Exactly one well-formed attribution source marker naming the logged decision.
  const parsed = parseMarkers(grant.decisionRef);
  if (parsed.markers.length !== 1 || parsed.malformed.length || parsed.markers[0].raw !== grant.decisionRef.trim()) return null;
  const expiresAt = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + TEST_GROUP_GRANT_MAX_MS) return null;
  const bots: TestGroupBot[] = [];
  for (const raw of grant.bots) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const bot = raw as Record<string, unknown>;
    if (Object.keys(bot).length !== 2 || typeof bot.username !== 'string' || typeof bot.userId !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(bot.username) || !/bot$/i.test(bot.username) || !DIGITS.test(bot.userId)) return null;
    const username = bot.username, userId = bot.userId;
    if (bots.some(b => b.username.toLowerCase() === username.toLowerCase() || b.userId === userId)) return null;
    bots.push(Object.freeze({ username, userId }));
  }
  return Object.freeze({ profileId: grant.profileId, accountId: grant.accountId, bots: Object.freeze(bots),
    decisionRef: grant.decisionRef, expiresAt });
}
export function grantedBot(grant: TestGroupGrant, requested: unknown): TestGroupBot | null {
  if (typeof requested !== 'string') return null;
  const name = requested.startsWith('@') ? requested.slice(1) : requested;
  return grant.bots.find(bot => bot.username.toLowerCase() === name.toLowerCase()) ?? null;
}
export function validTestGroupTitle(title: unknown): title is string {
  return typeof title === 'string' && CALLER_TITLE.test(title) && !title.includes('  ') && !title.endsWith(' ');
}

// ── Marker ───────────────────────────────────────────────────────────────

function base32Of25(value: number): string {
  let out = '';
  for (let i = 4; i >= 0; i--) out += BASE32[(value >>> (i * 5)) & 31];
  return out;
}
function tagFor(key: Buffer, profileId: string, random: string): string {
  const digest = createHmac('sha256', key).update(`itg:${profileId}:${random}`).digest();
  return base32Of25(digest.readUInt32BE(0) >>> 7);
}
export function issueTestGroupMarker(key: Buffer, profileId: string): string {
  const random = base32Of25(randomBytes(4).readUInt32BE(0) >>> 7);
  return `itg-${random}${tagFor(key, profileId, random)}`;
}
export function verifyTestGroupMarker(key: Buffer, profileId: string, marker: string): boolean {
  if (!MARKER.test(marker)) return false;
  const random = marker.slice(4, 9), tag = marker.slice(9);
  return tagFor(key, profileId, random) === tag;
}
export function markerOfTitle(title: string): string | null {
  return MARKED_TITLE.exec(title)?.[1] ?? null;
}

/** The dedicated marker key. Never derived from the rotatable ASP identity key. */
export class TestGroupMarkerKey {
  readonly file: string;
  private cached: Buffer | null = null;
  constructor(stateDir: string) { this.file = path.join(stateDir, 'state', 'telegram-test-groups.key'); }
  /** null means present-but-unusable: create and delete hold, list reports unverified. */
  async load(): Promise<Buffer | null> {
    if (this.cached) return this.cached;
    let text: string;
    try { text = await readFile(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      const created = randomBytes(32);
      try {
        await mkdir(path.dirname(this.file), { recursive: true });
        await writeFile(this.file, created.toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
        this.cached = created;
        return created;
      } catch (writeError) {
        // A concurrent creator won the race: read its key.
        if ((writeError as NodeJS.ErrnoException).code === 'EEXIST') return this.load();
        return null;
      }
    }
    const hex = text.trim();
    if (!/^[0-9a-f]{64}$/.test(hex)) return null;
    this.cached = Buffer.from(hex, 'hex');
    return this.cached;
  }
}

// ── Audit log ────────────────────────────────────────────────────────────

export interface TestGroupProducer { originMachineId: string; harnessId: string | null; sessionId: string | null }
export interface TestGroupAuditLine {
  at: number; op: 'create' | 'delete' | 'list' | 'hold'; phase: 'intent' | 'outcome' | 'hold';
  profileId: string; accountId?: string; channelId?: string; title?: string; bot?: string;
  outcome?: string; reason?: string; until?: number; decisionRef?: string; producer?: TestGroupProducer;
}
export interface TestGroupAuditSummary { attempts24h: number; holdUntil: number; holdReason: string | null; floodUntil: number }

/** Append-only JSONL. Never stores hashes, tokens, session strings or message text. */
export class TestGroupAuditLog {
  readonly file: string;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly stateDir: string, private readonly now: () => number = Date.now) {
    this.file = path.join(stateDir, 'state', 'telegram-test-groups.jsonl');
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work);
    this.chain = next.catch(() => undefined);
    return next;
  }
  append(line: TestGroupAuditLine): Promise<void> {
    return this.serial(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const handle = await open(this.file, 'a', 0o600);
      try { await handle.appendFile(JSON.stringify(line) + '\n'); await handle.sync(); }
      finally { await handle.close(); }
      await this.rotateIfLarge();
    });
  }
  /** Rotating log (registry class A): past 2 MB the live file becomes the one kept segment. */
  private async rotateIfLarge(): Promise<void> {
    if ((await stat(this.file)).size <= AUDIT_ROTATE_BYTES) return;
    await rename(this.file, this.segment);
  }
  private get segment(): string { return path.join(path.dirname(this.file), 'telegram-test-groups.1.jsonl'); }
  /** Read the last 24 h. A torn final line is a crash artifact and is dropped. Damage
   * anywhere else moves the file aside and starts a log whose first line is a 24 h hold:
   * it heals itself and never lifts the cap. */
  summary(profileId: string): Promise<TestGroupAuditSummary> {
    return this.serial(async () => {
      const now = this.now();
      let text: string;
      try { text = await readFile(this.file, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        text = '';
      }
      if (text && !text.endsWith('\n')) {
        const cut = text.lastIndexOf('\n') + 1;
        text = text.slice(0, cut);
        await truncate(this.file, Buffer.byteLength(text));
      }
      const lines: TestGroupAuditLine[] = [];
      // The kept segment can hold lines from the last 24 h right after a rotation.
      try {
        for (const raw of (await readFile(this.segment, 'utf8')).split('\n')) {
          if (!raw) continue;
          try { lines.push(JSON.parse(raw) as TestGroupAuditLine); } catch { /* a segment is never appended to again */ }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      let damaged = false;
      for (const raw of text.split('\n')) {
        if (!raw) continue;
        try {
          const line = JSON.parse(raw) as TestGroupAuditLine;
          if (!line || typeof line.at !== 'number' || typeof line.op !== 'string') { damaged = true; break; }
          lines.push(line);
        } catch { damaged = true; break; }
      }
      if (damaged) {
        await rename(this.file, path.join(path.dirname(this.file), `telegram-test-groups.damaged-${now}.jsonl`));
        const hold: TestGroupAuditLine = { at: now, op: 'hold', phase: 'hold', profileId: '*', reason: 'audit-damaged', until: now + DAY_MS };
        const handle = await open(this.file, 'a', 0o600);
        try { await handle.appendFile(JSON.stringify(hold) + '\n'); await handle.sync(); } finally { await handle.close(); }
        return { attempts24h: 0, holdUntil: hold.until!, holdReason: 'audit-damaged', floodUntil: 0 };
      }
      let attempts = 0, holdUntil = 0, holdReason: string | null = null, floodUntil = 0;
      for (const line of lines) {
        if (line.profileId !== profileId && line.profileId !== '*') continue;
        if (line.op === 'create' && line.phase === 'intent' && line.at > now - DAY_MS) attempts++;
        if (line.op === 'hold' && typeof line.until === 'number' && line.until > now && line.until > holdUntil) {
          holdUntil = line.until; holdReason = line.reason ?? 'hold';
        }
        if (line.op === 'hold' && line.reason === 'flood-wait' && typeof line.until === 'number' && line.until > now && line.until > floodUntil) floodUntil = line.until;
      }
      return { attempts24h: attempts, holdUntil, holdReason, floodUntil };
    });
  }
}

// ── Page result parsers (exact keys only; nothing that could carry a hash passes) ──

export interface TestGroupCandidate { channelId: string; title: string; date: number }
export type TestGroupListResult =
  | { ok: true; complete: boolean; groups: TestGroupCandidate[]; requested?: { present: boolean } }
  | TestGroupPageFailure;
export type TestGroupCreateResult =
  | { ok: true; channelId: string }
  | TestGroupPageFailure;
export type TestGroupDeleteResult = { ok: true; outcome: 'deleted' | 'gone' } | TestGroupPageFailure;
export interface TestGroupPageFailure {
  ok: false; step: string; code?: number; type?: string; kind?: string; message?: string; uncertain?: boolean; channelId?: string; rolledBack?: boolean;
}
const STEPS = new Set(['canary', 'budget', 'list', 'bot-identity', 'create', 'create-shape', 'invite', 'promote', 'verify',
  'stale-read', 'identity-mismatch', 'delete', 'read']);
function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
function parseFailure(v: Record<string, unknown>): TestGroupPageFailure | null {
  if (v.ok !== false || !onlyKeys(v, ['ok', 'step', 'code', 'type', 'kind', 'message', 'uncertain', 'channelId', 'rolledBack']) ||
    (v.kind !== undefined && (typeof v.kind !== 'string' || !/^[A-Za-z]{1,40}$/.test(v.kind))) ||
    (v.message !== undefined && (typeof v.message !== 'string' || !/^[A-Za-z0-9 _.:()'-]{1,120}$/.test(v.message))) ||
    typeof v.step !== 'string' || !STEPS.has(v.step) ||
    (v.code !== undefined && !Number.isSafeInteger(v.code)) ||
    (v.type !== undefined && (typeof v.type !== 'string' || !/^[A-Z_0-9]{1,48}$/.test(v.type))) ||
    (v.uncertain !== undefined && typeof v.uncertain !== 'boolean') ||
    (v.channelId !== undefined && (typeof v.channelId !== 'string' || !DIGITS.test(v.channelId))) ||
    (v.rolledBack !== undefined && typeof v.rolledBack !== 'boolean')) return null;
  return v as unknown as TestGroupPageFailure;
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function parseTestGroupList(value: unknown): TestGroupListResult | null {
  const v = record(value); if (!v) return null;
  if (v.ok === false) return parseFailure(v);
  if (v.ok !== true || !onlyKeys(v, ['ok', 'complete', 'groups', 'requested']) || typeof v.complete !== 'boolean' ||
    !Array.isArray(v.groups) || v.groups.length > TEST_GROUP_LIST_BOUND) return null;
  const groups: TestGroupCandidate[] = [];
  for (const raw of v.groups) {
    const g = record(raw);
    if (!g || !onlyKeys(g, ['channelId', 'title', 'date']) || typeof g.channelId !== 'string' || !DIGITS.test(g.channelId) ||
      typeof g.title !== 'string' || !MARKED_TITLE.test(g.title) || !Number.isSafeInteger(g.date)) return null;
    groups.push({ channelId: g.channelId, title: g.title, date: g.date as number });
  }
  let requested: { present: boolean } | undefined;
  if (v.requested !== undefined) {
    const r = record(v.requested);
    if (!r || !onlyKeys(r, ['present']) || typeof r.present !== 'boolean') return null;
    requested = { present: r.present };
  }
  return { ok: true, complete: v.complete, groups, ...(requested ? { requested } : {}) };
}
export function parseTestGroupCreate(value: unknown): TestGroupCreateResult | null {
  const v = record(value); if (!v) return null;
  if (v.ok === false) return parseFailure(v);
  if (v.ok === true && onlyKeys(v, ['ok', 'channelId']) && typeof v.channelId === 'string' && DIGITS.test(v.channelId)) return { ok: true, channelId: v.channelId };
  return null;
}
export function parseTestGroupDelete(value: unknown): TestGroupDeleteResult | null {
  const v = record(value); if (!v) return null;
  if (v.ok === false) return parseFailure(v);
  if (v.ok === true && onlyKeys(v, ['ok', 'outcome']) && (v.outcome === 'deleted' || v.outcome === 'gone')) return { ok: true, outcome: v.outcome };
  return null;
}
export function floodWaitSeconds(failure: TestGroupPageFailure): number | null {
  const match = /^FLOOD_WAIT_([0-9]{1,6})$/.exec(failure.type ?? '');
  return match ? Number(match[1]) : failure.code === 420 ? 60 : null;
}

// ── Broker seam ──────────────────────────────────────────────────────────

/** One page evaluation inside a test-group operation. `mutating` marks the point
 * after which an error means the account may have changed. */
export type TestGroupStep = <R>(input: { mutating: boolean; minRemainingMs?: number },
  call: (driver: TelegramBrowserDriver, deadlineMs: number) => Promise<R>) => Promise<R>;
export type TestGroupOperationOutcome<T> =
  | { state: 'done'; value: T }
  | { state: 'known-failed'; reason: string }
  | { state: 'unknown'; reason: string };
export interface TestGroupBrokerSeam {
  isBusy(): boolean;
  runTestGroupOperation<T>(options: { expectedAccountId: string; authorize: () => string | null; operationMs: number;
    evaluationMs: number }, body: (step: TestGroupStep) => Promise<T>): Promise<TestGroupOperationOutcome<T>>;
}
/** Raised inside an operation body for a typed, known refusal (nothing changed). */
export class TestGroupKnownStop extends Error {
  constructor(readonly reason: string) { super(reason); }
}

// ── Orchestrator ─────────────────────────────────────────────────────────

export interface TestGroupResponse { status: number; body: Record<string, unknown> }
export interface TelegramTestGroupsOptions {
  profileId: string;
  stateDir: string;
  /** The enrolled account id. */
  accountId: string;
  broker: TestGroupBrokerSeam;
  /** Executor has a reply send in flight (peer resolution, admission, between chunks). */
  executorBusy: () => boolean;
  /** Fresh config/lease/grant view. `null` grant means create is off. */
  authority: () => { healthy: boolean; enabled: boolean; holdsLease: boolean; grant: TestGroupGrant | null };
  now?: () => number;
}
interface CachedRead { at: number; complete: boolean; verified: TestGroupCandidate[]; unverified: TestGroupCandidate[]; keyAvailable: boolean }

export class TelegramTestGroups {
  readonly audit: TestGroupAuditLog;
  readonly key: TestGroupMarkerKey;
  private running = false;
  private lastRead: CachedRead | null = null;
  /** Telegram's own error code and type from the current operation's page failure, if any: already
   * validated by parseFailure (a safe integer, an uppercase identifier), never page text. Operations
   * run one at a time (`running`), so one field serves; admit() clears it. Without it a live
   * failure reads only "list" and cannot be diagnosed (2026-11-09 first live run). */
  private failureDetail: { code?: number; type?: string; kind?: string; message?: string } | null = null;
  private noteFailure(f: TestGroupPageFailure): void {
    this.failureDetail = { ...(f.code !== undefined ? { code: f.code } : {}), ...(f.type !== undefined ? { type: f.type } : {}),
      ...(f.kind !== undefined ? { kind: f.kind } : {}), ...(f.message !== undefined ? { message: f.message } : {}) };
  }
  private liveReads: number[] = [];
  private readonly now: () => number;
  constructor(private readonly options: TelegramTestGroupsOptions) {
    this.now = options.now ?? Date.now;
    this.audit = new TestGroupAuditLog(options.stateDir, this.now);
    this.key = new TestGroupMarkerKey(options.stateDir);
  }

  /** Synchronous admission: busy rule and live-read spacing, checked together. */
  private admit(): TestGroupResponse | null {
    const now = this.now();
    if (this.running || this.options.broker.isBusy() || this.options.executorBusy()) {
      return { status: 429, body: { error: 'test-groups-busy', retryAfterMs: 5000 } };
    }
    this.liveReads = this.liveReads.filter(at => at > now - HOUR_MS);
    const last = this.liveReads.at(-1);
    if (last !== undefined && now - last < TEST_GROUP_READ_SPACING_MS) {
      return { status: 429, body: { error: 'test-groups-busy', retryAfterMs: TEST_GROUP_READ_SPACING_MS - (now - last) } };
    }
    if (this.liveReads.length >= TEST_GROUP_READS_PER_HOUR) {
      return { status: 429, body: { error: 'test-groups-busy', retryAfterMs: this.liveReads[0] + HOUR_MS - now } };
    }
    this.running = true;
    this.failureDetail = null;
    this.liveReads.push(now);
    return null;
  }
  private baseAuthority(): string | null {
    const a = this.options.authority();
    if (!a.healthy) return 'origin-config-unavailable';
    if (!a.enabled) return 'telegram-disabled';
    return null;
  }
  private createAuthority(bot: TestGroupBot): string | null {
    const base = this.baseAuthority(); if (base) return base;
    const a = this.options.authority(), grant = a.grant;
    if (!grant || grant.expiresAt <= this.now() || grant.profileId !== this.options.profileId || grant.accountId !== this.options.accountId) return 'test-groups-not-granted';
    if (!grant.bots.some(b => b.username === bot.username && b.userId === bot.userId)) return 'test-groups-not-granted';
    if (!a.holdsLease) return 'test-groups-not-lease-holder';
    return null;
  }
  private split(groups: TestGroupCandidate[], key: Buffer | null): { verified: TestGroupCandidate[]; unverified: TestGroupCandidate[] } {
    const verified: TestGroupCandidate[] = [], unverified: TestGroupCandidate[] = [];
    for (const group of groups) {
      const marker = markerOfTitle(group.title);
      (key && marker && verifyTestGroupMarker(key, this.options.profileId, marker) ? verified : unverified).push(group);
    }
    return { verified, unverified };
  }
  private async listStep(step: TestGroupStep, key: Buffer | null, requested?: string): Promise<CachedRead & { requested?: { present: boolean } }> {
    const raw = await step({ mutating: false }, (driver, deadline) => {
      if (!driver.listTestGroups) throw new TestGroupKnownStop('test-groups-unsupported-transport');
      return driver.listTestGroups({ deadline, ...(requested ? { channelId: requested } : {}) });
    });
    const result = parseTestGroupList(raw);
    if (!result) throw new TestGroupKnownStop('unusable-page-result');
    if (!result.ok) {
      this.noteFailure(result);
      const flood = floodWaitSeconds(result);
      if (flood !== null) await this.recordFlood(flood);
      throw new TestGroupKnownStop(flood !== null ? 'flood-wait' : result.step);
    }
    const split = this.split(result.groups, key);
    const read: CachedRead = { at: this.now(), complete: result.complete, ...split, keyAvailable: !!key };
    if (result.complete) this.lastRead = read;
    return { ...read, ...(result.requested ? { requested: result.requested } : {}) };
  }
  private async recordFlood(seconds: number): Promise<void> {
    const now = this.now();
    try {
      await this.audit.append({ at: now, op: 'hold', phase: 'hold', profileId: this.options.profileId, reason: 'flood-wait', until: now + seconds * 1000 });
    } catch { /* The refusal stands; Telegram repeats FLOOD_WAIT and the next reply re-records it. */ }
  }
  private publicGroups(read: CachedRead): Record<string, unknown> {
    const shape = (g: TestGroupCandidate, verification: string) => ({ channelId: g.channelId, chatId: `-100${g.channelId}`, title: g.title, date: g.date, verification });
    return { complete: read.complete, readAt: read.at,
      groups: [...read.verified.map(g => shape(g, 'verified')),
        ...read.unverified.map(g => shape(g, read.keyAvailable ? 'unverified' : 'key-unavailable'))] };
  }
  private holdResponse(summary: TestGroupAuditSummary, kind: 'create' | 'cleanup' = 'create'): TestGroupResponse | null {
    // Cleanup (list, delete) is held only by Telegram's own flood wait, never by the
    // audit-damage hold, so a damaged log can never strand groups on the account.
    if (kind === 'cleanup') {
      return summary.floodUntil > this.now()
        ? { status: 429, body: { error: 'test-groups-limit', limit: 'flood-wait', retryAfterMs: summary.floodUntil - this.now() } } : null;
    }
    if (summary.holdUntil > this.now()) {
      return { status: 429, body: { error: 'test-groups-limit', limit: summary.holdReason ?? 'hold', retryAfterMs: summary.holdUntil - this.now() } };
    }
    return null;
  }
  private outcomeResponse(outcome: { state: 'known-failed' | 'unknown'; reason: string }): TestGroupResponse {
    if (outcome.state === 'unknown') return { status: 409, body: { error: 'test-group-outcome-unknown', reason: outcome.reason, retryable: false,
      check: `/telegram/browser/${this.options.profileId}/test-groups` } };
    if (outcome.reason === 'test-groups-unsupported-transport') return { status: 409, body: { error: outcome.reason } };
    if (['test-groups-not-granted', 'test-groups-not-lease-holder', 'origin-config-unavailable', 'telegram-disabled'].includes(outcome.reason)) {
      return { status: outcome.reason === 'test-groups-not-granted' ? 403 : 409, body: { error: outcome.reason } };
    }
    if (['live-groups', 'unverified-candidates', 'daily-creates', 'flood-wait'].includes(outcome.reason)) {
      return { status: 429, body: { error: 'test-groups-limit', limit: outcome.reason } };
    }
    if (outcome.reason === 'read-incomplete') return { status: 409, body: { error: 'test-groups-read-incomplete' } };
    if (outcome.reason.startsWith('browser-')) return { status: 409, body: { error: 'telegram-browser-held', reason: outcome.reason, retryable: false } };
    return { status: 409, body: { error: 'test-group-failed', step: outcome.reason, ...(this.failureDetail ?? {}) } };
  }

  async list(): Promise<TestGroupResponse> {
    const base = this.baseAuthority();
    if (base) return { status: 409, body: { error: base } };
    const cached = this.lastRead;
    if (cached && this.now() - cached.at < TEST_GROUP_READ_CACHE_MS) return { status: 200, body: this.publicGroups(cached) };
    const refused = this.admit(); if (refused) return refused;
    try {
      const hold = this.holdResponse(await this.audit.summary(this.options.profileId).catch(() => ({ attempts24h: 0, holdUntil: 0, holdReason: null, floodUntil: 0 })), 'cleanup');
      if (hold) return hold;
      const key = await this.key.load();
      const outcome = await this.options.broker.runTestGroupOperation({ expectedAccountId: this.options.accountId,
        authorize: () => this.baseAuthority(), operationMs: TEST_GROUP_OPERATION_MS, evaluationMs: TEST_GROUP_EVALUATION_MS },
      step => this.listStep(step, key));
      const response = outcome.state !== 'done' ? this.outcomeResponse(outcome) : { status: 200, body: this.publicGroups(outcome.value) };
      await this.audit.append({ at: this.now(), op: 'list', phase: 'outcome', profileId: this.options.profileId,
        outcome: outcome.state === 'done' ? `groups:${outcome.value.verified.length}+${outcome.value.unverified.length}` : String(response.body.error),
        ...(outcome.state !== 'done' && this.failureDetail ? { failure: { ...this.failureDetail, step: String(response.body.step ?? '') } } : {}) }).catch(() => undefined);
      return response;
    } finally { this.running = false; }
  }

  async create(input: { title: unknown; bot: unknown }, producer: TestGroupProducer): Promise<TestGroupResponse> {
    if (!validTestGroupTitle(input.title)) return { status: 400, body: { error: 'invalid-test-group-request', field: 'title' } };
    const a = this.options.authority();
    const bot = a.grant ? grantedBot(a.grant, input.bot) : null;
    if (!a.grant || !bot) return { status: 403, body: { error: 'test-groups-not-granted' } };
    const denied = this.createAuthority(bot);
    if (denied) return this.outcomeResponse({ state: 'known-failed', reason: denied });
    const title = input.title;
    const refused = this.admit(); if (refused) return refused;
    let intentWritten = false, marked = '', channelId: string | undefined;
    try {
      let summary: TestGroupAuditSummary;
      try { summary = await this.audit.summary(this.options.profileId); }
      catch { return { status: 409, body: { error: 'test-groups-audit-unavailable' } }; }
      const hold = this.holdResponse(summary); if (hold) return hold;
      if (summary.attempts24h >= TEST_GROUP_DAILY_CREATES) return { status: 429, body: { error: 'test-groups-limit', limit: 'daily-creates' } };
      const key = await this.key.load();
      if (!key) return { status: 409, body: { error: 'test-groups-key-unavailable' } };
      const decisionRef = a.grant.decisionRef;
      const outcome = await this.options.broker.runTestGroupOperation({ expectedAccountId: this.options.accountId,
        authorize: () => this.createAuthority(bot), operationMs: TEST_GROUP_OPERATION_MS, evaluationMs: TEST_GROUP_EVALUATION_MS },
      async step => {
        const read = await this.listStep(step, key);
        this.lastRead = null;
        if (!read.complete) throw new TestGroupKnownStop('read-incomplete');
        if (read.verified.length >= TEST_GROUP_LIVE_CAP) throw new TestGroupKnownStop('live-groups');
        if (read.unverified.length >= TEST_GROUP_UNVERIFIED_CAP) throw new TestGroupKnownStop('unverified-candidates');
        const live24 = read.verified.filter(g => g.date * 1000 > this.now() - DAY_MS).length;
        if (Math.max(summary.attempts24h, live24) >= TEST_GROUP_DAILY_CREATES) throw new TestGroupKnownStop('daily-creates');
        marked = `${title} [${issueTestGroupMarker(key, this.options.profileId)}]`;
        try {
          await this.audit.append({ at: this.now(), op: 'create', phase: 'intent', profileId: this.options.profileId,
            accountId: this.options.accountId, title: marked, bot: bot.username, decisionRef, producer });
        } catch { throw new TestGroupKnownStop('audit-unavailable'); }
        intentWritten = true;
        const raw = await step({ mutating: true, minRemainingMs: TEST_GROUP_CREATE_MIN_MS }, (driver, deadline) => {
          if (!driver.createTestGroup) throw new TestGroupKnownStop('test-groups-unsupported-transport');
          return driver.createTestGroup({ title: marked, bot: { username: bot.username, userId: bot.userId }, deadline });
        });
        const result = parseTestGroupCreate(raw);
        if (!result) return { kind: 'unknown' as const, reason: 'unusable-page-result' };
        if (result.ok) { channelId = result.channelId; return { kind: 'created' as const, channelId: result.channelId }; }
        this.noteFailure(result);
        const flood = floodWaitSeconds(result);
        if (flood !== null) await this.recordFlood(flood);
        if (result.uncertain || (result.channelId && !result.rolledBack)) return { kind: 'unknown' as const, reason: result.step };
        return { kind: 'failed' as const, step: flood !== null ? 'flood-wait' : result.step, rolledBack: !!result.rolledBack };
      });
      if (outcome.state === 'known-failed') {
        if (outcome.reason === 'audit-unavailable') return { status: 409, body: { error: 'test-groups-audit-unavailable' } };
        return this.outcomeResponse(outcome);
      }
      if (outcome.state === 'unknown') return this.outcomeResponse(outcome);
      const value = outcome.value;
      if (value.kind === 'created') {
        return { status: 200, body: { channelId: value.channelId, chatId: `-100${value.channelId}`, title: marked, bot: bot.username, createdAt: this.now() } };
      }
      if (value.kind === 'unknown') return this.outcomeResponse({ state: 'unknown', reason: value.reason });
      return { status: 409, body: { error: 'test-group-failed', step: value.step, rolledBack: value.rolledBack, ...(this.failureDetail ?? {}) } };
    } finally {
      this.running = false;
      if (intentWritten) {
        await this.audit.append({ at: this.now(), op: 'create', phase: 'outcome', profileId: this.options.profileId,
          title: marked, ...(channelId ? { channelId, outcome: 'created' } : { outcome: 'not-created-or-unknown' }),
          ...(this.failureDetail ? { failure: this.failureDetail } : {}), producer }).catch(() => undefined);
      }
    }
  }

  async delete(channelId: string, producer: TestGroupProducer): Promise<TestGroupResponse> {
    if (!DIGITS.test(channelId)) return { status: 400, body: { error: 'invalid-test-group-request', field: 'channelId' } };
    const base = this.baseAuthority();
    if (base) return { status: 409, body: { error: base } };
    const refused = this.admit(); if (refused) return refused;
    let result: TestGroupResponse | undefined;
    try {
      const hold = this.holdResponse(await this.audit.summary(this.options.profileId).catch(() => ({ attempts24h: 0, holdUntil: 0, holdReason: null, floodUntil: 0 })), 'cleanup');
      if (hold) return result = hold;
      const key = await this.key.load();
      if (!key) return result = { status: 409, body: { error: 'test-groups-key-unavailable' } };
      const outcome = await this.options.broker.runTestGroupOperation({ expectedAccountId: this.options.accountId,
        authorize: () => this.baseAuthority(), operationMs: TEST_GROUP_OPERATION_MS, evaluationMs: TEST_GROUP_EVALUATION_MS },
      async step => {
        const read = await this.listStep(step, key, channelId);
        const target = read.verified.find(g => g.channelId === channelId);
        if (!target) {
          if (read.complete && read.requested && !read.requested.present) return { outcome: 'gone' as const };
          if (read.requested?.present || read.unverified.some(g => g.channelId === channelId)) throw new TestGroupKnownStop('not-a-test-group');
          throw new TestGroupKnownStop('incomplete-read');
        }
        this.lastRead = null;
        const raw = await step({ mutating: true }, (driver, deadline) => {
          if (!driver.deleteTestGroup) throw new TestGroupKnownStop('test-groups-unsupported-transport');
          return driver.deleteTestGroup({ channelId, title: target.title, deadline });
        });
        const parsed = parseTestGroupDelete(raw);
        if (!parsed) return { outcome: 'unknown' as const, reason: 'unusable-page-result' };
        if (parsed.ok) return { outcome: parsed.outcome };
        this.noteFailure(parsed);
        const flood = floodWaitSeconds(parsed);
        if (flood !== null) await this.recordFlood(flood);
        if (parsed.step === 'delete' && parsed.uncertain) return { outcome: 'unknown' as const, reason: 'delete' };
        throw new TestGroupKnownStop(flood !== null ? 'flood-wait' : parsed.step);
      });
      if (outcome.state !== 'done') return result = this.outcomeResponse(outcome);
      if (outcome.value.outcome === 'unknown') return result = this.outcomeResponse({ state: 'unknown', reason: outcome.value.reason });
      return result = { status: 200, body: { channelId, state: outcome.value.outcome } };
    } finally {
      this.running = false;
      await this.audit.append({ at: this.now(), op: 'delete', phase: 'outcome', profileId: this.options.profileId, channelId,
        outcome: result ? String(result.body.state ?? result.body.error) : 'error', ...(this.failureDetail ? { failure: this.failureDetail } : {}), producer }).catch(() => undefined);
    }
  }
}
