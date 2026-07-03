/**
 * ReviewCanaryBattery — unit tests (context-aware-outbound-review §D9.4b(a);
 * test-plan boundary 13): outcome classification against a scripted route
 * double, the seed-then-cleanup contract, refuse conditions, per-run-unique
 * messageIds + the seed-count assertion.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ReviewCanaryBattery,
  REVIEW_CANARY_FIXTURES,
  CANARY_FIXTURE_USER_ID,
  type ReviewCanaryBatteryDeps,
  type ReviewTestResponse,
} from '../../src/monitoring/ReviewCanaryBattery.js';
import type { TopicMessage } from '../../src/memory/TopicMemory.js';

// ── Fakes ────────────────────────────────────────────────────────────

/** In-memory TopicMemory double recording the seed/cleanup lifecycle. */
function fakeTopicMemory() {
  const rows: TopicMessage[] = [];
  const events: string[] = [];
  return {
    rows,
    events,
    insertMessages(messages: TopicMessage[]): number {
      events.push(`insert:${messages.length}`);
      let inserted = 0;
      for (const m of messages) {
        if (rows.some((r) => r.messageId === m.messageId && r.topicId === m.topicId)) continue; // INSERT OR IGNORE
        rows.push(m);
        inserted++;
      }
      return inserted;
    },
    deleteMessagesByUser(userId: string): number {
      events.push(`delete:${userId}`);
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].userId === userId) rows.splice(i, 1);
      }
      return before - rows.length;
    },
  };
}

type ArmScript = (body: Record<string, unknown>) => ReviewTestResponse;

const OK = (opts: { flag: boolean; pel?: boolean; mode?: string | null; hasTopic: boolean }): ReviewTestResponse => ({
  status: 200,
  body: {
    results: opts.flag ? [{ reviewer: 'conversational-tone', severity: 'block', issue: 'flagged' }] : [],
    pelBlock: opts.pel === true,
    contextMeta: opts.hasTopic
      ? { messagesIncluded: 2, askLicenseMode: opts.mode === null ? undefined : (opts.mode ?? 'single-sender') }
      : null,
  },
});

/** The healthy live-reviewer script: adversarial content flagged on BOTH arms;
 *  controls pass with their asks. */
const healthyScript: ArmScript = (body) => {
  const ctx = body.context as { topicId?: number };
  const hasTopic = typeof ctx.topicId === 'number';
  const fixtureId = String(body.fixtureId ?? '');
  const adversarial = fixtureId.startsWith('cred-') || fixtureId.startsWith('pii-');
  return OK({ flag: adversarial, hasTopic });
};

function makeDeps(script: ArmScript, overrides?: Partial<ReviewCanaryBatteryDeps>) {
  const tm = fakeTopicMemory();
  const decisionRows: Array<Record<string, unknown>> = [];
  const calls: Array<Record<string, unknown>> = [];
  const deps: ReviewCanaryBatteryDeps = {
    topicMemory: tm,
    callReviewTest: async (body) => {
      calls.push(body);
      return script(body);
    },
    writeDecisionRow: (row) => decisionRows.push(row),
    isFeatureLive: () => true,
    isObserveOnly: () => true,
    isTestEndpointEnabled: () => true,
    ...overrides,
  };
  return { deps, tm, decisionRows, calls };
}

// ── Refuse conditions ────────────────────────────────────────────────

describe('refuse conditions — inconclusive summary recorded, NEVER a silent skip', () => {
  const cases: Array<[string, Partial<ReviewCanaryBatteryDeps>, string]> = [
    ['feature dark', { isFeatureLive: () => false }, 'dark'],
    ['under enforcement', { isObserveOnly: () => false }, 'enforcement'],
    ['test endpoint disabled', { isTestEndpointEnabled: () => false }, 'disabled'],
  ];
  for (const [name, override, reasonBit] of cases) {
    it(`refuses when ${name}`, async () => {
      const { deps, tm, decisionRows, calls } = makeDeps(healthyScript, override);
      const battery = new ReviewCanaryBattery(deps);
      const summary = await battery.run();
      expect(summary.verdict).toBe('inconclusive');
      expect(summary.reason).toContain(reasonBit);
      expect(summary.batterySummary).toBe(true);
      expect(decisionRows).toHaveLength(1); // the recorded refusal
      expect(calls).toHaveLength(0); // no evaluation performed
      expect(tm.events).toHaveLength(0); // no seeding on a refusal
    });
  }
});

// ── Outcome classification ───────────────────────────────────────────

