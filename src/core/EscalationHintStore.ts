/**
 * EscalationHintStore — WS5.3 ("escalation rides the topic") of
 * docs/specs/MULTI-MACHINE-SEAMLESSNESS-SPEC.md (mirrored at
 * docs/specs/ws53-escalation-rides-topic.md).
 *
 * The EPHEMERAL carrier for "this topic was running on the escalated tier
 * when it moved." Model-tier escalation leases are keyed on the spawn-
 * generated session-instance-id (see EscalationGovernor.ts header); a
 * `POST /pool/transfer` respawns the topic's session on the destination with
 * a NEW instance id, so the live escalation state is DROPPED and the resumed
 * session starts on the default tier mid-heavy-work. WS5.3 carries the source
 * topic's active escalation TRIGGER as a hint so the destination has a REASON
 * to re-evaluate escalation under its OWN cost guards.
 *
 * THE LOAD-BEARING SAFETY INVARIANT (spec §"safety invariant"): a hint is a
 * trigger carry, NEVER a tier grant. The destination MUST re-decide through
 * its own `EscalationGovernor.admit()` (every cost guard intact) — the hint
 * only decides WHETHER to ask, never the answer. This store carries no tier
 * authority; the re-admit chokepoint (ModelSwapService.swap → admit) is the
 * single decision authority and is untouched here.
 *
 * Design (deliberately tiny — it is a hint, not state):
 *  - **Ephemeral by TTL**: every hint carries an `expiresAt`; a hint older
 *    than the TTL is treated as absent (a topic that moved long ago and was
 *    never resumed must not silently re-escalate days later — the destination
 *    governor's own dwell/quota would re-price it anyway, but a stale hint is
 *    never even surfaced). Expiry is evaluated lazily on read.
 *  - **Consume-once**: `consume()` returns the live hint AND removes it, so a
 *    single transfer produces at most one re-admit attempt. A re-transfer
 *    files a fresh hint.
 *  - **Durable enough**: the source leg of the transfer runs on the
 *    holder/router and the destination resume is lazy (next message), so the
 *    hint outlives the request; an atomic JSON write survives a restart in
 *    that gap. Corrupt/absent file → no hints (the safe direction: no hint =
 *    no re-admit = default tier).
 *  - **NOT the durable topic profile**: a topic profile is sticky operator
 *    intent and must not gain a transient "was escalated" bit. The hint lives
 *    in its own file and is consumed, never resolved into a pin.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { EscalationTier } from './ModelTierEscalation.js';

/** Default hint TTL — a topic not resumed within this window drops the hint. */
export const DEFAULT_ESCALATION_HINT_TTL_MS = 6 * 60 * 60 * 1000; // 6h (mirrors maxEscalationTtlMs)

/** One ephemeral carry: the trigger to re-evaluate + the tier the source ran. */
export interface EscalationHint {
  /** The escalation trigger label the source topic was running under (e.g.
   *  'build' / 'autonomous' / 'instar-dev' / 'spec-converge' / 'transfer'). A
   *  free-string label — NEVER trusted as authority; the destination governor
   *  re-evaluates from real state. Recorded for audit only. */
  trigger: string;
  /** The tier the source session was on (always 'escalated' for a filed hint —
   *  a default-tier topic files no hint). Recorded for audit/observability. */
  sourceTier: EscalationTier;
  /** Source machine id (audit only — peer-asserted, never a principal). */
  sourceMachineId?: string;
  /** Epoch ms after which the hint is treated as absent. */
  expiresAt: number;
  /** Epoch ms the hint was filed (audit/observability). */
  filedAt: number;
}

interface HintFileShape {
  version: 1;
  hints: Record<string, EscalationHint>;
}

