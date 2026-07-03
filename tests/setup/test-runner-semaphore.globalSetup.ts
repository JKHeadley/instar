/**
 * test-runner-semaphore.globalSetup — THE CHOKEPOINT of the test-runner
 * concurrency bound (spec §2.2). Rides inside every root vitest config (wired
 * by tests/setup/test-runner-bound.config-eval.ts), so every invocation path
 * that loads a config is bounded — package scripts, husky pre-push, editor
 * integrations, ad-hoc `npx vitest`.
 *
 * THIN CALLER (spec L12): all lock/holders/ledger machinery lives in
 * src/core/hostTestRunnerSemaphore.ts; this file decides skip-vs-acquire,
 * prints the deterministic per-run line, and returns the release teardown.
 *
 * SHIP POSTURE IS DRY-RUN (operator-ratified): full bookkeeping, zero
 * enforcement side-effects — a run that WOULD block logs `would-block` and
 * admits. Nothing here can block at ship time; blocking exists only behind
 * the tuning-file `enforcing` flip (§2.9/§4).
 *
 * FAIL-OPEN (§1.1): any unexpected internal error admits the run with a loud
 * WARN — the chokepoint must never wedge `git push` or a `/build` gate.
 */

import fs from 'node:fs';

import type { GlobalSetupContext } from 'vitest/node';

import {
  HostTestRunnerSemaphore,
  TestRunnerCapacityTimeoutError,
  TestRunnerStormCeilingError,
  checkTuningBaseline,
  resolveAcquireBudgetMs,
  type TestLane,
  type TestPosture,
} from '../../src/core/hostTestRunnerSemaphore.js';
import {
  analyzeVitestArgv,
  checkNestedUnderHolder,
  deriveRunClass,
  isAgentContext,
  isCiEnvironment,
  isKillSwitchOff,
  resolvedPoolBound,
} from '../../src/core/testRunnerRunClassifier.js';

/** Braille spinner char — matches the silence/load-stall sentinels' liveActivity
 * indicator (§2.10: the wait must not read as a hang). */
const WAIT_SPINNER = '⠹';

type HeldFlagMap = Map<TestLane, { id: string; pid: number }>;

/** Process-global one-slot-per-process flag, LANE-SCOPED (§2.5). */
function heldFlags(): HeldFlagMap {
  const g = globalThis as Record<string, unknown>;
  if (!(g['__instarTestRunnerHeld'] instanceof Map)) {
    g['__instarTestRunnerHeld'] = new Map();
  }
  return g['__instarTestRunnerHeld'] as HeldFlagMap;
}

function line(msg: string): void {
  try {
    process.stderr.write(`[test-runner-bound] ${msg}\n`);
  } catch {
    /* @silent-fallback-ok: stderr write failure is unrecoverable noise */
  }
}

function skipLine(sem: HostTestRunnerSemaphore, reason: string, posture: TestPosture, loud: boolean, extra = ''): void {
  // Every skip prints ONE deterministic line naming reason + posture and
  // appends the same to the ledger — an inert bound is never silent (§2.6).
  if (loud) {
    line(`WARN: SKIPPING the host-wide test-runner bound (reason: ${reason}) — posture: ${posture}.${extra ? ` ${extra}` : ''} A self-disabled bound explains more incidents than a broken one.`);
  } else {
    line(`skip (${reason}) — posture: ${posture}${extra ? ` ${extra}` : ''}`);
  }
  try {
    sem.ledger('skip', { reason, loud });
  } catch {
    /* @silent-fallback-ok: ledger append is best-effort (§2.8) */
  }
}

function inferConfigName(ctx: GlobalSetupContext): string {
  const stashed = process.env['__INSTAR_TRB_CONFIG'];
  if (stashed) return stashed;
  const include = JSON.stringify(ctx.config?.include ?? []);
  if (include.includes('tests/integration') && !include.includes('tests/unit')) return 'integration';
  if (include.includes('tests/e2e') && !include.includes('tests/unit')) return 'e2e';
  if (include.includes('tests/contract')) return 'contract';
  return 'unit';
}

