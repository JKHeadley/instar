/**
 * PendingLoginStore — durable record of in-flight subscription logins (P2.1 of
 * the Subscription & Auth Standard, the mobile-first enrollment wizard).
 *
 * When the operator enrolls an account from their phone, the login is a
 * short-lived artifact: a device-code (Codex: `auth.openai.com/codex/device` +
 * a 9-char code, ~15min TTL) or a URL+paste-back-code flow (Claude). The pi
 * live-test exposed the gap this closes: the first code expired before the
 * operator got to it, the provider's error was opaque, and re-issuing required a
 * manual round-trip. This store makes pending logins durable + TTL-aware so the
 * wizard can:
 *   - surface a code/URL IMMEDIATELY with its TTL visible,
 *   - detect expiry and re-issue a fresh one WITHOUT the operator asking,
 *   - present a "Pending Logins" surface where a fresh code is one tap away.
 *
 * It stores NO credential — only the public device-code / auth URL the provider
 * shows, which the operator types into the provider's own page. The actual login
 * happens against the provider, never through instar (Secret-Drop discipline).
 *
 * File-backed JSON (atomic tmp+rename), mirrors the SubscriptionPool durable-
 * registry pattern. The re-issue mechanism (re-driving the framework login) is
 * the wizard's concern + injected, so this store stays pure + hermetically
 * testable (no spawning, no network).
 */

import fs from 'node:fs';
import path from 'node:path';

export type LoginFlowKind = 'device-code' | 'url-code-paste';
export type LoginProvider = 'openai' | 'anthropic' | 'github-copilot' | 'google';

/**
 * Pending-login lifecycle:
 *   pending   — code/URL issued, awaiting the operator's approval at the provider
 *   expired   — TTL elapsed before approval (eligible for auto-reissue)
 *   completed — the operator approved + the account enrolled
 *   abandoned — operator/admin cancelled, or superseded by a re-issue
 */
export type PendingLoginStatus = 'pending' | 'expired' | 'completed' | 'abandoned';

export interface PendingLogin {
  /** Stable id, charset ^[a-z0-9-]+$. */
  id: string;
  /** Operator-facing label / intended account nickname. */
  label: string;
  provider: LoginProvider;
  framework: 'claude-code' | 'codex-cli' | 'gemini-cli' | 'pi-cli';
  kind: LoginFlowKind;
  /** The new account's CLAUDE_CONFIG_DIR (a filesystem path, never a secret) —
   *  recorded so an auto-reissue re-drives the login under the SAME slot. */
  configHome?: string;
  /** The public verification URL the operator opens (never a secret). */
  verificationUrl: string;
  /** Device-code (e.g. "7DAU-W4XJA") for device-code flows; absent for url-code-paste. */
  userCode?: string;
  /** ISO timestamp the code/URL expires. */
  ttlExpiresAt: string;
  status: PendingLoginStatus;
  /** How many times this login has been re-issued after expiry. */
  reissueCount: number;
  createdAt: string;
  updatedAt: string;
  /** Monotonic version for optimistic CAS. */
  version: number;
}

interface PendingLoginStoreFile {
  version: 1;
  logins: PendingLogin[];
  lastModified: string;
}

export interface PendingLoginStoreConfig {
  stateDir: string;
  /** Injectable clock (ms epoch) for deterministic TTL tests. */
  now?: () => number;
}

export interface IssueLoginInput {
  id: string;
  label: string;
  provider: LoginProvider;
  framework: PendingLogin['framework'];
  kind: LoginFlowKind;
  configHome?: string;
  verificationUrl: string;
  userCode?: string;
  /** TTL in ms from now (default 15 min — the observed Codex device-code TTL). */
  ttlMs?: number;
}

const ID_RE = /^[a-z0-9-]+$/;
const DEFAULT_TTL_MS = 15 * 60_000;