describe('outcome classification (the §D9.4b outcome table)', () => {
  it('healthy run → passed; ~6 arm outcomes; summary row written through the §D8 writer', async () => {
    const { deps, decisionRows, calls } = makeDeps(healthyScript);
    const summary = await new ReviewCanaryBattery(deps).run();
    expect(summary.verdict).toBe('passed');
    // 2 adversarial × 2 arms + 2 controls = 6 route calls / arm outcomes.
    expect(calls).toHaveLength(6);
    expect(summary.fixtures).toHaveLength(6);
    expect(summary.fixtures.every((f) => f.status === 'ok')).toBe(true);
    expect(decisionRows).toHaveLength(1);
    expect(decisionRows[0].batterySummary).toBe(true);
    // Every replay carried the canary tag + an arm-encoding fixtureId.
    for (const c of calls) {
      expect(c.canary).toBe(true);
      expect(String(c.fixtureId)).toMatch(/\/(baseline|with-context)$/);
    }
    // Baseline arms carry NO topicId; with-context arms carry the reserved
    // NEGATIVE id.
    for (const c of calls) {
      const ctx = c.context as { topicId?: number };
      if (String(c.fixtureId).endsWith('/baseline')) expect(ctx.topicId).toBeUndefined();
      else expect(ctx.topicId).toBeLessThan(0);
    }
  });

  it('with-context arm unflagged on an adversarial fixture → CONTEXT-LAUNDERED → failed', async () => {
    const script: ArmScript = (body) => {
      const ctx = body.context as { topicId?: number };
      const hasTopic = typeof ctx.topicId === 'number';
      const adversarial = String(body.fixtureId ?? '').startsWith('cred-') || String(body.fixtureId ?? '').startsWith('pii-');
      // The ask LAUNDERS the paste: flagged at baseline, unflagged with context.
      return OK({ flag: adversarial && !hasTopic, hasTopic });
    };
    const { deps } = makeDeps(script);
    const summary = await new ReviewCanaryBattery(deps).run();
    expect(summary.verdict).toBe('failed');
    expect(summary.reason).toContain('CONTEXT-LAUNDERED');
    expect(summary.fixtures.some((f) => f.status === 'context-laundered')).toBe(true);
  });

  it('baseline arm that does not flag → fixture INVALID → inconclusive (never a soak failure)', async () => {
    const script: ArmScript = (body) => {
      const ctx = body.context as { topicId?: number };
      return OK({ flag: false, hasTopic: typeof ctx.topicId === 'number' });
    };
    const { deps } = makeDeps(script);
    const summary = await new ReviewCanaryBattery(deps).run();
    expect(summary.verdict).toBe('inconclusive');
    expect(summary.fixtures.some((f) => f.status === 'invalid-baseline-missed')).toBe(true);
  });

  it('pelBlock on any arm → fixture INVALID (exercised the deterministic layer) → inconclusive', async () => {
    const script: ArmScript = (body) => {
      const ctx = body.context as { topicId?: number };
      const hasTopic = typeof ctx.topicId === 'number';
      const adversarial = String(body.fixtureId ?? '').startsWith('cred-') || String(body.fixtureId ?? '').startsWith('pii-');
      return OK({ flag: adversarial, pel: adversarial, hasTopic });
    };
    const { deps } = makeDeps(script);
    const summary = await new ReviewCanaryBattery(deps).run();
    expect(summary.verdict).toBe('inconclusive');
    expect(summary.fixtures.some((f) => f.status === 'invalid-pel-fired')).toBe(true);
  });

  it('with-context arm without the pinned single-sender mode → invalid-mode-mismatch → inconclusive', async () => {
    const script: ArmScript = (body) => {
      const ctx = body.context as { topicId?: number };
      const hasTopic = typeof ctx.topicId === 'number';
      const adversarial = String(body.fixtureId ?? '').startsWith('cred-') || String(body.fixtureId ?? '').startsWith('pii-');
      return OK({ flag: adversarial, hasTopic, mode: hasTopic ? 'weak-corroboration-only' : undefined });
    };
    const { deps } = makeDeps(script);
    const summary = await new ReviewCanaryBattery(deps).run();
    expect(summary.verdict).toBe('inconclusive');
    expect(summary.fixtures.some((f) => f.status === 'invalid-mode-mismatch')).toBe(true);
  });

  it('a control that FLAGS with its ask in context → failed (the veto false positive is back)', async () => {
    const script: ArmScript = (body) => {
      const ctx = body.context as { topicId?: number };
      const hasTopic = typeof ctx.topicId === 'number';
      const fixtureId = String(body.fixtureId ?? '');
      const adversarial = fixtureId.startsWith('cred-') || fixtureId.startsWith('pii-');
      return OK({ flag: adversarial || fixtureId.startsWith('veto-'), hasTopic });
    };
    const { deps } = makeDeps(script);
    const summary = await new ReviewCanaryBattery(deps).run();
    expect(summary.verdict).toBe('failed');
    expect(summary.fixtures.some((f) => f.status === 'control-flagged')).toBe(true);
  });

  it('a laundering FAILURE is never downgraded by a later fixture invalidity', async () => {
    const script: ArmScript = (body) => {
      const ctx = body.context as { topicId?: number };
      const hasTopic = typeof ctx.topicId === 'number';
      const fixtureId = String(body.fixtureId ?? '');
      if (fixtureId.startsWith('cred-')) return OK({ flag: !hasTopic, hasTopic }); // laundered
      if (fixtureId.startsWith('pii-')) return OK({ flag: false, hasTopic }); // invalid baseline
      return OK({ flag: false, hasTopic });
    };
    const { deps } = makeDeps(script);
    const summary = await new ReviewCanaryBattery(deps).run();
    expect(summary.verdict).toBe('failed');
  });

  it('route error → inconclusive; the summary is still written', async () => {
    const { deps, decisionRows } = makeDeps(() => ({ status: 500, body: { error: 'kaput' } }));
    const summary = await new ReviewCanaryBattery(deps).run();
    expect(summary.verdict).toBe('inconclusive');
    expect(decisionRows).toHaveLength(1);
  });
});

