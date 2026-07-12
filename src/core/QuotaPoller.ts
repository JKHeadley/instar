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
  readClaudeOauthAsync,
  refreshClaudeToken,
  expandHome,
  type RefreshResult,
} from './OAuthRefresher.js';
import type { CredentialLocationGate } from './CredentialLocationGate.js';
import {
  readLatestCodexUsage,
  type CodexUsageSnapshot,
  type ReadCodexUsageOptions,
} from '../providers/adapters/openai-codex/observability/codexRateLimitReader.js';

/**
 * Injectable token resolver — returns an account's OAuth access token or null.
 * The default (`defaultTokenResolver`) is ASYNC so the per-account keychain read happens OFF the
 * event loop (a slow/contended `securityd` read used to freeze the loop every poll cycle — the
 * dashboard-flap / false-sleep residual). `pollAccount` `await`s the result, so a SYNC resolver
 * (e.g. a test stub returning a plain string) is equally valid — hence the union return type.
 */
export type TokenResolver = (
  account: SubscriptionAccount,
) => string | null | Promise<string | null>;

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
}

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

/**
 * Resolve a claude-code account's OAuth access token from its config home,
 * TRANSIENTLY. Never persisted, never logged. Reads via the shared OAuthRefresher
 * locator (macOS keychain `Claude Code-credentials-<sha256(configHome)[0:8]>`,
 * else `<configHome>/.credentials.json`) so the resolver and the refresher always
 * agree on WHERE a config home's credentials live. NOTE: an EXPIRED access token
 * is still returned here (it's a valid string) — expiry is detected by the usage
 * read's 401 and recovered by the refresher, not by this resolver.
 */
export async function defaultTokenResolver(
  account: SubscriptionAccount,
): Promise<string | null> {
  if (account.provider !== 'anthropic' || account.framework !== 'claude-code') {
    return null;
  }
  // Single periodic keychain read per poll cycle, bounded by OAuthRefresher's 3s timeout AND run
  // OFF the event loop via `readClaudeOauthAsync` (promisified `security` spawn). The earlier sync
  // read blocked the loop for the full spawn duration each cycle — under multi-agent `securityd`
  // contention that was seconds, and across N accounts a burst (the residual freeze this fixes).
  const oauth = await readClaudeOauthAsync(account.configHome);
  const tok = oauth?.accessToken;
  return typeof tok === 'string' && tok.startsWith('sk-ant-oat') ? tok : null;
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

export class QuotaPoller {
  private readonly pool: SubscriptionPool;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: FetchImpl;
  private readonly tokenResolver: TokenResolver;
  private readonly refresher: AccountRefresher;
  private readonly codexUsageReader: CodexUsageReader;
  private readonly now: () => number;
  private readonly logger: { log: (m: string) => void; warn: (m: string) => void };
  private readonly locationGate?: CredentialLocationGate;
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
    this.now = config.now ?? (() => Date.now());
    this.logger = config.logger ?? { log: () => {}, warn: () => {} };
    this.locationGate = config.locationGate;
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

  private markNeedsReauth(account: SubscriptionAccount, reason: string): void {
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
    const slotAccount = this.accountForReads(account);

    if (account.provider === 'openai' && account.framework === 'codex-cli') {
      const nowMs = this.now();
      const nowIso = new Date(nowMs).toISOString();
      const usage = await this.codexUsageReader({ codexHome: slotAccount.configHome, nowMs });
      if (!usage) return null;
      const window = (value: CodexUsageSnapshot['primary']) => {
        if (!value) return undefined;
        const resetMs = value.resetsAtIso ? Date.parse(value.resetsAtIso) : NaN;
        if (Number.isFinite(resetMs) && resetMs <= nowMs) {
          return { utilizationPct: 0, resetsAt: '' };
        }
        return { utilizationPct: value.usedPercent, resetsAt: value.resetsAtIso ?? '' };
      };
      const fiveHour = window(usage.primary);
      const sevenDay = window(usage.secondary);
      const snap: AccountQuotaSnapshot = {
        source: 'codex-rollout',
        measuredAt: usage.capturedAt ?? nowIso,
      };
      if (fiveHour) snap.fiveHour = fiveHour;
      if (sevenDay) snap.sevenDay = sevenDay;
      const priorLast = this.lastByAccount.get(account.id);
      if (priorLast) this.prevByAccount.set(account.id, priorLast);
      this.lastByAccount.set(account.id, snap);
      return snap;
    }

    const token = await this.tokenResolver(slotAccount);
    if (!token) {
      this.logger.warn(`[QuotaPoller] no resolvable token for account ${account.id} — skipping`);
      return null;
    }

    const read = await this.readUsage(token);
    if (read === null) return null; // network failure

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
          return null;
        }
        // No refresh token, or the exchange was rejected — genuine re-auth.
        this.markNeedsReauth(account, refreshed.reason);
        return null;
      }
      const retry = await this.readUsage(refreshed.accessToken);
      if (retry === null) return null; // network blip on the retry → next cycle
      if (retry.authFailed) {
        // Fresh token still rejected — treat as genuinely failed.
        this.markNeedsReauth(account, 'usage still auth-failed after refresh');
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

    if (!body) return null;

    const snap = mapUsageResponse(body, 'oauth-usage-endpoint-fallback', new Date(this.now()).toISOString());
    // Shift the prior "last" down to "prev" so burnRate has a distinct baseline.
    const priorLast = this.lastByAccount.get(account.id);
    if (priorLast) this.prevByAccount.set(account.id, priorLast);
    this.lastByAccount.set(account.id, snap);
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
    for (const account of this.pool.list()) {
      const supported =
        (account.provider === 'anthropic' && account.framework === 'claude-code') ||
        (account.provider === 'openai' && account.framework === 'codex-cli');
      if (!supported) continue;
      if (account.status === 'disabled') continue;
      const snap = await this.pollAccount(account);
      if (!snap) {
        failed++;
        continue;
      }
      polled++;
      const patch: Parameters<SubscriptionPool['update']>[1] = { lastQuota: snap };
      // A clean read on an account previously flagged needs-reauth restores it.
      if (account.status === 'needs-reauth') patch.status = 'active';
      // Census #3: email auto-patch. When credential re-pointing is enabled the enrollment home
      // no longer maps 1:1 to a tenant (a swap moves the credential), so reading the slot's
      // `.claude.json` email and writing it onto this pool account would CROSS-CONTAMINATE pool
      // emails and poison the recovery probe's email→account map. So while the gate is enabled the
      // auto-patch is SUPPRESSED (the ledger + identity oracle own divergence detection now). With
      // the gate absent/off this is byte-for-byte today's behavior.
      if (account.framework === 'claude-code' && !this.locationGate?.isEnabled()) {
        // Auto-populate the account email from the config home's own login record,
        // so the stored email always reflects which account actually authenticated
        // (a login into the wrong account surfaces here instead of hiding).
        const email = readAccountEmail(account.configHome);
        if (email && email !== account.email) patch.email = email;
      }
      try {
        this.pool.update(account.id, patch);
      } catch {
        // @silent-fallback-ok: persistence best-effort; snapshot retained in memory
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

  /** Expose the last in-memory snapshot for an account (test/diagnostic). */
  lastSnapshot(accountId: string): AccountQuotaSnapshot | null {
    return this.lastByAccount.get(accountId) ?? null;
  }
}