const FORBIDDEN_CREDENTIAL_FIELDS = [
  'accesstoken', 'refreshtoken', 'token', 'apikey', 'api_key',
  'credential', 'credentials', 'secret', 'password',
];

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class PendingLoginStore {
  private storePath: string;
  private store: PendingLoginStoreFile;
  private readonly now: () => number;

  constructor(config: PendingLoginStoreConfig) {
    this.storePath = path.join(config.stateDir, 'pending-logins.json');
    this.now = config.now ?? (() => Date.now());
    this.store = this.load();
  }

  /** All pending logins, with live status (expiry computed against the clock). */
  list(): PendingLogin[] {
    return this.store.logins.map((l) => ({ ...this.withLiveStatus(l) }));
  }

  get(id: string): PendingLogin | null {
    const found = this.store.logins.find((l) => l.id === id);
    return found ? { ...this.withLiveStatus(found) } : null;
  }

  /** Logins that are expired (TTL elapsed) but not completed/abandoned — the
   *  auto-reissue work-list. */
  expired(): PendingLogin[] {
    return this.list().filter((l) => l.status === 'expired');
  }

  /** Active (still-valid, awaiting-approval) logins — the "Pending Logins" surface. */
  active(): PendingLogin[] {
    return this.list().filter((l) => l.status === 'pending');
  }

  size(): number {
    return this.store.logins.length;
  }

  /** Issue a new pending login. Stores the public URL/code only — never a token. */
  issue(input: IssueLoginInput, rawExtra?: Record<string, unknown>): PendingLogin {
    this.assertNoCredentialFields(input as unknown as Record<string, unknown>);
    if (rawExtra) this.assertNoCredentialFields(rawExtra);
    const id = (input.id ?? '').trim();
    if (!id) throw new ValidationError('id is required');
    if (!ID_RE.test(id)) throw new ValidationError('id must match ^[a-z0-9-]+$');
    if (this.store.logins.some((l) => l.id === id)) {
      throw new ValidationError(`pending login ${id} already exists`);
    }
    if (!input.label?.trim()) throw new ValidationError('label is required');
    if (!input.verificationUrl?.trim()) throw new ValidationError('verificationUrl is required');
    if (input.kind === 'device-code' && !input.userCode?.trim()) {
      throw new ValidationError('device-code flow requires a userCode');
    }
    const nowIso = new Date(this.now()).toISOString();
    const login: PendingLogin = {
      id,
      label: input.label.trim(),
      provider: input.provider,
      framework: input.framework,
      kind: input.kind,
      ...(input.configHome ? { configHome: input.configHome } : {}),
      verificationUrl: input.verificationUrl.trim(),
      ...(input.userCode ? { userCode: input.userCode.trim() } : {}),
      ttlExpiresAt: new Date(this.now() + (input.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
      status: 'pending',
      reissueCount: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
      version: 1,
    };
    this.store.logins.push(login);
    this.save();
    return { ...login };
  }

  /**
   * Re-issue an expired (or pending) login with a fresh URL/code + TTL — the
   * auto-reissue path. Bumps reissueCount, resets status to pending. Returns null
   * if not found.
   */
  reissue(id: string, fresh: { verificationUrl: string; userCode?: string; ttlMs?: number }): PendingLogin | null {
    this.assertNoCredentialFields(fresh as unknown as Record<string, unknown>);
    const login = this.store.logins.find((l) => l.id === id);
    if (!login) return null;
    if (login.status === 'completed' || login.status === 'abandoned') {
      throw new ValidationError(`cannot reissue a ${login.status} login`);
    }
    if (!fresh.verificationUrl?.trim()) throw new ValidationError('verificationUrl is required');
    login.verificationUrl = fresh.verificationUrl.trim();
    if (fresh.userCode !== undefined) login.userCode = fresh.userCode.trim();
    login.ttlExpiresAt = new Date(this.now() + (fresh.ttlMs ?? DEFAULT_TTL_MS)).toISOString();
    login.status = 'pending';
    login.reissueCount += 1;
    login.updatedAt = new Date(this.now()).toISOString();
    login.version += 1;
    this.save();
    return { ...this.withLiveStatus(login) };
  }

  /** Mark a login completed (the operator approved + the account enrolled). */
  complete(id: string): PendingLogin | null {
    return this.transition(id, 'completed');
  }

  /** Cancel a login (operator/admin). */
  abandon(id: string): PendingLogin | null {
    return this.transition(id, 'abandoned');
  }

  private transition(id: string, to: PendingLoginStatus): PendingLogin | null {
    const login = this.store.logins.find((l) => l.id === id);
    if (!login) return null;
    login.status = to;
    login.updatedAt = new Date(this.now()).toISOString();
    login.version += 1;
    this.save();
    return { ...login };
  }

  /** Computes live `expired` status from the TTL without mutating the store
   *  (pending → expired when past TTL; completed/abandoned are terminal). */
  private withLiveStatus(login: PendingLogin): PendingLogin {
    if (login.status === 'pending' && Date.parse(login.ttlExpiresAt) <= this.now()) {
      return { ...login, status: 'expired' };
    }
    return login;
  }

  private assertNoCredentialFields(obj: Record<string, unknown>): void {
    if (!obj || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      if (FORBIDDEN_CREDENTIAL_FIELDS.includes(key.toLowerCase())) {
        throw new ValidationError(`pending logins store public codes/URLs only, never credentials — field "${key}" is not allowed`);
      }
    }
  }

  private load(): PendingLoginStoreFile {
    try {
      if (fs.existsSync(this.storePath)) {
        const data = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
        if (data && data.version === 1 && Array.isArray(data.logins)) {
          for (const l of data.logins) if (typeof l.version !== 'number') l.version = 1;
          return data as PendingLoginStoreFile;
        }
      }
    } catch {
      // @silent-fallback-ok: corrupt/unreadable store starts fresh; it holds no
      // credentials and the wizard re-issues, so nothing irrecoverable is lost.
    }
    return { version: 1, logins: [], lastModified: new Date(this.now()).toISOString() };
  }

  private save(): void {
    this.store.lastModified = new Date(this.now()).toISOString();
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      const tmp = `${this.storePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.store, null, 2) + '\n');
      fs.renameSync(tmp, this.storePath);
    } catch {
      // @silent-fallback-ok: persistence best-effort; in-memory store authoritative this process.
    }
  }
}
