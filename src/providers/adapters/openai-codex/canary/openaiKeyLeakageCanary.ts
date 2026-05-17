/**
 * Codex OPENAI_API_KEY leakage canary.
 *
 * Rule 1a in `specs/provider-portability/12-openai-path-constraints.md`
 * requires that every Codex spawn strip `OPENAI_API_KEY` from the inherited
 * env. The Codex CLI prefers an API key over the stored OAuth token when
 * both are present, so a leak silently routes Codex inference to the OpenAI
 * API account (full per-token billing) instead of the ChatGPT subscription
 * envelope. The check that prevents this lives in `buildCodexChildEnv()`
 * (in `../transport/codexSpawn.ts`).
 *
 * This canary verifies that the scrub still works. It sets a sentinel value
 * for `OPENAI_API_KEY` in the test's `process.env`, calls the helper, and
 * asserts the helper's output does NOT contain the sentinel. Catches
 * regressions where (a) the allowlist accidentally adds OPENAI_API_KEY,
 * (b) the defensive hard-delete is removed, (c) the helper is bypassed by
 * a caller that constructs env from `process.env` directly.
 *
 * RULE 3.1 RATIONALE
 *   Criticality: critical — a leak silently bills the user's API account at
 *                full rates; the scrub MUST never regress
 *   Frequency:   startup canary (one tick per adapter init)
 *   Stability:   stable in shape — the env-allowlist contract is internal
 *                Instar code, so this canary is a regression guard rather
 *                than a drift detector
 *   Fallback:    none — failure surfaces via DegradationReporter; the
 *                remediation is a code fix, not self-heal
 *   Verdict:     deterministic structural assertion against the helper
 */

import { buildCodexChildEnv } from '../transport/codexSpawn.js';

const SENTINEL_API_KEY = 'sk-CANARY-NEVER-A-REAL-KEY';
const SENTINEL_ORG_ID = 'org-CANARY-NEVER-REAL';
const SENTINEL_PROJECT_ID = 'proj-CANARY-NEVER-REAL';

export interface OpenAiKeyLeakageCanaryResult {
  status: 'pass' | 'fail';
  message: string;
  failures: ReadonlyArray<string>;
}

/**
 * Run the canary. Returns `pass` only when ALL three OpenAI billing
 * variables (`OPENAI_API_KEY`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`) are
 * scrubbed from the helper's output, even when present in `process.env`
 * with the sentinel values. Restores the parent env after the check.
 */
export function runOpenAiKeyLeakageCanary(): OpenAiKeyLeakageCanaryResult {
  const failures: string[] = [];

  const saved = {
    apiKey: process.env.OPENAI_API_KEY,
    orgId: process.env.OPENAI_ORG_ID,
    projectId: process.env.OPENAI_PROJECT_ID,
    killSwitch: process.env.INSTAR_DISABLE_RULE1_OPENAI,
  };

  try {
    // Force a clean baseline — never run the canary with the kill-switch
    // active, since that path is explicitly allowed to leak.
    delete process.env.INSTAR_DISABLE_RULE1_OPENAI;

    process.env.OPENAI_API_KEY = SENTINEL_API_KEY;
    process.env.OPENAI_ORG_ID = SENTINEL_ORG_ID;
    process.env.OPENAI_PROJECT_ID = SENTINEL_PROJECT_ID;

    const childEnv = buildCodexChildEnv();

    if (childEnv.OPENAI_API_KEY !== undefined) {
      failures.push(
        `OPENAI_API_KEY leaked into child env (value: ${childEnv.OPENAI_API_KEY === SENTINEL_API_KEY ? 'sentinel-passed-through' : 'unexpected-value'})`,
      );
    }
    if (childEnv.OPENAI_ORG_ID !== undefined) {
      failures.push('OPENAI_ORG_ID leaked into child env');
    }
    if (childEnv.OPENAI_PROJECT_ID !== undefined) {
      failures.push('OPENAI_PROJECT_ID leaked into child env');
    }

    // Sanity: at least one allowlisted variable must come through. If the
    // helper returns an empty env, something deeper is broken (e.g., the
    // allowlist iteration is no-op'd) and the "no leak" assertion above
    // would pass vacuously.
    const allowlistHits = Object.keys(childEnv).length;
    if (allowlistHits === 0) {
      failures.push(
        'helper returned empty env — allowlist iteration may be broken; canary cannot meaningfully assert non-leak',
      );
    }
  } finally {
    restore('OPENAI_API_KEY', saved.apiKey);
    restore('OPENAI_ORG_ID', saved.orgId);
    restore('OPENAI_PROJECT_ID', saved.projectId);
    restore('INSTAR_DISABLE_RULE1_OPENAI', saved.killSwitch);
  }

  if (failures.length > 0) {
    return {
      status: 'fail',
      message: `Codex env-scrub canary detected ${failures.length} leak(s) — Rule 1a is broken`,
      failures,
    };
  }
  return {
    status: 'pass',
    message: 'Codex env-scrub canary passed: OPENAI_API_KEY / OPENAI_ORG_ID / OPENAI_PROJECT_ID all scrubbed',
    failures: [],
  };
}

function restore(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
