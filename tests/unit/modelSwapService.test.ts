/**
 * §5.3 ModelSwapService unit tests
 * (spec: docs/specs/FABLE-MODEL-ESCALATION-SPEC.md §11).
 *
 * Load-bearing contracts:
 *  - refuses protected and non-idle sessions (live-input collision guard);
 *  - honors enabled:false / dryRun:true (dry-run injects NOTHING);
 *  - model id derived server-side; caller can only name a tier;
 *  - canary confirm ⇒ Session.model updated; unconfirmed ⇒ untouched +
 *    ONE Attention item + still counted (fails toward counting);
 *  - escalated:null framework ⇒ noop, zero injections (back-compat).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ModelSwapService,
  paneConfirmsModel,
  paneIdleWithEmptyInput,
  type SwapSessionFacade,
} from '../../src/core/ModelSwapService.js';
import {
  DEFAULT_TIER_ESCALATION_CONFIG,
  normalizeTierEscalationConfig,
  type TierEscalationConfig,
} from '../../src/core/ModelTierEscalation.js';
import type { Session } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const IDLE_TAIL = [
  'some earlier output',
  '╭──────────────────────────────╮',
  '│ >                            │',
  '╰──────────────────────────────╯',
  '  bypass permissions on (shift+tab to cycle)',
].join('\n');

const BUSY_TAIL = [
  'Working on it…',
  '╭──────────────────────────────╮',
  '│ > draft reply to justin      │',
  '╰──────────────────────────────╯',
  '  bypass permissions on (shift+tab to cycle)',
].join('\n');

const CONFIRM_TAIL = (id: string) =>
  `${IDLE_TAIL}\n⎿ Set model to ${id} (custom)\n`;

function makeSession(overrides?: Partial<Session>): Session {
  return {
    id: 'inst-1',
    name: 'topic-chat',
    status: 'running',
    tmuxSession: 'proj-topic-chat',
    startedAt: new Date().toISOString(),
    framework: 'claude-code',
    model: 'claude-opus-4-8',
    ...overrides,
  };
}

describe('paneIdleWithEmptyInput', () => {
  it('true for an idle pane with an empty prompt line', () => {
    expect(paneIdleWithEmptyInput(IDLE_TAIL)).toBe(true);
  });
  it('true with only the CLI placeholder hint typed', () => {
    expect(paneIdleWithEmptyInput(IDLE_TAIL.replace('│ >  ', '│ > Try "fix the bug" '))).toBe(true);
  });
  it('false when text is typed in the input (live-input collision guard)', () => {
    expect(paneIdleWithEmptyInput(BUSY_TAIL)).toBe(false);
  });
  it('false without an idle marker, false for null/empty (fail closed)', () => {
    expect(paneIdleWithEmptyInput('│ > │')).toBe(false);
    expect(paneIdleWithEmptyInput(null)).toBe(false);
    expect(paneIdleWithEmptyInput('')).toBe(false);
  });
});

describe('paneConfirmsModel — independent oracle', () => {
  it('confirms on the CLI acknowledgment line', () => {
    expect(paneConfirmsModel(CONFIRM_TAIL('claude-fable-5'), 'claude-fable-5')).toBe(true);
  });
  it('does NOT confirm from the echo of our own injected /model input', () => {
    const echoOnly = `${IDLE_TAIL}\n> /model claude-fable-5\n`;
    expect(paneConfirmsModel(echoOnly, 'claude-fable-5')).toBe(false);
  });
  it('does NOT confirm a different model id', () => {
    expect(paneConfirmsModel(CONFIRM_TAIL('claude-opus-4-8'), 'claude-fable-5')).toBe(false);
  });
  it('unrecognized format reads as NOT confirmed (honest degrade)', () => {
    expect(paneConfirmsModel('model is now totally swapped, trust me', 'claude-fable-5')).toBe(false);
    expect(paneConfirmsModel(null, 'claude-fable-5')).toBe(false);
  });

  // Live-canary pins (2026-06-09): the REAL CLI acks with the DISPLAY NAME,
  // not the id, and echoes our injected input with the ❯ prompt char.
  it('confirms the REAL CLI display-name ack (live format pin)', () => {
    const realAck = '❯ /model claude-fable-5\n  ⎿  Set model to Fable 5 and saved as your default for new sessions\n';
    expect(paneConfirmsModel(realAck, 'claude-fable-5')).toBe(true);
  });
  it('confirms the multi-part-version display form (Opus 4.8)', () => {
    const realAck = '  ⎿  Set model to Opus 4.8 and saved as your default for new sessions\n';
    expect(paneConfirmsModel(realAck, 'claude-opus-4-8')).toBe(true);
  });
  it('display form does NOT cross-confirm a sibling version', () => {
    const realAck = '  ⎿  Set model to Opus 4.6 and saved as your default for new sessions\n';
    expect(paneConfirmsModel(realAck, 'claude-opus-4-8')).toBe(false);
  });
});

describe('paneIdleWithEmptyInput — real CLI prompt char (live-canary pin)', () => {
  it('accepts the REAL CLI ❯ prompt with placeholder hint', () => {
    const realIdle = '────────────\n❯ Try "how do I log an error?"\n────────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents\n';
    expect(paneIdleWithEmptyInput(realIdle)).toBe(true);
  });
  it('accepts the REAL CLI bare ❯ prompt', () => {
    const realIdle = '────────────\n❯ \n────────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n';
    expect(paneIdleWithEmptyInput(realIdle)).toBe(true);
  });
  it('still refuses a ❯ prompt with typed text pending', () => {
    const typed = '────────────\n❯ deploy everything now\n────────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n';
    expect(paneIdleWithEmptyInput(typed)).toBe(false);
  });
});

describe('ModelSwapService.swap', () => {
  let stateDir: string;
  let session: Session;
  let tail: string;
  let postInjectTail: string | null;
  let injected: string[];
  let saved: Session[];
  let admitResult: { allow: boolean; reason?: string };
  let admitCalls: Array<Record<string, unknown>>;
  let injectionRecords: Array<[string, string]>;
  let cfg: TierEscalationConfig;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-swap-'));
    session = makeSession();
    tail = IDLE_TAIL;
    postInjectTail = null;
    injected = [];
    saved = [];
    admitResult = { allow: true };
    admitCalls = [];
    injectionRecords = [];
    cfg = normalizeTierEscalationConfig({
      ...DEFAULT_TIER_ESCALATION_CONFIG,
      enabled: true,
      dryRun: false,
    });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(stateDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/modelSwapService.test.ts:cleanup',
    });
  });

  function service(overrides?: {
    sessions?: Session[];
    protectedSessions?: string[];
    nowMs?: () => number;
  }): ModelSwapService {
    const facade: SwapSessionFacade = {
      listRunningSessions: () => overrides?.sessions ?? [session],
      captureMeaningfulTail: (_t, lines) =>
        injected.length > 0 && lines >= 30 ? postInjectTail : tail,
      sendInput: (_t, input) => {
        injected.push(input);
        return true;
      },
    };
    return new ModelSwapService({
      stateDir,
      sessions: facade,
      saveSession: s => saved.push({ ...s }),
      protectedSessions: () => overrides?.protectedSessions ?? [],
      getConfig: () => cfg,
      governor: {
        admitEscalation: input => {
          admitCalls.push(input as unknown as Record<string, unknown>);
          return admitResult;
        },
        recordInjection: (id, tr) => {
          injectionRecords.push([id, tr]);
          return true;
        },
      } as never,
      canaryAttempts: 3,
      canaryIntervalMs: 1,
      wait: () => Promise.resolve(),
      ...(overrides?.nowMs ? { now: overrides.nowMs } : {}),
    });
  }

  it('refuses an unknown session (exact match only — no substring matching)', async () => {
    const r1 = await service().swap('nope', 'escalated');
    expect(r1).toMatchObject({ status: 'refused', reason: 'unknown-session' });
    // a PREFIX of a real name must not match
    const r2 = await service().swap('topic', 'escalated');
    expect(r2.reason).toBe('unknown-session');
    expect(injected).toHaveLength(0);
  });

  it('refuses a launch-time-only framework (§5.6 capability honored by code)', async () => {
    session = makeSession({ framework: 'codex-cli', model: 'gpt-5.5' });
    const r = await service().swap('topic-chat', 'escalated');
    expect(r).toMatchObject({ status: 'refused', reason: 'launch-time-only-framework' });
  });

  it('refuses a protected session (authorization boundary)', async () => {
    const r = await service({ protectedSessions: ['proj-topic-chat'] }).swap('topic-chat', 'escalated');
    expect(r).toMatchObject({ status: 'refused', reason: 'protected-session' });
    expect(injected).toHaveLength(0);
  });

  it('escalated:null ⇒ noop with ZERO injections (backwards-compat contract)', async () => {
    cfg.frameworks['claude-code'] = { default: null, escalated: null };
    const r = await service().swap('topic-chat', 'escalated');
    expect(r).toMatchObject({ status: 'noop', reason: 'no-model-configured' });
    expect(injected).toHaveLength(0);
    expect(admitCalls).toHaveLength(0);
  });

  it('already on the target tier ⇒ noop', async () => {
    session = makeSession({ model: 'claude-fable-5' });
    const r = await service().swap('topic-chat', 'escalated');
    expect(r).toMatchObject({ status: 'noop', reason: 'already-on-tier' });
  });

  it('enabled:false wins — refuses before any injection', async () => {
    cfg.enabled = false;
    const r = await service().swap('topic-chat', 'escalated');
    expect(r).toMatchObject({ status: 'refused', reason: 'disabled' });
    expect(injected).toHaveLength(0);
  });

  it('refuses a non-idle pane and a pane with typed input (fail closed)', async () => {
    tail = BUSY_TAIL;
    expect((await service().swap('topic-chat', 'escalated')).reason).toBe('not-idle');
    tail = 'thinking…';
    expect((await service().swap('topic-chat', 'escalated')).reason).toBe('not-idle');
    expect(injected).toHaveLength(0);
  });

  it('cost-guard refusal surfaces the governor reason', async () => {
    admitResult = { allow: false, reason: 'quota-unavailable' };
    const r = await service().swap('topic-chat', 'escalated');
    expect(r).toMatchObject({ status: 'refused', reason: 'cost-guard:quota-unavailable' });
    expect(injected).toHaveLength(0);
  });

  it('dryRun: evaluates every gate, injects NOTHING, admission is dry', async () => {
    cfg.dryRun = true;
    const r = await service().swap('topic-chat', 'escalated');
    expect(r).toMatchObject({ status: 'dry-run', model: 'claude-fable-5' });
    expect(injected).toHaveLength(0);
    expect(admitCalls[0]?.dry).toBe(true);
    expect(injectionRecords).toHaveLength(0);
    const audit = fs.readFileSync(
      path.join(stateDir, 'state', 'model-tier-escalation', 'audit.jsonl'), 'utf-8');
    expect(audit).toContain('dry-run-would-swap');
  });

  it('confirmed swap: injects server-derived id, counts at injection, updates Session.model', async () => {
    postInjectTail = CONFIRM_TAIL('claude-fable-5');
    const r = await service().swap('topic-chat', 'escalated');
    expect(r).toMatchObject({ status: 'swapped', model: 'claude-fable-5', confirmed: true });
    expect(injected).toEqual(['/model claude-fable-5']);
    expect(injectionRecords).toEqual([['inst-1', 'claude-opus-4-8→escalated']]);
    expect(saved).toHaveLength(1);
    expect(saved[0].model).toBe('claude-fable-5');
  });

  it('UNCONFIRMED swap: Session.model untouched, silent maturation breadcrumb (never Attention), STILL counted', async () => {
    postInjectTail = IDLE_TAIL; // never confirms
    const r = await service().swap('topic-chat', 'escalated');
    expect(r).toMatchObject({ status: 'unconfirmed', confirmed: false });
    expect(saved).toHaveLength(0); // Session.model NOT written
    expect(session.model).toBe('claude-opus-4-8');
    // TOPIC-PROFILE-SPEC §11/§14 (maturing-feature-health-no-alerts): the
    // signal is a maturation-track audit breadcrumb, not an Attention item.
    const audit = fs.readFileSync(
      path.join(stateDir, 'state', 'model-tier-escalation', 'audit.jsonl'), 'utf-8');
    const unconfirmedRow = audit
      .trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
      .find(e => e.type === 'swap-unconfirmed');
    expect(unconfirmedRow).toMatchObject({
      maturationSignal: true,
      feature: 'model-tier-escalation',
      session: 'topic-chat',
    });
    expect(injectionRecords).toHaveLength(1); // fails toward counting
  });

  it('echo of our own /model input never confirms the canary', async () => {
    postInjectTail = `${IDLE_TAIL}\n> /model claude-fable-5\n`;
    const r = await service().swap('topic-chat', 'escalated');
    expect(r.status).toBe('unconfirmed');
  });

  it('dwell backstop: a second swap within minTierDwellMs is refused + flap audited', async () => {
    postInjectTail = CONFIRM_TAIL('claude-fable-5');
    let t = Date.parse('2026-06-10T12:00:00Z');
    const svc = service({ nowMs: () => t });
    expect((await svc.swap('topic-chat', 'escalated')).status).toBe('swapped');
    // immediately try to swap back
    session.model = 'claude-fable-5';
    t += 1000; // 1s later — inside the 5min dwell
    const r = await svc.swap('topic-chat', 'default');
    expect(r).toMatchObject({ status: 'refused', reason: 'dwell' });
    const audit = fs.readFileSync(
      path.join(stateDir, 'state', 'model-tier-escalation', 'audit.jsonl'), 'utf-8');
    expect(audit).toContain('flap-suppressed');
    // past the dwell window the down-swap proceeds
    t += cfg.costGuards.minTierDwellMs;
    postInjectTail = CONFIRM_TAIL('claude-opus-4-8');
    injected.length = 0;
    const r2 = await svc.swap('topic-chat', 'default');
    expect(r2.status).toBe('swapped');
  });

  it('a swap back to DEFAULT consumes no budget and no lease', async () => {
    session = makeSession({ model: 'claude-fable-5' });
    postInjectTail = CONFIRM_TAIL('claude-opus-4-8');
    const r = await service().swap('topic-chat', 'default');
    expect(r).toMatchObject({ status: 'swapped', model: 'claude-opus-4-8' });
    expect(admitCalls).toHaveLength(0);
    expect(injectionRecords).toHaveLength(0);
  });

  it('matches by exact tmuxSession value too (registry value, not caller string)', async () => {
    postInjectTail = CONFIRM_TAIL('claude-fable-5');
    const r = await service().swap('proj-topic-chat', 'escalated');
    expect(r.status).toBe('swapped');
  });
});
