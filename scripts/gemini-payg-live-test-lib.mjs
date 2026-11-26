/**
 * Pure helpers for the Gemini pay-per-use user-role live test
 * (scripts/gemini-payg-live-test.mjs; docs/specs/gemini-payg-metered-lane.md §8 "The run
 * boundary" Run 1 step 2, and release check (b), the holder-death drill).
 *
 * The honesty layer of docs/specs/live-user-channel-proof-standard.md §4.4–4.6 lives here:
 *   - a PASS row must carry evidence, and any failed check inside a scenario turns it into
 *     a FAIL that stays FAIL (no retry-until-green, no hand-written verdicts);
 *   - a BLOCKED row must carry a blockedKind and a concrete reason; BLOCKED is never
 *     accepted for a happy-path or channel-parity row (§4.6);
 *   - the artifact is PASS-able only when every required risk category has a row and
 *     every row passed.
 * The signed artifact itself is written by LiveTestArtifactStore (the runner does that);
 * this module only builds and judges it, so it is unit-testable without a server.
 */

export const REQUIRED_RISK_CATEGORIES = [
  'happy-path', 'channel-parity', 'lifecycle', 'permission-volatile',
  'failure-rollback', 'concurrency', 'idempotency', 'regression',
];
export const BLOCKED_KINDS = ['platform-error', 'platform-outage', 'operator-waiver', 'timeout', 'credential-unavailable'];
const LOAD_BEARING = new Set(['happy-path', 'channel-parity']);
const NON_EVIDENCE_KEYS = new Set(['error', 'failedCheck', 'screenshots']);

/** The feature ids the release recorder's check (b) is pointed at. */
export const FEATURE_SETUP_FLOW = 'routingSpend.geminiPaygLane.setupFlow';
export const FEATURE_HOLDER_DEATH = 'routingSpend.geminiPaygLane.holderDeathDrill';

/** A failed expectation inside a scenario. */
export class CheckFailed extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'CheckFailed';
    this.detail = detail;
  }
}

/** A scenario that cannot run for a machine-verifiable external reason (§4.6). */
export class Blocked extends Error {
  constructor(kind, reason) {
    super(reason);
    this.name = 'Blocked';
    this.kind = kind;
  }
}

export function check(cond, message, detail = {}) {
  if (!cond) throw new CheckFailed(message, detail);
}

export function expectEqual(actual, expected, message) {
  if (actual !== expected) throw new CheckFailed(message, { expected, actual });
}

export function hasEvidence(e) {
  if (!e) return false;
  return Object.entries(e).some(([k, v]) => !NON_EVIDENCE_KEYS.has(k) && v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0));
}

/** Evidence as plain JSON (no shared references, no undefined, no functions). */
export function plainEvidence(e) {
  return JSON.parse(JSON.stringify(e ?? {}, (_k, v) => (typeof v === 'bigint' ? String(v) : v)));
}

/**
 * The scenario matrix. `run` executes one scenario body with a fresh evidence object;
 * the body throws CheckFailed (FAIL), Blocked (BLOCKED) or returns (PASS when it recorded
 * evidence, FAIL otherwise). Any other throw is a FAIL with the error recorded.
 */
export class ScenarioMatrix {
  constructor({ surface = 'dashboard', log = () => {} } = {}) {
    this.surface = surface;
    this.rows = [];
    this.log = log;
  }

  async run(spec, body) {
    if (!REQUIRED_RISK_CATEGORIES.includes(spec.riskCategory)) throw new Error(`unknown risk category ${spec.riskCategory}`);
    if (this.rows.some((r) => r.id === spec.id)) throw new Error(`duplicate scenario id ${spec.id}`);
    const evidence = {};
    let verdict = 'PASS';
    let blockedKind;
    let blockedReason;
    try {
      await body(evidence);
      if (!hasEvidence(evidence)) {
        verdict = 'FAIL';
        evidence.failedCheck = 'the scenario recorded no evidence';
      }
    } catch (err) {
      if (err instanceof Blocked) {
        if (LOAD_BEARING.has(spec.riskCategory)) {
          verdict = 'FAIL';
          evidence.failedCheck = `BLOCKED is not accepted for a ${spec.riskCategory} scenario: ${err.message}`;
        } else if (!BLOCKED_KINDS.includes(err.kind) || !String(err.message || '').trim()) {
          verdict = 'FAIL';
          evidence.failedCheck = 'a BLOCKED row needs a known kind and a concrete reason';
        } else {
          verdict = 'BLOCKED';
          blockedKind = err.kind;
          blockedReason = err.message;
        }
      } else {
        verdict = 'FAIL';
        evidence.failedCheck = err instanceof CheckFailed ? err.message : `unexpected error: ${err && err.message ? err.message : String(err)}`;
        if (err instanceof CheckFailed && err.detail && Object.keys(err.detail).length) evidence.failedDetail = err.detail;
      }
    }
    const row = {
      id: spec.id,
      description: spec.description,
      surface: this.surface,
      riskCategory: spec.riskCategory,
      verdict,
      evidence: plainEvidence(evidence),
      ...(blockedKind ? { blockedKind, blockedReason } : {}),
    };
    this.rows.push(row);
    this.log(`[${verdict}] ${spec.id}${verdict === 'PASS' ? '' : ` — ${row.evidence.failedCheck ?? blockedReason ?? ''}`}`);
    return row;
  }

