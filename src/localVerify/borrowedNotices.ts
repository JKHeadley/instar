/**
 * Helper events and who is told (docs/specs/local-verify-borrowed-slices-count.md, F "Who is told").
 * Pure.
 *
 * Every confirmed wrong pass and every lapse is written to the audit log and sent to the session
 * that operates the line. The owner hears, in the topic where he was asked about that machine,
 * only when the repair itself was not enough: a helper's pass let a change merge that then made
 * `main` red, or a helper has lapsed for a fault three times in 7 days. Ordinary lapses (an image
 * or runner-version change, 7 days without an agreeing comparison) never count toward that.
 *
 * Notices are sent once, by the coordinator. A peer's run machine lists its helper's events, with
 * ids, in the status the coordinator already polls; the coordinator remembers the ids it has told.
 */
import crypto from 'node:crypto';
import { PRACTICE_LANES, PRACTICE_LIMITS, isFaultLapse, type LapseReason, type PracticeLane } from './borrowedPractice.js';

export type HelperEventKind = 'wrong-pass' | 'lapse' | 'suspended' | 'main-red-after-pass';

export interface HelperEvent {
  /** 32 lowercase hex characters, made where the event happened. */
  id: string;
  at: number;
  /** The run machine the helper is paired with (where the event happened). */
  runMachineId: string;
  helper: string;
  lane: PracticeLane;
  kind: HelperEventKind;
  /** `lapse` only. */
  reason?: LapseReason;
  /** `lapse` only: whether the reason is a fault. */
  fault?: boolean;
  /** `wrong-pass` and `main-red-after-pass`: the file. */
  file?: string;
  /** `wrong-pass` and `main-red-after-pass`: the change (its PR number as text), when there was one. */
  change?: string;
}

export const HELPER_EVENT_LIMITS = Object.freeze({
  /** Events a run machine keeps (and a coordinator remembers as told). */
  kept: 200,
  /** Events in one peer status answer: the newest. */
  perStatus: 50,
});

export const newEventId = (): string => crypto.randomBytes(16).toString('hex');

const ID_RE = /^[0-9a-f]{32}$/;
const MACHINE_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const KINDS: readonly HelperEventKind[] = Object.freeze(['wrong-pass', 'lapse', 'suspended', 'main-red-after-pass']);
const REASONS: readonly string[] = Object.freeze(['wrong-pass-compare-only', 'wrong-pass-two-changes', 'invalid-answers', 'suspension-followup', 'image-changed', 'runner-version-changed', 'no-agreeing-comparison']);
const KEYS = Object.freeze(['id', 'at', 'runMachineId', 'helper', 'lane', 'kind', 'reason', 'fault', 'file', 'change']);

/** One event, strictly: exactly the known keys, every value bounded. Anything else is null. */
export function parseHelperEvent(v: unknown): HelperEvent | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const x = v as Record<string, unknown>;
  if (!Object.keys(x).every((k) => KEYS.includes(k))) return null;
  if (typeof x.id !== 'string' || !ID_RE.test(x.id)) return null;
  if (typeof x.at !== 'number' || !Number.isSafeInteger(x.at) || x.at < 0) return null;
  if (typeof x.runMachineId !== 'string' || !MACHINE_ID_RE.test(x.runMachineId)) return null;
  if (typeof x.helper !== 'string' || !MACHINE_ID_RE.test(x.helper)) return null;
  if (!(PRACTICE_LANES as readonly unknown[]).includes(x.lane)) return null;
  if (!(KINDS as readonly unknown[]).includes(x.kind)) return null;
  if (x.kind === 'lapse') {
    if (typeof x.reason !== 'string' || !REASONS.includes(x.reason)) return null;
    // The fault flag is derived, never taken on the sender's word.
    if (x.fault !== isFaultLapse(x.reason as LapseReason)) return null;
  } else if (x.reason !== undefined || x.fault !== undefined) return null;
  if (x.file !== undefined && !(typeof x.file === 'string' && x.file.length >= 1 && x.file.length <= 300)) return null;
  if (x.change !== undefined && !(typeof x.change === 'string' && /^[0-9]{1,10}$/.test(x.change))) return null;
  return { ...(x as unknown as HelperEvent) };
}

/**
 * A peer's `helperEvents` list from its status answer, strictly: an array of at most
 * `perStatus` valid events, all about that peer as the run machine. One malformed entry drops
 * the whole list (the next poll brings it again).
 */
export function parseHelperEvents(v: unknown, peerMachineId: string): HelperEvent[] | null {
  if (!Array.isArray(v) || v.length > HELPER_EVENT_LIMITS.perStatus) return null;
  const out: HelperEvent[] = [];
  for (const e of v) {
    const p = parseHelperEvent(e);
    if (!p || p.runMachineId !== peerMachineId) return null;
    out.push(p);
  }
  return out;
}

export interface WhoIsTold {
  /** Always: every event is written to the audit log. */
  audit: true;
  /** The session that operates the line. */
  line: boolean;
  /** The owner's topic for that machine. */
  owner: boolean;
  ownerReason: 'main-red-after-pass' | 'three-fault-lapses' | null;
}

/**
 * Who hears of one event. `history` is every known event of that helper (it may include `e`).
 * The owner hears only of a pass that made `main` red, or of a fault lapse that is the third (or
 * a later one) within 7 days; ordinary lapses never count.
 */
export function whoIsTold(e: HelperEvent, history: readonly HelperEvent[]): WhoIsTold {
  const line = e.kind === 'wrong-pass' || e.kind === 'lapse' || e.kind === 'main-red-after-pass';
  if (e.kind === 'main-red-after-pass') return { audit: true, line, owner: true, ownerReason: 'main-red-after-pass' };
  if (e.kind === 'lapse' && e.fault === true) {
    const ids = new Set<string>([e.id]);
    let n = 1;
    for (const h of history) {
      if (ids.has(h.id)) continue;
      ids.add(h.id);
      if (h.helper === e.helper && h.kind === 'lapse' && h.fault === true && h.at <= e.at && e.at - h.at <= PRACTICE_LIMITS.ownerFaultWindowMs) n++;
    }
    if (n >= PRACTICE_LIMITS.ownerFaultLapses) return { audit: true, line, owner: true, ownerReason: 'three-fault-lapses' };
  }
  return { audit: true, line, owner: false, ownerReason: null };
}

/** The events not yet told, oldest first. Pure: the caller records the ids afterwards. */
export function untold(events: readonly HelperEvent[], told: ReadonlySet<string>): HelperEvent[] {
  const seen = new Set<string>();
  return events.filter((e) => { if (told.has(e.id) || seen.has(e.id)) return false; seen.add(e.id); return true; }).sort((a, b) => a.at - b.at);
}

/** One event in plain words (the notice's text). */
export function eventText(e: HelperEvent): string {
  const where = `helper ${e.helper}, ${e.lane} lane (run machine ${e.runMachineId})`;
  if (e.kind === 'wrong-pass') return `A helper passed a test file that fails on the run machine: ${e.file ?? 'a file'}${e.change ? ` (change ${e.change})` : ''}; ${where}. The verify failed on the run machine's own result.`;
  if (e.kind === 'lapse') return `Counting ended and the helper is back in practice: ${e.reason ?? 'unknown reason'}${e.fault ? ' (a fault)' : ''}; ${where}.`;
  if (e.kind === 'suspended') return `More than five disagreements in one verify: nothing from this helper counts until its next compare-only verify; ${where}.`;
  return `A helper's pass let a change merge that then made main red: ${e.file ?? 'a file'}${e.change ? ` (change ${e.change})` : ''}; ${where}.`;
}
