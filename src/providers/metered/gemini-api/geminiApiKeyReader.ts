/**
 * geminiApiKeyReader — the ONLY named reader of the Gemini pay-per-use key
 * (docs/specs/gemini-payg-metered-lane.md §4.1, §4.3, "keyGeneration").
 *
 * - Exposes `withKey(fn)` only. Its sole caller is the provider, which hands the value
 *   straight to the transport's `x-goog-api-key` header. The value never leaves `fn`.
 * - Refuses (`key-in-plain-config`) when the key name appears as plain text in
 *   `.instar/config.json`: a tracked state file must never hold a paid key. One notice
 *   is raised through the injected `onPlainConfigCopy` so the agent moves it.
 * - Checks the stored value's SHA-256 fingerprint against the committed `keyGeneration`
 *   inside `withKey` (never logged). A mismatch refuses (`key-generation-mismatch`), so a
 *   wrong key in the vault can never spend under the one-key fence.
 *
 * `scripts/lint-metered-secret-readers.js` allowlists exactly this file for named reads.
 */

// RULE 3: EXEMPT — not a state detector: it reads ONE value from the agent's own vault and
// compares its fingerprint to a committed record; it parses no provider/CLI output or state.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GEMINI_PAYG_SECRET_NAME } from '../../../core/meteredSecrets.js';

export type GeminiKeyRefusalCode = 'key-absent' | 'key-in-plain-config' | 'key-generation-mismatch' | 'vault-unreadable';

export class GeminiKeyRefusal extends Error {
  constructor(public readonly code: GeminiKeyRefusalCode, detail: string) {
    super(`gemini-api key refused (${code}): ${detail}`);
    this.name = 'GeminiKeyRefusal';
  }
}

/** SHA-256 hex fingerprint of a key value. The value itself is never returned or logged. */
export function keyFingerprint(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export interface GeminiApiKeyReaderOptions {
  /** The agent's `.instar` dir (for the plain-config check). */
  stateDir: string;
  /** Vault read of ONE name. Injected so tests never touch a real vault. */
  vaultGet: (name: string) => unknown;
  /** The committed keyGeneration (fingerprint) from the door policy; null → refuse. */
  expectedKeyGeneration: () => string | null;
  /** Raised once when a plain-config copy is found (the agent should move it). */
  onPlainConfigCopy?: () => void;
}

export class GeminiApiKeyReader {
  private plainNoticeRaised = false;

  constructor(private readonly opts: GeminiApiKeyReaderOptions) {}

  /** True when `.instar/config.json` holds the key name as a plain string. */
  private plainConfigHasKey(): boolean {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(this.opts.stateDir, 'config.json'), 'utf-8')) as Record<string, unknown>;
      const v = cfg?.[GEMINI_PAYG_SECRET_NAME];
      return typeof v === 'string' && v.length > 0;
    } catch {
      // @silent-fallback-ok: an unreadable/absent config cannot hold a plain copy; the
      // vault read below still fails closed on its own.
      return false;
    }
  }

  /**
   * Run `fn` with the key value. Every refusal throws `GeminiKeyRefusal` BEFORE `fn` runs.
   * `fn` must not retain or log the value.
   */
  async withKey<T>(fn: (key: string) => Promise<T>): Promise<T> {
    if (this.plainConfigHasKey()) {
      if (!this.plainNoticeRaised) {
        this.plainNoticeRaised = true;
        try { this.opts.onPlainConfigCopy?.(); } catch { /* @silent-fallback-ok: notice is signal-only */ }
      }
      throw new GeminiKeyRefusal('key-in-plain-config', 'the key is in .instar/config.json as plain text; move it into the vault');
    }
    let raw: unknown;
    try {
      raw = this.opts.vaultGet(GEMINI_PAYG_SECRET_NAME);
    } catch {
      throw new GeminiKeyRefusal('vault-unreadable', 'the vault could not be read');
    }
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new GeminiKeyRefusal('key-absent', 'no key in this machine\'s vault');
    }
    const expected = this.opts.expectedKeyGeneration();
    if (!expected || keyFingerprint(raw) !== expected) {
      throw new GeminiKeyRefusal('key-generation-mismatch', 'the stored key is not the committed key generation');
    }
    return fn(raw);
  }

  /** The stored key's fingerprint, computed inside the reader (for the handoff check). */
  async storedFingerprint(): Promise<string | null> {
    try {
      const raw = this.opts.vaultGet(GEMINI_PAYG_SECRET_NAME);
      return typeof raw === 'string' && raw.length > 0 ? keyFingerprint(raw) : null;
    } catch {
      // @silent-fallback-ok: an unreadable vault reports "no fingerprint", which every
      // caller treats as awaiting-key (fail closed).
      return null;
    }
  }
}
