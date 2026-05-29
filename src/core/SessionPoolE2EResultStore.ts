/**
 * SessionPoolE2EResultStore — the durable, signed, append-only record of each
 * rollout stage's Tier-3 E2E outcome (Multi-Machine Session Pool §Rollout). It is
 * the mechanical evidence the StageAdvancer gates on: a stage does NOT activate
 * until its prior stage's E2E recorded `green` for the current commit. Per
 * "Structure > Willpower" the gate is grounded in this implemented record, not a
 * human's say-so.
 *
 * Append-only + signed (tamper-evident, AuditTrail-style): a reversion or a new run
 * APPENDS a row, NEVER overwrites a prior one, so the full green/red history per
 * commit is preserved. The Tier-3 E2E harness is the ONLY writer (`recordResult`).
 */

import fs from 'node:fs';
import path from 'node:path';

export type StageE2EOutcome = 'green' | 'red';

export interface StageE2EResult {
  stage: number;
  result: StageE2EOutcome;
  commitSha: string;
  ranAt: string;
  evidenceRef: string;
  signature: string;
}

export interface SessionPoolE2EResultStoreDeps {
  /** Absolute path to the append-only results file. */
  filePath: string;
  /** Sign the canonical (signature-excluded) row. Production: HMAC/Ed25519 over a state secret. */
  sign: (canonical: string) => string;
  /** Verify a signature against the canonical row. */
  verifySig: (canonical: string, signature: string) => boolean;
  now?: () => number;
}

/** Canonical bytes a row's signature covers — field-ordered, signature EXCLUDED. */
export function canonicalE2ERow(r: Omit<StageE2EResult, 'signature'>): string {
  return JSON.stringify([r.stage, r.result, r.commitSha, r.ranAt, r.evidenceRef]);
}

export class SessionPoolE2EResultStore {
  private readonly d: SessionPoolE2EResultStoreDeps;
  constructor(deps: SessionPoolE2EResultStoreDeps) {
    this.d = deps;
  }

  /** Append a signed result row. The ONLY writer (called by the Tier-3 E2E harness). */
  recordResult(stage: number, result: StageE2EOutcome, commitSha: string, evidenceRef: string): StageE2EResult {
    const ranAt = new Date(this.d.now ? this.d.now() : Date.now()).toISOString();
    const unsigned: Omit<StageE2EResult, 'signature'> = { stage, result, commitSha, ranAt, evidenceRef };
    const row: StageE2EResult = { ...unsigned, signature: this.d.sign(canonicalE2ERow(unsigned)) };
    fs.mkdirSync(path.dirname(this.d.filePath), { recursive: true });
    fs.appendFileSync(this.d.filePath, JSON.stringify(row) + '\n');
    return row;
  }

  /** All rows (oldest→newest). Tolerant of a missing file / a torn trailing line. */
  all(): StageE2EResult[] {
    let content: string;
    try { content = fs.readFileSync(this.d.filePath, 'utf8'); } catch { return []; }
    const out: StageE2EResult[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as StageE2EResult); } catch { /* skip a torn line */ }
    }
    return out;
  }

  /** The MOST RECENT row for a stage (a later `red` supersedes an earlier `green`). */
  getLatestForStage(stage: number): StageE2EResult | null {
    let latest: StageE2EResult | null = null;
    for (const r of this.all()) if (r.stage === stage) latest = r;
    return latest;
  }

  /** Verify a row's signature (tamper check). */
  verify(row: StageE2EResult): boolean {
    return this.d.verifySig(canonicalE2ERow(row), row.signature);
  }
}
