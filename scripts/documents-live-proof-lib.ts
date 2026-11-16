/**
 * Pure helpers for the Instar Documents live user-role proof (scripts/documents-live-proof.ts).
 *
 * The runner drives the real document page in Chromium and records every scenario through
 * {@link ScenarioMatrix}. The matrix is the honesty layer of the proof standard
 * (docs/specs/live-user-channel-proof-standard.md §4.4–4.6):
 *   - a PASS row must carry deterministic evidence, and any failed check inside the scenario turns
 *     it into a FAIL that stays FAIL (no retry-until-green, no hand-written verdicts);
 *   - a BLOCKED row must carry a blockedKind and a concrete reason; a bare BLOCKED is refused;
 *   - BLOCKED is never accepted for a happy-path or channel-parity scenario (§4.6).
 * The artifact is written by LiveTestArtifactStore (signed + hash-chained); this module only builds it.
 */
import type {
  BlockedKind, LiveTestArtifact, RiskCategory, ScenarioEvidence, ScenarioRow, Surface,
} from '../src/core/LiveTestArtifactStore.js';
import { REQUIRED_RISK_CATEGORIES } from '../src/core/LiveTestArtifactStore.js';

/** A failed expectation inside a scenario. Carries what was expected and what was seen. */
export class CheckFailed extends Error {
  constructor(message: string, readonly detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CheckFailed';
  }
}

/** Throw CheckFailed unless `cond` holds. */
export function check(cond: unknown, message: string, detail: Record<string, unknown> = {}): asserts cond {
  if (!cond) throw new CheckFailed(message, detail);
}

/** Throw unless `actual === expected` (strict), naming both in the failure. */
export function expectEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new CheckFailed(message, { expected, actual });
}

export interface ScenarioSpec {
  id: string;
  description: string;
  riskCategory: RiskCategory;
  surface?: Surface;
}

/** What a scenario body returns: its evidence. A body that returns nothing has proven nothing. */
export type ScenarioBody = (evidence: ScenarioEvidence) => Promise<void> | void;

const LOAD_BEARING: ReadonlySet<RiskCategory> = new Set(['happy-path', 'channel-parity']);

/** Keys that never count as evidence on their own (bookkeeping, not observations). */
const NON_EVIDENCE_KEYS = new Set(['error', 'failedCheck', 'screenshots']);

export function hasEvidence(e: ScenarioEvidence | undefined): boolean {
  if (!e) return false;
  return Object.entries(e).some(([k, v]) => !NON_EVIDENCE_KEYS.has(k) && v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0));
}

/**
 * Evidence as plain JSON data: a copy with no shared references (the artifact store's canonical
 * serializer treats a value seen twice as a cycle), no functions and no undefined values.
 */
export function plainEvidence(e: ScenarioEvidence): ScenarioEvidence {
  return JSON.parse(JSON.stringify(e ?? {})) as ScenarioEvidence;
}

export class ScenarioMatrix {
  readonly rows: ScenarioRow[] = [];
  private readonly ids = new Set<string>();

  constructor(private readonly log: (line: string) => void = () => undefined) {}

  private claim(id: string): void {
    if (this.ids.has(id)) throw new Error(`scenario id used twice: ${id}`);
    this.ids.add(id);
  }