export default async function setup(ctx: GlobalSetupContext): Promise<(() => Promise<void>) | void> {
  const sem = new HostTestRunnerSemaphore();
  try {
    const context = sem.resolveContext();
    const posture = context.posture.posture;

    // ── Kill switch (env-only — §2.6) ─────────────────────────────────────
    if (isKillSwitchOff()) {
      skipLine(sem, 'off', posture, true, 'Unset INSTAR_HOST_TEST_SEMAPHORE to re-arm.');
      return;
    }

    // ── CI exemption (hardened; spoof-suspect contexts are LOUD — §2.6) ──
    if (isCiEnvironment()) {
      const spoofSuspect = isAgentContext();
      skipLine(sem, 'CI', posture, spoofSuspect, spoofSuspect ? '(CI env in an agent context — a spoofed CI export on a dev host is graded like `off`.)' : '');
      return;
    }

    const argv = analyzeVitestArgv(process.argv);

    // ── list / collect invocations — no-op (never waits or consumes) ─────
    if (argv.isList) {
      skipLine(sem, 'list', posture, false);
      return;
    }

    // ── watch exemption — kept, but NEVER quiet where it matters (§2.6) ──
    const watchMode = ctx.config?.watch === true || argv.explicitWatch;
    if (watchMode) {
      const defaultedIntoWatch = !argv.explicitWatch; // bare `vitest` in a TTY
      const agentCtx = isAgentContext();
      const loud = defaultedIntoWatch || agentCtx;
      skipLine(
        sem,
        'watch',
        posture,
        loud,
        defaultedIntoWatch ? 'This run DEFAULTED into watch mode — use `vitest run` for a bounded one-shot.' : agentCtx ? '(watch in an agent-launched context is a labeled-innocent full-suite skip — soak-metered.)' : '',
      );
      return;
    }

    // ── Tuning-mutation visibility (content-hash baseline — §2.9) ─────────
    try {
      const baseline = checkTuningBaseline(sem.paths, context.tuning);
      if (baseline.changed) {
        line(
          `WARN: host-test-runner tuning file CHANGED since last observed${baseline.changedFields.length ? ` — ${baseline.changedFields.join('; ')}` : ''}`,
        );
        sem.ledger('tuning-changed', { changedFields: baseline.changedFields });
      } else if (baseline.established) {
        sem.ledger('tuning-baseline-established', { silent: baseline.silentEstablish });
      }
    } catch {
      /* @silent-fallback-ok: baseline detection is observability, never gates */
    }

    // ── Divergence loudness (bidirectional posture, cap inflation, arm) ───
    if (context.posture.divergence === 'weaker') {
      line(`WARN: resolved posture (${posture}) is WEAKER than the host-uniform authority (${context.posture.authority}) — this process is admitting past the host cap.`);
      sem.ledger('warn', { warnType: 'posture-divergence', direction: 'weaker' });
    } else if (context.posture.divergence === 'stronger') {
      line(`WARN: resolved posture (${posture}) is STRONGER than the host-uniform authority (${context.posture.authority}) — your blocks are NOT host policy (the soak's would-block evidence is being contaminated).`);
      sem.ledger('warn', { warnType: 'posture-divergence', direction: 'stronger' });
    }
    for (const [laneName, cap] of [['suite', context.suiteCap], ['targeted', context.targetedCap]] as const) {
      if (cap.divergentBeyond4x) {
        line(`WARN: resolved ${laneName} cap (${cap.cap}, env) exceeds the host-uniform authority by >4× — a lone env export is the quiet twin of the kill switch.`);
        sem.ledger('warn', { warnType: 'cap-divergence', lane: laneName, cap: cap.cap });
      }
      if (cap.coerced) {
        sem.ledger('warn', { warnType: 'cap-coerced', lane: laneName, cap: cap.cap });
      }
    }
    if (context.ttlSignal.envArmIgnored) {
      line('WARN: INSTAR_HOST_TEST_TTL_SIGNAL=1 (env) IGNORED — arming the signal arm is tuning-file-only (env can only disarm).');
      sem.ledger('warn', { warnType: 'env-arm-ignored' });
    }
    if (context.tuning.corrupt) {
      line('WARN: host-test-runner tuning file was CORRUPT — quarantined aside; code defaults apply (never a silent posture revert).');
      sem.ledger('warn', { warnType: 'tuning-corrupt-quarantined' });
    }

    if (posture === 'off') {
      // Config-file/tuning postures cannot turn the chokepoint off (§2.6) —
      // only the env kill switch (handled above). 'off' here is unreachable
      // via tuning by construction; guard anyway (fail toward bounding).
      skipLine(sem, 'off', posture, true);
      return;
    }

    // ── Lane classification (STATE-verified — §2.3) ───────────────────────
    const configName = inferConfigName(ctx);
    let lane: TestLane = 'suite';
    let fileCount: number | undefined;
    if (configName === 'unit') {
      const stash = process.env['__INSTAR_TRB_TARGETED'];
      let targeted = false;
      if (stash) {
        try {
          const parsed = JSON.parse(stash);
          targeted = parsed?.targeted === true;
          fileCount = typeof parsed?.matchedCount === 'number' ? parsed.matchedCount : undefined;
        } catch {
          /* @silent-fallback-ok: unparseable stash → suite-class (safe superset) */
        }
      }
      // Two-point agreement BY STATE (§2.3): targeted routing requires BOTH the
      // argv classification AND the RESOLVED config's live pool bound ≤ 4 — a
      // run whose final pool exceeds 4 lands in the cap-1 suite lane BY
      // CONSTRUCTION, whatever flags produced it.
      const bound = resolvedPoolBound(ctx.config as Parameters<typeof resolvedPoolBound>[0]);
      if (targeted && argv.poolShaping.length === 0 && bound !== null && bound <= 4) {
        lane = 'targeted';
      }
    }

    // ── Re-entrancy: lane-scoped ancestry+holders cross-check (§2.5) ──────
    const flags = heldFlags();
    if (flags.has(lane)) {
      skipLine(sem, 'reentrant', posture, false, '(in-process same-lane slot already held)');
      return;
    }
    const nested = checkNestedUnderHolder(readHoldersRaw(sem), lane, {
      envMarker: process.env['INSTAR_TEST_SEMAPHORE_HELD'],
    });
    if (nested.nested) {
      const helperRan = process.env['__INSTAR_TRB_CONFIG'] !== undefined;
      const clampStash = process.env['__INSTAR_TRB_CLAMPED'];
      const clampActive = context.clampActive;
      const bound = resolvedPoolBound(ctx.config as Parameters<typeof resolvedPoolBound>[0]);
      const poolOverride = clampActive && helperRan && (bound === null || bound > 4);
      // `clamped` per §2.5 = "this child went through the GUARDED config-eval
      // path" (true) vs an unguarded config that skipped without the clamp
      // (false + WARN). It is NOT the "a reshape physically happened" dimension —
      // in dry-run the guarded path ledgers `would-clamp` and reshapes nothing
      // (§2.11); that posture nuance is carried by `clampStash` ('dry-run' vs
      // 'nested'), and the §4(e) real-clamp soak count is read from the
      // would-clamp/clamp events, not from this boolean.
      const clamped = helperRan && !poolOverride;
      if (!helperRan) {
        line('WARN: nested run reached the chokepoint WITHOUT the config-eval clamp (unguarded config) — skipping unclamped (deadlock rule); fix the config to call withTestRunnerBound().');
      } else if (poolOverride) {
        line('WARN: nested run\'s RESOLVED pool still exceeds 4 after neutralization (a novel pool flag?) — ledgered loud, not silently unbounded.');
      }
      sem.ledger('nested-skip', {
        shelteringPid: nested.shelteringPid,
        shelteringSlotId: nested.shelteringSlotId,
        clamped,
        ...(poolOverride ? { poolOverride: true } : {}),
        clampStash: clampStash ?? null,
      });
      line(`skip (reentrant-nested under pid ${nested.shelteringPid}) — posture: ${posture}, clamped: ${clamped}`);
      return;
    }

    // ── Acquire ───────────────────────────────────────────────────────────
    const runClass = deriveRunClass(configName);
    const budgetMs = resolveAcquireBudgetMs(lane, runClass, process.env);
    let lastWaitLineAt = 0;
    const outcome = await sem.acquire({
      lane,
      runClass,
      fileCount,
      budgetMs,
      onWaitTick: (elapsedMs, holders) => {
        const now = Date.now();
        if (now - lastWaitLineAt < 60_000) return; // once a minute (§2.6)
        lastWaitLineAt = now;
        // The braille spinner char makes this frame match the silence/load-stall
        // sentinels' liveActivity indicator — a waiting run must not read as a
        // hang (§2.10).
        line(
          `${WAIT_SPINNER} waiting for a ${lane}-lane test slot (${Math.round(elapsedMs / 60000)}m elapsed; ` +
            `${holders.length} holder(s): ${holders.map((h) => `pid ${h.pid} age ${Math.round(h.ageMs / 1000)}s`).join(', ') || 'none visible'}) — active work, not a hang`,
        );
      },
    });

    if (outcome.kind === 'fail-open-admit') {
      line(`WARN: admitted WITHOUT a slot (fail-open: ${outcome.cause}) — posture: ${posture}. The bound is temporarily lost in the safe direction; witness recorded.`);
      return; // nothing to release (witness is liveness-swept)
    }

    // Acquired.
    const capForLane = lane === 'suite' ? context.suiteCap.cap : context.targetedCap.cap;
    line(
      `${lane}-lane slot acquired (posture: ${posture}${outcome.wouldBlock ? ', WOULD-BLOCK under enforcement — admitted (dry-run)' : ''}, cap ${capForLane}, pid ${process.pid})`,
    );
    flags.set(lane, { id: outcome.id, pid: process.pid });
    process.env['INSTAR_TEST_SEMAPHORE_HELD'] = `${process.pid}:${outcome.id}`;

    return async () => {
      try {
        sem.release(outcome.id);
        flags.delete(lane);
        delete process.env['INSTAR_TEST_SEMAPHORE_HELD'];
      } catch {
        /* @silent-fallback-ok: pid-death reclaim frees the slot if release fails */
      }
    };
  } catch (err) {
    if (err instanceof TestRunnerCapacityTimeoutError || err instanceof TestRunnerStormCeilingError) {
      // Typed capacity refusal (enforcing posture only): a DISTINCT signal —
      // "this is NOT a test failure" (§2.6). Never process.exit() (§2.2 item 4);
      // the thrown error is reported cleanly by vitest and leaves no holder.
      process.exitCode = err.exitCode;
      throw err;
    }
    // FAIL-OPEN (§1.1): an internal chokepoint error must never wedge the run.
    line(`WARN: internal error (${(err as Error)?.message ?? err}) — admitting the run (fail-open)`);
    try {
      sem.ledger('fail-open-admit', { cause: 'internal-error', detail: String((err as Error)?.message ?? err).slice(0, 256) });
    } catch {
      /* @silent-fallback-ok: ledger append is best-effort */
    }
    return;
  }
}

/** Raw holders rows for the ancestry cross-check (no lock — read-only). */
function readHoldersRaw(sem: HostTestRunnerSemaphore): unknown[] {
  try {
    const obj = JSON.parse(fs.readFileSync(sem.paths.holders, 'utf-8'));
    return Array.isArray(obj?.holders) ? obj.holders : [];
  } catch {
    // @silent-fallback-ok: no holders file → not nested (acquire normally).
    return [];
  }
}