export interface EscalationHintStoreDeps {
  /** File the hints persist to (JSON). */
  filePath: string;
  /** Hint TTL (ms). Defaults to DEFAULT_ESCALATION_HINT_TTL_MS. */
  ttlMs?: number;
  /** Wall clock — injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export class EscalationHintStore {
  private readonly d: EscalationHintStoreDeps;
  private hints: Record<string, EscalationHint> = {};
  private loaded = false;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(deps: EscalationHintStoreDeps) {
    this.d = deps;
    this.now = deps.now ?? (() => Date.now());
    this.ttlMs = deps.ttlMs ?? DEFAULT_ESCALATION_HINT_TTL_MS;
  }

  private load(): void {
    if (this.loaded) return;
    try {
      if (fs.existsSync(this.d.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.d.filePath, 'utf-8')) as Partial<HintFileShape>;
        if (raw && typeof raw === 'object' && raw.hints && typeof raw.hints === 'object') {
          // Shape-validate each entry — a malformed entry is dropped, never
          // trusted (no hint = the safe direction).
          for (const [k, v] of Object.entries(raw.hints)) {
            if (
              v && typeof v === 'object' &&
              typeof (v as EscalationHint).trigger === 'string' &&
              typeof (v as EscalationHint).expiresAt === 'number'
            ) {
              this.hints[k] = v as EscalationHint;
            }
          }
        }
      }
    } catch {
      // @silent-fallback-ok — a corrupt/absent hint file means NO hints, which
      // is the safe direction: no hint ⇒ no re-admit ⇒ the resumed session
      // stays on the default tier (exactly as if WS5.3 were off). Never throws
      // into the transfer/spawn path.
      this.hints = {};
    }
    this.loaded = true;
  }

  private persist(): void {
    const dir = path.dirname(this.d.filePath);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.d.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, hints: this.hints } satisfies HintFileShape, null, 2));
      fs.renameSync(tmp, this.d.filePath); // atomic swap
    } catch {
      // @silent-fallback-ok — a failed hint persist keeps the in-memory hint
      // authoritative for this process (the common case: file then consume in
      // the same process). A lost durable copy only loses the re-admit across a
      // restart-in-the-gap, which degrades to default tier — never an error,
      // never a thrown exception into the transfer path.
    }
  }

  /**
   * File an escalation hint for a topic (the transfer SOURCE leg). Idempotent —
   * a newer file for the same topic replaces the older one. Stamps `expiresAt`
   * from the TTL.
   */
  file(sessionKey: string, hint: Omit<EscalationHint, 'expiresAt' | 'filedAt'>): void {
    this.load();
    const filedAt = this.now();
    this.hints[sessionKey] = { ...hint, filedAt, expiresAt: filedAt + this.ttlMs };
    this.persist();
  }

  /**
   * Read a topic's live (non-expired) hint WITHOUT consuming it. Returns null
   * when absent or expired. Observability/peek surface.
   */
  peek(sessionKey: string): EscalationHint | null {
    this.load();
    const h = this.hints[sessionKey];
    if (!h) return null;
    if (this.now() >= h.expiresAt) return null; // lazily expired
    return { ...h };
  }

  /**
   * Read AND remove a topic's live hint (the destination resume leg). Returns
   * null when absent or expired (an expired hint is removed as a side effect).
   * Consume-once: a single transfer yields at most one re-admit attempt.
   */
  consume(sessionKey: string): EscalationHint | null {
    this.load();
    const h = this.hints[sessionKey];
    if (!h) return null;
    delete this.hints[sessionKey];
    this.persist();
    if (this.now() >= h.expiresAt) return null; // expired — removed, not returned
    return { ...h };
  }

  /** Remove a topic's hint (e.g. a suppress write, or an explicit clear). */
  clear(sessionKey: string): void {
    this.load();
    if (this.hints[sessionKey]) {
      delete this.hints[sessionKey];
      this.persist();
    }
  }

  /** All live (non-expired) hints — diagnostics surface. Prunes expired. */
  all(): Record<string, EscalationHint> {
    this.load();
    const now = this.now();
    let changed = false;
    for (const [k, h] of Object.entries(this.hints)) {
      if (now >= h.expiresAt) {
        delete this.hints[k];
        changed = true;
      }
    }
    if (changed) this.persist();
    return { ...this.hints };
  }
}