  /**
   * Run one scenario. Any thrown error (a failed check, an HTTP surprise, a Playwright timeout) is a
   * FAIL with the error recorded. A body that finishes but gathered no evidence is a FAIL too.
   */
  async run(spec: ScenarioSpec, body: ScenarioBody): Promise<ScenarioRow> {
    this.claim(spec.id);
    const evidence: ScenarioEvidence = {};
    let verdict: 'PASS' | 'FAIL' = 'PASS';
    try {
      await body(evidence);
      if (!hasEvidence(evidence)) {
        verdict = 'FAIL';
        evidence.error = 'scenario recorded no evidence';
      }
    } catch (err) {
      verdict = 'FAIL';
      evidence.error = err instanceof Error ? err.message : String(err);
      if (err instanceof CheckFailed && Object.keys(err.detail).length) evidence.failedCheck = err.detail;
    }
    const row: ScenarioRow = { id: spec.id, description: spec.description, surface: spec.surface ?? 'dashboard', riskCategory: spec.riskCategory, verdict, evidence: plainEvidence(evidence) };
    this.rows.push(row);
    this.log(`${verdict.padEnd(7)} ${spec.riskCategory.padEnd(19)} ${spec.id}${verdict === 'FAIL' ? `  — ${String(evidence.error).split('\n')[0]}${evidence.failedCheck ? ` ${JSON.stringify(evidence.failedCheck).slice(0, 600)}` : ''}` : ''}`);
    return row;
  }

  /** A scenario that cannot run here, for a recorded external reason. Never for a load-bearing category. */
  blocked(spec: ScenarioSpec, blockedKind: BlockedKind, blockedReason: string, evidence: ScenarioEvidence = {}): ScenarioRow {
    this.claim(spec.id);
    if (LOAD_BEARING.has(spec.riskCategory)) throw new Error(`BLOCKED is not allowed for ${spec.riskCategory} (${spec.id}); it must PASS or FAIL`);
    if (!blockedKind || !blockedReason || blockedReason.trim().length < 20) throw new Error(`BLOCKED row ${spec.id} needs a blockedKind and a concrete reason`);
    const row: ScenarioRow = { id: spec.id, description: spec.description, surface: spec.surface ?? 'dashboard', riskCategory: spec.riskCategory, verdict: 'BLOCKED', blockedKind, blockedReason, evidence: plainEvidence(evidence) };
    this.rows.push(row);
    this.log(`BLOCKED ${spec.riskCategory.padEnd(19)} ${spec.id}  — ${blockedReason}`);
    return row;
  }

  counts(): { PASS: number; FAIL: number; BLOCKED: number } {
    const c = { PASS: 0, FAIL: 0, BLOCKED: 0 };
    for (const r of this.rows) c[r.verdict]++;
    return c;
  }

  /** Categories with at least one PASS, and the required ones with none (§4.6: BLOCKED-only is uncovered). */
  coverage(): { covered: RiskCategory[]; uncovered: RiskCategory[] } {
    const covered = REQUIRED_RISK_CATEGORIES.filter((c) => this.rows.some((r) => r.riskCategory === c && r.verdict === 'PASS'));
    return { covered, uncovered: REQUIRED_RISK_CATEGORIES.filter((c) => !covered.includes(c)) };
  }

  artifact(input: { featureId: string; runId: string; runnerFingerprint: string; createdAt: string }): LiveTestArtifact {
    const cats = [...new Set(this.rows.map((r) => r.riskCategory))];
    return {
      featureId: input.featureId,
      runId: input.runId,
      surfaces: [...new Set(this.rows.map((r) => r.surface))],
      riskCategories: REQUIRED_RISK_CATEGORIES.filter((c) => cats.includes(c)),
      scenarios: this.rows,
      createdAt: input.createdAt,
      runnerFingerprint: input.runnerFingerprint,
    };
  }
}

/** A run id: sortable time plus a random tail. */
export function newRunId(now: number, rand: string): string {
  return `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${rand}`;
}

/** Chromium's --host-resolver-rules value mapping each test hostname to a local port. */
export function hostResolverRules(map: Record<string, number>): string {
  return Object.entries(map).map(([host, port]) => `MAP ${host} 127.0.0.1:${port}`).join(', ');
}

/** The Send template the page posts (app contract item 7). */
export function sendTemplate(count: number, title: string, label: number | string, origin: string, id: string): string {
  return `I left ${count} ${count === 1 ? 'comment' : 'comments'} on "${title}" (version ${label}): ${origin}/docs/${id}`;
}
