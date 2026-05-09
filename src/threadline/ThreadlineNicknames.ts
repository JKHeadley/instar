/**
 * ThreadlineNicknames — user-editable display names for threadline agents,
 * keyed by fingerprint (or any stable id).
 *
 * Storage: .instar/threadline/nicknames.json
 *   {
 *     "version": 1,
 *     "nicknames": {
 *       "8c7928aa9f04fbda...": {
 *         "nickname": "Dawn",
 *         "source": "user" | "haiku" | "import",
 *         "updatedAt": "2026-05-06T17:00:00.000Z"
 *       }
 *     }
 *   }
 */

import fs from 'node:fs';
import path from 'node:path';

export type NicknameSource = 'user' | 'haiku' | 'import';

export interface NicknameEntry {
  nickname: string;
  source: NicknameSource;
  updatedAt: string;
}

interface NicknamesFile {
  version: number;
  nicknames: Record<string, NicknameEntry>;
}

export interface ThreadlineNicknamesOptions {
  stateDir: string;
}

const FILE_VERSION = 1;

export class ThreadlineNicknames {
  private readonly stateDir: string;
  private cache: Map<string, NicknameEntry> | null = null;
  private cacheReadAt = 0;
  private static readonly CACHE_TTL_MS = 30_000;

  constructor(opts: ThreadlineNicknamesOptions) {
    this.stateDir = opts.stateDir;
  }

  /** Path to the nicknames JSON file. */
  filePath(): string {
    return path.join(this.stateDir, 'threadline', 'nicknames.json');
  }

  /** Returns the nickname for a fingerprint, or null if none set. */
  get(fingerprint: string): NicknameEntry | null {
    if (!fingerprint) return null;
    const map = this.load();
    return map.get(fingerprint) ?? null;
  }

  /** Returns all nicknames as a plain map. */
  all(): Record<string, NicknameEntry> {
    const map = this.load();
    const out: Record<string, NicknameEntry> = {};
    for (const [k, v] of map) out[k] = v;
    return out;
  }

  /**
   * Canonicalize a name for authority-grade comparison.
   *
   * Applies Unicode NFC normalization, trims surrounding whitespace,
   * collapses internal whitespace runs to a single space, and lowercases.
   * This is what makes two visually-identical names compare equal even
   * when one was hand-edited with stray whitespace, mixed case, or
   * combining-character forms.
   *
   * Used by `resolveByName()` on BOTH the lookup key AND each stored
   * entry's nickname at compare time — so we never mutate the user's
   * chosen display string on disk (preserving their preferred casing
   * and spacing for the dashboard), but lookups still match across
   * cosmetic differences. `set()` does NOT pre-canonicalize on store
   * for the same reason: the stored string is user-presentation; the
   * canonical form is comparison-only.
   */
  static canonicalizeName(name: string): string {
    if (!name) return '';
    return name
      .normalize('NFC')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }

  /**
   * Reverse-lookup: nickname → fingerprint. Canonicalized exact match
   * (NFC-normalized, internal-whitespace-collapsed, case-insensitive).
   *
   * Returns null if no nickname matches. If multiple fingerprints share
   * the same nickname (rare; user shouldn't do this but the file allows it),
   * returns { ambiguous: true, candidates: [...] } so callers can fail
   * loudly instead of silently picking one.
   *
   * The send-path resolver consults this BEFORE relay discovery so that
   * user-curated names take authority over potentially-stale or imposter
   * presence entries. See routes.ts /threadline/relay-send.
   */
  resolveByName(name: string): { fingerprint: string; entry: NicknameEntry } | { ambiguous: true; candidates: Array<{ fingerprint: string; entry: NicknameEntry }> } | null {
    const canonical = ThreadlineNicknames.canonicalizeName(name);
    if (!canonical) return null;
    const map = this.load();
    const matches: Array<{ fingerprint: string; entry: NicknameEntry }> = [];
    for (const [fp, entry] of map) {
      if (ThreadlineNicknames.canonicalizeName(entry.nickname) === canonical) {
        matches.push({ fingerprint: fp, entry });
      }
    }
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0];
    return { ambiguous: true, candidates: matches };
  }

  /** Set a nickname for a fingerprint. Empty/whitespace nickname clears it. */
  set(fingerprint: string, nickname: string, source: NicknameSource = 'user'): NicknameEntry | null {
    if (!fingerprint) throw new Error('fingerprint required');
    const trimmed = nickname.trim();
    const map = this.load();
    if (trimmed.length === 0) {
      map.delete(fingerprint);
      this.persist(map);
      return null;
    }
    if (trimmed.length > 64) {
      throw new Error('nickname too long (max 64 chars)');
    }
    const entry: NicknameEntry = {
      nickname: trimmed,
      source,
      updatedAt: new Date().toISOString(),
    };
    map.set(fingerprint, entry);
    this.persist(map);
    return entry;
  }

  /** Delete a nickname mapping. Returns true if one existed. */
  delete(fingerprint: string): boolean {
    const map = this.load();
    if (!map.has(fingerprint)) return false;
    map.delete(fingerprint);
    this.persist(map);
    return true;
  }

  /** Force-reload on next get(). */
  invalidate(): void {
    this.cache = null;
    this.cacheReadAt = 0;
  }

  // ── internal ───────────────────────────────────────────────────

  private load(): Map<string, NicknameEntry> {
    const fresh = Date.now() - this.cacheReadAt < ThreadlineNicknames.CACHE_TTL_MS;
    if (this.cache && fresh) return this.cache;
    const map = new Map<string, NicknameEntry>();
    const file = this.filePath();
    if (fs.existsSync(file)) {
      try {
        const raw = fs.readFileSync(file, 'utf-8');
        const parsed = JSON.parse(raw) as NicknamesFile;
        const items = parsed?.nicknames ?? {};
        for (const [k, v] of Object.entries(items)) {
          if (v && typeof v.nickname === 'string') {
            map.set(k, {
              nickname: v.nickname,
              source: (v.source as NicknameSource) ?? 'user',
              updatedAt: v.updatedAt ?? new Date().toISOString(),
            });
          }
        }
      } catch (err) {
        // Corrupt file — degrade to empty map (sends still flow via
        // relay-discovery fallback) but make the silent authority loss
        // visible. One log per cache cycle (every 30s at most), so a
        // persistently-corrupt file doesn't spam logs but is observable.
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[ThreadlineNicknames] nicknames.json parse failed at ${file}: ${msg}. ` +
          `Treating as empty (no user-curated authority for this load cycle). ` +
          `Outbound sends will fall back to relay-discovery for nicknamed names.`,
        );
      }
    }
    this.cache = map;
    this.cacheReadAt = Date.now();
    return map;
  }

  private persist(map: Map<string, NicknameEntry>): void {
    const file = this.filePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const obj: NicknamesFile = {
      version: FILE_VERSION,
      nicknames: Object.fromEntries(map),
    };
    // Atomic write: temp + rename. Prevents a concurrent reader from
    // observing a half-written file (which would parse-fail and degrade
    // to "no nicknames" — silent authority loss). rename(2) is atomic on
    // POSIX when source and destination live on the same filesystem.
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
    this.cache = map;
    this.cacheReadAt = Date.now();
  }
}