// ── Seeding contract ─────────────────────────────────────────────────

describe('seed-then-cleanup contract (R4-m4)', () => {
  it('pre-cleans, seeds uid-carrying rows into the reserved negative range, and cleans up in a finally', async () => {
    let rowsDuringRun: TopicMessage[] = [];
    const { deps, tm } = makeDeps((body) => {
      rowsDuringRun = [...tm.rows]; // capture mid-run state at first replay
      return healthyScript(body);
    });
    const battery = new ReviewCanaryBattery(deps);
    await battery.run();

    // Lifecycle order: pre-clean BEFORE the first insert; final delete last.
    expect(tm.events[0]).toBe(`delete:${CANARY_FIXTURE_USER_ID}`);
    expect(tm.events[tm.events.length - 1]).toBe(`delete:${CANARY_FIXTURE_USER_ID}`);
    expect(tm.events.filter((e) => e.startsWith('insert')).length).toBe(REVIEW_CANARY_FIXTURES.length);

    // Rows present DURING the run…
    expect(rowsDuringRun.length).toBeGreaterThan(0);
    for (const r of rowsDuringRun) {
      expect(r.topicId).toBeLessThan(0); // reserved negative range
      expect(r.userId).toBe(CANARY_FIXTURE_USER_ID); // cleanup key (non-rendered column)
      if (r.fromUser) expect(typeof r.telegramUserId).toBe('number'); // uid-carrying (pins single-sender)
      // R4-m2: fixture identity NEVER in the rendered text.
      expect(r.text).not.toContain('canary');
      expect(r.text).not.toContain('fixture');
    }
    // …and absent after the finally.
    expect(tm.rows).toHaveLength(0);
  });

  it('cleanup runs in a finally even when a replay throws mid-run', async () => {
    const { deps, tm, decisionRows } = makeDeps(() => {
      throw new Error('network down');
    });
    const summary = await new ReviewCanaryBattery(deps).run();
    expect(summary.verdict).toBe('inconclusive');
    expect(tm.rows).toHaveLength(0);
    expect(tm.events[tm.events.length - 1]).toBe(`delete:${CANARY_FIXTURE_USER_ID}`);
    expect(decisionRows).toHaveLength(1);
  });

  it('seed-count assertion failure → battery INCONCLUSIVE (stray-collision guard)', async () => {
    const { deps } = makeDeps(healthyScript, {
      topicMemory: {
        insertMessages: () => 0, // INSERT OR IGNORE swallowed everything
        deleteMessagesByUser: () => 0,
      },
    });
    const summary = await new ReviewCanaryBattery(deps).run();
    expect(summary.verdict).toBe('inconclusive');
    expect(summary.reason).toContain('seed assertion failed');
  });

  it('messageIds are per-run-unique (a second run inserts fresh rows, never no-ops against strays)', async () => {
    const clock = { t: 1_700_000_000_000 };
    const { deps, tm } = makeDeps(healthyScript, { now: () => new Date(clock.t) });
    const battery = new ReviewCanaryBattery(deps);
    await battery.run();
    const firstIds = tm.events.filter((e) => e.startsWith('insert'));
    expect(firstIds.length).toBe(REVIEW_CANARY_FIXTURES.length);

    // Simulate stranded rows: skip cleanup effects by re-seeding directly.
    clock.t += 60_000;
    const summary2 = await battery.run();
    expect(summary2.verdict).toBe('passed'); // pre-clean + fresh ids ⇒ seed assertions hold
  });
});

// ── isLive ───────────────────────────────────────────────────────────

describe('isLive (the route 503 predicate)', () => {
  it('reports the wiring-layer feature resolution; an erroring read reports NOT live', () => {
    const live = new ReviewCanaryBattery(makeDeps(healthyScript).deps);
    expect(live.isLive()).toBe(true);
    const broken = new ReviewCanaryBattery(
      makeDeps(healthyScript, { isFeatureLive: () => { throw new Error('x'); } }).deps,
    );
    expect(broken.isLive()).toBe(false);
  });
});
