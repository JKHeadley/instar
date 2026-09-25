/**
 * QuotaPoller — per-account live quota reader (P1.2 of the Subscription & Auth
 * Standard, decision C hybrid read).
 *
 * Produces an AccountQuotaSnapshot per SubscriptionPool account: 5-hour and
 * 7-day utilization + reset dates, per-model breakdown, and extra-usage credit
 * state — exactly what the QuotaAwareScheduler (P1.3) needs to drain each
 * account optimally before its reset and swap before a limit.
 *
 * ── Read mechanism (decision C, grounded by hands-on finding) ──
 * Justin chose C: drive Claude Code's own /usage surface by default, the
 * `GET /api/oauth/usage` endpoint as a bounded fallback. FINDING (2026-06-06):
 * Claude Code does NOT persist usage to disk and exposes no non-interactive
 * usage command, so a truly "read what the client cached" primary does not
 * exist. The only viable Claude mechanism is the OAuth usage endpoint — the
 * same endpoint the client's /usage screen calls internally. So the poller:
 *   - resolves each account's OAuth access token TRANSIENTLY from that account's
 *     own config-home credential store (never persisted, never logged),
 *   - calls the read-only usage endpoint at LOW frequency, and
 *   - stamps the snapshot `source: 'oauth-usage-endpoint-fallback'` for honesty.
 * This is read-only TELEMETRY, not inference — distinct from the inference-
 * spoofing Anthropic enforces against. It stays within decision C's accepted
 * bounds (subscription-only, no API keys, official-client login reused).
 *
 * ── Burn rate, not call count ──
 * The scheduler must decide on MEASURED utilization deltas over time, never raw
 * call volume (lesson: call counts overstate real burn ~100× because the
 * LlmQueue shed layer absorbs most background traffic). The poller exposes a
 * per-account burn rate (utilization %/hour) computed from consecutive reads.
 *
 * Testability: `fetchImpl` and `tokenResolver` are injectable so the whole
 * poller runs hermetically with zero credentials and zero network in tests.
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  SubscriptionPool,
  SubscriptionAccount,
  AccountQuotaSnapshot,
} from './SubscriptionPool.js';
import {
  readClaudeOauthAsyncDetailed,
  refreshClaudeToken,
  expandHome,
  type RefreshResult,
} from './OAuthRefresher.js';
import type { CredentialLocationGate } from './CredentialLocationGate.js';
import type { CredentialLocationLedger } from './CredentialLocationLedger.js';
import type {
  SubscriptionLoginCauseClass,
  SubscriptionLoginSettledOutcome,
} from './SubscriptionLoginLedger.js';
import type { CodexLiveRead } from '../providers/adapters/openai-codex/observability/codexLiveRateLimitReader.js';
import type { CliLoginVerdict } from './CliLoginStatus.js';
import {
  readLatestCodexUsage,
  type CodexUsageSnapshot,
  type ReadCodexUsageOptions,
} from '../providers/adapters/openai-codex/observability/codexRateLimitReader.js';

/**
 * Injectable token resolver — returns an account's OAuth access token, null,
 * or a closed re-auth reason when the credential itself is malformed.
 * The default (`defaultTokenResolver`) is ASYNC so the per-account keychain read happens OFF the
 * event loop (a slow/contended `securityd` read used to freeze the loop every poll cycle — the
 * dashboard-flap / false-sleep residual). `pollAccount` `await`s the result, so a SYNC resolver
 * (e.g. a test stub returning a plain string) is equally valid — hence the union return type.
 */
export type TokenResolution =
  | string
  | null
  | { reauthNeeded: true; reason: 'unparseable-credential-blob' }
  | { observationOnly: true; reason:
      'credential-absent-or-unreadable' | 'credential-missing-oauth-block' | 'credential-token-shape-invalid' };

export type TokenResolver = (
  account: SubscriptionAccount,
) => TokenResolution | Promise<TokenResolution>;

/**
 * Injectable account refresher — exchanges a config home's stored refresh token
 * for a fresh access token (see OAuthRefresher). Defaults to the real keychain/
 * file-backed refresh; tests inject a stub so the poller runs hermetically.
 */
export type AccountRefresher = (account: SubscriptionAccount) => Promise<RefreshResult>;
export type CodexUsageReader = (opts?: ReadCodexUsageOptions) => Promise<CodexUsageSnapshot | null>;

