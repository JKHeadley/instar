/**
 * What the person chose to do about one health problem (docs/specs/health-quick-actions.md).
 *
 *   snooze  Hide for a while: 1 hour, 1 day or 1 week. It shows again if it's still happening when that ends.
 *   hide    Hide from me: it stops showing and counting for the person. The agent keeps tracking it.
 *   ignore  Ignore completely: the agent stops tracking it. What that can honestly mean depends on the kind of
 *           item, so `offerFor` says which choices each item gets and what Ignore does there.
 *
 * A choice names one exact id: a degradation's feature or a `health:` id, never a family, so a different new
 * problem still shows. Two ids can't be chosen at all because they aren't one problem: the catch-alls.
 *
 * Multi-machine: replicated. A choice is saved here, pushed to every online machine of this agent, and pulled
 * on a timer so one that was offline catches up. Later stamp wins per id; an undo is a stamped removal, so a stale
 * copy can't bring a choice back. What each machine has seen of the problem stays on that machine.
 */
import fs from 'node:fs';
import path from 'node:path';
import { scrubSecrets } from './scrubSecrets.js';

export type HealthChoiceMode = 'snooze' | 'hide' | 'ignore';
export const SNOOZE_HOURS = [1, 24, 168] as const;

export const MAX_CHOICES = 200;
const SCHEMA_VERSION = 1;
const TITLE_MAX = 200;
const KEY_RE = /^[^\u0000-\u001f]{1,200}$/;
const HOUR = 3_600_000;
/** After a snooze ends its row stays this long, so a later return can still say it was hidden before. */
const RETURN_MEMORY_MS = 7 * 24 * HOUR;
/**
 * An undo stays as a stamp, so a machine offline for any length of time can't revive the choice it removed. Only
 * the oldest go, past this many: a bound on the file, not a time limit.
 */
const MAX_REMOVALS = 500;
const FUTURE_SKEW_MS = 24 * HOUR;
const LONGEST_SNOOZE_MS = Math.max(...SNOOZE_HOURS) * HOUR;
/**
 * /health counts an event for this long. Absent for less than this isn't "stopped": a restart empties the
 * in-memory events, and a problem that re-reports within the window never went away.
 */
const STOPPED_AFTER_MS = 30 * 60_000;
/** Refreshing "last seen" alone isn't worth a disk write more often than this. */
const SEEN_SAVE_MS = 10 * 60_000;

// ── What each item can be offered ────────────────────────────────────────────────────────────

/** Ids that aren't one problem. Choosing one could hide a different problem under the same name. */
const CATCH_ALL_IDS = new Set(['health:unnamed', 'health:unnamed-event']);

/**
 * Security and data-loss ids, read from each `report()` site. These only ever get Hide for a while: a person can
 * quiet one for a week, but nothing here can make the agent lose sight of it for good. A family covers its ids.
 */
const PROTECTED_IDS = new Set([
  // Security: credentials, identity, who may act.
  'HealthChoices.store', 'relay-script-modified-locally', 'AgentIdentity.coherence', 'Config.secretMerge', 'CredentialRebalancer', 'DesktopLocked.securityItem', 'ExternalOperationGate.consultLLM',
  'FeedbackInbox.blobToken', 'GitSync.commitSigning', 'MemoryPrivacy.sandbox', 'MobileDeviceKeyLedger', 'MobileSecrets.read',
  'PromptGate.executionApprovalAutoReject', 'SlackAdapter.authorizedUsers', 'TelegramAdapter.callbackApprover', 'TelegramIngress.lifelineSecret',
  'Threadline.encryptToPinned', 'Threadline.identity', 'Threadline.localRouteSignature', 'Threadline.refuseDowngrade',
  // Data loss: work, messages or state that could be lost.
  'AppConversations', 'InboundQueue.drain', 'SessionManager.injectMessage', 'SessionManager.verifyInjection.unsubmitted', 'ensureSqliteBindings.rebuildFailed', 'GitSync.rollbackSnapshot', 'HandoffManager.commitWip', 'HandoffManager.pushAll',
  'SemanticMemory', 'SessionManager.recoverPendingInjects', 'SharedStateLedger', 'sqlite-runtime-broken', 'Telegram.messageLog',
  'template-integrity-failed', 'threadline.inboundIdLedger', 'TopicMemory.dualWrite', 'UpdateChecker.postUpdateMigration',
]);
const PROTECTED_FAMILIES = ['GlobalSecretStore.', 'SecretStore.', 'SessionMigrator.', 'StateManager.', 'OutboundDedupStore.'];
/** The floor for an id written after this list: only ever narrows the choices, and only on the id. */
const PROTECTED_WORDS = /secret|credential|keychain|encrypt|privacy|security|leak|corrupt|data-?loss|backup/i;

