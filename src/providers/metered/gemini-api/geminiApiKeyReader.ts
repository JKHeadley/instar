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

  /**
   * The go-live transcript check (spec §4 "A holder-side check"): does the stored key's
   * EXACT value appear in any of these files (directories are walked)? The value never
   * leaves this module. A path that is missing, unreadable or too large is reported in
   * `unreadable` — never counted as "no hit". No key in the vault ⇒ every path is
   * reported unreadable (the check cannot be made).
   */
  async scanForStoredKey(paths: string[], opts: { maxFileBytes?: number; maxFiles?: number } = {}): Promise<{ hit: boolean; unreadable: string[]; scannedFiles: number }> {
    // A transcript bigger than this is reported unreadable (a named blocker), never skipped as clean.
    const maxBytes = opts.maxFileBytes ?? 128 * 1024 * 1024;
    const maxFiles = opts.maxFiles ?? 20_000;
    let raw: unknown;
    try { raw = this.opts.vaultGet(GEMINI_PAYG_SECRET_NAME); } catch { raw = null; } // @silent-fallback-ok — no key: every path is reported unreadable below
    if (typeof raw !== 'string' || raw.length === 0) return { hit: false, unreadable: [...paths], scannedFiles: 0 };
    const needle = Buffer.from(raw, 'utf8');
    const unreadable: string[] = [];
    let scanned = 0;
    let hit = false;
    const seen = new Set<string>();
    const visit = (p: string): void => {
      if (hit) return;
      let st: fs.Stats;
      let real: string;
      try { st = fs.statSync(p); real = fs.realpathSync(p); } catch { unreadable.push(p); return; } // @silent-fallback-ok — reported as unreadable, a named blocker
      if (seen.has(real)) return; // a symlink loop or a path listed twice
      seen.add(real);
      if (seen.size > maxFiles) { unreadable.push(p); return; } // directories count toward the budget too
      if (st.isDirectory()) {
        let names: string[];
        try { names = fs.readdirSync(p); } catch { unreadable.push(p); return; } // @silent-fallback-ok — reported as unreadable
        for (const n of names) visit(path.join(p, n));
        return;
      }
      if (!st.isFile()) return;
      if (scanned >= maxFiles || st.size > maxBytes) { unreadable.push(p); return; }
      scanned += 1;
      try {
        if (fs.readFileSync(p).indexOf(needle) !== -1) hit = true;
      } catch { unreadable.push(p); } // @silent-fallback-ok — reported as unreadable
    };
    for (const p of paths) visit(p);
    return { hit, unreadable, scannedFiles: scanned };
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
