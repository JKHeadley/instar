/**
 * test-runner-selfdisable-patterns.mjs — the SHARED serverless-host
 * self-disable pattern detector for the test-runner concurrency bound
 * (docs/specs/test-runner-concurrency-bound.md §2.6(b), §2.9, §5 last bullet).
 *
 * WHY THIS LIVES IN scripts/lib AS PLAIN ESM (one implementation, two
 * consumers): the pre-push hook chain (scripts/pre-push-*.mjs) deliberately
 * imports nothing from src/ or dist/ — a stale or missing dist must never
 * break (let alone block) a push — while `instar dev:preflight`
 * (src/commands/devPreflight.ts) runs its checks by SPAWNING commands.
 * Implementing the detector once here and having dev:preflight spawn the same
 * consumer script (scripts/pre-push-test-runner-selfdisable.mjs --preflight)
 * keeps a single implementation reachable from both module systems.
 *
 * The paths + event shapes read here are the FROZEN rendezvous contract of
 * spec §4 (canonical TS implementation: src/core/hostTestRunnerSemaphore.ts —
 * resolveTestRunnerPaths / readLedgerTail / listLedgerSegments). This module
 * re-reads the same frozen paths directly instead of importing the compiled
 * module, per the dist-independence requirement above; the unit suite
 * (tests/unit/test-runner-selfdisable-patterns.test.ts) pins the shared
 * contract.
 *
 * ADVISORY-ONLY BY DESIGN: every read is best-effort and torn/malformed-line
 * TOLERANT — a missing, unreadable, or garbage ledger yields ZERO findings
 * and never throws out of the public entry points. Spec §2.6: "ledger content
 * may only ever ADD a warning, never block a push."
 *
 * "SUSTAINED" (the spec leaves the threshold to the builder — documented
 * choice): a pattern is flagged when >= DEFAULT_THRESHOLD (3) matching
 * events land within DEFAULT_WINDOW_MS (48h) among the newest
 * DEFAULT_MAX_EVENTS (400) ledger events (live file + newest 2 rotated
 * segments). Rationale: one skip is a deliberate one-off, two may be a
 * retry; three within two days is a pattern worth a WARN — and the surface
 * is advisory-only, so a false positive costs one stderr line, never a
 * blocked push.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_THRESHOLD = 3;
export const DEFAULT_WINDOW_MS = 48 * 60 * 60 * 1000; // 48h
export const DEFAULT_MAX_EVENTS = 400;
/** Newest rotated segments consulted in addition to the live ledger file. */
export const MAX_SEGMENTS_READ = 2;

// Code-default caps + pinned sanity ceilings (spec §2.9 — mirrors
// HOST_TEST_SUITE_CAP_DEFAULT/…CEILING in src/core/hostTestRunnerSemaphore.ts;
// pinned by the shared-contract unit test).
export const SUITE_CAP_DEFAULT = 1;
export const TARGETED_CAP_DEFAULT = 6;
export const SUITE_CAP_CEILING = 4;
export const TARGETED_CAP_CEILING = 24;
/** Cap stamps beyond this multiple of the host-uniform authority flag (§2.9). */
export const CAP_DIVERGENCE_FACTOR = 4;

/**
 * The two patterns unambiguous enough for `dev:preflight` (which MAY fail per
 * §2.6) to exit non-zero on: a sustained `off` kill-switch and sustained
 * CI-reason skips on a non-CI host are both graded "like `off`" by the spec —
 * deliberate self-disable signatures. The divergence/watch patterns keep
 * plausible legitimate explanations (emergency env scoping, a deliberate
 * interactive watch) and stay WARN-without-fail even in preflight. The
 * pre-push surface NEVER fails on any of them (structural, §5 last bullet).
 */
export const PREFLIGHT_FAIL_PATTERNS = ['sustained-off', 'ci-skip-non-ci-host'];

/** Frozen §4 rendezvous paths (mirror of resolveTestRunnerPaths — including
 * the internal INSTAR_HOST_TEST_BASE_DIR test seam). */
export function resolveLedgerPaths(env = process.env) {
  const override = env['INSTAR_HOST_TEST_BASE_DIR'];
  const baseDir =
    override && override.trim() ? override.trim() : path.join(os.homedir(), '.instar');
  return {
    baseDir,
    ledger: path.join(baseDir, 'host-test-runner-events.jsonl'),
    tuning: path.join(baseDir, 'host-test-runner-tuning.json'),
  };
}

/** Hardened CI predicate (spec §2.6 — mirrors isCiEnvironment in
 * src/core/testRunnerRunClassifier.ts): CI must be 'true'/'1' AND a positive
 * CI signal must be present. */