/** LLM components that decide what may happen: a safety check failing often is a security item, not background noise. */
const PROTECTED_LLM_COMPONENTS = new Set(['InputGuard', 'CoherenceReviewer', 'IntentLlmJudge', 'LlmIntentClassifier', 'RelationshipAnomalyScorer']);
const PROTECTED_LLM_WORDS = /gate|guard|sentinel/i;

/** An LLM component's reliability: the one `health:` reading Ignore can really remove from what counts. */
export const LLM_COMPONENT_PREFIX = 'health:llm:';

export function isProtectedIssue(id: string): boolean {
  const name = id.startsWith(LLM_COMPONENT_PREFIX) ? id.slice(LLM_COMPONENT_PREFIX.length) : id;
  if (name !== id && (PROTECTED_LLM_COMPONENTS.has(name) || PROTECTED_LLM_WORDS.test(name))) return true;
  return PROTECTED_IDS.has(name) || PROTECTED_FAMILIES.some((f) => name.startsWith(f)) || PROTECTED_WORDS.test(name);
}

export const isCatchAllIssue = (id: string): boolean => CATCH_ALL_IDS.has(id);
const isLlmComponent = (id: string): boolean => id.startsWith(LLM_COMPONENT_PREFIX) && id.length > LLM_COMPONENT_PREFIX.length;
/** A reading /health works out live, which other parts of the agent also act on. */
const isLiveCheck = (id: string): boolean => id.startsWith('health:') && !isLlmComponent(id);

export interface HealthChoiceOffer {
  choices: HealthChoiceMode[];
  /** The one sentence Ignore's confirmation shows. Null when Ignore isn't offered. */
  ignoreSays: string | null;
  /** Why a choice isn't offered, for the screen. */
  choiceNote: string | null;
}

const IGNORE_EVENT = 'I’ll stop recording this problem, so you won’t hear about it again, even if it gets worse. You can undo this from Hidden, but I won’t have any record of what happened while it was ignored.';
const IGNORE_LLM = 'I’ll stop counting this as a problem, so it won’t make me report that something is wrong. I’ll still log how the check runs, and you can undo this from Hidden.';

/** The choices for one row. A row that groups several ids gets what all of them allow. */
export function offerFor(ids: readonly string[], unsorted = false): HealthChoiceOffer {
  // An id no row could carry (too long, control characters) would hide now and vanish on the next read of the file.
  if (ids.length === 0 || ids.some(isCatchAllIssue) || ids.some((id) => !KEY_RE.test(id))) {
    return { choices: [], ignoreSays: null, choiceNote: 'This one has no name I can follow, so hiding it could hide a different problem. Ask me about it instead.' };
  }
  if (ids.some(isProtectedIssue)) {
    return { choices: ['snooze'], ignoreSays: null, choiceNote: 'This one involves security or your data, so I keep it in view. You can hide it for a while, and then it comes back if it’s still happening.' };
  }
  if (ids.some(isLiveCheck)) {
    return { choices: ['snooze', 'hide'], ignoreSays: null, choiceNote: 'I can’t stop tracking this one: it’s a live reading other parts of me depend on. You can still hide it from yourself.' };
  }
  const said = ids.every(isLlmComponent) ? IGNORE_LLM : IGNORE_EVENT;
  return { choices: ['snooze', 'hide', 'ignore'], ignoreSays: unsorted ? `I haven’t worked out whether this one affects you. ${said}` : said, choiceNote: null };
}