/** Minimal fetch surface so tests inject a stub (no global fetch dependency). */
export type FetchImpl = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface QuotaPollerConfig {
  pool: SubscriptionPool;
  /** Poll cadence. Default 15 min — low frequency by design (telemetry, not hot path). */
  pollIntervalMs?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: FetchImpl;
  /** Injected for tests; defaults to the config-home credential resolver. */
  tokenResolver?: TokenResolver;
  /**
   * Injected for tests; defaults to the real OAuth refresh-token exchange. On a
   * usage-read auth failure the poller calls this BEFORE declaring needs-reauth,
   * so a routine access-token expiry recovers silently instead of crying wolf.
   */
  refresher?: AccountRefresher;
  /** Injected for tests; defaults to the rollout-backed Codex usage reader. */
  codexUsageReader?: CodexUsageReader;
  /**
   * The zero-spend LIVE codex reader (`codex app-server` →
   * account/rateLimits/read). Tried FIRST for codex accounts; any failure
   * falls back to `codexUsageReader` (the rollout tail), so the worst case is
   * exactly the rollout-only behaviour. DELIBERATELY no real default: absent
   * or null means rollout-only, and the production implementation is injected
   * once at server composition via `buildCodexLiveUsageReader` — so a test
   * that builds a poller without injecting one can never spawn a real
   * `codex` subprocess. Config lever: `subscriptionPool.codexLiveQuota: false`.
   */
  codexLiveUsageReader?: CodexUsageReader | null;
  /**
   * The live codex read with its failure KIND kept (spec skill-driven-signin-repair). When
   * present it REPLACES `codexLiveUsageReader`: an app-server "authentication required"
   * refusal is then told apart from a transport failure, and only a live `codex-app-server`
   * read counts as proof of login — the rollout-file fallback is usage history only.
   */
  codexLiveUsageReaderDetailed?: ((opts?: { codexHome?: string; nowMs?: number }) => Promise<CodexLiveRead>) | null;
  /**
   * The Codex CLI's own login check for one config home (`codex login status`), proven able
   * to fail by its canary. Required for the CLI-signed-out rule; absent ⇒ that rule never fires.
   */
  codexLoginStatus?: ((codexHome: string) => Promise<CliLoginVerdict>) | null;
  /** Clock injection for Codex reset-boundary normalization. */
  now?: () => number;
  /** Logger (defaults to console). */
  logger?: { log: (m: string) => void; warn: (m: string) => void };
  /**
   * Census re-routing gate (§2.2 rows #1–#4). When present AND enabled, the poller resolves
   * each account's LIVE slot via the ledger instead of reading its enrollment `configHome` —
   * so a swap mid-poll can't make the poller read the wrong tenant's token, refresh the wrong
   * slot, cross-contaminate pool emails, or attribute needs-reauth to the wrong account. Absent
   * (or flag-off / ledger-unknown) → byte-for-byte today's enrollment-home behavior.
   */
  locationGate?: CredentialLocationGate;
  /** Cached identity truth for Claude credential slots (default host TTL: ~6h). */
  resolveSlotIdentity?: (slot: string) => Promise<
    | { accountId: string; email?: string }
    | { unavailable: true; reason: string }
  >;
  identityCacheTtlMs?: number;
  /** Reconcile confirmed live attribution into the durable location ledger. */
  locationLedger?: CredentialLocationLedger;
  /** One deduped attention item per drift episode (id is stable until self-close). */
  emitIdentityDriftAttention?: (item: { id: string; title: string; summary: string }) => void | Promise<void>;
  onIdentityRestored?: (accountId: string, attentionId: string) => void | Promise<void>;
  /** Passive evidence sink. It cannot select accounts, mutate pool authority, or trigger repair. */
  loginObservationSink?: (input: {
    accountId: string;
    at: string;
    outcome: SubscriptionLoginSettledOutcome;
    pollIntervalMs: number;
  }) => void;
  loginAdmission?: (cells: Array<{
    accountId: string; supported: boolean; disabled: boolean; at: string;
  }>) => Set<string>;
}

/**
 * The login signal behind an account's pool status (spec skill-driven-signin-repair). `ok` = the
 * latest poll made an authenticated read (for Codex, a LIVE app-server read); `signed-out` = the
 * provider refused the read as unauthenticated; `unavailable` = no measurable signal this poll
 * (transport failure, check not runnable, not yet polled). `unavailable` never counts as a fresh
 * `active`; it is shown next to the status so the gap is visible.
 */
export type PoolLoginCheck = 'ok' | 'signed-out' | 'unavailable';

/** Two consecutive CLI-signed-out + auth-refused polls move a Codex account to needs-reauth. */
const CLI_SIGNED_OUT_POLLS_REQUIRED = 2;
/** The two agreeing polls must be at least this far apart (on-demand polls seconds apart don't count twice). */
const CLI_SIGNED_OUT_MIN_GAP_MS = 5 * 60_000;

/** Outcome of a single usage read (internal). */
type UsageRead =
  | { authFailed: false; body: Record<string, unknown> | null }
  | { authFailed: true };

export interface BurnRate {
  /** Utilization points per hour on the binding (7-day) window. */
  sevenDayPctPerHour: number | null;
  /** Utilization points per hour on the 5-hour window. */
  fiveHourPctPerHour: number | null;
  /** Wall-clock ms between the two samples the rate was computed from. */
  spanMs: number;
}

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const QUOTA_SNAPSHOT_STALE_AFTER_MS = 30 * 60 * 1000;

/**
 * Resolve a claude-code account's OAuth access token from its config home,
 * TRANSIENTLY, or a closed re-auth result for malformed stored JSON. Never
 * persisted, never logged. Reads via the shared OAuthRefresher
 * locator (macOS keychain `Claude Code-credentials-<sha256(configHome)[0:8]>`,
 * else `<configHome>/.credentials.json`) so the resolver and the refresher always
 * agree on WHERE a config home's credentials live. NOTE: an EXPIRED access token
 * is still returned here (it's a valid string) — expiry is detected by the usage
 * read's 401 and recovered by the refresher, not by this resolver.
 */
