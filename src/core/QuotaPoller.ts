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

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  SubscriptionPool,
  SubscriptionAccount,
  AccountQuotaSnapshot,
} from './SubscriptionPool.js';

/** Injectable token resolver — returns an account's OAuth access token or null. */
export type TokenResolver = (account: SubscriptionAccount) => string | null;

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
  /** Logger (defaults to console). */
  logger?: { log: (m: string) => void; warn: (m: string) => void };
}

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
 * TRANSIENTLY. Never persisted, never logged. macOS: the per-config-home
 * keychain entry `Claude Code-credentials-<sha256(configHome)[0:8]>` (verified
 * empirically). Linux/other: `<configHome>/.credentials.json`. The default
 * (`~/.claude`) keychain entry has no hash suffix.
 */
export function defaultTokenResolver(account: SubscriptionAccount): string | null {
  if (account.provider !== 'anthropic' || account.framework !== 'claude-code') {
    return null;
  }
  const configHome = expandHome(account.configHome);

  // Linux / non-darwin: per-config-home credentials file.
  if (process.platform !== 'darwin') {
    try {
      const credPath = path.join(configHome, '.credentials.json');
      if (fs.existsSync(credPath)) {
        const data = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
        const tok = data?.claudeAiOauth?.accessToken;
        return typeof tok === 'string' && tok.startsWith('sk-ant-oat') ? tok : null;
      }
    } catch {
      // @silent-fallback-ok: missing/unreadable creds → unresolvable token (null)
    }
    return null;
  }

  // macOS: keychain service name, hash-suffixed by config-home path.
  const defaultHome = expandHome('~/.claude');
  const service =
    configHome === defaultHome
      ? 'Claude Code-credentials'
      : `Claude Code-credentials-${crypto.createHash('sha256').update(configHome).digest('hex').slice(0, 8)}`;
  try {
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-s', service, '-w'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (!raw) return null;
    const data = JSON.parse(raw);
    const tok = data?.claudeAiOauth?.accessToken;
    return typeof tok === 'string' && tok.startsWith('sk-ant-oat') ? tok : null;
  } catch {
    // @silent-fallback-ok: no keychain entry for this config home → null
    return null;
  }
}

function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return path.join(process.env.HOME ?? '', p.slice(1));
  }
  return p;
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
  private readonly logger: { log: (m: string) => void; warn: (m: string) => void };
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
    this.logger = config.logger ?? { log: () => {}, warn: () => {} };
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
   * Poll one account: resolve token transiently, read usage, map to snapshot.
   * Returns null when the token is unresolvable or the read fails. NEVER logs
   * or returns the token.
   */
  async pollAccount(account: SubscriptionAccount): Promise<AccountQuotaSnapshot | null> {
    const token = this.tokenResolver(account);
    if (!token) {
      this.logger.warn(`[QuotaPoller] no resolvable token for account ${account.id} — skipping`);
      return null;
    }
    let body: Record<string, unknown> | null = null;
    let authFailed = false;
    try {
      const res = await this.fetchImpl(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': '2023-06-01',
        },
      });
      if (res.ok) {
        body = (await res.json()) as Record<string, unknown>;
      } else if (res.status === 401 || res.status === 403) {
        authFailed = true;
      }
    } catch {
      // @silent-fallback-ok: network failure → no snapshot this cycle (retry next)
      return null;
    }
    if (authFailed) {
      // Genuine auth failure (revoked / password change) — surface for re-auth.
      try {
        this.pool.update(account.id, { status: 'needs-reauth' });
      } catch {
        // @silent-fallback-ok: pool update best-effort; status reflects next read
      }
      this.logger.warn(`[QuotaPoller] account ${account.id} usage read returned auth error → needs-reauth`);
      return null;
    }
    if (!body) return null;

    const snap = mapUsageResponse(body, 'oauth-usage-endpoint-fallback', new Date().toISOString());
    // Shift the prior "last" down to "prev" so burnRate has a distinct baseline.
    const priorLast = this.lastByAccount.get(account.id);
    if (priorLast) this.prevByAccount.set(account.id, priorLast);
    this.lastByAccount.set(account.id, snap);
    return snap;
  }

  /**
   * Poll every claude-code/anthropic account in the pool and persist each
   * account's latest snapshot (and a recovered status when a prior needs-reauth
   * account now reads cleanly).
   */
  async pollAll(): Promise<{ polled: number; failed: number }> {
    let polled = 0;
    let failed = 0;
    for (const account of this.pool.list()) {
      if (account.provider !== 'anthropic' || account.framework !== 'claude-code') continue;
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
      // Auto-populate the account email from the config home's own login record,
      // so the stored email always reflects which account actually authenticated
      // (a login into the wrong account surfaces here instead of hiding).
      const email = readAccountEmail(account.configHome);
      if (email && email !== account.email) patch.email = email;
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