// ── The saved rows ───────────────────────────────────────────────────────────────────────────

/** Who made a choice, shown on the Hidden list. A bearer token is the console or a session: it can't say which. */
export type HealthChoiceBy = 'phone' | 'dashboard-or-agent' | 'another-machine';

/** What crosses between machines. */
export interface HealthChoiceRow {
  key: string;
  mode: HealthChoiceMode;
  /** When a snooze ends. Null otherwise. */
  until: string | null;
  /** The stamp that decides which copy of this row wins. */
  at: string;
  title: string;
  by: HealthChoiceBy;
  /** A stable name for the machine that wrote it: breaks a tie between equal stamps. */
  origin: string;
  /** Set when it was undone. */
  removed: boolean;
}

/** What this machine has seen of the problem since the choice. Never replicated. */
interface Seen {
  lastSeenAt: string | null;
  clearedAt: string | null;
  cameBackAt: string | null;
}

type Stored = HealthChoiceRow & Seen;

export interface HealthHiddenRow {
  key: string;
  title: string;
  mode: HealthChoiceMode;
  until: string | null;
  at: string;
  by: HealthChoiceBy;
  /** Whether it's happening now. Null when the agent isn't tracking it, so it can't say. */
  happening: boolean | null;
  lastSeenAt: string | null;
  /** One plain sentence on where this stands. */
  line: string;
}

const parse = (s: string | null | undefined): number | null => {
  if (typeof s !== 'string') return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
};

function cleanTitle(v: unknown): string {
  if (typeof v !== 'string') return 'A problem you hid';
  const t = scrubSecrets(v.slice(0, TITLE_MAX * 2)).replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
  return t || 'A problem you hid';
}

/** A row from a peer or the disk, or null if any part of it can't be trusted to mean what it says. */
export function validateRow(raw: unknown, now: number): HealthChoiceRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.key !== 'string' || !KEY_RE.test(r.key)) return null;
  if (r.mode !== 'snooze' && r.mode !== 'hide' && r.mode !== 'ignore') return null;
  const at = typeof r.at === 'string' ? parse(r.at) : null;
  if (at === null || at > now + FUTURE_SKEW_MS) return null;
  const removed = r.removed === true;
  let until: string | null = null;
  // An undo needs nothing but its stamp: it must land whatever the snooze it removes said.
  if (r.mode === 'snooze' && !removed) {
    const u = typeof r.until === 'string' ? parse(r.until) : null;
    if (u === null || u <= at || u - at > LONGEST_SNOOZE_MS) return null;
    until = r.until as string;
  }
  // The rules travel with the row: a machine never takes a choice this id isn't offered, whichever machine sent it.
  if (!removed && !offerFor([r.key]).choices.includes(r.mode)) return null;
  return {
    key: r.key, mode: r.mode, until, at: r.at as string, title: cleanTitle(r.title),
    by: r.by === 'phone' ? 'phone' : r.by === 'another-machine' ? 'another-machine' : 'dashboard-or-agent',
    origin: typeof r.origin === 'string' ? r.origin.slice(0, 80) : '',
    removed,
  };
}

const newer = (a: HealthChoiceRow, b: HealthChoiceRow): boolean => {
  const ta = parse(a.at) ?? 0;
  const tb = parse(b.at) ?? 0;
  return ta !== tb ? ta > tb : a.origin > b.origin;
};

export interface HealthChoiceStoreOptions {
  stateDir: string;
  /** Names this machine on rows it writes. */
  origin?: string;
  now?: () => number;
  /** A read or write of the saved file failed. */
  onError?: (detail: string, err: unknown) => void;
}

export class HealthChoiceStore {
  private readonly file: string;
  private readonly auditFile: string;
  private readonly rowsByKey = new Map<string, Stored>();
  private lastSavedAt = 0;
  private dirty = false;
  private unreadable = false;
  /** The file exists but couldn't be read just now, so saving would overwrite choices it may hold. */
  private readError = false;
  private origin: string;