export async function defaultTokenResolver(
  account: SubscriptionAccount,
): Promise<TokenResolution> {
  if (account.provider !== 'anthropic' || account.framework !== 'claude-code') {
    return null;
  }
  // Single periodic keychain read per poll cycle, bounded by OAuthRefresher's 3s timeout AND run
  // OFF the event loop via `readClaudeOauthAsync` (promisified `security` spawn). The earlier sync
  // read blocked the loop for the full spawn duration each cycle — under multi-agent `securityd`
  // contention that was seconds, and across N accounts a burst (the residual freeze this fixes).
  const read = await readClaudeOauthAsyncDetailed(account.configHome);
  if (!read.ok) {
    if (read.reason === 'unparseable') return { reauthNeeded: true, reason: 'unparseable-credential-blob' };
    return {
      observationOnly: true,
      reason: read.reason === 'missing-oauth-block'
        ? 'credential-missing-oauth-block'
        : 'credential-absent-or-unreadable',
    };
  }
  const tok = read.oauth.accessToken;
  return typeof tok === 'string' && tok.startsWith('sk-ant-oat')
    ? tok
    : { observationOnly: true, reason: 'credential-token-shape-invalid' };
}

/**
 * Read the account email (`oauthAccount.emailAddress`) Claude Code records for a
 * config home. This is a PUBLIC account identifier (not a secret) — it lets the
 * pool show WHICH account a slot actually authenticated as, so a login into the
 * wrong account surfaces instead of hiding. Tries `<configHome>/.claude.json`,
 * then (for the default home) the home-root `~/.claude.json`. Null if unreadable.
 */
export function readAccountEmail(configHome: string): string | null {
  const home = expandHome(configHome);
  const candidates = [path.join(home, '.claude.json')];
  if (home === expandHome('~/.claude')) {
    candidates.push(path.join(process.env.HOME ?? '', '.claude.json'));
  }
  for (const f of candidates) {
    try {
      if (!fs.existsSync(f)) continue;
      const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
      const email = j?.oauthAccount?.emailAddress;
      if (typeof email === 'string' && email.includes('@')) return email;
    } catch {
      // @silent-fallback-ok: missing/unreadable config → no email (null)
    }
  }
  return null;
}

/**
 * Map the REAL /api/oauth/usage response (verified live 2026-06-06) into an
 * AccountQuotaSnapshot. The live shape is `five_hour: {utilization, resets_at}`,
 * `seven_day: {utilization, resets_at}`, `seven_day_sonnet`, `seven_day_opus`,
 * `extra_usage: {is_enabled, used_credits, monthly_limit}`.
 */
export function mapUsageResponse(
  body: Record<string, unknown>,
  source: AccountQuotaSnapshot['source'],
  nowIso: string,
): AccountQuotaSnapshot {
  const snap: AccountQuotaSnapshot = { source, measuredAt: nowIso };

  const win = (v: unknown): { utilizationPct: number; resetsAt: string } | undefined => {
    if (!v || typeof v !== 'object') return undefined;
    const o = v as Record<string, unknown>;
    if (o.utilization === undefined && o.resets_at === undefined) return undefined;
    return {
      utilizationPct: Number(o.utilization ?? 0),
      resetsAt: String(o.resets_at ?? ''),
    };
  };

  const five = win(body['five_hour']);
  if (five) snap.fiveHour = five;
  const seven = win(body['seven_day']);
  if (seven) snap.sevenDay = seven;

  const perModel: Record<string, number | null> = {};
  for (const [key, label] of [
    ['seven_day_sonnet', 'sonnet'],
    ['seven_day_opus', 'opus'],
  ] as const) {
    const v = body[key];
    if (v && typeof v === 'object') {
      const u = (v as Record<string, unknown>).utilization;
      perModel[label] = u === undefined || u === null ? null : Number(u);
    }
  }
  if (Object.keys(perModel).length > 0) snap.perModel = perModel;

  // Fable 5 usage is NOT a top-level `seven_day_fable` field — it surfaces as a
  // scoped weekly limit entry inside `limits[]`, identified by
  // `scope.model.display_name === 'Fable'` (group 'weekly'). The entry carries a
  // `percent` (0–100) and a `resets_at`, so we map it into a window with the same
  // shape as fiveHour/sevenDay. Verified live 2026-07-11 across all pool accounts.
  const limits = body['limits'];
  if (Array.isArray(limits)) {
    for (const entry of limits) {
      if (!entry || typeof entry !== 'object') continue;
      const l = entry as Record<string, unknown>;
      const scope = l.scope as Record<string, unknown> | null | undefined;
      const model =
        scope && typeof scope === 'object'
          ? (scope.model as Record<string, unknown> | null | undefined)
          : undefined;
      const displayName = model && typeof model === 'object' ? model.display_name : undefined;
      if (l.group === 'weekly' && displayName === 'Fable' && l.percent !== undefined) {
        snap.fable = {
          utilizationPct: Number(l.percent ?? 0),
          resetsAt: String(l.resets_at ?? ''),
        };
        break;
      }
    }
  }

  const extra = body['extra_usage'];
  if (extra && typeof extra === 'object') {
    const e = extra as Record<string, unknown>;
    snap.extraUsage = {
      isEnabled: Boolean(e.is_enabled),
      usedCredits: Number(e.used_credits ?? 0),
      monthlyLimit: Number(e.monthly_limit ?? 0),
    };
  }

  return snap;
}

/**
 * Boundary between codex's short (5-hour) and long (weekly) rate-limit windows,
 * in minutes. Codex reports 300 and 10080; anything under a day is the short window.
 */
export const CODEX_LONG_WINDOW_MIN_MINUTES = 1440;

