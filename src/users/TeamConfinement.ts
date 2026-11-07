/**
 * TeamConfinement — which conversations must never run with owner reach
 * (docs/specs/team-roles-and-access.md §3.5, §4.1).
 *
 * Reads the confined list directly, so it works from the first moment of boot, before the key ledger
 * or the phone service exist. The list needs no signature to be obeyed: it only ever narrows reach.
 * Pure decisions over one small file, cached by mtime, because this runs on every spawn and message.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ConfinedEntry } from '../core/TeamAccessLog.js';
import { TEAM_ACCESS_DIR, TEAM_ACCESS_LAST_GOOD_DIR } from '../core/TeamAccessLog.js';
import type { MemoryPlace } from './MemoryAudience.js';
import type { SessionPlaceInput } from './MemoryPrivacy.js';

/** The reference a place input names, or null when it names no conversation (jobs, the dashboard). */
export function conversationRefOf(input: SessionPlaceInput): string | null {
  if (input.memoryPlace) return null;
  if (input.telegramTopicId !== undefined) return `telegram:${input.telegramTopicId}`;
  if (input.memoryPlaceKey?.startsWith('app:')) return input.memoryPlaceKey.slice(4);
  return null;
}

/** A per-topic place key. The whole-group key stays for every topic that was never shared. */
export function topicPlaceKey(ref: string): string {
  return `telegram:topic:${ref.slice('telegram:'.length)}`;
}

export function placeForEntry(entry: ConfinedEntry): MemoryPlace {
  if (entry.personKey) return { kind: 'private', placeKey: `app:${entry.ref}`, personId: entry.personKey, alwaysPerson: true };
  return { kind: 'shared', placeKey: entry.placeKey ?? (entry.ref.startsWith('telegram:') ? topicPlaceKey(entry.ref) : `app:${entry.ref}`) };
}

export class TeamConfinement {
  private readonly file: string;
  private cache: { mtimeMs: number; size: number; entries: Map<string, ConfinedEntry> } | null = null;

  constructor(private readonly stateDir: string) {
    this.file = path.join(stateDir, TEAM_ACCESS_DIR, 'confined.json');
  }

  /** Any sign the agent has been in team use, with the list gone. */
  private signsOfTeamUse(): boolean {
    if (fs.existsSync(path.join(this.stateDir, TEAM_ACCESS_DIR, 'log.jsonl'))) return true;
    if (fs.existsSync(path.join(this.stateDir, TEAM_ACCESS_LAST_GOOD_DIR, 'log.jsonl'))) return true;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.stateDir, 'state', 'mobile-devices.json'), 'utf8')) as { devices?: Array<{ role?: string }> };
      return (raw.devices ?? []).some((d) => d.role === 'team');
    } catch {
      // @silent-fallback-ok — no device file on this agent is no sign of team use.
      return false;
    }
  }

  /** The list, an empty map on a never-team agent, or null when it cannot be trusted. */
  entries(): Map<string, ConfinedEntry> | null {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.file);
    } catch {
      // @silent-fallback-ok — missing is decided by the signs of team use on the next line.
      this.cache = null;
      return this.signsOfTeamUse() ? null : new Map();
    }
    if (this.cache && this.cache.mtimeMs === stat.mtimeMs && this.cache.size === stat.size) return this.cache.entries;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { entries?: ConfinedEntry[] };
      if (!Array.isArray(raw.entries)) return null;
      const entries = new Map(raw.entries.filter((e) => e && typeof e.ref === 'string').map((e) => [e.ref, e]));
      this.cache = { mtimeMs: stat.mtimeMs, size: stat.size, entries };
      return entries;
    } catch {
      // @silent-fallback-ok — null makes every caller refuse, the strict direction.
      this.cache = null;
      return null;
    }
  }

  isConfined(ref: string): boolean | null {
    const entries = this.entries();
    return entries ? entries.has(ref) : null;
  }

  /** The place for a confined conversation, or null when this one is not confined. */
  place(input: SessionPlaceInput): MemoryPlace | null {
    const ref = conversationRefOf(input);
    if (!ref) return null;
    const entry = this.entries()?.get(ref);
    return entry ? placeForEntry(entry) : null;
  }

  /**
   * Whether a spawn must be refused. An unreadable list refuses every conversation; a confined
   * conversation is refused with memory privacy off, because nothing could confine it.
   */
  refuseSpawn(input: SessionPlaceInput, privacyOn: boolean): boolean {
    if (input.memoryPlace) return false;
    const entries = this.entries();
    if (!entries) return true;
    const ref = conversationRefOf(input);
    return !!ref && entries.has(ref) && !privacyOn;
  }
}