  constructor(private readonly opts: HealthChoiceStoreOptions) {
    this.file = path.join(opts.stateDir, 'state', 'health-choices.json');
    this.auditFile = path.join(opts.stateDir, 'logs', 'health-choices.jsonl');
    this.origin = opts.origin ?? '';
    this.load();
  }

  private now(): number { return this.opts.now ? this.opts.now() : Date.now(); }

  setOrigin(origin: string): void { this.origin = origin; }

  setOnError(onError: NonNullable<HealthChoiceStoreOptions['onError']>): void { this.opts.onError = onError; }

  /** True when the saved file couldn't be read: nothing is hidden, and every problem shows. */
  get failedToRead(): boolean { return this.unreadable; }

  private load(): void {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { this.unreadable = true; this.readError = true; this.opts.onError?.('read', err); }
      return;
    }
    try {
      const rows = (JSON.parse(text) as { rows?: unknown }).rows;
      if (!Array.isArray(rows)) throw new Error('no rows');
      const now = this.now();
      for (const raw of rows) {
        const row = validateRow(raw, now);
        if (!row) continue;
        const o = raw as Record<string, unknown>;
        const str = (v: unknown): string | null => (typeof v === 'string' && parse(v) !== null ? v : null);
        this.rowsByKey.set(row.key, { ...row, lastSeenAt: str(o.lastSeenAt), clearedAt: str(o.clearedAt), cameBackAt: str(o.cameBackAt) });
      }
    } catch (err) {
      // Everything shows until a new choice is made. Keep the bad file for whoever looks into it.
      this.unreadable = true;
      this.opts.onError?.('parse', err);
      try { fs.renameSync(this.file, `${this.file}.unreadable-${this.now()}`); } catch { /* @silent-fallback-ok — already reported; the next save replaces it */ }
    }
  }

  /** Try a failed read again before anything can overwrite the file. Throws if it still can't be read. */
  private ensureReadable(): void {
    if (!this.readError) return;
    this.readError = false;
    this.unreadable = false;
    this.load();
    if (this.readError) throw new Error('health choices could not be read');
  }

  private save(): void {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: SCHEMA_VERSION, rows: [...this.rowsByKey.values()] }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.lastSavedAt = this.now();
    this.dirty = false;
    this.unreadable = false;
  }

  private tryFlush(): void {
    if (!this.dirty || this.readError) return;
    try { this.save(); } catch (err) { this.opts.onError?.('write', err); }
  }

  private audit(event: string, row: HealthChoiceRow): void {
    try {
      fs.mkdirSync(path.dirname(this.auditFile), { recursive: true });
      fs.appendFileSync(this.auditFile, `${JSON.stringify({ at: new Date(this.now()).toISOString(), event, key: row.key, mode: row.mode, until: row.until, by: row.by, origin: row.origin })}\n`, { mode: 0o600 });
    } catch (err) {
      this.opts.onError?.('audit', err);
    }
  }

  private isActive(r: Stored): boolean {
    if (r.removed) return false;
    if (r.mode !== 'snooze') return true;
    return (parse(r.until) ?? 0) > this.now();
  }

  /** A stamp that always beats the row it replaces, even after a machine's clock moved back. */
  private stampAfter(key: string): string {
    const prior = parse(this.rowsByKey.get(key)?.at);
    const now = this.now();
    return new Date(prior !== null && prior >= now ? prior + 1 : now).toISOString();
  }

  /** Save a choice for these ids. All or nothing: throws if it can't be saved, and nothing changes. */
  choose(keys: readonly string[], input: { mode: HealthChoiceMode; hours?: number; title: string; by: HealthChoiceBy }): HealthChoiceRow[] {
    this.ensureReadable();
    const before = keys.map((k) => [k, this.rowsByKey.get(k)] as const);
    const rows = keys.map((key) => {
      const at = this.stampAfter(key);
      const until = input.mode === 'snooze' ? new Date(parse(at)! + (input.hours ?? 1) * HOUR).toISOString() : null;
      return { key, mode: input.mode, until, at, title: cleanTitle(input.title), by: input.by, origin: this.origin, removed: false };
    });
    for (const row of rows) this.rowsByKey.set(row.key, { ...row, lastSeenAt: new Date(this.now()).toISOString(), clearedAt: null, cameBackAt: null });
    try {
      this.prune();
      if (this.liveCount() > MAX_CHOICES) throw new Error('too-many-choices');
      this.save();
    } catch (err) {
      for (const [k, prior] of before) { if (prior) this.rowsByKey.set(k, prior); else this.rowsByKey.delete(k); }
      throw err;
    }
    for (const row of rows) this.audit('choose', row);
    return rows;
  }

  /** Bring one back. Null when nothing was hidden under that id. Throws if it can't be saved. */
  undo(key: string, by: HealthChoiceBy): HealthChoiceRow | null {
    this.ensureReadable();
    const prior = this.rowsByKey.get(key);
    if (!prior || prior.removed) return null;
    const row: HealthChoiceRow = { key, mode: prior.mode, until: null, at: this.stampAfter(key), title: prior.title, by, origin: this.origin, removed: true };
    this.rowsByKey.set(key, { ...row, lastSeenAt: null, clearedAt: null, cameBackAt: null });
    try {
      this.save();
    } catch (err) {
      this.rowsByKey.set(key, prior);
      throw err;
    }
    this.audit('undo', row);
    return row;
  }

  /** Take in a peer's rows. Later stamp wins. Returns how many changed anything here. */
  merge(raw: unknown): number {
    if (!Array.isArray(raw)) return 0;
    try { this.ensureReadable(); } catch { return 0; } // @silent-fallback-ok — already reported; the next pull brings it again
    const now = this.now();
    let changed = 0;
    for (const item of raw.slice(0, MAX_CHOICES * 2)) {
      const row = validateRow(item, now);
      if (!row) continue;
      const mine = this.rowsByKey.get(row.key);
      if (mine && !newer(row, mine)) continue;
      // A new key is refused once the list is full. A row for a key already here always lands, so an undo can.
      if (!mine && this.liveCount() >= MAX_CHOICES && !row.removed) continue;
      // A peer can't vouch for who made the choice: the screen says only that it came from another machine.
      this.rowsByKey.set(row.key, { ...row, by: 'another-machine', lastSeenAt: mine?.lastSeenAt ?? null, clearedAt: null, cameBackAt: null });
      this.audit('merge', row);
      changed += 1;
    }
    if (changed > 0) { this.dirty = true; this.tryFlush(); }
    return changed;
  }

  /** What a peer reads and takes in: never what this machine saw of the problem. */
  rows(): HealthChoiceRow[] {
    return [...this.rowsByKey.values()].map(({ key, mode, until, at, title, by, origin, removed }) => ({ key, mode, until, at, title, by, origin, removed }));
  }

  /** Rows that aren't undo stamps. */
  private liveCount(): number { return [...this.rowsByKey.values()].filter((r) => !r.removed).length; }

  private prune(): void {
    const now = this.now();
    for (const [key, r] of this.rowsByKey) {
      if (!r.removed && r.mode === 'snooze' && now - (parse(r.until) ?? now) > RETURN_MEMORY_MS) { this.rowsByKey.delete(key); this.dirty = true; }
    }
    const removals = [...this.rowsByKey.values()].filter((r) => r.removed);
    if (removals.length > MAX_REMOVALS) {
      removals.sort((a, b) => (parse(a.at) ?? 0) - (parse(b.at) ?? 0));
      for (const r of removals.slice(0, removals.length - MAX_REMOVALS)) this.rowsByKey.delete(r.key);
      this.dirty = true;
    }
  }

  // ── Policy: what the reporter and /health ask ──

  /** True when the person chose for the agent to stop tracking this exact id. */
  isIgnored(key: string): boolean {
    const r = this.rowsByKey.get(key);
    return !!r && !r.removed && r.mode === 'ignore';
  }

  /** True while this exact id is hidden from the person in any way. */
  hidesNow(key: string): boolean {
    const r = this.rowsByKey.get(key);
    return !!r && this.isActive(r);
  }

  hasRows(): boolean {
    for (const r of this.rowsByKey.values()) if (!r.removed) return true;
    return false;
  }

  /** Words for a problem that's showing again after a snooze ended, or null. */
  returnNote(key: string): string | null {
    const r = this.rowsByKey.get(key);
    if (!r || r.removed || r.mode !== 'snooze' || this.isActive(r)) return null;
    return r.cameBackAt
      ? 'You hid this earlier. It stopped, and then it came back.'
      : 'You hid this for a while, and it’s still happening.';
  }

  /** Note which ids are happening right now. Stopping and starting again is recorded so the person can be told. */
  observe(present: ReadonlySet<string>): void {
    const now = this.now();
    const nowIso = new Date(now).toISOString();
    let moved = false;
    this.prune();
    for (const r of this.rowsByKey.values()) {
      // An ignored id has nothing to observe: its events no longer arrive.
      if (r.removed || r.mode === 'ignore') continue;
      if (!present.has(r.key)) {
        const seen = parse(r.lastSeenAt) ?? parse(r.at) ?? now;
        if (!r.clearedAt && now - seen > STOPPED_AFTER_MS) { r.clearedAt = nowIso; moved = true; }
        continue;
      }
      if (r.clearedAt) {
        r.cameBackAt = nowIso;
        r.clearedAt = null;
        moved = true;
      }
      r.lastSeenAt = nowIso;
    }
    // A stop or a return is saved at once; a fresher "last seen" alone can wait.
    if (moved || (this.hasRows() && now - this.lastSavedAt > SEEN_SAVE_MS)) this.dirty = true;
    this.tryFlush();
  }

  /** The Hidden list: what's hidden now, soonest to come back first, then the rest, newest first. */
  hiddenRows(present: ReadonlySet<string>): HealthHiddenRow[] {
    const rows = [...this.rowsByKey.values()].filter((r) => this.isActive(r));
    rows.sort((a, b) => {
      const ua = parse(a.until);
      const ub = parse(b.until);
      if (ua !== null && ub !== null) return ua - ub;
      if (ua !== null) return -1;
      if (ub !== null) return 1;
      return (parse(b.at) ?? 0) - (parse(a.at) ?? 0);
    });
    return rows.map((r) => {
      // Absent isn't "stopped" until it has stayed absent: right after a restart, a real problem hasn't re-reported yet.
      const happening = r.mode === 'ignore' ? null : present.has(r.key) || !r.clearedAt;
      return { key: r.key, title: r.title, mode: r.mode, until: r.until, at: r.at, by: r.by, happening, lastSeenAt: r.mode === 'ignore' ? null : r.lastSeenAt, line: hiddenLine(r, happening) };
    });
  }
}