/**
 * Route codex's two rate-limit windows into the short (5h) and long (weekly) buckets
 * by the `windowMinutes` each window REPORTS, rather than by whether it arrived under
 * the `primary` or `secondary` key.
 *
 * WHY (found on real hardware, 2026-08-19): the mapping used to be positional —
 * `primary → fiveHour`, `secondary → sevenDay` — because codex conventionally puts the
 * 5-hour window first. A live account on the pro plan reported `primary` with
 * `window_minutes: 10080` (the WEEKLY window) and `secondary: null`. The pool duly
 * recorded 20% of a seven-day allowance as a five-hour figure, and the account page
 * showed a weekly wall resetting "in hours". Every consumer of fiveHour/sevenDay —
 * proactive swap, placement, the load-shed brake — reads those two fields as window
 * LENGTHS, so a mislabel there is a wrong decision, not a cosmetic one.
 *
 * Positional order is a convention of the producer; `windowMinutes` is the producer
 * stating what the window actually is. Prefer the statement over the convention.
 *
 * Ties are resolved deterministically: when both windows fall in the same class the
 * more extreme one represents it (shortest for the short bucket, longest for the long),
 * so a bucket is never filled by an arbitrary pick. A window carrying no usable
 * `windowMinutes` falls back to its positional meaning, so this can only correct a
 * mislabel, never introduce one.
 */
export function classifyCodexWindows(
  primary: CodexUsageSnapshot['primary'],
  secondary: CodexUsageSnapshot['secondary'],
): { short: CodexUsageSnapshot['primary']; long: CodexUsageSnapshot['secondary'] } {
  const candidates: Array<{ w: NonNullable<CodexUsageSnapshot['primary']>; positional: 'short' | 'long' }> = [];
  if (primary) candidates.push({ w: primary, positional: 'short' });
  if (secondary) candidates.push({ w: secondary, positional: 'long' });

  const classOf = (c: (typeof candidates)[number]): 'short' | 'long' => {
    const m = c.w.windowMinutes;
    if (typeof m !== 'number' || !Number.isFinite(m) || m <= 0) return c.positional;
    return m >= CODEX_LONG_WINDOW_MIN_MINUTES ? 'long' : 'short';
  };
  // A window with no usable length keeps its positional meaning; ranking it by a
  // sentinel would let it beat a window that genuinely stated its length.
  const lengthOf = (c: (typeof candidates)[number]): number =>
    typeof c.w.windowMinutes === 'number' && Number.isFinite(c.w.windowMinutes) && c.w.windowMinutes > 0
      ? c.w.windowMinutes
      : c.positional === 'short'
        ? 0
        : Number.MAX_SAFE_INTEGER;

  let short: CodexUsageSnapshot['primary'] = null;
  let long: CodexUsageSnapshot['secondary'] = null;
  for (const c of candidates) {
    if (classOf(c) === 'short') {
      if (!short || lengthOf(c) < (short.windowMinutes ?? Number.MAX_SAFE_INTEGER)) short = c.w;
    } else {
      if (!long || lengthOf(c) > (long.windowMinutes ?? 0)) long = c.w;
    }
  }
  return { short, long };
}

export class QuotaPoller {
  private readonly pool: SubscriptionPool;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: FetchImpl;
  private readonly tokenResolver: TokenResolver;
  private readonly refresher: AccountRefresher;
  private readonly codexUsageReader: CodexUsageReader;
  private readonly codexLiveUsageReader: CodexUsageReader | null;
  private readonly codexLiveUsageReaderDetailed: QuotaPollerConfig['codexLiveUsageReaderDetailed'];
  private readonly codexLoginStatus: QuotaPollerConfig['codexLoginStatus'];
  private readonly loginChecks = new Map<string, PoolLoginCheck>();
  private readonly cliSignedOutStreak = new Map<string, { count: number; lastAt: number }>();
  private readonly now: () => number;
  private readonly logger: { log: (m: string) => void; warn: (m: string) => void };
  private readonly locationGate?: CredentialLocationGate;
  private readonly resolveSlotIdentity?: QuotaPollerConfig['resolveSlotIdentity'];
  private readonly identityCacheTtlMs: number;
  private readonly locationLedger?: CredentialLocationLedger;
  private readonly emitIdentityDriftAttention?: QuotaPollerConfig['emitIdentityDriftAttention'];
  private readonly onIdentityRestored?: QuotaPollerConfig['onIdentityRestored'];
  private readonly loginObservationSink?: QuotaPollerConfig['loginObservationSink'];
  private readonly loginAdmission?: QuotaPollerConfig['loginAdmission'];
  private readonly identityCache = new Map<string, { at: number; value: Awaited<ReturnType<NonNullable<QuotaPollerConfig['resolveSlotIdentity']>>> }>();
  private readonly attributionByExpected = new Map<string, string>();
  private interval: ReturnType<typeof setInterval> | null = null;
  /** Most-recent snapshot per account id. */
  private readonly lastByAccount = new Map<string, AccountQuotaSnapshot>();
  /** The snapshot BEFORE the most recent, per account — the burn-rate baseline. */
  private readonly prevByAccount = new Map<string, AccountQuotaSnapshot>();

