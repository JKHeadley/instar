/**
 * Native "capacity" reads for the Instar iPhone app (docs/specs/mobile-native-capacity-screens.md).
 *
 *   GET /mobile/accounts   — subscription accounts: signed in or needing sign-in per machine,
 *                            usage windows with reset times (merged across the machines that answer).
 *   GET /mobile/spend      — what thinking costs on this machine: recorded cost with its basis,
 *                            paid-route limits, conversation token totals. ?window=today|week|month.
 *   GET /mobile/resources  — CPU and memory for the agent, its server and each session (last hour),
 *                            on EVERY machine: a combined summary plus one block per machine
 *                            (proxied-on-read to each peer's `?scope=local` answer; a machine that
 *                            does not answer is "not answering", never zeros). `?scope=local`
 *                            answers only the machine asked (the peer read; never fans out).
 *
 * Read-only. A paired OWNER phone (device-signed; DEVICE_ALLOWLIST lists exactly these three paths,
 * each `ownerOnly`) or the agent's bearer token may read them; anything else gets 403
 * `owner-phone-required`. Each answer is a purpose-built trimmed summary of what the web console
 * already shows the owner (Capacity > Accounts, What thinking costs, Resource usage), built from an
 * explicit field allowlist: no paths (`configHome`), ids, credentials, lease holders, raw error text
 * or config values. Free text is passed through the shared secret scrubber and length-capped.
 *
 * The summarizers are pure (unit-tested on both sides of every rule); the router takes its data
 * from the same server-side reads the console's own routes use.
 */
import crypto from 'node:crypto';
import type { Request, Response, Router } from 'express';
import { devicePersonOf } from './mobilePairingRoutes.js';
import { scrubSecrets } from '../monitoring/scrubSecrets.js';
import { verifiedEntityName } from '../messaging/shared/channelIdentity.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';

export const MOBILE_CAPACITY_SCHEMA_VERSION = 1;
/** A usage reading older than this is marked stale (the console's READING_STALE_MS). */
export const READING_STALE_MS = 60 * 60 * 1000;
export const MAX_ACCOUNTS = 100;
export const MAX_SPEND_ROWS = 50;
export const MAX_PAID_ROUTES = 30;
export const MAX_SESSIONS = 30;
export const RESOURCE_WINDOW_HOURS = 1;
/** A resource sample older than this reads "last recorded … ago", never "now" (the sampler runs every 30-60 s). */
export const SAMPLE_STALE_MS = 5 * 60_000;
/** A usage reading dated further ahead than this is treated as no reading (a clock or peer error). */
export const FUTURE_SKEW_MS = 5 * 60_000;
/** Pool-wide answers (accounts, spend) are cached this long, single-flight, so phone refreshes never multiply peer reads. */
export const POOL_READ_CACHE_MS = 15_000;
const REPAIR_WORKING = new Set(['approved', 'starting', 'running', 'in-progress', 'navigating', 'awaiting-code']);

type Rec = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const nonNeg = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
const iso = (v: unknown): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});

const SCRUB_MARGIN = 2048;