function hiddenLine(r: Stored, happening: boolean | null): string {
  if (r.mode === 'ignore') {
    return r.key.startsWith(LLM_COMPONENT_PREFIX)
      ? 'I’m not counting this as a problem, so I can’t say how it’s doing.'
      : 'I’m not tracking this, so I can’t say whether it’s still happening.';
  }
  const back = r.cameBackAt ? 'It stopped, and then it came back. ' : '';
  if (r.mode === 'hide') return `${back}I’m still keeping track of this. ${happening ? 'It’s happening now.' : 'It isn’t happening right now.'}`;
  return happening
    ? `${back}It’s happening now. If it still is when this ends, it shows again.`
    : 'It has stopped for now. If it starts again, you’ll see it when this ends.';
}

const stores = new Map<string, HealthChoiceStore>();

/** One store per state directory: the reporter, /health and the routes must all read the same choices. */
export function healthChoiceStoreFor(stateDir: string, opts: Omit<HealthChoiceStoreOptions, 'stateDir'> = {}): HealthChoiceStore {
  const known = stores.get(stateDir);
  if (known) { if (opts.onError) known.setOnError(opts.onError); return known; }
  const made = new HealthChoiceStore({ stateDir, ...opts });
  stores.set(stateDir, made);
  return made;
}