export function isCiHost(env = process.env) {
  const ci = env['CI'];
  if (ci !== 'true' && ci !== '1') return false;
  return env['GITHUB_ACTIONS'] !== undefined || env['RUNNER_OS'] !== undefined;
}

/** Rotated ledger segments, newest first (mirror of listLedgerSegments). */
export function listLedgerSegmentsNewestFirst(paths) {
  try {
    const base = path.basename(paths.ledger).replace(/\.jsonl$/, '');
    return fs
      .readdirSync(paths.baseDir)
      .filter(
        (f) =>
          f.startsWith(`${base}.`) && f.endsWith('.jsonl') && f !== path.basename(paths.ledger),
      )
      .map((f) => path.join(paths.baseDir, f))
      .sort()
      .reverse();
  } catch {
    return []; // no base dir → no segments (nothing to warn about)
  }
}

/**
 * Bounded, torn/malformed-line-TOLERANT read of the newest ledger events
 * across the live file + the newest MAX_SEGMENTS_READ rotated segments.
 * Returns `{ events, ledgerPresent }` with events oldest→newest. Never
 * throws; a missing/unreadable file is an empty contribution.
 */
export function readLedgerEvents(paths, maxEvents = DEFAULT_MAX_EVENTS) {
  const files = [
    ...listLedgerSegmentsNewestFirst(paths).slice(0, MAX_SEGMENTS_READ).reverse(),
    paths.ledger,
  ];
  const events = [];
  let ledgerPresent = false;
  for (const file of files) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf-8');
      ledgerPresent = true;
    } catch {
      continue; // missing live file / segment — empty contribution
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === 'object' && typeof obj.kind === 'string') {
          events.push(obj);
        }
      } catch {
        // torn/malformed ledger line — tolerated by contract (§2.6)
      }
    }
  }
  return { events: events.slice(-maxEvents), ledgerPresent };
}

function sanitizeCap(raw, codeDefault, ceiling) {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > ceiling) return codeDefault;
  return n;
}

/**
 * Tolerant read of the host-uniform tuning authority (spec §2.9). A missing /
 * corrupt file or out-of-range values resolve to code-defaults — this
 * detector must never throw on the same-user-writable file it reads.
 */
export function readTuningAuthority(paths) {
  let file = null;
  try {
    const obj = JSON.parse(fs.readFileSync(paths.tuning, 'utf-8'));
    if (obj && typeof obj === 'object') file = obj;
  } catch {
    // absent/corrupt tuning file → code-default authority
  }
  return {
    posture: file?.enforcing === true ? 'enforcing' : 'dry-run',
    suiteCap: sanitizeCap(file?.maxConcurrent, SUITE_CAP_DEFAULT, SUITE_CAP_CEILING),
    targetedCap: sanitizeCap(file?.targetedMax, TARGETED_CAP_DEFAULT, TARGETED_CAP_CEILING),
    ttlSignal: file?.ttlSignal === true,
  };
}

export function defaultAuthority() {
  return {
    posture: 'dry-run',
    suiteCap: SUITE_CAP_DEFAULT,
    targetedCap: TARGETED_CAP_DEFAULT,
    ttlSignal: false,
  };
}

/**
 * The §2.6/§2.9 pattern list. Event shapes are the chokepoint's own ledger
 * emissions (tests/setup/test-runner-semaphore.globalSetup.ts):
 *   skip  → { kind:'skip', reason, loud }
 *   warn  → { kind:'warn', warnType: 'posture-divergence'|'cap-divergence'|
 *             'env-arm-ignored'|…, … }
 * and every event carries resolved-state stamps (posture, suiteCap,
 * targetedCap, ttlSignalArmed).
 */