  missingCategories() {
    const seen = new Set(this.rows.map((r) => r.riskCategory));
    return REQUIRED_RISK_CATEGORIES.filter((c) => !seen.has(c));
  }

  allPass() {
    return this.allRowsPass() && this.missingCategories().length === 0;
  }

  /** Every recorded row PASS (the release recorder's own check (b) criterion), whatever categories it covers. */
  allRowsPass() {
    return this.rows.length > 0 && this.rows.every((r) => r.verdict === 'PASS');
  }

  toArtifact({ featureId, runId, runnerFingerprint, createdAt }) {
    return {
      featureId,
      runId,
      surfaces: [this.surface],
      riskCategories: [...new Set(this.rows.map((r) => r.riskCategory))],
      scenarios: this.rows.map((r) => ({ ...r })),
      createdAt,
      runnerFingerprint,
    };
  }
}

export function newRunId(now = Date.now(), rand = Math.random) {
  return `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${Math.floor(rand() * 0xffffff).toString(16).padStart(6, '0')}`;
}

/**
 * The throwaway agent's config: everything that could reach the outside world or the
 * real agent off (tunnel, auto-update, feedback, dispatches), the pieces the live test
 * drives on (dashboard PIN, Work Board, routing spend, the live-test artifact store),
 * and — for a pair — the multi-machine pool with the mesh transport.
 */
export function throwawayConfig(cfg, { pin, pair, failoverTimeoutMinutes = 15 }) {
  const c = { ...cfg };
  c.dashboardPin = pin;
  c.tunnel = { enabled: false };
  c.updates = { ...(c.updates || {}), autoApply: false };
  c.feedback = { ...(c.feedback || {}), enabled: false };
  c.dispatches = { ...(c.dispatches || {}), enabled: false };
  c.threadline = { ...(c.threadline || {}), relayEnabled: false };
  c.monitoring = { ...(c.monitoring || {}), liveTestGate: { enabled: true }, liveTestRunner: { enabled: true } };
  c.workBoard = { ...(c.workBoard || {}), enabled: true };
  // The Work Board is built on the app-conversation service (a card owns one app
  // conversation), which exists only with native app conversations on.
  c.mobilePairing = { ...(c.mobilePairing || {}), enabled: true, native: { ...((c.mobilePairing || {}).native || {}), enabled: true } };
  c.routingSpend = { ...(c.routingSpend || {}), enabled: true };
  if (pair) {
    c.multiMachine = { ...(c.multiMachine || {}), sessionPool: { enabled: true }, meshTransport: { enabled: true }, failoverTimeoutMinutes };
  }
  return c;
}

/** The account lane's handoff body (§4) for a FAKE key, with screenshots already on disk. */
export function handoffBody({ keyFingerprint, readAt, shots, transcriptPath, designationEpoch = 1, keyCount = 1 }) {
  return {
    noEchoTransfer: { attestedBy: 'live-test-account-lane', at: readAt, method: 'secret-drop-retrieve --run -- secret-set', sourceMessageRef: 'live-test-drop#1' },
    oneKeyArtifact: { providerKeyId: 'projects/live-test/keys/fake-1', keyFingerprint, readAt, screenshotPath: shots.oneKey.path, screenshotSha256: shots.oneKey.sha256, keyCount },
    googleSpendLimit: { kind: 'budget-alert-only', amountUsd: 50, readAt, screenshotPath: shots.limit.path, screenshotSha256: shots.limit.sha256 },
    boundTo: { designationEpoch },
    transcripts: { paths: [transcriptPath], complete: true },
  };
}

/**
 * Every line of the server's plan text, checked against what the page shows. Returns the
 * lines that are missing (an empty array means every committed field is on the page).
 * Whitespace is collapsed on both sides: the page wraps text, the server does not.
 */
export function missingPlanLines(planText, pageText) {
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
  const page = norm(pageText);
  return String(planText).split('\n').map((l) => l.trim()).filter(Boolean).filter((l) => !page.includes(norm(l)));
}

/**
 * The money figures a setup commits, as the plan must print them. Independent of the
 * renderer, so a renderer that dropped a field fails here even if the page matches it.
 */
export function committedMoneyFigures(setup) {
  const usd = (n) => `$${Number(n).toFixed(2)}`;
  const share = Math.round(setup.monthlyCapUsd * setup.e2MonthSharePct) / 100;
  return [usd(setup.monthlyCapUsd), usd(setup.dailyCapUsd), usd(setup.perCallCeilingUsd), usd(setup.provisionalCeilingUsd), usd(share), usd(setup.e2DayCapUsd)];
}

/** Did a respawned process come back within its bound? Pure arithmetic over recorded times. */
export function restartWindow({ commitAt, exitAt, readyAt }) {
  if (![commitAt, exitAt, readyAt].every((t) => typeof t === 'number' && Number.isFinite(t))) return null;
  return { exitAfterCommitMs: exitAt - commitAt, downMs: readyAt - exitAt, totalMs: readyAt - commitAt };
}