  constructor(config: QuotaPollerConfig) {
    this.pool = config.pool;
    this.pollIntervalMs = config.pollIntervalMs ?? 15 * 60_000;
    this.fetchImpl =
      config.fetchImpl ??
      ((url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchImpl>);
    this.tokenResolver = config.tokenResolver ?? defaultTokenResolver;
    this.refresher =
      config.refresher ?? ((account) => refreshClaudeToken(expandHome(account.configHome)));
    this.codexUsageReader = config.codexUsageReader ?? readLatestCodexUsage;
    this.codexLiveUsageReader = config.codexLiveUsageReader ?? null;
    this.codexLiveUsageReaderDetailed = config.codexLiveUsageReaderDetailed ?? null;
    this.codexLoginStatus = config.codexLoginStatus ?? null;
    this.now = config.now ?? (() => Date.now());
    this.logger = config.logger ?? { log: () => {}, warn: () => {} };
    this.locationGate = config.locationGate;
    this.resolveSlotIdentity = config.resolveSlotIdentity;
    this.identityCacheTtlMs = config.identityCacheTtlMs ?? 6 * 60 * 60_000;
    this.locationLedger = config.locationLedger;
    this.emitIdentityDriftAttention = config.emitIdentityDriftAttention;
    this.onIdentityRestored = config.onIdentityRestored;
    this.loginObservationSink = config.loginObservationSink;
    this.loginAdmission = config.loginAdmission;
  }

  private async identityForSlot(slot: string) {
    if (!this.resolveSlotIdentity) return null;
    const cached = this.identityCache.get(slot);
    const now = this.now();
    if (cached && now - cached.at < this.identityCacheTtlMs) return cached.value;
    const value = await this.resolveSlotIdentity(slot);
    this.identityCache.set(slot, { at: now, value });
    return value;
  }

  /** Credential mutations must invalidate observations made before the write. */
  invalidateIdentityCache(slots: string[]): void {
    for (const slot of slots) this.identityCache.delete(slot);
  }

  /** Identity truth wins over a stale registry/ledger label. */
  private async reconcileIdentity(expected: SubscriptionAccount, slot: string): Promise<SubscriptionAccount | null> {
    this.attributionByExpected.set(expected.id, expected.id);
    if (expected.framework !== 'claude-code') return expected;
    const identity = await this.identityForSlot(slot);
    if (!identity || 'unavailable' in identity) return expected; // uncertainty never mutates truth
    const actual = this.pool.get(identity.accountId);
    const nowIso = new Date(this.now()).toISOString();
    if (identity.accountId === expected.id) {
      if (expected.identityDrifted) {
        const attentionId = `credential-identity-drift-${expected.id}-${expected.identityDrift?.detectedAt ?? nowIso}`;
        this.pool.update(expected.id, { identityDrifted: false, identityDrift: null });
        try { void this.onIdentityRestored?.(expected.id, attentionId); }
        catch { /* @silent-fallback-ok: drift state is already self-closed; commitment cleanup retries on a later confirmed poll */ }
      }
      this.locationLedger?.recordAssignment(slot, expected.id, {
        verifiedAt: nowIso,
        op: 'reconcile',
        source: 'quota-poll-identity-oracle',
      });
      this.attributionByExpected.set(expected.id, expected.id);
      return expected;
    }

    const detectedAt = expected.identityDrift?.detectedAt ?? nowIso;
    const actualId = actual?.id ?? identity.accountId;
    this.pool.update(expected.id, {
      identityDrifted: true,
      identityDrift: {
        expectedAccountId: expected.id,
        actualAccountId: actualId,
        ...(identity.email ? { actualEmail: identity.email } : {}),
        slot,
        detectedAt,
        lastConfirmedAt: nowIso,
        repairState: 'planned',
      },
    });
    // Registry truth is explicit + journalled. This changes attribution only;
    // the separately planned executor move restores the labelled physical home.
    this.locationLedger?.recordAssignment(slot, actualId, {
      verifiedAt: nowIso,
      op: 'reconcile',
      source: 'quota-poll-identity-oracle',
    });
    this.attributionByExpected.set(expected.id, actualId);
    try {
      void this.emitIdentityDriftAttention?.({
        id: `credential-identity-drift-${expected.id}-${detectedAt}`,
        title: `Credential identity drift: ${expected.id}`,
        summary: `Slot ${slot} is labelled ${expected.id} but live identity is ${actualId}. ${actual ? `Quota was attributed to ${actualId}` : 'The confirmed identity is not enrolled in the registry'}; the slot is excluded from swaps pending audited repair.`,
      });
    } catch { /* @silent-fallback-ok: attribution + exclusion are already enforced; attention is best-effort */ }
    return actual ? { ...actual, configHome: slot } : null;
  }

  /**
   * Census re-routing (§2.2 rows #1–#4): resolve the account's LIVE slot home through the ledger
   * gate when enabled, else its enrollment `configHome` (today's behavior). The result is the
   * config home every per-account credential read in this poller targets — so a swap mid-poll
   * reads/refreshes/attributes against the slot the credential ACTUALLY lives in now. Sync,
   * fail-open-loud (the gate never throws), back-compat when the ledger is unknown/never-seeded.
   *
   * Returns the account UNCHANGED when no re-route is needed, so the byte-identical flag-off path
   * does not allocate a clone (and the default token resolver / refresher see the exact same
   * object they do today).
   */
  private accountForReads(account: SubscriptionAccount): SubscriptionAccount {
    if (!this.locationGate) return account;
    const slot = this.locationGate.slotForAccount(account.id, account.configHome);
    if (slot === account.configHome) return account;
    return { ...account, configHome: slot };
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      void this.pollAll();
    }, this.pollIntervalMs);
    this.interval.unref?.();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * One usage read. Returns the parsed body (or null body on a non-auth non-ok),
   * an auth-failed marker (401/403), or null on a network failure. NEVER logs the
   * token.
   */
  private async readUsage(token: string): Promise<UsageRead | null> {
    try {
      const res = await this.fetchImpl(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': '2023-06-01',
        },
      });
      if (res.ok) {
        return { authFailed: false, body: (await res.json()) as Record<string, unknown> };
      }
      if (res.status === 401 || res.status === 403) return { authFailed: true };
      return { authFailed: false, body: null }; // 5xx etc. → no snapshot, not auth
    } catch {
      // @silent-fallback-ok: network failure → no snapshot this cycle (retry next)
      return null;
    }
  }

  private observe(accountId: string, outcome: SubscriptionLoginSettledOutcome): void {
    try {
      this.loginObservationSink?.({
        accountId,
        at: new Date(this.now()).toISOString(),
        outcome,
        pollIntervalMs: this.pollIntervalMs,
      });
    } catch (error) {
      this.logger.warn(`[QuotaPoller] login observation refused for ${accountId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private markNeedsReauth(account: SubscriptionAccount, reason: SubscriptionLoginCauseClass): void {
    this.loginChecks.set(account.id, 'signed-out');
    try {
      this.pool.update(account.id, { status: 'needs-reauth' });
    } catch {
      // @silent-fallback-ok: pool update best-effort; status reflects next read
    }
    this.logger.warn(`[QuotaPoller] account ${account.id} → needs-reauth (${reason})`);
  }

  /**
   * Poll one account: resolve token transiently, read usage, map to snapshot.
   * On a usage-read auth failure (401/403) the access token may simply have
   * EXPIRED while the refresh token is still valid — so the poller attempts a
   * refresh-token exchange and ONE retry BEFORE declaring needs-reauth. Only a
   * genuinely dead login (no refresh token / refresh rejected / still 401 after
   * a fresh token) yields needs-reauth. Returns null when the token is
   * unresolvable or the read fails. NEVER logs or returns the token.
   */
  async pollAccount(account: SubscriptionAccount): Promise<AccountQuotaSnapshot | null> {
    // Census #1/#2/#4: every per-account credential read (token resolve, 401-refresh, needs-reauth
    // attribution) targets the account's LIVE slot per the ledger gate — NOT its enrollment home —
    // so a swap mid-poll can't read/refresh/flag the wrong tenant. account.id is preserved (only
    // the slot home moves), so pool.update + logging still name the right account.
    const routedAccount = this.accountForReads(account);
    // Preserve the ledger-routed home through identity reconciliation. Passing
    // the enrollment object here silently discarded census routing whenever
    // the optional identity oracle was absent or confirmed the expected id.
    const slotAccount = await this.reconcileIdentity(routedAccount, routedAccount.configHome);
    if (!slotAccount) return null;

    if (account.provider === 'openai' && account.framework === 'codex-cli') {
      const nowMs = this.now();
      const nowIso = new Date(nowMs).toISOString();
      // Live-first: the app-server read is authoritative and current even for a
      // WALLED account (which writes no rollout records at all — the dawn@ case,
      // 2026-09-20) and costs zero quota. Any failure — binary missing, spawn
      // error, timeout, protocol drift — degrades to the rollout tail, i.e. to
      // exactly the previous behaviour. The live reader never throws, but the
      // guard also catches an injected test reader that does.
      let usage: CodexUsageSnapshot | null = null;
      if (this.codexLiveUsageReaderDetailed) {
        let live: CodexLiveRead;
        try {
          live = await this.codexLiveUsageReaderDetailed({ codexHome: slotAccount.configHome, nowMs });
        } catch {
          live = { kind: 'unavailable' }; // @silent-fallback-ok: a throwing reader is a transport failure
        }
        if (live.kind === 'ok') {
          usage = live.snapshot;
          this.loginChecks.set(slotAccount.id, 'ok');
          this.cliSignedOutStreak.delete(slotAccount.id);
        } else if (live.kind === 'auth-failed') {
          await this.onCodexAuthRefused(slotAccount);
          return null;
        } else {
          // Transport failure: no login signal this poll, and it breaks a signed-out streak.
          this.loginChecks.set(slotAccount.id, 'unavailable');
          this.cliSignedOutStreak.delete(slotAccount.id);
        }
      } else if (this.codexLiveUsageReader) {
        try {
          usage = await this.codexLiveUsageReader({ codexHome: slotAccount.configHome, nowMs });
        } catch {
          usage = null; // @silent-fallback-ok: rollout tail below is the designed fallback
        }
        this.loginChecks.set(slotAccount.id, usage?.source === 'codex-app-server' ? 'ok' : 'unavailable');
      } else {
        this.loginChecks.set(slotAccount.id, 'unavailable');
      }
      if (!usage) usage = await this.codexUsageReader({ codexHome: slotAccount.configHome, nowMs });
      if (!usage) return null;
      const window = (value: CodexUsageSnapshot['primary']) => {
        if (!value) return undefined;
        const resetMs = value.resetsAtIso ? Date.parse(value.resetsAtIso) : NaN;
        if (Number.isFinite(resetMs) && resetMs <= nowMs) {
          return { utilizationPct: 0, resetsAt: '' };
        }
        return { utilizationPct: value.usedPercent, resetsAt: value.resetsAtIso ?? '' };
      };
      // Route each window by the length IT reports, not by which key it arrived under
      // (see classifyCodexWindows) — a weekly window filed as `fiveHour` tells every
      // downstream swap/placement decision that a multi-day wall clears in hours.
      const { short: shortWindow, long: longWindow } = classifyCodexWindows(usage.primary, usage.secondary);
      const fiveHour = window(shortWindow);
      const sevenDay = window(longWindow);
      const snap: AccountQuotaSnapshot = {
        source: usage.source,
        measuredAt: usage.capturedAt ?? nowIso,
      };
      if (fiveHour) snap.fiveHour = fiveHour;
      if (sevenDay) snap.sevenDay = sevenDay;
      // The account answered, but reported no usage window (entitlement/credits
      // only). Carry that through so the dashboard can say so plainly rather
      // than show "No quota reading yet", which reads as a pending poll.
      if (!fiveHour && !sevenDay && usage.windowsUnavailable) snap.noQuotaWindow = true;
      const attributedId = slotAccount.id;
      const priorLast = this.lastByAccount.get(attributedId);
      if (priorLast) this.prevByAccount.set(attributedId, priorLast);
      this.lastByAccount.set(attributedId, snap);
      return snap;
    }

    const tokenResolution = await this.tokenResolver(slotAccount);
    if (typeof tokenResolution !== 'string') {
      if (tokenResolution && 'reauthNeeded' in tokenResolution && tokenResolution.reauthNeeded) {
        this.markNeedsReauth(slotAccount, tokenResolution.reason);
        this.observe(slotAccount.id, {
          kind: 'transition-to-needs-reauth',
          causeClass: tokenResolution.reason,
          corroboration: 'status-preexisting',
        });
        return null;
      }
      if (tokenResolution && 'observationOnly' in tokenResolution && tokenResolution.observationOnly) {
        this.loginChecks.set(slotAccount.id, 'unavailable');
        this.observe(slotAccount.id, { kind: 'observation-absence', causeClass: tokenResolution.reason });
        return null;
      }
      this.loginChecks.set(slotAccount.id, 'unavailable');
      this.logger.warn(`[QuotaPoller] no resolvable token for account ${account.id} — skipping`);
      return null;
    }
    const token = tokenResolution;

    const read = await this.readUsage(token);
    if (read === null) { // network failure: no login signal this poll
      this.loginChecks.set(slotAccount.id, 'unavailable');
      return null;
    }

    let body: Record<string, unknown> | null;
    if (read.authFailed) {
      const refreshed = await this.refresher(slotAccount);
      if (!refreshed.ok) {
        if (refreshed.reason === 'write-skipped') {
          // The refresh exchange SUCCEEDED but the per-slot credential funnel lock was busy
          // (a swap or a concurrent refresh holds it). Transient — no snapshot this cycle,
          // retry next tick. NEVER needs-reauth: the login is fully intact (Step 4b).
          this.logger.warn(
            `[QuotaPoller] account ${account.id} refresh-write skipped (slot busy) — no snapshot this cycle`,
          );
          this.loginChecks.set(slotAccount.id, 'unavailable');
          return null;
        }
        // No refresh token, or the exchange was rejected — genuine re-auth.
        const causeClass: SubscriptionLoginCauseClass = refreshed.reason === 'read-failed'
          ? 'refresh-read-failed'
          : refreshed.reason === 'unsupported-account'
            ? 'unrecognized-reason'
            : refreshed.reason;
        this.markNeedsReauth(slotAccount, causeClass);
        this.observe(slotAccount.id, {
          kind: 'transition-to-needs-reauth',
          causeClass,
          corroboration: 'exchange-corroborated',
        });
        return null;
      }
      const retry = await this.readUsage(refreshed.accessToken);
      if (retry === null) { // network blip on the retry → next cycle
        this.loginChecks.set(slotAccount.id, 'unavailable');
        return null;
      }
      if (retry.authFailed) {
        // Fresh token still rejected — treat as genuinely failed.
        this.markNeedsReauth(slotAccount, 'still-authfailed-after-refresh');
        this.observe(slotAccount.id, {
          kind: 'transition-to-needs-reauth',
          causeClass: 'still-authfailed-after-refresh',
          corroboration: 'exchange-corroborated',
        });
        return null;
      }
      // Recovered silently — no operator action needed. Record for visibility.
      try {
        this.pool.update(account.id, { lastRefreshAt: new Date().toISOString() });
      } catch {
        // @silent-fallback-ok: visibility-only write
      }
      this.logger.log(
        `[QuotaPoller] account ${account.id} access token refreshed silently (no re-auth needed)`,
      );
      body = retry.body;
    } else {
      body = read.body;
    }

    if (!body) { // a non-auth error status: no login signal this poll
      this.loginChecks.set(slotAccount.id, 'unavailable');
      return null;
    }

    // The OAuth usage endpoint answered with this account's token: an authenticated read.
    this.loginChecks.set(slotAccount.id, 'ok');
    const snap = mapUsageResponse(body, 'oauth-usage-endpoint-fallback', new Date(this.now()).toISOString());
    // Shift the prior "last" down to "prev" so burnRate has a distinct baseline.
    const attributedId = slotAccount.id;
    const priorLast = this.lastByAccount.get(attributedId);
    if (priorLast) this.prevByAccount.set(attributedId, priorLast);
    this.lastByAccount.set(attributedId, snap);
    return snap;
  }

  /**
   * Poll every supported claude-code/anthropic or codex-cli/openai account and persist each
   * account's latest snapshot (and a recovered status when a prior needs-reauth
   * account now reads cleanly).
   */
  async pollAll(): Promise<{ polled: number; failed: number }> {
    let polled = 0;
    let failed = 0;
    const scan = this.pool.scanAccountsBounded(4_096);
    const nowIso = new Date(this.now()).toISOString();
    const admitted = this.loginAdmission?.(scan.accounts.map((account) => ({
      accountId: account.id,
      supported: isQuotaPollSupportedAccount(account),
      disabled: account.status === 'disabled',
      at: nowIso,
    }))) ?? new Set(scan.accounts.map((account) => account.id));
    for (const account of scan.accounts) {
      if (!admitted.has(account.id)) continue;
      const supported = isQuotaPollSupportedAccount(account);
      if (!supported) {
        this.observe(account.id, { kind: 'skipped-unsupported-framework' });
        continue;
      }
      if (account.status === 'disabled') {
        this.observe(account.id, { kind: 'skipped-disabled' });
        continue;
      }
      const snap = await this.pollAccount(account);
      if (!snap) {
        failed++;
        continue;
      }
      polled++;
      const attributedId = this.attributionByExpected.get(account.id) ?? account.id;
      const patch: Parameters<SubscriptionPool['update']>[1] = { lastQuota: snap };
      // A clean AUTHENTICATED read on an account previously flagged needs-reauth restores it. A
      // Codex rollout-file snapshot is usage history, not proof of login (spec
      // skill-driven-signin-repair), so it never restores `active`.
      const restores = account.status === 'needs-reauth' && snap.source !== 'codex-rollout';
      if (restores) patch.status = 'active';
      // Email is provider-attested identity, not quota metadata. Quota polling
      // must never mutate it; drift detection and the identity registrar own
      // that authority.
      try {
        this.pool.update(attributedId, patch);
      } catch {
        // @silent-fallback-ok: persistence best-effort; snapshot retained in memory
      }
      if (account.status !== 'needs-reauth' || restores) {
        this.observe(attributedId, restores ? { kind: 'transition-to-active' } : { kind: 'resolved-clean' });
      }
    }
    return { polled, failed };
  }

  /**
   * Burn rate for an account, computed from the two most recent reads. Returns
   * null until at least two distinct reads exist. Uses MEASURED utilization
   * deltas — never call counts. The caller (P1.3 scheduler) decides on these.
   */
  burnRate(accountId: string): BurnRate | null {
    const prev = this.prevByAccount.get(accountId);
    const current = this.lastByAccount.get(accountId);
    if (!prev || !current || prev.measuredAt === current.measuredAt) return null;
    const t0 = Date.parse(prev.measuredAt ?? '');
    const t1 = Date.parse(current.measuredAt ?? '');
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return null;
    const spanMs = t1 - t0;
    const hours = spanMs / 3_600_000;
    const delta = (
      a?: { utilizationPct: number },
      b?: { utilizationPct: number },
    ): number | null =>
      a && b ? (b.utilizationPct - a.utilizationPct) / hours : null;
    return {
      sevenDayPctPerHour: delta(prev.sevenDay, current.sevenDay),
      fiveHourPctPerHour: delta(prev.fiveHour, current.fiveHour),
      spanMs,
    };
  }

  /**
   * The login signal behind an account's pool status (see {@link PoolLoginCheck}). An account
   * this process has not polled reads `unavailable`.
   */
  loginCheck(accountId: string): PoolLoginCheck {
    return this.loginChecks.get(accountId) ?? 'unavailable';
  }

  /**
   * The CLI-signed-out rule (spec skill-driven-signin-repair). The live app-server read was
   * refused as unauthenticated; ask the CLI itself. Only when BOTH say signed out on two
   * consecutive polls does the account move to needs-reauth, through the explicit
   * `transition-to-needs-reauth` outcome. A CLI that disagrees, or cannot answer, leaves the
   * status unchanged and records `unavailable`.
   */
  private async onCodexAuthRefused(account: SubscriptionAccount): Promise<void> {
    let cli: CliLoginVerdict = 'unavailable';
    if (this.codexLoginStatus) {
      try { cli = await this.codexLoginStatus(account.configHome); }
      catch { cli = 'unavailable'; } // @silent-fallback-ok — no signal; status kept
    }
    if (cli !== 'signed-out') {
      this.loginChecks.set(account.id, 'unavailable');
      this.cliSignedOutStreak.delete(account.id);
      return;
    }
    this.loginChecks.set(account.id, 'signed-out');
    const nowMs = this.now();
    const prior = this.cliSignedOutStreak.get(account.id);
    if (prior && nowMs - prior.lastAt < CLI_SIGNED_OUT_MIN_GAP_MS) return; // too soon to count again
    const streak = (prior?.count ?? 0) + 1;
    this.cliSignedOutStreak.set(account.id, { count: streak, lastAt: nowMs });
    if (streak < CLI_SIGNED_OUT_POLLS_REQUIRED) return;
    if (account.status === 'needs-reauth') return;
    this.markNeedsReauth(account, 'cli-signed-out-auth-refused');
    this.observe(account.id, {
      kind: 'transition-to-needs-reauth',
      causeClass: 'cli-signed-out-auth-refused',
      corroboration: 'exchange-corroborated',
    });
  }

  /** Expose the last in-memory snapshot for an account (test/diagnostic). */
  lastSnapshot(accountId: string): AccountQuotaSnapshot | null {
    return this.lastByAccount.get(accountId) ?? null;
  }
}

export function isQuotaPollSupportedAccount(account: SubscriptionAccount): boolean {
  return (account.provider === 'anthropic' && account.framework === 'claude-code') ||
    (account.provider === 'openai' && account.framework === 'codex-cli');
}
