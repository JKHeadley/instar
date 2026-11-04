/**
 * FeatureEvidenceLog — the rich-context record a switched-off feature keeps of
 * what it actually did, so it can be judged on its own behaviour.
 *
 * Spec: docs/specs/feature-maturation-ladder.md §4. One JSONL file per agent
 * home, rotated by segment. `record` never throws and never blocks the feature
 * that calls it: a lost evidence row costs a sample, never a behaviour.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { scrubForStore } from '../core/durableSecretScrub.js';
import { maybeRotateJsonlSegment } from '../utils/jsonl-rotation.js';

export const FEATURE_EVIDENCE_FILE = 'logs/feature-evidence.jsonl';
const MAX_ACTIVE_BYTES = 10 * 1024 * 1024;
const KEEP_SEGMENTS = 8;
const MAX_TEXT = 240;
const MAX_CONTEXT_KEYS = 16;
const CONTEXT_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export type FeatureEvidenceKind = 'fired' | 'held' | 'error' | 'outcome';
export type FeatureEvidenceOutcome = 'right' | 'wrong' | 'unknown';
export type FeatureEvidenceContext = Record<string, string | number | boolean | null>;

export interface FeatureEvidenceInput {
  kind: FeatureEvidenceKind;
  reason: string;
  outcome?: FeatureEvidenceOutcome;
  /** An outcome row grades one earlier event. */
  gradesEventId?: string;
  gradedBy?: string;
  rung?: string;
  flagState?: string;
  context?: FeatureEvidenceContext;
}

export interface FeatureEvidenceRow extends FeatureEvidenceInput {
  eventId: string;
  at: string;
  featureId: string;
  machine: string;
  instarVersion: string;
}

function clean(text: string): string {
  const scrubbed = scrubForStore(text.slice(0, MAX_TEXT * 4)).text;
  return scrubbed.length > MAX_TEXT ? scrubbed.slice(0, MAX_TEXT) : scrubbed;
}

function cleanContext(raw: unknown): FeatureEvidenceContext | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: FeatureEvidenceContext = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!CONTEXT_KEY_RE.test(k)) continue;
    if (++n > MAX_CONTEXT_KEYS) break;
    if (typeof v === 'string') out[k] = clean(v);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean' || v === null) out[k] = v;
  }
  return n ? out : undefined;
}

export class FeatureEvidenceLog {
  readonly filePath: string;
  private dirReady = false;

  constructor(private readonly opts: {
    projectDir: string;
    machine: string;
    instarVersion: string;
    now?: () => number;
  }) {
    this.filePath = path.join(opts.projectDir, FEATURE_EVIDENCE_FILE);
  }

  /** Append one row. Returns its event id, or null if the row could not be kept. */
  record(featureId: string, input: FeatureEvidenceInput): string | null {
    try {
      const eventId = crypto.randomUUID();
      const row: FeatureEvidenceRow = {
        eventId,
        at: new Date(this.opts.now?.() ?? Date.now()).toISOString(),
        featureId: featureId.slice(0, 160),
        machine: this.opts.machine,
        instarVersion: this.opts.instarVersion,
        kind: input.kind,
        reason: clean(String(input.reason ?? '')),
        ...(input.outcome ? { outcome: input.outcome } : {}),
        ...(input.gradesEventId ? { gradesEventId: input.gradesEventId.slice(0, 64) } : {}),
        ...(input.gradedBy ? { gradedBy: clean(input.gradedBy).slice(0, 64) } : {}),
        ...(input.rung ? { rung: input.rung.slice(0, 32) } : {}),
        ...(input.flagState ? { flagState: input.flagState.slice(0, 32) } : {}),
      };
      const context = cleanContext(input.context);
      if (context) row.context = context;
      if (!this.dirReady) {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        this.dirReady = true;
      }
      maybeRotateJsonlSegment(this.filePath, { maxBytes: MAX_ACTIVE_BYTES, keepSegments: KEEP_SEGMENTS });
      fs.appendFileSync(this.filePath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      return eventId;
    } catch { // @silent-fallback-ok — evidence must never break the feature; the missing row reads as fewer samples, which is the honest side
      return null;
    }
  }
}

let shared: FeatureEvidenceLog | null = null;

/** Wire the process-wide log once, at server boot. */
export function setFeatureEvidenceLog(log: FeatureEvidenceLog | null): void {
  shared = log;
}

/**
 * The call a feature makes at a decision point. Safe before boot and in tests:
 * with no log wired it does nothing.
 */
export const featureEvidence = {
  record(featureId: string, input: FeatureEvidenceInput): string | null {
    return shared ? shared.record(featureId, input) : null;
  },
};