/** Free text for the phone: secrets scrubbed, whitespace folded, length capped. */
export function phoneText(v: unknown, max: number): string | null {
  // Cut before scrubbing: a scrub pattern is quadratic on long text, and a peer's answer can be long.
  // The margin keeps a secret that crosses the shown length whole enough to be caught.
  const s = str(v)?.slice(0, max + SCRUB_MARGIN);
  if (!s) return null;
  const clean = scrubSecrets(s).replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** A one-way, stable row key (never the id itself). */
export function rowKey(kind: string, id: string): string {
  return crypto.createHash('sha256').update(`mobile-capacity-${kind}:${id}`).digest('hex').slice(0, 16);
}

// ── access ────────────────────────────────────────────────────────────────────

type Principal = { kind: string };
/**
 * The bearer token (checked explicitly by `bearerOk`, never inferred from a missing principal), or a
 * device whose person resolves to the owner. Everything else is refused.
 */
export function ownerOrBearer(req: Request, bearerOk: (req: Request) => boolean): boolean {
  const p = (req as unknown as { instarPrincipal?: Principal }).instarPrincipal;
  if (!p || p.kind === 'token') return bearerOk(req);
  if (p.kind !== 'device') return false;
  const person = devicePersonOf(req);
  return person !== null && person.role === 'owner';
}

// ── accounts ──────────────────────────────────────────────────────────────────

const NEEDS_SIGN_IN = new Set(['needs-reauth', 'signed-out', 'expired', 'broken']);
const WRONG_LOGIN_SETTLE_MS = 24 * 60 * 60 * 1000;
const KIND_WORDS: Record<string, string> = { 'claude-code': 'Claude', 'codex-cli': 'Codex', 'gemini-cli': 'Gemini', 'grok-build': 'Grok', 'pi-cli': 'Pi' };
export function kindWord(framework: unknown): string { return (typeof framework === 'string' && KIND_WORDS[framework]) || 'Other'; }

export interface MobileAccountWindow { label: string; pct: number; resetsAt: string | null }
export interface MobileAccountMachine { name: string; isSelf: boolean; state: 'ok' | 'attn' | 'working' | 'unknown'; label: string }
export interface MobileAccount {
  key: string;
  name: string;
  email: string | null;
  kind: string;
  inUse: boolean;
  signIn: 'signed-in' | 'signed-in-unchecked' | 'signing-in' | 'needs-sign-in' | 'unknown';
  windows: MobileAccountWindow[];
  usageLine: string;
  tone: 'bad' | 'attn' | null;
  readingAt: string | null;
  stale: boolean;
  machines: MobileAccountMachine[];
}

/**
 * A machine row's sign-in state in words (the console's cellState). `repairing`: this machine is
 * running an automatic sign-in repair for the row (only known for this machine's own rows). A login
 * check that found the login signed out reads as needing sign-in even while the status says active.
 */
export function accountCellState(row: Rec, repairing = false, blockerReason: string | null = null, nowMs = Date.now()): { state: MobileAccountMachine['state']; label: string } {
  const status = str(row.status);
  if (repairing) return { state: 'working', label: 'signing in now' };
  // A slot proven to hold another account's login. Same rule as the console's accounts-model.js:
  // a fresh mismatch may correct itself; after a day it needs a new sign-in. The other account's
  // address stays off the phone.
  if (row.identityDrifted === true) {
    const drift = rec(row.identityDrift);
    if (drift.actualAccountId === 'missing-local-login' || drift.repairState === 'owner-relogin-required') return { state: 'attn', label: 'needs sign-in' };
    const at = Date.parse(String(drift.detectedAt ?? ''));
    if (drift.repairState === 'repairing' || (Number.isFinite(at) && nowMs - at < WRONG_LOGIN_SETTLE_MS)) {
      return { state: 'unknown', label: "holds another account's login; checking if it corrects itself" };
    }
    return { state: 'attn', label: "holds another account's login" };
  }
  // A repair blocker with no operator-only step is shown, not counted: `unknown` keeps the app's state list.
  if (status && NEEDS_SIGN_IN.has(status) && blockerReason && blockerReason !== 'device-limit-benched') {
    return { state: 'unknown', label: blockerReason === 'no-open-incident' ? 'sign-in not confirmed; still checking' : "automatic repair can't start yet" };
  }
  if (status && NEEDS_SIGN_IN.has(status)) return { state: 'attn', label: 'needs sign-in' };
  if (status === 'active' && row.loginCheck === 'signed-out') return { state: 'attn', label: 'login check failed' };
  if (status === 'active' && row.loginCheck === 'ok') return { state: 'ok', label: 'signed in' };
  if (status === 'active') return { state: 'ok', label: 'signed in (not re-checked)' };
  return { state: 'unknown', label: status && /^[a-z-]{1,24}$/.test(status) ? status.replace(/-/g, ' ') : 'unknown' };
}

/** Every usage window on a reading, highest first (the console's `tightest`, all windows kept). */
export function usageWindows(q: unknown): MobileAccountWindow[] {
  const r = rec(q);
  const wins: MobileAccountWindow[] = [];
  const seen = new Set<string>();
  for (const [k, label] of [['fiveHour', '5-hour'], ['sevenDay', 'weekly'], ['fable', 'Fable weekly'], ['primary', '5-hour'], ['secondary', 'weekly']] as const) {
    const w = rec(r[k]);
    if (!Object.keys(w).length || seen.has(label)) continue;
    const pct = Number(w.utilizationPct ?? w.usedPercent);
    if (!Number.isFinite(pct)) continue;
    seen.add(label);
    wins.push({ label, pct: Math.max(0, Math.round(pct)), resetsAt: iso(w.resetsAt ?? w.resetsAtIso) });
  }
  return wins.sort((a, b) => b.pct - a.pct);
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
/** The account's own login email, as the console shows it, or null. */
export function accountEmail(id: string, email: unknown): string | null {
  const v = verifiedEntityName(id, email);
  if (!v || v.length > 120 || !EMAIL_RE.test(v)) return null;
  return v;
}

interface AccountGroup { id: string; name: string | null; email: string | null; framework: unknown; cells: Array<{ row: Rec; machine: string; isSelf: boolean }>; reading: unknown; readingAt: number }
export interface AccountsOptions {
  /** The account this machine's sessions run on (`/subscription-pool/in-use`), or null. */
  inUseAccountId?: string | null;
  now: number;
  nicknameOf?: (machineId: string) => string | null;
  /** This machine's own repair episodes (accountId + state); remote rows are never matched. */
  localRepairs?: Array<{ accountId: string; state: string }>;
  /** Repair blockers across machines; a machine with no row here keeps its pool status. */
  blockers?: Array<{ accountId: string; machineId: string; reason: string }>;
  /** Registered machines the pool does not count as online (not asked): their ids. */
  offlineMachineIds?: string[];
}

/** A usage window at or over this share is "nearly out" (the rows' red tone uses the same line). */
export const NEAR_OUT_PCT = 90;

/**
 * Something on the Accounts screen that needs the person or changes what they can do. The screen's
 * notice spot shows only these, and nothing at all when the list is empty: a routine state (one
 * account full while others have room) is already on its row and is never a notice.
 * `action`: `sign-in` names the accounts (row keys) to sign in; `ask` is the question for the agent.
 */
export interface AccountNotice {
  key: string;
  tone: 'bad' | 'attn';
  title: string;
  /** When room comes back (the earliest account to free up), for an out-of-room notice. */
  returnsAt: string | null;
  action: { kind: 'sign-in'; accounts: string[] } | { kind: 'ask'; about: string };
}

type NoticeAccount = Pick<MobileAccount, 'key' | 'name' | 'kind' | 'signIn' | 'windows' | 'machines'>;

/** When this account has room again: every window at or over the line must reset (null if one has no time). */
function roomReturnsAt(a: NoticeAccount): number | null {
  const full = a.windows.filter((w) => w.pct >= NEAR_OUT_PCT);
  let latest = 0;
  for (const w of full) {
    const t = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
    if (!Number.isFinite(t)) return null;
    latest = Math.max(latest, t);
  }
  return latest || null;
}

/**
 * The notices, most serious first. Each rule is about the pool, never one account among several:
 *  - this machine's own account list can't be read (and nothing else was);
 *  - accounts need signing in (only what the person can act on: `needs-sign-in`);
 *  - a machine has no signed-in account (none signed in or signing in there, and one to sign in);
 *  - every usable account, or every usable account of one kind, is at or over the line,
 *    with when room returns. A kind with an unread usable account is not concluded on.
 */
export function accountNotices(accounts: NoticeAccount[], opts: { localUnreadable: boolean; partial: boolean }): AccountNotice[] {
  const out: AccountNotice[] = [];
  const scope = opts.partial ? ' (on the machines that answered)' : '';
  if (opts.localUnreadable && accounts.length === 0) {
    const title = "This machine's account list can't be read right now.";
    out.push({ key: 'list-unreadable', tone: 'bad', title, returnsAt: null, action: { kind: 'ask', about: title } });
    return out;
  }
  const needing = accounts.filter((a) => a.signIn === 'needs-sign-in');

  // A machine where nothing is signed in can run nothing. Grouped by the name the rows show.
  const byMachine = new Map<string, { states: string[]; attn: string[] }>();
  for (const a of accounts) for (const m of a.machines) {
    const g = byMachine.get(m.name) ?? { states: [], attn: [] };
    g.states.push(m.state);
    if (m.state === 'attn' && !g.attn.includes(a.key)) g.attn.push(a.key);
    byMachine.set(m.name, g);
  }
  const machineNotices: AccountNotice[] = [];
  for (const [name, g] of byMachine) {
    // Only when a sign-in would fix it: a machine whose rows are all unknown (warming up, still
    // checking) is not concluded on.
    if (g.states.some((s) => s === 'ok' || s === 'working') || g.attn.length === 0) continue;
    const title = `${name} has no signed-in account, so nothing can run there.`;
    machineNotices.push({ key: rowKey('notice-machine', name), tone: 'bad', title, returnsAt: null, action: { kind: 'sign-in', accounts: g.attn } });
  }

  // Out of room: per kind (a session uses only its own kind's accounts), or the whole pool at once.
  const usable = accounts.filter((a) => a.machines.some((m) => m.state === 'ok'));
  const kinds = [...new Set(usable.map((a) => a.kind))].sort();
  const outKinds: Array<{ kind: string; list: NoticeAccount[] }> = [];
  for (const kind of kinds) {
    const list = usable.filter((a) => a.kind === kind);
    if (list.some((a) => a.windows.length === 0)) continue; // one we can't read may have room
    if (list.every((a) => (a.windows[0]?.pct ?? 0) >= NEAR_OUT_PCT)) outKinds.push({ kind, list });
  }
  const roomNotice = (list: NoticeAccount[], kind: string | null): AccountNotice => {
    const usedUp = list.every((a) => (a.windows[0]?.pct ?? 0) >= 100);
    const state = usedUp ? 'used up' : 'nearly out';
    const noun = kind ? `${kind} account` : 'account';
    const title = list.length === 1 ? `The only ${noun} is ${state}${scope}.` : `All ${list.length} ${noun}s are ${state}${scope}.`;
    const times = list.map(roomReturnsAt).filter((t): t is number => t !== null);
    return { key: rowKey('notice-room', kind ?? '*'), tone: usedUp ? 'bad' : 'attn', title,
      returnsAt: times.length ? new Date(Math.min(...times)).toISOString() : null, action: { kind: 'ask', about: title } };
  };
  const roomNotices = outKinds.length && outKinds.length === kinds.length
    ? [roomNotice(outKinds.flatMap((k) => k.list), kinds.length === 1 ? kinds[0] : null)]
    : outKinds.map((k) => roomNotice(k.list, k.kind));

  out.push(...machineNotices);
  // An account a machine notice already asks to sign in is not asked for twice.
  const covered = new Set(machineNotices.flatMap((n) => (n.action.kind === 'sign-in' ? n.action.accounts : [])));
  const rest = needing.filter((a) => !covered.has(a.key));
  if (rest.length) {
    const more = covered.size ? ' more' : '';
    const title = `${rest.length === 1 ? `1${more} account needs` : `${rest.length}${more} accounts need`} signing in${scope}.`;
    out.push({ key: 'sign-in', tone: 'attn', title, returnsAt: null, action: { kind: 'sign-in', accounts: rest.map((a) => a.key) } });
  }
  out.push(...roomNotices);
  return out.sort((a, b) => Number(b.tone === 'bad') - Number(a.tone === 'bad'));
}

/**
 * Accounts from the `/subscription-pool?scope=pool` payload. One entry per account id; its freshest
 * usage reading; a sign-in state per machine row. Needing sign-in first, then by kind, then usage.
 */
export function summarizeAccounts(
  payload: unknown,
  opts: AccountsOptions,
): { enabled: boolean; localUnreadable: boolean; accounts: MobileAccount[]; headline: string; notices: AccountNotice[]; needsSignIn: number; usable: number; unread: { count: number; names: string[] }; offline: { count: number; names: string[] }; truncated: boolean } {
  const p = rec(payload);
  const nicknameOf = opts.nicknameOf ?? (() => null);
  const selfId = str(rec(p.pool).selfMachineId);
  const failedAll = Array.isArray(rec(p.pool).failed) ? (rec(p.pool).failed as unknown[]).map(rec) : [];
  // This machine's own row in `failed` (its pool unreadable or unconfigured) is not an unreached peer.
  const isSelfRow = (f: Rec) => f.machineId === 'self' || (!!selfId && f.machineId === selfId);
  const localUnreadable = failedAll.some((f) => isSelfRow(f) && f.error !== 'peer-pool-unconfigured');
  const failed = failedAll.filter((f) => !isSelfRow(f));
  const unread = {
    count: failed.length,
    names: failed.map((f) => phoneText(verifiedEntityName(String(f.machineId ?? ''), nicknameOf(String(f.machineId ?? ''))), 60)).filter((n): n is string => !!n),
  };
  const offlineIds = opts.offlineMachineIds ?? [];
  const offline = { count: offlineIds.length, names: offlineIds.map((id) => phoneText(verifiedEntityName(id, nicknameOf(id)), 60)).filter((n): n is string => !!n) };
  if (p.enabled === false || !Array.isArray(p.accounts)) {
    return { enabled: false, localUnreadable: false, accounts: [], headline: 'The account pool is not set up on this agent.', notices: [], needsSignIn: 0, usable: 0, unread, offline, truncated: false };
  }
  const repairing = new Set((opts.localRepairs ?? []).filter((e) => REPAIR_WORKING.has(e.state)).map((e) => e.accountId));
  const groups = new Map<string, AccountGroup>();
  for (const raw of p.accounts as unknown[]) {
    const r = rec(raw);
    const id = str(r.id);
    if (!id) continue;
    const g = groups.get(id) ?? { id, name: null, email: null, framework: r.framework, cells: [], reading: null, readingAt: 0 };
    g.name = g.name ?? phoneText(verifiedEntityName(id, r.nickname), 80);
    g.email = g.email ?? accountEmail(id, r.email);
    const mid = String(r.machineId ?? '');
    const isSelf = r.remote !== true;
    const machine = verifiedEntityName(mid, r.machineNickname) ?? verifiedEntityName(mid, nicknameOf(mid)) ?? (isSelf ? 'This machine' : 'A machine with no name yet');
    g.cells.push({ row: r, machine: phoneText(machine, 60) ?? 'A machine with no name yet', isSelf });
    const q = rec(r.lastQuota);
    const at = Date.parse(String(q.measuredAt ?? ''));
    // A reading dated in the future (beyond small skew) is not evidence; it can never win "freshest".
    if (Object.keys(q).length && Number.isFinite(at) && at <= opts.now + FUTURE_SKEW_MS && at > g.readingAt) { g.reading = q; g.readingAt = at; }
    groups.set(id, g);
  }
  const accounts = [...groups.values()].map((g): MobileAccount & { _pct: number } => {
    const machines = g.cells.map((c) => ({ name: c.machine, isSelf: c.isSelf, ...accountCellState(c.row, c.isSelf && repairing.has(g.id), (opts.blockers ?? []).find((b) => b.accountId === g.id && b.machineId === String(c.row.machineId ?? ''))?.reason ?? null, opts.now) }));
    const windows = usageWindows(g.reading);
    const top = windows[0] ?? null;
    const signIn: MobileAccount['signIn'] = machines.some((m) => m.state === 'attn') ? 'needs-sign-in'
      : machines.some((m) => m.state === 'working') ? 'signing-in'
        : machines.some((m) => m.state === 'ok' && m.label === 'signed in') ? 'signed-in'
          : machines.some((m) => m.state === 'ok') ? 'signed-in-unchecked' : 'unknown';
    return {
      key: rowKey('account', g.id),
      name: g.name ?? g.email ?? 'Account name unavailable',
      email: g.email,
      kind: kindWord(g.framework),
      // The resolver reads this machine's own auth surface: only an account with a row here can be in use here.
      inUse: !!opts.inUseAccountId && opts.inUseAccountId === g.id && g.cells.some((c) => c.isSelf),
      signIn,
      windows: windows.map((w) => ({ ...w, resetsAt: w.resetsAt && Date.parse(w.resetsAt) > opts.now ? w.resetsAt : null })),
      usageLine: top ? `${top.pct}% of ${top.label}` : g.framework === 'grok-build' ? "Usage isn't readable for this kind of account." : 'No reading yet.',
      tone: top && top.pct >= 90 ? 'bad' : top && top.pct >= 75 ? 'attn' : null,
      readingAt: g.readingAt ? new Date(g.readingAt).toISOString() : null,
      stale: !!g.readingAt && opts.now - g.readingAt > READING_STALE_MS,
      machines,
      _pct: top ? top.pct : -1,
    };
  }).sort((a, b) => Number(b.signIn === 'needs-sign-in') - Number(a.signIn === 'needs-sign-in')
    || a.kind.localeCompare(b.kind)
    || b._pct - a._pct
    || a.name.localeCompare(b.name));
  const needsSignIn = accounts.filter((a) => a.signIn === 'needs-sign-in').length;
  const usable = accounts.filter((a) => a.machines.some((m) => m.state === 'ok')).length;
  // Conclusions cover only the machines that answered; a partial read says so.
  // An offline machine was not read: its accounts may be missing, so conclusions are scoped too.
  const partial = unread.count > 0 || localUnreadable || offline.count > 0;
  const notices = accountNotices(accounts, { localUnreadable, partial });
  const read = accounts.filter((a) => a._pct >= 0 && a.machines.some((m) => m.state === 'ok'));
  // `headline` is kept for app builds that show it as a line of its own; current builds show `notices`
  // and nothing when there are none. It never names one account as "nearly out".
  let headline: string;
  if (notices.length) headline = notices[0].title;
  else if (accounts.length === 0) headline = partial ? 'No accounts found on the machines that answered.' : 'No accounts are set up yet.';
  else if (read.length) headline = `${read.filter((a) => a._pct < NEAR_OUT_PCT).length} of ${read.length} accounts have room.`;
  else headline = 'No usage readings yet.';
  const truncated = accounts.length > MAX_ACCOUNTS;
  return { enabled: true, localUnreadable, accounts: accounts.slice(0, MAX_ACCOUNTS).map(({ _pct, ...a }) => a), headline, notices, needsSignIn, usable, unread, offline, truncated };
}

// ── spend ─────────────────────────────────────────────────────────────────────

export const SPEND_WINDOWS = {
  today: { label: 'Today', hours: 24, phrase: 'today' },
  week: { label: '7 days', hours: 168, phrase: 'this week' },
  month: { label: '30 days', hours: 720, phrase: 'in the last 30 days' },
} as const;
export type SpendWindowKey = keyof typeof SPEND_WINDOWS;
/** The window named by the query, the console's default (`week`) for anything else. */
export function windowOf(q: unknown): SpendWindowKey {
  return typeof q === 'string' && Object.prototype.hasOwnProperty.call(SPEND_WINDOWS, q) ? (q as SpendWindowKey) : 'week';
}

/** A part of the spend answer: read, switched off on this agent, or not readable. */
/** A part of the spend answer: read; switched off on that machine; or not readable (`unreached`: the machine did not answer). */
export type SpendPart = { ok: true; data: unknown } | { ok: false; off: boolean; unreached?: boolean; offline?: boolean };

export function fmtUsd(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return 'under $0.01';
  return `$${n.toFixed(2)}`;
}
export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  return n.toLocaleString('en-US');
}
const DOOR_WORDS: Record<string, string> = { 'claude-code': 'Claude Code', 'codex-cli': 'Codex', 'gemini-cli': 'Gemini CLI', 'pi-cli': 'Pi', 'grok-build': 'Grok', openrouter: 'OpenRouter', groq: 'Groq', google: 'Google', anthropic: 'Anthropic', openai: 'OpenAI' };
/** The console's doorWord. */
export function doorWord(door: unknown): string {
  const d = phoneText(door, 40);
  if (!d) return 'an unknown route';
  return DOOR_WORDS[d] ?? d.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
/** The console's modelWord: 'claude-opus-4-8-20260115' → 'Claude Opus 4.8'. */
export function modelWord(id: unknown): string {
  const s = phoneText(id, 80);
  if (!s) return 'unknown model';
  const parts = s.split(/[-_]/).filter((x) => x && !/^\d{8}$/.test(x));
  const out: string[] = [];
  for (const x of parts) {
    if (/^\d+$/.test(x) && out.length && /\d$/.test(out[out.length - 1])) out[out.length - 1] += `.${x}`;
    else if (/^\d+$/.test(x) && out.length && /^gpt$/i.test(out[out.length - 1])) out[out.length - 1] += `-${x}`;
    else if (/^(gpt|llm|ai)$/i.test(x)) out.push(x.toUpperCase());
    else out.push(x.charAt(0).toUpperCase() + x.slice(1));
  }
  return out.join(' ') || s;
}
/** The console's basisWord. */
export function basisWord(costBasis: unknown): string {
  if (costBasis === 'provider-reported') return 'provider-reported';
  if (costBasis === 'subscription-zero') return 'subscription';
  if (costBasis === 'unpriced') return 'unpriced';
  if (costBasis === 'internal-derived' || costBasis === 'internal-derived-provider-tokens') return 'estimated';
  return 'basis not stated';
}
/** The console's routeStatusWord. */
export function routeStatusWord(k: Rec): 'Frozen' | 'Open' | 'Closed' | 'Not open' {
  if (k.frozen === true) return 'Frozen';
  if (k.goLiveState === 'live') return 'Open';
  if (k.goLiveState === 'disarmed') return 'Closed';
  return 'Not open';
}

export interface MobileSpendRow { key: string; model: string; route: string; basis: string; usd: number | null; tokens: number; unpricedTokens: number; priceStale: boolean; notLiveYet: boolean }
export interface MobilePaidRoute { key: string; name: string; status: 'Frozen' | 'Open' | 'Closed' | 'Not open'; committedDayUsd: number | null; dailyCapUsd: number | null; committedLifetimeUsd: number | null; lifetimeCapUsd: number | null; heldBy: string | null; committedElsewhere: boolean }
/** One machine's ledger read for the spend answer. `name` is the registry nickname (unverified; verified against `machineId` here). */
export interface SpendMachine { name: string | null; machineId?: string; isSelf: boolean; summary: SpendPart; tokens: SpendPart }
function machineName(m: SpendMachine): string {
  const v = m.machineId ? verifiedEntityName(m.machineId, m.name) : m.name;
  return phoneText(v, 60) ?? (m.isSelf ? 'This machine' : 'A machine with no name yet');
}
type SpendMachineLine = { name: string; isSelf: boolean; state: 'ok' | 'off' | 'unavailable' | 'unreached' | 'offline'; netUsd: number | null; unpricedTokens: number | null };

const partState = (part: SpendPart): SpendMachineLine['state'] => (part.ok ? 'ok' : part.off ? 'off' : part.offline ? 'offline' : part.unreached ? 'unreached' : 'unavailable');

/** One ledger's rows, in phone words (the console's costRow), keyed so the same model+route+basis merges across machines. */
function ledgerRows(data: unknown): { rows: MobileSpendRow[]; t: Rec } | null {
  const d = rec(data);
  const t = d.totals && typeof d.totals === 'object' ? rec(d.totals) : null;
  if (!Array.isArray(d.rows) || !t) return null;
  const rows = (d.rows as unknown[]).map(rec).map((r): MobileSpendRow => {
    const basis = basisWord(r.costBasis);
    const usd = r.costBasis === 'provider-reported' && num(r.providerReportedUsd) !== null ? Math.max(0, r.providerReportedUsd as number) : nonNeg(r.netUsd);
    return {
      key: rowKey('spend', `${String(r.door ?? '')}|${String(r.modelId ?? '')}|${basis}`),
      model: modelWord(r.modelId), route: doorWord(r.door), basis,
      usd: basis === 'unpriced' ? null : usd,
      tokens: nonNeg(r.tokensIn) + nonNeg(r.tokensOut),
      unpricedTokens: nonNeg(r.unpricedTokensIn) + nonNeg(r.unpricedTokensOut),
      priceStale: r.priceStale === true, notLiveYet: r.notLiveYet === true,
    };
  });
  return { rows, t };
}

/**
 * Recorded cost across the machines that answered (each machine's own ledger, read on that machine:
 * proxied-on-read). Rows with the same model, route and basis are added together; each machine's own
 * total is listed so the owner can see where it was recorded.
 */
export function summarizeRecorded(machines: SpendMachine[]): Rec {
  const lines: SpendMachineLine[] = [];
  const merged = new Map<string, MobileSpendRow>();
  let netUsd = 0; let tokens = 0; let unpricedTokens = 0; let amortized: number | null = null; let horizonNote: string | null = null;
  let anyOk = false;
  for (const m of machines) {
    let state = partState(m.summary);
    const read = m.summary.ok ? ledgerRows(m.summary.data) : null;
    if (m.summary.ok && !read) state = 'unavailable';
    if (!read) { lines.push({ name: machineName(m), isSelf: m.isSelf, state, netUsd: null, unpricedTokens: null }); continue; }
    anyOk = true;
    const net = nonNeg(read.t.netUsd);
    const unpriced = nonNeg(read.t.unpricedTokensIn) + nonNeg(read.t.unpricedTokensOut);
    netUsd += net; tokens += nonNeg(read.t.tokensIn) + nonNeg(read.t.tokensOut); unpricedTokens += unpriced;
    // Declared subscription costs are per-machine config; the same subscription may be declared on
    // several machines, so only this machine's figure is shown (labelled), never a sum.
    if (m.isSelf && num(read.t.amortizedSubscriptionUsd) !== null) amortized = read.t.amortizedSubscriptionUsd as number;
    if (m.isSelf) horizonNote = phoneText(rec(m.summary.ok ? m.summary.data : {}).horizonNote, 240);
    lines.push({ name: machineName(m), isSelf: m.isSelf, state: 'ok', netUsd: net, unpricedTokens: unpriced });
    for (const r of read.rows) {
      const prev = merged.get(r.key);
      if (!prev) { merged.set(r.key, { ...r }); continue; }
      prev.usd = prev.usd === null || r.usd === null ? null : prev.usd + r.usd;
      prev.tokens += r.tokens; prev.unpricedTokens += r.unpricedTokens;
      // Conservative: a flag any machine raised stays on the merged row.
      prev.priceStale = prev.priceStale || r.priceStale; prev.notLiveYet = prev.notLiveYet || r.notLiveYet;
    }
  }
  // Offline machines were not asked: precedence is over the machines that were.
  const asked = lines.filter((l) => l.state !== 'offline');
  const allOff = asked.length > 0 && asked.every((l) => l.state === 'off');
  if (!anyOk) {
    return allOff
      ? { state: 'off', reason: "Spend figures aren't available on this agent (the reporting view is switched off here).", machines: lines, rows: [] }
      : { state: 'unavailable', reason: "Can't tell what was recorded: the spend view could not be read.", machines: lines, rows: [] };
  }
  const rows = [...merged.values()].sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || b.tokens - a.tokens);
  const bases = [...new Set(rows.filter((r) => r.usd !== null && r.usd > 0).map((r) => r.basis))];
  const doors = [...new Set(rows.filter((r) => r.usd !== null && r.usd > 0).map((r) => r.route))];
  const PLAIN: Record<string, string> = { estimated: 'estimated from token counts and a price list', 'provider-reported': 'reported by the provider', 'basis not stated': 'basis not stated' };
  let howWords: string | null = null;
  if (netUsd > 0) {
    const h = `${bases.map((b) => PLAIN[b] ?? b).join(' and ') || 'basis not stated'}${doors.length === 1 ? `, all on ${doors[0]}` : ''}.`;
    howWords = h.charAt(0).toUpperCase() + h.slice(1);
  }
  return {
    state: 'ok', reason: null, netUsd, tokens, unpricedTokens,
    subscriptionTokens: rows.filter((r) => r.basis === 'subscription').reduce((a, r) => a + r.tokens, 0),
    amortizedUsd: amortized, howWords, horizonNote,
    machines: lines,
    rows: rows.slice(0, MAX_SPEND_ROWS), truncated: rows.length > MAX_SPEND_ROWS,
  };
}

/**
 * Paid-route limits and whether they enforce. Two separate sources with separate states, as in the
 * console: `routes` (the caps view, behind the spend view's switch) and `controls` (the money-layer
 * status). Both are this machine's (the money layer is held by one machine, named in the sentence).
 */
export function summarizeLimits(caps: SpendPart, status: SpendPart, nicknameOf: (machineId: string) => string | null = () => null, selfMachineIds: string[] = []): Rec {
  const isSelf = (id: string) => selfMachineIds.includes(id);
  let routesState: 'ok' | 'off' | 'unavailable' = 'ok'; let routesReason: string | null = null;
  let routes: MobilePaidRoute[] = [];
  let storeUnreadable = false; let truncated = false;
  if (!caps.ok) {
    routesState = caps.off ? 'off' : 'unavailable';
    routesReason = caps.off ? "Paid-route limits aren't readable on this agent (same switch as the spend figures)." : "Can't tell the limits: they could not be read.";
  } else {
    const d = rec(caps.data);
    if (!Array.isArray(d.keys)) { routesState = 'unavailable'; routesReason = 'The limits view answered without its routes.'; } else {
      const keys = (d.keys as unknown[]).map(rec);
      truncated = keys.length > MAX_PAID_ROUTES;
      // The name is built from the provider and route words only; the credential reference (keyRef) is hashed into `key`.
      routes = keys.slice(0, MAX_PAID_ROUTES).map((k) => {
        // The machine designated to spend on this route, by verified registry name only (never its id).
        const holder = typeof k.meteredLeaseHolder === 'string' && k.meteredLeaseHolder ? k.meteredLeaseHolder : null;
        // Committed spend is booked on the designated machine; read anywhere else it is not the
        // figure, so it is null (never a local $0) with `committedElsewhere`.
        const elsewhere = holder !== null && !isSelf(holder);
        return {
          key: rowKey('route', String(k.keyRef ?? '')),
          name: `${doorWord(k.provider)} · ${doorWord(k.door)}`,
          status: routeStatusWord(k),
          committedDayUsd: elsewhere ? null : nonNeg(k.committedDayUsd),
          dailyCapUsd: num(k.dailyCapUsd),
          committedLifetimeUsd: elsewhere ? null : nonNeg(k.committedLifetimeUsd),
          lifetimeCapUsd: num(k.lifetimeCapUsd),
          heldBy: holder === null ? null : isSelf(holder) ? 'this machine' : (phoneText(verifiedEntityName(holder, nicknameOf(holder)), 60) ?? 'another machine'),
          committedElsewhere: elsewhere,
        };
      });
      storeUnreadable = typeof d.storeError === 'string' && d.storeError.length > 0;
    }
  }
  const open = routes.filter((r) => r.status === 'Open').length;
  const frozen = routes.filter((r) => r.status === 'Frozen').length;
  const routesSentence = routesState !== 'ok' ? null : routes.length === 0 ? 'No paid route is set up.' : open === 0 && frozen === 0 ? 'No paid route is open.'
    : [open ? `${open} paid ${open === 1 ? 'route is' : 'routes are'} open` : null, frozen ? `${frozen} frozen` : null].filter(Boolean).join('; ') + '.';
  let controlsState: 'ok' | 'off' | 'unavailable' = 'ok';
  let sentence: string;
  let enforcing: boolean | null = null;
  let notEnforcingWhileOn = false;
  if (!status.ok) {
    controlsState = status.off ? 'off' : 'unavailable';
    sentence = status.off ? 'Spending limits are not built on this machine.' : "Can't tell whether spending limits are on.";
  } else {
    const s = rec(status.data);
    const life = str(s.lifecycleState);
    enforcing = s.enforcementReady === true;
    notEnforcingWhileOn = life === 'probe-failed' || life === 'construction-failed';
    const comp = typeof s.failingComponent === 'string' && /^[A-Za-z0-9 ._-]{1,48}$/.test(s.failingComponent) ? s.failingComponent : null;
    if (enforcing) sentence = 'Limits are on and enforcing';
    else if (life === 'enable-pending-restart') sentence = 'Limits are turned on but wait for a restart to start enforcing';
    else if (notEnforcingWhileOn) sentence = `Limits are turned on but not enforcing (${String(life).replace(/-/g, ' ')}${comp ? `: ${comp}` : ''})`;
    else if (!life || life === 'disabled') sentence = 'Spending limits are off';
    else sentence = /^[a-z-]{1,40}$/.test(life) ? `Limits: ${life.replace(/-/g, ' ')}` : 'Limits: state unknown';
    if (s.anyKeyFrozen === true) sentence += '; a paid route is frozen';
    // The status is this machine's own; the machine that holds each paid route is on the route (`heldBy`).
    sentence = `${sentence} on this machine.`;
  }
  return { routesState, routesReason, routesSentence, routes, storeUnreadable, truncated, controlsState, sentence, enforcing, notEnforcingWhileOn };
}

/** Conversation token totals across the machines that answered; Claude and Codex are never added together. */
export function summarizeConversations(machines: SpendMachine[], phrase: string): Rec {
  type Tally = { count: number; tokens: number };
  let claude = null as Tally | null;
  let codex = null as Tally | null;
  const lines: Array<{ name: string; isSelf: boolean; state: ReturnType<typeof partState> }> = [];
  for (const m of machines) {
    const d = m.tokens.ok ? rec(m.tokens.data) : null;
    const s = d && d.summary && typeof d.summary === 'object' ? rec(d.summary) : null;
    if (!s) { lines.push({ name: machineName(m), isSelf: m.isSelf, state: m.tokens.ok ? 'unavailable' : partState(m.tokens) }); continue; }
    lines.push({ name: machineName(m), isSelf: m.isSelf, state: 'ok' });
    claude = { count: (claude?.count ?? 0) + nonNeg(s.sessionsActive), tokens: (claude?.tokens ?? 0) + nonNeg(s.totalTokens) };
    const c = d && d.codex && typeof d.codex === 'object' ? rec(d.codex) : null;
    if (c) codex = { count: (codex?.count ?? 0) + nonNeg(c.sessionCount), tokens: (codex?.tokens ?? 0) + nonNeg(c.totalTokens) };
  }
  if (!claude) {
    const asked = lines.filter((l) => l.state !== 'offline');
    const allOff = asked.length > 0 && asked.every((l) => l.state === 'off');
    return { state: allOff ? 'off' : 'unavailable', reason: allOff ? "Conversation token use isn't tracked here." : "Can't tell about conversation token use.", claude: null, codex: null, machines: lines };
  }
  return {
    state: 'ok', reason: null, machines: lines,
    claude: { ...claude, line: `Claude: ${claude.count} ${claude.count === 1 ? 'conversation' : 'conversations'} processed ${fmtTokens(claude.tokens)} tokens ${phrase}.` },
    codex: codex ? { ...codex, line: `Codex: ${codex.count} ${codex.count === 1 ? 'conversation' : 'conversations'} active ${phrase} ${codex.count === 1 ? 'has' : 'have'} used ${fmtTokens(codex.tokens)} tokens over ${codex.count === 1 ? 'its' : 'their'} whole life.` } : null,
    note: 'The two lines measure different things and are not added together.',
  };
}

/** The whole spend answer (minus schemaVersion/generatedAt). `machines[0]` is this machine. */
export function summarizeSpend(windowKey: SpendWindowKey, parts: { machines: SpendMachine[]; caps: SpendPart; status: SpendPart; nicknameOf?: (machineId: string) => string | null; selfMachineIds?: string[]; now?: number }): Rec {
  const w = SPEND_WINDOWS[windowKey];
  const now = parts.now ?? Date.now();
  const recorded = summarizeRecorded(parts.machines);
  const limits = summarizeLimits(parts.caps, parts.status, parts.nicknameOf, parts.selfMachineIds ?? []);
  const conversations = summarizeConversations(parts.machines, w.phrase);
  const answered = (recorded.machines as SpendMachineLine[]).filter((l) => l.state === 'ok').length;
  const where = parts.machines.length <= 1 ? 'on this machine' : answered === parts.machines.length ? `across ${answered} machines` : `on the ${answered === 1 ? 'machine' : `${answered} machines`} that answered`;
  let headline: string;
  if (recorded.state === 'ok') {
    const net = recorded.netUsd as number;
    const unpriced = recorded.unpricedTokens as number;
    if (net > 0) headline = `About ${fmtUsd(net)} of pay-per-use cost ${w.phrase} ${where}.`;
    // $0 is only claimed when nothing went unpriced; otherwise the figure is not measured.
    else if (unpriced > 0) headline = `No priced pay-per-use cost ${w.phrase} ${where}; ${fmtTokens(unpriced)} tokens had no price on file.`;
    else headline = `No pay-per-use cost ${w.phrase} ${where}.`;
  } else if (recorded.state === 'off') headline = "Spend figures aren't available on this agent.";
  else headline = "Can't tell what AI use cost.";
  // What each figure actually covers: cost comes from whole UTC-day buckets (the ledger's daily
  // rollup, as the console reads it), tokens from the exact window. Both starts are returned.
  const costSince = new Date(new Date(now - Math.ceil(w.hours / 24) * 86_400_000).toISOString().slice(0, 10) + 'T00:00:00.000Z').toISOString();
  const tokensSince = new Date(now - w.hours * 3_600_000).toISOString();
  return { window: { key: windowKey, label: w.label, costSince, tokensSince }, headline, recorded, limits, conversations };
}

// ── resources ─────────────────────────────────────────────────────────────────

export interface MobileProcess { key: string; name: string; ended: boolean; stale: boolean; cpuPercent: number | null; memoryBytes: number | null; avgCpuPercent: number | null; peakCpuPercent: number | null; peakMemoryBytes: number | null; newestAt: string | null }

function processRow(s: Rec, key: string, name: string, now: number, ended = false): MobileProcess {
  const newest = num(s.newestTs) ?? (Number.isFinite(Date.parse(String(s.newestTs ?? ''))) ? Date.parse(String(s.newestTs)) : null);
  const stale = newest === null || now - newest > SAMPLE_STALE_MS;
  return {
    key, name, ended, stale,
    // An ended session has no current reading; its peaks for the hour stay.
    cpuPercent: ended ? null : num(s.currentCpuPercent), memoryBytes: ended ? null : num(s.currentRssBytes),
    avgCpuPercent: num(s.avgCpuPercent), peakCpuPercent: num(s.peakCpuPercent), peakMemoryBytes: num(s.peakRssBytes),
    newestAt: newest !== null ? new Date(newest).toISOString() : null,
  };
}
const gb = (b: number | null): string => (b !== null ? `${(b / 1e9).toFixed(1)} GB` : 'unknown');
function agoWords(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

/**
 * The `/resources/summary` sources as the phone shows them. `sessionNames`: running session id → name.
 * A reading older than SAMPLE_STALE_MS is "last recorded … ago", never "now".
 */
export function summarizeResources(sources: unknown, sessionNames: Map<string, string>, machine: string, now: number): { headline: string; total: MobileProcess | null; server: MobileProcess | null; sessions: MobileProcess[]; truncated: boolean; machine: string } {
  const list = Array.isArray(sources) ? (sources as unknown[]).map(rec) : [];
  const agg = list.find((s) => s.source === 'aggregate');
  const srv = list.find((s) => s.source === 'agent-server');
  const sessions = list.filter((s) => typeof s.source === 'string' && s.source.startsWith('session:'))
    .map((s) => {
      const id = String(s.source).slice('session:'.length);
      const running = sessionNames.get(id);
      return processRow(s, rowKey('session', id), phoneText(running, 80) ?? (running === undefined ? 'A session that has ended' : 'A session'), now, running === undefined);
    })
    .sort((a, b) => Number(a.ended) - Number(b.ended) || (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1) || (b.peakCpuPercent ?? -1) - (a.peakCpuPercent ?? -1) || a.name.localeCompare(b.name));
  const total = agg ? processRow(agg, 'total', 'Everything together', now) : null;
  let headline = 'No total reading yet.';
  if (total && total.cpuPercent !== null) {
    const use = `${Math.round(total.cpuPercent)}% CPU and ${gb(total.memoryBytes)} of memory`;
    const peak = `peak ${Math.round(total.peakCpuPercent ?? 0)}% in the last hour`;
    headline = total.stale && total.newestAt
      ? `Last recorded ${agoWords(now - Date.parse(total.newestAt))}: Instar was using ${use} (${peak}). No newer reading.`
      : `Instar is using ${use} now (${peak}).`;
  }
  return { headline, total, server: srv ? processRow(srv, 'server', 'The agent server', now) : null, sessions: sessions.slice(0, MAX_SESSIONS), truncated: sessions.length > MAX_SESSIONS, machine };
}

/** Busiest sessions shown per machine in the pooled answer. */
export const MAX_SESSIONS_PER_MACHINE = 5;

/** One machine of the pool, as the pooled resources read needs it (no ids are returned). */
export interface ResourceMachineInfo {
  key: string; name: string; isSelf: boolean; leading: boolean;
  sessions: number | null; maxSessions: number | null; version: string | null;
}
/** A machine's own `/mobile/resources?scope=local` answer, or why there is none. */
export type ResourceAnswer = { ok: true; body: unknown } | { ok: false; reason: 'not-answering' | 'offline' };

export interface MobileResourceMachine {
  key: string; name: string; leading: boolean;
  /** answering: a reading came back; off: the machine answered but does not record resource use; not-answering: no answer. */
  state: 'answering' | 'off' | 'not-answering';
  /** Short: "43% CPU · 6.1 GB", "Last read 12 min ago: …", "Not answering", "Not recorded there". */
  line: string;
  headline: string | null;
  total: MobileProcess | null;
  server: MobileProcess | null;
  /** The busiest few, running first. */
  sessions: MobileProcess[];
  sessionsShownOf: number;
  runningSessions: number | null; maxSessions: number | null; version: string | null;
}
export interface MobileResourcesCombined {
  headline: string;
  busiest: string | null;
  machines: number; answering: number; notAnswering: string[]; off: string[];
  memoryBytes: number | null; runningSessions: number | null; maxSessions: number | null;
}

/** A process row from a peer's answer, re-checked field by field (a peer's text is not trusted as shaped). */
function peerProcess(v: unknown): MobileProcess | null {
  const p = rec(v);
  const key = str(p.key);
  if (!key || !/^[A-Za-z0-9_-]{1,40}$/.test(key)) return null;
  return {
    key, name: phoneText(p.name, 80) ?? 'A session', ended: p.ended === true, stale: p.stale === true,
    cpuPercent: num(p.cpuPercent), memoryBytes: num(p.memoryBytes), avgCpuPercent: num(p.avgCpuPercent),
    peakCpuPercent: num(p.peakCpuPercent), peakMemoryBytes: num(p.peakMemoryBytes), newestAt: iso(p.newestAt),
  };
}

function useWords(p: MobileProcess, now: number): string {
  const use = `${p.cpuPercent !== null ? `${Math.round(p.cpuPercent)}%` : '?'} CPU · ${gb(p.memoryBytes)}`;
  if (p.stale && p.newestAt) return `Last read ${agoWords(now - Date.parse(p.newestAt))}: ${use}`;
  return use;
}

/**
 * Every machine's resource use, merged for the phone. Each machine's own answer is re-read through
 * an allowlist; a machine that did not answer carries no numbers at all.
 */
export function summarizeResourceMachines(inputs: Array<{ info: ResourceMachineInfo; answer: ResourceAnswer }>, now: number): { machines: MobileResourceMachine[]; combined: MobileResourcesCombined } {
  const machines = inputs.map(({ info, answer }): MobileResourceMachine => {
    const base = { key: info.key, name: phoneText(info.name, 60) ?? 'A machine with no name yet', leading: info.leading, runningSessions: info.sessions, maxSessions: info.maxSessions, version: info.version };
    if (!answer.ok) return { ...base, state: 'not-answering', line: answer.reason === 'offline' ? 'Offline' : 'Not answering', headline: null, total: null, server: null, sessions: [], sessionsShownOf: 0 };
    const b = rec(answer.body);
    if (b.enabled !== true) return { ...base, state: 'off', line: 'Not recorded there', headline: null, total: null, server: null, sessions: [], sessionsShownOf: 0 };
    const all = (Array.isArray(b.sessions) ? b.sessions : []).map(peerProcess).filter((x): x is MobileProcess => !!x);
    const total = peerProcess(b.total);
    const line = total && total.cpuPercent !== null ? useWords(total, now) : 'No reading yet';
    return { ...base, state: 'answering', line, headline: phoneText(b.headline, 200), total, server: peerProcess(b.server), sessions: all.slice(0, MAX_SESSIONS_PER_MACHINE), sessionsShownOf: all.length };
  }).sort((a, b) => Number(a.state === 'answering') - Number(b.state === 'answering') || Number(b.leading) - Number(a.leading) || a.name.localeCompare(b.name));
  const answering = machines.filter((m) => m.state === 'answering');
  const read = answering.filter((m) => m.total && !m.total.stale);
  const sum = (xs: Array<number | null>): number | null => (xs.length && xs.every((x) => x !== null) ? xs.reduce<number>((a, x) => a + (x as number), 0) : null);
  const memoryBytes = read.length ? sum(read.map((m) => m.total!.memoryBytes)) : null;
  const runningSessions = sum(machines.map((m) => m.runningSessions));
  const maxSessions = sum(machines.map((m) => m.maxSessions));
  const busiestM = read.filter((m) => m.total!.cpuPercent !== null).sort((a, b) => (b.total!.cpuPercent ?? 0) - (a.total!.cpuPercent ?? 0))[0];
  const notAnswering = machines.filter((m) => m.state === 'not-answering').map((m) => m.name);
  const off = machines.filter((m) => m.state === 'off').map((m) => m.name);
  const n = machines.length;
  let headline: string;
  if (!answering.length) headline = n === 1 ? "The machine's resource use couldn't be read." : "No machine's resource use could be read right now.";
  else {
    const parts = [n === 1 ? null : answering.length === n ? `All ${n} machines` : `${answering.length} of ${n} machines`,
      memoryBytes !== null ? `${gb(memoryBytes)} of memory` : null,
      runningSessions !== null ? `${runningSessions} ${runningSessions === 1 ? 'session' : 'sessions'}` : null].filter(Boolean);
    headline = parts.length ? parts.join(' · ') : 'Resource use, last hour';
  }
  const busiest = busiestM ? `Busiest: ${busiestM.name}, ${Math.round(busiestM.total!.cpuPercent ?? 0)}% CPU` : null;
  return { machines, combined: { headline, busiest, machines: n, answering: answering.length, notAnswering, off, memoryBytes, runningSessions, maxSessions } };
}

// ── routes ────────────────────────────────────────────────────────────────────

export interface MobileCapacityDeps {
  /** The `/subscription-pool?scope=pool` payload. */
  accountsView: () => Promise<unknown>;
  /** The account this machine is running on (`/subscription-pool/in-use`, cached resolver), or null. */
  inUseAccountId: () => Promise<string | null>;
  /** Registered machines the pool does not count as online (ids; never returned). */
  offlineMachineIds?: () => string[];
  /** This machine's sign-in repair episodes (`/subscription-relogin`, local store). */
  localRepairs: () => Array<{ accountId: string; state: string }>;
  /** Repair blockers across machines; unavailable means cells keep their pool status. */
  reloginBlockers?: () => Promise<Array<{ accountId: string; machineId: string; reason: string }>>;
  /** This machine's `/routing-spend/summary?grain=day&sinceHours=N` and `/tokens/summary?since=` reads. */
  spendSummary: (sinceHours: number) => SpendPart;
  tokens: (sinceMs: number) => SpendPart;
  /** The same two reads from each online peer (proxied-on-read; a peer that does not answer is `unreached`). */
  peerSpend: (sinceHours: number, sinceMs: number) => Promise<SpendMachine[]>;
  /** `/routing-spend/caps` (behind the same switch) and `/routing-spend/enable-status`, this machine's. */
  spendCaps: () => SpendPart;
  spendStatus: () => SpendPart;
  /** `/resources/summary` sources since the time given, or null when the resource ledger is off. */
  resourceSources: (sinceMs: number) => unknown[] | null;
  /**
   * Every machine in the pool (this one included, `isSelf`), or [] when there is no pool. With
   * `peerResources`, makes `/mobile/resources` pooled; without them it answers this machine only.
   */
  resourceMachines?: () => ResourceMachineInfo[];
  /** A peer's own `/mobile/resources?scope=local` answer (5 s bound), by its row key. */
  peerResources?: (key: string) => Promise<ResourceAnswer>;
  /** Running session id → name. */
  runningSessionNames: () => Map<string, string>;
  /** Machine id → registry nickname (unverified; the summarizers verify it). */
  nicknameOf: (machineId: string) => string | null;
  /** This machine's verified name, or null. */
  selfName: () => string | null;
  /**
   * Every id this machine is known by (its mesh id and the money layer's own machine id, which the
   * designation is written with), compared with a paid route's designated machine; never returned.
   */
  selfMachineIds?: () => string[];
  /** Whether the request carries the agent's own bearer token (explicit check). */
  bearerOk: (req: Request) => boolean;
  now?: () => number;
}

/** A read the phone could not get is recorded (route + error class only), never silent. */
function reportReadFailure(route: string, err: unknown): void {
  try {
    DegradationReporter.getInstance().report({
      feature: 'MobileCapacityScreens.read',
      primary: `${route} answers the phone's native screen`,
      fallback: 'the phone shows "couldn\'t read" and the owner can retry or open the console',
      reason: err instanceof Error ? err.name : 'unknown error',
      impact: 'The owner\'s phone cannot show this screen until the read succeeds.',
    });
  } catch { /* @silent-fallback-ok — reporting must never turn a 500 into a crash */ }
}

/** Run one spend part; a throw becomes "unavailable" (reported), never a 500 for the whole answer. */
function safePart(route: string, f: () => SpendPart): SpendPart {
  try { return f(); } catch (err) { reportReadFailure(route, err); return { ok: false, off: false }; }
}

/** A short single-flight cache: concurrent and repeated reads within `ttlMs` share one underlying read. */
export function singleFlight<T>(ttlMs: number, now: () => number): (key: string, f: () => Promise<T>) => Promise<T> {
  const entries = new Map<string, { at: number; p: Promise<T> }>();
  return (key, f) => {
    const t = now();
    const e = entries.get(key);
    if (e && t - e.at < ttlMs) return e.p;
    const p = f();
    entries.set(key, { at: t, p });
    // A failed read is not cached. The caller still receives the rejection (this branch only evicts).
    // E2E-PAIRING: EXEMPT — comment-only change here; the routes keep their e2e (tests/e2e/mobile-native-capacity-screens-alive.test.ts).
    p.catch(() => { if (entries.get(key)?.p === p) entries.delete(key); }); // @silent-fallback-ok — eviction only; the rejection reaches the caller through the returned promise
    return p;
  };
}

export function mountMobileCapacityRoutes(router: Router, deps: MobileCapacityDeps): void {
  const now = () => (deps.now ? deps.now() : Date.now());
  const cached = singleFlight<Rec>(POOL_READ_CACHE_MS, now);
  const guard = (req: Request, res: Response): boolean => {
    res.set('Cache-Control', 'no-store');
    if (ownerOrBearer(req, deps.bearerOk)) return true;
    res.status(403).json({ error: 'owner-phone-required', detail: 'Only the owner\'s phone can see accounts, spending and resource use.' });
    return false;
  };
  const head = () => ({ schemaVersion: MOBILE_CAPACITY_SCHEMA_VERSION, generatedAt: new Date(now()).toISOString() });

  router.get('/mobile/accounts', async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try {
      const body = await cached('accounts', async () => {
        const [payload, inUse, blockers] = await Promise.all([deps.accountsView(), deps.inUseAccountId().catch(() => null), deps.reloginBlockers?.().catch(() => []) ?? Promise.resolve([])]);
        let repairs: Array<{ accountId: string; state: string }> = [];
        try { repairs = deps.localRepairs(); } catch { /* @silent-fallback-ok — no repair evidence: cells show their pool status */ }
        // generatedAt is stamped when the answer is built, so a cached answer keeps its own time.
        return { ...head(), ...summarizeAccounts(payload, { inUseAccountId: inUse, now: now(), nicknameOf: deps.nicknameOf, localRepairs: repairs, blockers, offlineMachineIds: deps.offlineMachineIds?.() ?? [] }) } as unknown as Rec;
      });
      res.json(body);
    } catch (err) {
      reportReadFailure('GET /mobile/accounts', err);
      res.status(500).json({ error: 'accounts-unavailable' });
    }
  });

  router.get('/mobile/spend', async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try {
      const key = windowOf(req.query.window);
      const body = await cached(`spend:${key}`, async () => {
        const hours = SPEND_WINDOWS[key].hours;
        const sinceMs = now() - hours * 3_600_000;
        let peers: SpendMachine[] = [];
        try { peers = await deps.peerSpend(hours, sinceMs); } catch (err) { reportReadFailure('GET /mobile/spend (peers)', err); }
        const self: SpendMachine = {
          name: deps.selfName(), isSelf: true,
          summary: safePart('GET /mobile/spend (recorded)', () => deps.spendSummary(hours)),
          tokens: safePart('GET /mobile/spend (tokens)', () => deps.tokens(sinceMs)),
        };
        return { ...head(), ...summarizeSpend(key, {
          nicknameOf: deps.nicknameOf,
          selfMachineIds: deps.selfMachineIds?.() ?? [],
          now: now(),
          machines: [self, ...peers],
          caps: safePart('GET /mobile/spend (limits)', () => deps.spendCaps()),
          status: safePart('GET /mobile/spend (limits status)', () => deps.spendStatus()),
        }) };
      });
      res.json(body);
    } catch (err) {
      reportReadFailure('GET /mobile/spend', err);
      res.status(500).json({ error: 'spend-unavailable' });
    }
  });

  /** This machine's own answer (the shape every older phone reads). */
  const localResources = (): Rec => {
    const machine = phoneText(deps.selfName(), 60) ?? 'This machine';
    const sources = deps.resourceSources(now() - RESOURCE_WINDOW_HOURS * 3_600_000);
    if (sources === null) {
      return { ...head(), enabled: false, machine, windowHours: RESOURCE_WINDOW_HOURS, headline: "Resource usage isn't recorded on this agent.", total: null, server: null, sessions: [], truncated: false };
    }
    return { ...head(), enabled: true, windowHours: RESOURCE_WINDOW_HOURS, ...summarizeResources(sources, deps.runningSessionNames(), machine, now()) };
  };

  router.get('/mobile/resources', async (req: Request, res: Response) => {
    if (!guard(req, res)) return;
    try {
      const local = localResources();
      if (req.query.scope === 'local' || !deps.resourceMachines || !deps.peerResources) { res.json(local); return; }
      const pooled = await cached('resources', async () => {
        const list = deps.resourceMachines!();
        if (!list.length) return {} as Rec;
        const inputs = await Promise.all(list.map(async (info) => ({
          info,
          answer: info.isSelf ? { ok: true as const, body: local } : await deps.peerResources!(info.key).catch((): ResourceAnswer => ({ ok: false, reason: 'not-answering' })),
        })));
        return summarizeResourceMachines(inputs, now()) as unknown as Rec;
      });
      // The top-level fields stay this machine's, so an older phone reads what it always did.
      res.json(Array.isArray(pooled.machines) ? { ...local, scope: 'pool', ...pooled } : local);
    } catch (err) {
      reportReadFailure('GET /mobile/resources', err);
      res.status(500).json({ error: 'resources-unavailable' });
    }
  });
}