export const PATTERNS = [
  {
    id: 'sustained-off',
    label: 'sustained INSTAR_HOST_TEST_SEMAPHORE=off skips',
    match: (e) => e.kind === 'skip' && e.reason === 'off',
  },
  {
    id: 'ci-skip-non-ci-host',
    label: 'CI-reason skips ledgered on a NON-CI host (spoofed-CI signature; graded like `off`)',
    // Only meaningful when the DETECTING host is not itself a CI runner —
    // gated in detectSelfDisablePatterns().
    requiresNonCiHost: true,
    match: (e) => e.kind === 'skip' && e.reason === 'CI',
  },
  {
    id: 'sustained-watch-skip',
    label:
      'sustained defaulted/agent-context watch-mode skips (the labeled-innocent full-suite path)',
    // `loud: true` is stamped exactly for defaulted-into-watch or
    // agent-context watch skips (§2.6); a deliberate human interactive
    // `--watch` is stamped loud:false and never flags.
    match: (e) => e.kind === 'skip' && e.reason === 'watch' && e.loud === true,
  },
  {
    id: 'resolved-cap-divergence',
    label: 'resolved cap stamps exceed the host-uniform authority by >4× (env cap-inflation)',
    // Explicit chokepoint warns OR stamp-derived (§2.9: "from the ledger's
    // per-run cap stamps"). The 4× margin makes legitimate authority
    // transitions (caps live in [1, ceiling]) unable to false-positive.
    match: (e, ctx) =>
      (e.kind === 'warn' && e.warnType === 'cap-divergence') ||
      (Number.isFinite(e.suiteCap) &&
        e.suiteCap > ctx.authority.suiteCap * CAP_DIVERGENCE_FACTOR) ||
      (Number.isFinite(e.targetedCap) &&
        e.targetedCap > ctx.authority.targetedCap * CAP_DIVERGENCE_FACTOR),
  },
  {
    id: 'posture-divergence',
    label: 'resolved posture diverged from the host-uniform authority (either direction)',
    // Explicit chokepoint-emitted divergence WARNs only (both directions).
    // Deliberately NOT stamp-inferred: comparing historical posture stamps
    // against the CURRENT authority would false-positive across every
    // legitimate posture flip, and the chokepoint already ledgers one
    // explicit warn per divergent run — so a sustained divergence is
    // >= threshold explicit warns by construction.
    match: (e) => e.kind === 'warn' && e.warnType === 'posture-divergence',
  },
  {
    id: 'arm-divergence',
    label:
      'env TTL_SIGNAL=1 ignored against an unarmed authority (arming is tuning-file-only)',
    match: (e) => e.kind === 'warn' && e.warnType === 'env-arm-ignored',
  },
];

/**
 * Pure pattern detection over parsed ledger events. Returns
 * `{ findings, eventsScanned }`; a finding is
 * `{ pattern, label, count, threshold, windowMs, lastTs }`.
 * Events with an unparseable `ts` are excluded (never flag on garbage).
 */
export function detectSelfDisablePatterns(events, opts = {}) {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const nowMs = opts.nowMs ?? Date.now();
  const ciHost = opts.isCiHost ?? isCiHost(opts.env ?? process.env);
  const authority = opts.authority ?? defaultAuthority();
  const ctx = { authority };

  const recent = (Array.isArray(events) ? events : []).filter((e) => {
    const t = Date.parse(e?.ts);
    return Number.isFinite(t) && nowMs - t <= windowMs;
  });

  const findings = [];
  for (const p of PATTERNS) {
    if (p.requiresNonCiHost && ciHost) continue;
    const matched = recent.filter((e) => {
      try {
        return p.match(e, ctx) === true;
      } catch {
        return false; // a hostile/degenerate event never breaks detection
      }
    });
    if (matched.length >= threshold) {
      findings.push({
        pattern: p.id,
        label: p.label,
        count: matched.length,
        threshold,
        windowMs,
        lastTs: typeof matched[matched.length - 1]?.ts === 'string'
          ? matched[matched.length - 1].ts
          : null,
      });
    }
  }
  return { findings, eventsScanned: recent.length };
}

/**
 * Full composition: resolve paths → read ledger (live + newest segments) →
 * read tuning authority → detect. A missing/unreadable ledger returns
 * `{ ledgerPresent: false, findings: [] }` — no ledger, nothing to warn.
 * Never throws.
 */
export function runSelfDisableCheck(opts = {}) {
  try {
    const env = opts.env ?? process.env;
    const paths = opts.paths ?? resolveLedgerPaths(env);
    const { events, ledgerPresent } = readLedgerEvents(paths, opts.maxEvents ?? DEFAULT_MAX_EVENTS);
    if (!ledgerPresent) {
      return { ledgerPresent: false, findings: [], eventsScanned: 0, authority: null };
    }
    const authority = opts.authority ?? readTuningAuthority(paths);
    const { findings, eventsScanned } = detectSelfDisablePatterns(events, {
      ...opts,
      env,
      authority,
    });
    return { ledgerPresent: true, findings, eventsScanned, authority };
  } catch {
    // Advisory surface: any unexpected internal failure is "nothing to warn".
    return { ledgerPresent: false, findings: [], eventsScanned: 0, authority: null };
  }
}

/** Human-readable WARN lines (one per finding) for stderr surfaces. */
export function formatWarnLines(findings) {
  return (findings ?? []).map(
    (f) =>
      `WARN [test-runner-bound self-disable] ${f.label ?? f.pattern}: ` +
      `${f.count} event(s) within ${Math.round(f.windowMs / 3_600_000)}h ` +
      `(threshold ${f.threshold}${f.lastTs ? `, latest ${f.lastTs}` : ''}) — ` +
      `advisory only; a silently-disabled guard explains more incidents than a broken one (spec §2.6).`,
  );
}
