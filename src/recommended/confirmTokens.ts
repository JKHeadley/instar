/**
 * Single-use tokens for a recommended service's confirm page (docs/specs/recommended-services.md, Yes).
 *
 * The machine serving the page mints one when the page opens, so a lease move can't kill a yes. Each
 * is bound to the owner, service, target machine and offer text, and expires in 30 minutes. Only a
 * hash is stored. Local to this machine by design: a token is never replicated.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ChoiceOrigin } from './RecommendedServicesLedger.js';

export const CONFIRM_TOKEN_TTL_MS = 30 * 60_000;
const MAX_PER_SERVICE = 50;
/** Opening the page rewrites a file and needs no token, so it is rate-bounded across all services. */
export const MAX_MINTS_PER_MINUTE = 30;

export interface ConfirmBinding {
  service: string;
  owner: string;
  targetMachine: string;
  offerTextHash: string;
  origin: ChoiceOrigin;
  /** Every no known when the page opened. A no outside this list, from any machine, voids the page. */
  nosAtOpen: string[];
}

interface StoredToken extends ConfirmBinding {
  hash: string;
  expiresAt: number;
}

function hashOf(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function confirmTokensFile(stateDir: string): string {
  return path.join(stateDir, 'state', 'recommended-service-tokens', 'tokens.json');
}

export class ConfirmTokenStore {
  private readonly file: string;
  private recentMints: number[] = [];

  constructor(private readonly opts: { stateDir: string; now?: () => number }) {
    this.file = confirmTokensFile(opts.stateDir);
  }

  /** False once pages are opening faster than a person could. Nothing is written. */
  mayMint(): boolean {
    const since = this.now() - 60_000;
    this.recentMints = this.recentMints.filter((at) => at > since);
    return this.recentMints.length < MAX_MINTS_PER_MINUTE;
  }

  /** Oldest tokens fall off past the cap, so opening a page repeatedly can't grow the file. */
  mint(binding: ConfirmBinding): { token: string; expiresAt: number } {
    this.recentMints.push(this.now());
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = this.now() + CONFIRM_TOKEN_TTL_MS;
    const others = this.live().filter((t) => t.service !== binding.service);
    const same = this.live().filter((t) => t.service === binding.service).slice(-(MAX_PER_SERVICE - 1));
    this.write([...others, ...same, { ...binding, hash: hashOf(token), expiresAt }]);
    return { token, expiresAt };
  }

  /** Checks a token without spending it, so a mistyped PIN doesn't cost the person their page. */
  isLive(token: string, service: string): boolean {
    const hash = hashOf(token);
    return this.live().some((t) => t.hash === hash && t.service === service);
  }

  /**
   * Spends a token. Removed before returning, so a second call gets null even if the first caller
   * then fails. An unreadable file means no token is valid.
   */
  consume(token: string, service: string): ConfirmBinding | null {
    const hash = hashOf(token);
    const tokens = this.live();
    const found = tokens.find((t) => t.hash === hash && t.service === service);
    if (!found) return null;
    this.write(tokens.filter((t) => t !== found));
    const { hash: _hash, expiresAt: _expiresAt, ...binding } = found;
    return binding;
  }

  /** A no invalidates every open page for that service. */
  invalidateService(service: string): void {
    const tokens = this.live();
    const kept = tokens.filter((t) => t.service !== service);
    if (kept.length !== tokens.length) this.write(kept);
  }

  private live(): StoredToken[] {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return []; // @silent-fallback-ok — no file or a torn one means no valid token, which refuses
    }
    if (!Array.isArray(raw)) return [];
    const now = this.now();
    return (raw as StoredToken[]).filter((t) => t && typeof t.hash === 'string' && typeof t.expiresAt === 'number' && t.expiresAt > now);
  }

  private write(tokens: StoredToken[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(tokens), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
}
