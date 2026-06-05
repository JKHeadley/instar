/**
 * MandateAudit — append-only, hash-chained audit of every mandate gate decision.
 *
 * Every gate decision (ALLOW and DENY alike) is recorded. The hash chain (each
 * entry embeds the hash of the previous one) makes a deletion or edit detectable
 * (threat-model T8): break any link and `verifyChain()` reports the first broken
 * index. The chain head is surfaced read-only for the operator. An external,
 * out-of-process sink is a follow-on hardening, called out in the spec.
 *
 * Accountability after the fact is what makes ahead-of-time delegation safe: a
 * misbehaving mandate is killable AND every action it authorized is reconstructable.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { MandateAuditEntry, MandateDecision } from './types.js';

/** Canonical bytes an entry's hash covers — field-ordered, hash EXCLUDED. */
export function canonicalAuditEntry(e: Omit<MandateAuditEntry, 'hash'>): string {
  return JSON.stringify([
    e.ts, e.mandateId, e.agentFp, e.action, e.decision, e.reason,
    e.conditionResult, e.prevHash,
  ]);
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export interface MandateAuditDeps {
  filePath: string;
  now?: () => number;
}

export class MandateAudit {
  private readonly d: MandateAuditDeps;
  constructor(deps: MandateAuditDeps) {
    this.d = deps;
  }

  /** Append a decision, chaining it to the current head. Returns the new entry. */
  record(input: {
    mandateId: string;
    agentFp: string;
    action: string;
    decision: MandateDecision;
    reason: string;
    conditionResult?: boolean | null;
  }): MandateAuditEntry {
    const prevHash = this.headHash();
    const ts = new Date(this.d.now ? this.d.now() : Date.now()).toISOString();
    const unsigned: Omit<MandateAuditEntry, 'hash'> = {
      ts,
      mandateId: input.mandateId,
      agentFp: input.agentFp,
      action: input.action,
      decision: input.decision,
      reason: input.reason,
      conditionResult: input.conditionResult ?? null,
      prevHash,
    };
    const entry: MandateAuditEntry = { ...unsigned, hash: sha256(prevHash + canonicalAuditEntry(unsigned)) };
    fs.mkdirSync(path.dirname(this.d.filePath), { recursive: true });
    fs.appendFileSync(this.d.filePath, JSON.stringify(entry) + '\n');
    return entry;
  }

  /** All entries (oldest→newest). Tolerant of a missing file / a torn trailing line. */
  all(): MandateAuditEntry[] {
    let content: string;
    try { content = fs.readFileSync(this.d.filePath, 'utf8'); } catch { /* @silent-fallback-ok — audit file may not exist yet; empty history is the natural default */ return []; }
    const out: MandateAuditEntry[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as MandateAuditEntry); } catch { /* @silent-fallback-ok — torn-trailing-line tolerance; a crash mid-append must not poison reads */ }
    }
    return out;
  }

  /** The current chain head hash ('' when empty). */
  headHash(): string {
    const all = this.all();
    return all.length ? all[all.length - 1].hash : '';
  }

  /**
   * Verify the hash chain end-to-end. Returns `{ ok: true }` when intact, else
   * `{ ok: false, brokenAt }` with the index of the first entry whose recomputed
   * hash (or prevHash linkage) does not match — the tamper signal.
   */
  verifyChain(): { ok: true } | { ok: false; brokenAt: number } {
    const all = this.all();
    let prevHash = '';
    for (let i = 0; i < all.length; i++) {
      const { hash, ...unsigned } = all[i];
      if (unsigned.prevHash !== prevHash) return { ok: false, brokenAt: i };
      const expected = sha256(prevHash + canonicalAuditEntry(unsigned));
      if (expected !== hash) return { ok: false, brokenAt: i };
      prevHash = hash;
    }
    return { ok: true };
  }
}
