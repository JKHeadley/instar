/**
 * PermissionDecisionLedger — observe-only, append-only record of every permission
 * verdict (allow / clarify / refuse / step-up) with the verified principal + basis.
 *
 * Purpose: measure the gate's decisions (and false-positive rate) against real
 * traffic BEFORE enforcement is ever switched on. Writing here never blocks or
 * mutates the message path — a ledger failure is swallowed.
 *
 * State category: `slack-permission-decisions` (state-coherence-registry.json).
 * Design: docs/specs/SLACK-ORG-INTEGRATION-SPEC.md §6.10, §11.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { PermissionVerdict } from './types.js';

export interface PermissionLedgerEntry {
  ts: string;
  decision: string;
  basis: string;
  action: string;
  tier: number;
  floorAction?: string;
  slackUserId?: string;
  userId: string | null;
  role: string;
  registered: boolean;
  directed: boolean;
  confidence: number;
  anomalyScore?: number;
  channel?: string;
  /** Observe-only marker: would this verdict have been ENFORCED (vs just logged)? */
  enforced: boolean;
}

export class PermissionDecisionLedger {
  private readonly file: string;

  constructor(stateDir: string) {
    /* state-registry: slack-permission-decisions */
    this.file = path.join(stateDir, 'slack-permission-decisions.jsonl');
  }

  get path(): string {
    return this.file;
  }

  record(verdict: PermissionVerdict, ctx?: { channel?: string; enforced?: boolean }): void {
    const entry: PermissionLedgerEntry = {
      ts: verdict.evaluatedAt,
      decision: verdict.decision,
      basis: verdict.basis,
      action: verdict.intent.action,
      tier: verdict.intent.tier,
      floorAction: verdict.intent.floorAction,
      slackUserId: verdict.principal.slackUserId,
      userId: verdict.principal.userId,
      role: verdict.principal.role,
      registered: verdict.principal.registered,
      directed: verdict.intent.directed,
      confidence: verdict.intent.confidence,
      anomalyScore: verdict.anomaly?.score,
      channel: ctx?.channel,
      enforced: ctx?.enforced ?? false,
    };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
    } catch {
      // Observe-only ledger must NEVER break the message path.
    }
  }

  /** Most-recent entries (for the read route + FP-rate measurement). */
  readRecent(limit = 100): PermissionLedgerEntry[] {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      return lines.slice(-limit).map((l) => JSON.parse(l) as PermissionLedgerEntry);
    } catch {
      return [];
    }
  }
}
